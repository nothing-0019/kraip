// Data retention and deletion. Transcripts and phone numbers are personal data: customers can delete them, a data subject
// can be exported or erased, and RETENTION_DAYS (0 = keep) removes old transcripts automatically.
// What is kept on purpose: billing records (usage, invoices, cost rows) and opt-outs, because a person who asked not to be
// called must stay suppressed and a business needs its invoices.
const db = require("../db");
const usage = require("../lib/usage");

// Removes the content of a conversation but keeps the row, so call counts, duration and cost records stay intact
function redactConversation(conversationId) {
  return db.transaction(() => {
    const msgs = db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId).changes;
    db.prepare(`UPDATE conversations SET contact_phone = NULL, summary = '', public_token_hash = NULL,
      status = CASE WHEN status = 'open' THEN 'closed' ELSE status END, redacted_at = datetime('now'), ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?`).run(conversationId);
    db.prepare("DELETE FROM research_reports WHERE conversation_id = ?").run(conversationId);
    return msgs;
  })();
}

function purgeOlderThan(days, businessId = null) {
  days = Math.floor(Number(days));
  if (!(days >= 1)) throw Object.assign(new Error("older_than_days must be 1 or more"), { status: 400 });
  const cutoff = `-${days} days`;
  const where = businessId ? "AND e.business_id = ?" : "";
  const args = businessId ? [cutoff, businessId] : [cutoff];
  const old = db.prepare(`SELECT c.id FROM conversations c JOIN employees e ON e.id = c.employee_id
    WHERE c.redacted_at IS NULL AND COALESCE(c.ended_at, c.created_at) < datetime('now', ?) ${where}`).all(...args);
  let messages = 0;
  for (const c of old) messages += redactConversation(c.id);
  const reports = db.prepare(`DELETE FROM research_reports WHERE created_at < datetime('now', ?) ${businessId ? "AND business_id = ?" : ""}`).run(...args).changes;
  const notes = db.prepare(`DELETE FROM notifications WHERE created_at < datetime('now', ?) ${businessId ? "AND business_id = ?" : ""}`).run(...args).changes;
  return { conversations: old.length, messages, research_reports: reports, notifications: notes };
}

// Right to erasure for one contact. Opt-outs survive (only the phone number is kept, so the person stays suppressed).
function eraseContact(businessId, contactId, userId = null) {
  return db.transaction(() => {
    const c = db.prepare("SELECT * FROM contacts WHERE id = ? AND business_id = ?").get(contactId, businessId);
    if (!c) return null;
    const convs = db.prepare(`SELECT c.id FROM conversations c JOIN employees e ON e.id = c.employee_id
      WHERE e.business_id = ? AND c.contact_phone = ?`).all(businessId, c.phone);
    let messages = 0;
    for (const v of convs) messages += redactConversation(v.id);
    const leads = db.prepare("DELETE FROM leads WHERE business_id = ? AND phone = ?").run(businessId, c.phone).changes;
    let kept = false;
    if (c.opted_out) {
      db.prepare("UPDATE contacts SET name = NULL, consent = 0, consent_source = NULL, consent_at = NULL, prospect_id = NULL WHERE id = ?").run(c.id);
      kept = true;
    } else db.prepare("DELETE FROM contacts WHERE id = ?").run(c.id);
    usage.audit(businessId, userId, "contact.erased", `contact ${c.id}${kept ? " (opt-out kept)" : ""}`);
    return { conversations: convs.length, messages, leads, contact_removed: !kept, opt_out_kept: kept };
  }).immediate();
}

// Everything held about one contact (for a data-subject access request)
function exportContact(businessId, contactId) {
  const c = db.prepare("SELECT * FROM contacts WHERE id = ? AND business_id = ?").get(contactId, businessId);
  if (!c) return null;
  const convs = db.prepare(`SELECT c.* FROM conversations c JOIN employees e ON e.id = c.employee_id WHERE e.business_id = ? AND c.contact_phone = ?`).all(businessId, c.phone);
  return {
    contact: c,
    leads: db.prepare("SELECT * FROM leads WHERE business_id = ? AND phone = ?").all(businessId, c.phone),
    conversations: convs.map((v) => ({ ...v, public_token_hash: undefined, messages: db.prepare("SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id").all(v.id) })),
    exported_at: new Date().toISOString(),
  };
}

// Deletes a whole business workspace. Refuses while money is owed. Invoices go with it, so export them first.
function deleteBusiness(businessId, userId) {
  const billing = require("./billing");
  const st = billing.spendStatus(businessId);
  const owed = billing.exposurePaise(businessId);
  if (owed > 0) throw Object.assign(new Error("Pay the outstanding usage before deleting this business"), { status: 409 });
  db.prepare("DELETE FROM businesses WHERE id = ?").run(businessId);   // cascades to employees, conversations, leads, contacts, campaigns, usage, invoices...
  usage.audit(businessId, userId, "business.deleted", `workspace ${businessId} deleted`);
  return { deleted: true, mode: st.mode };
}

let timer = null;
function startScheduler() {
  const days = Number(process.env.RETENTION_DAYS || 0);
  if (timer || !(days >= 1)) return;
  const run = () => { try { const r = purgeOlderThan(days); if (r.conversations || r.research_reports) console.log("[retention] purged", JSON.stringify(r)); } catch (e) { console.warn("[retention] failed:", e.message); } };
  timer = setInterval(run, 6 * 60 * 60 * 1000); timer.unref();
  run();
}

module.exports = { redactConversation, purgeOlderThan, eraseContact, exportContact, deleteBusiness, startScheduler };
