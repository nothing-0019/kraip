// Phone calls via Plivo. In the Plivo console create an Application and set (paste the exact URLs shown in the Employees tab):
//   Answer URL (POST):  {PUBLIC_URL}/plivo/<employeeId>/answer?k=...
//   Hangup URL (POST):  {PUBLIC_URL}/plivo/<employeeId>/hangup?k=...
// then attach your number to that Application. Outbound campaign calls set their own URLs automatically.
const express = require("express");
const db = require("../db");
const plivo = require("../services/plivo");
const calls = require("../services/calls");
const billing = require("../services/billing");
const { phrases } = require("../lib/phrases");
const { normalizePhone } = require("../lib/phone");

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: "100kb" }));
// Fail closed: nothing below runs unless the request carries this employee's own key or a valid Plivo signature.
// (With no WEBHOOK_SECRET and no Plivo token configured, every request is refused.)
router.use("/:employeeId", (req, res, next) => {
  const auth = plivo.authenticate(req, req.params.employeeId);
  if (!auth.ok) return res.status(403).type("text/plain").send("Invalid signature");
  req.plivoSigned = auth.signed;
  next();
});

const xml = (res, body) => res.type("text/xml").send(body);
const loadEmployee = (id) => {
  const employee = db.prepare("SELECT * FROM employees WHERE id = ?").get(id);
  return employee ? { employee, business: db.prepare("SELECT * FROM businesses WHERE id = ?").get(employee.business_id) } : {};
};
// One conversation per call: Plivo may deliver the same answer webhook more than once
function startConversation(employee, { direction, phone, callUuid }) {
  const find = () => callUuid && db.prepare("SELECT id FROM conversations WHERE employee_id = ? AND call_sid = ?").get(employee.id, callUuid);
  const existing = find();
  if (existing) return existing.id;
  try {
    return billing.withinLimit(employee.business_id, () => Number(db.prepare(
      "INSERT INTO conversations (employee_id, channel, direction, contact_phone, call_sid) VALUES (?, 'phone', ?, ?, ?)")
      .run(employee.id, direction, phone, callUuid || null).lastInsertRowid));
  } catch (e) {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT") && find()) return find().id;   // two deliveries raced
    throw e;
  }
}
const refuse = (res, employee, err) => {
  if (err.status === 402) console.warn(`[voice] employee ${employee.id}: ${err.message}`);
  else console.error("[voice] could not start call:", err.message);
  return xml(res, plivo.hangupXml(phrases(employee.language).unavailable));
};

router.all("/:employeeId/answer", (req, res) => {
  const { employee } = loadEmployee(req.params.employeeId);
  if (!employee || employee.status !== "active") return xml(res, plivo.hangupXml(phrases(employee?.language).unavailable));
  try {
    const convId = startConversation(employee, { direction: "inbound", phone: normalizePhone(req.body.From), callUuid: req.body.CallUUID });
    xml(res, plivo.streamXml(convId));
  } catch (err) { refuse(res, employee, err); }
});

router.all("/:employeeId/outbound", (req, res) => {
  const { employee } = loadEmployee(req.params.employeeId);
  const cc = db.prepare(`
    SELECT cc.id, cc.status, cc.conversation_id, c.phone, c.consent, c.opted_out FROM campaign_contacts cc
    JOIN contacts c ON c.id = cc.contact_id JOIN campaigns k ON k.id = cc.campaign_id
    WHERE cc.id = ? AND k.employee_id = ?`).get(Number(req.query.cc), req.params.employeeId);
  // Re-check at answer time: the person may have opted out since the call was queued, and only a call KRAIP placed may be answered
  if (!employee || !cc || !cc.consent || cc.opted_out || cc.status !== "calling") return xml(res, plivo.hangupXml());
  try {
    if (cc.conversation_id) {   // this attempt already has a conversation: only a repeat delivery for the same call may reuse it
      const prev = db.prepare("SELECT id, call_sid FROM conversations WHERE id = ?").get(cc.conversation_id);
      if (prev && prev.call_sid === req.body.CallUUID) return xml(res, plivo.streamXml(prev.id));
      return xml(res, plivo.hangupXml());
    }
    const convId = startConversation(employee, { direction: "outbound", phone: cc.phone, callUuid: req.body.CallUUID });
    db.prepare("UPDATE campaign_contacts SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL").run(convId, cc.id);
    xml(res, plivo.streamXml(convId));
  } catch (err) { refuse(res, employee, err); }
});

router.all("/:employeeId/handoff", (req, res) => {
  const { business } = loadEmployee(req.params.employeeId);
  xml(res, business?.handoff_number
    ? plivo.dialXml({ number: business.handoff_number })
    : plivo.hangupXml("Sorry, our team is unavailable right now. Goodbye."));
});

router.all("/:employeeId/end", (req, res) => xml(res, plivo.hangupXml()));

router.all("/:employeeId/hangup", (req, res) => {
  const status = String(req.body.CallStatus || "");
  const uuid = req.body.CallUUID;
  const conv = uuid && db.prepare("SELECT id, status FROM conversations WHERE call_sid = ? AND employee_id = ?").get(uuid, req.params.employeeId);
  if (conv) {
    // The carrier's duration can correct billed time only when Plivo's own signature was verified; the ?k= key alone
    // proves which endpoint was called, not who sent it, so it is never allowed to change what a customer is billed.
    if (req.plivoSigned && status === "completed" && Number(req.body.Duration) > 0) {
      try { calls.finalizeCall(conv.id, req.body.Duration, "provider"); } catch (e) { console.warn("[call]", e.message); }
    }
    // A call that has ended can no longer be "open" (a conversation waiting for a human stays flagged)
    if (conv.status === "open") db.prepare("UPDATE conversations SET status = 'closed', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ? AND status = 'open'").run(conv.id);
  }

  const ccId = Number(req.query.cc || 0);
  if (ccId) {
    // Only this employee's campaigns; a repeat delivery changes nothing because only a 'calling' row moves on
    const row = db.prepare(`SELECT cc.conversation_id FROM campaign_contacts cc JOIN campaigns k ON k.id = cc.campaign_id
      WHERE cc.id = ? AND k.employee_id = ?`).get(ccId, req.params.employeeId);
    if (row) {
      // Answered (a conversation exists) = completed, anything else = nobody picked up
      const next = row.conversation_id ? "completed" : ["busy", "no-answer", "failed", "timeout", "cancel", "canceled", "completed"].includes(status) ? "no_answer" : null;
      if (next) db.prepare("UPDATE campaign_contacts SET status = ? WHERE id = ? AND status = 'calling'").run(next, ccId);
    }
  }
  res.sendStatus(204);
});

module.exports = router;
