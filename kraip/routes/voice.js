// Phone calls via Twilio. In the Twilio console set your number's "A call comes in" webhook to:
//   POST  {PUBLIC_URL}/voice/<employeeId>/incoming
// Outbound campaign calls and call-status reports use the other routes below.
const express = require("express");
const db = require("../db");
const telephony = require("../services/telephony");
const { chat } = require("../services/employee");
const { normalizePhone } = require("../lib/phone");
const calls = require("../services/calls");
const billing = require("../services/billing");

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

router.use((req, res, next) => {
  if (!telephony.validSignature(req)) return res.status(403).type("text/plain").send("Invalid signature");
  next();
});

const xml = (res, body) => res.type("text/xml").send(body);
const loadEmployee = (id) => {
  const employee = db.prepare("SELECT * FROM employees WHERE id = ?").get(id);
  if (!employee) return {};
  return { employee, business: db.prepare("SELECT * FROM businesses WHERE id = ?").get(employee.business_id) };
};
const turnUrl = (employeeId, convId) => `${telephony.publicUrl()}/voice/${employeeId}/turn?conv=${convId}`;

// One conversation per call (Twilio may deliver the same webhook twice), and none beyond the spending limit
function startConversation(employee, { direction, phone, callSid }) {
  const find = () => callSid && db.prepare("SELECT id FROM conversations WHERE employee_id = ? AND call_sid = ?").get(employee.id, callSid);
  if (find()) return find().id;
  try {
    return billing.withinLimit(employee.business_id, () => Number(db.prepare(
      "INSERT INTO conversations (employee_id, channel, direction, contact_phone, call_sid) VALUES (?, 'phone', ?, ?, ?)")
      .run(employee.id, direction, phone, callSid || null).lastInsertRowid));
  } catch (e) {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT") && find()) return find().id;
    throw e;
  }
}
const unavailable = (res, err) => {
  if (err.status !== 402) console.error("[voice] could not start call:", err.message);
  return xml(res, telephony.hangupTwiml("Sorry, this number is not available right now."));
};

router.post("/:employeeId/incoming", (req, res) => {
  const { employee, business } = loadEmployee(req.params.employeeId);
  if (!employee || employee.status !== "active") return xml(res, telephony.hangupTwiml("Sorry, this number is not available right now."));
  let convId;
  try { convId = startConversation(employee, { direction: "inbound", phone: normalizePhone(req.body.From), callSid: req.body.CallSid }); }
  catch (err) { return unavailable(res, err); }
  const text = employee.greeting || `Hello, this is ${employee.name} from ${business.name}. I'm an AI assistant. How can I help you today?`;
  xml(res, telephony.gatherTwiml({ text, action: turnUrl(employee.id, convId), lang: employee.language }));
});

router.post("/:employeeId/outbound", (req, res) => {
  const { employee, business } = loadEmployee(req.params.employeeId);
  const cc = db.prepare(`
    SELECT cc.id, cc.status, cc.conversation_id, c.phone, c.consent, c.opted_out FROM campaign_contacts cc
    JOIN contacts c ON c.id = cc.contact_id JOIN campaigns k ON k.id = cc.campaign_id
    WHERE cc.id = ? AND k.employee_id = ?`).get(Number(req.query.cc), req.params.employeeId);
  // Re-check consent at answer time: someone may have opted out since the call was queued
  if (!employee || !cc || !cc.consent || cc.opted_out || cc.status !== "calling") return xml(res, telephony.hangupTwiml("Sorry, wrong number. Goodbye."));
  let convId;
  try {
    if (cc.conversation_id) {   // already answered once: only a repeat delivery for the same call may continue
      const prev = db.prepare("SELECT id, call_sid FROM conversations WHERE id = ?").get(cc.conversation_id);
      if (!prev || prev.call_sid !== req.body.CallSid) return xml(res, telephony.hangupTwiml("Sorry, wrong number. Goodbye."));
      convId = prev.id;
    } else {
      convId = startConversation(employee, { direction: "outbound", phone: cc.phone, callSid: req.body.CallSid });
      db.prepare("UPDATE campaign_contacts SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL").run(convId, cc.id);
    }
  } catch (err) { return unavailable(res, err); }
  const text = `Hello, this is ${employee.name} calling from ${business.name}. I'm an AI assistant. ` +
    `Is now a good time for a quick question? You can say stop at any time and we won't call again.`;
  xml(res, telephony.gatherTwiml({ text, action: turnUrl(employee.id, convId), lang: employee.language }));
});

router.post("/:employeeId/turn", async (req, res) => {
  const { employee, business } = loadEmployee(req.params.employeeId);
  const convId = Number(req.query.conv);
  const conv = employee && db.prepare("SELECT * FROM conversations WHERE id = ? AND employee_id = ?").get(convId, employee.id);
  if (!conv) return xml(res, telephony.hangupTwiml("Sorry, something went wrong. Goodbye."));
  const lang = employee.language;
  const speech = String(req.body.SpeechResult || "").trim();
  if (!speech) return xml(res, telephony.gatherTwiml({ text: "Sorry, I didn't catch that. Could you say it again?", action: turnUrl(employee.id, convId), lang }));

  let r;
  try {
    r = await chat(convId, speech, { voice: true });
  } catch (err) {
    console.error("[voice] chat failed:", err.message);
    db.prepare("UPDATE conversations SET status = 'needs_human' WHERE id = ?").run(convId);
    return xml(res, telephony.hangupTwiml("I'm having trouble right now. Our team will call you back shortly. Goodbye.", lang));
  }
  if (r.optOut) return xml(res, telephony.hangupTwiml(r.reply, lang));
  if (r.handoff) {
    const text = r.reply || "Connecting you to our team.";
    return xml(res, business.handoff_number
      ? telephony.dialTwiml(text, business.handoff_number, lang)
      : telephony.hangupTwiml(text, lang));
  }
  xml(res, telephony.gatherTwiml({ text: r.reply, action: turnUrl(employee.id, convId), lang }));
});

router.post("/:employeeId/status", (req, res) => {
  const { employee } = loadEmployee(req.params.employeeId);
  if (!employee) return res.sendStatus(204);
  const callStatus = req.body.CallStatus;
  const duration = Number(req.body.CallDuration || 0);

  const conv = db.prepare("SELECT * FROM conversations WHERE call_sid = ? AND employee_id = ?").get(req.body.CallSid, employee.id);
  if (conv && callStatus === "completed") calls.finalizeCall(conv.id, duration, "provider");

  const ccId = Number(req.query.cc || 0);
  if (ccId) {
    const next = callStatus === "completed" ? "completed" : ["busy", "no-answer", "failed", "canceled"].includes(callStatus) ? "no_answer" : null;
    if (next) db.prepare("UPDATE campaign_contacts SET status = ? WHERE id = ? AND status = 'calling'").run(next, ccId);
  }
  res.sendStatus(204);
});

module.exports = router;
