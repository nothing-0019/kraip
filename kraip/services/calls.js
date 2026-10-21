const db = require("../db");
const usage = require("../lib/usage");
const { closeConversation } = require("./employee");
const billing = require("./billing");

// Longest call time we will ever record, whatever a report claims (defence in depth; real calls end at MAX_CALL_SECONDS)
const HARD_CAP_SECONDS = () => Number(process.env.MAX_RECORDABLE_CALL_SECONDS || 4 * 3600);

// Called when a phone call ends. Records talk time for billing and writes the summary.
//  source "stream":   our own timing from the audio stream (measured by this server)
//  source "provider": the carrier's reported duration. Callers must only use this for requests whose provider
//                     signature was verified, never for a client-supplied number.
// Safe to call any number of times for the same call (duplicate callbacks, retries, two workers): the first report is
// billed once (the database also enforces one call_seconds record per conversation), and a later carrier figure only
// corrects it, except for calls that were transferred to a human (the carrier's figure then includes the human's talk time).
// Whether the call counts as a "lead call" (billed at the higher rate) is decided once, at the first report.
function finalizeCall(conversationId, seconds, source = "stream", opts = {}) {
  const secs = Math.min(HARD_CAP_SECONDS(), Math.max(0, Math.round(Number(seconds) || 0)));

  const outcome = db.transaction(() => {
    const conv = db.prepare(`SELECT c.*, e.business_id FROM conversations c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?`).get(conversationId);
    if (!conv) return { changed: false };

    if (conv.duration_seconds != null) {
      if (source === "provider" && conv.duration_source === "stream" && secs !== conv.duration_seconds) {
        db.prepare("UPDATE conversations SET duration_seconds = ?, duration_source = 'provider' WHERE id = ?").run(secs, conversationId);
        db.prepare("UPDATE usage_events SET quantity = ? WHERE type = 'call_seconds' AND business_id = ? AND json_extract(meta, '$.conversation_id') = ?")
          .run(secs, conv.business_id, conversationId);
        return { changed: true };
      }
      return { changed: false };
    }
    const leadCall = !!db.prepare("SELECT 1 FROM leads WHERE conversation_id = ? AND score IN ('hot','warm')").get(conversationId);
    db.prepare("UPDATE conversations SET duration_seconds = ?, duration_source = ?, ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?")
      .run(secs, opts.transferred ? "transfer" : source, conversationId);
    usage.record(conv.business_id, "call_seconds", secs, { conversation_id: conversationId, lead_call: leadCall });
    return { changed: true, first: true };
  }).immediate();   // take the write lock up front so two workers cannot both think they are first

  if (outcome.changed) {
    try {
      const biz = db.prepare("SELECT e.business_id FROM conversations c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?").get(conversationId);
      if (biz) billing.checkAlerts(biz.business_id);   // low balance / limit warnings
    } catch (e) { console.warn("[call] alert check failed:", e.message); }
  }
  if (outcome.first) {
    closeConversation(conversationId, { keepNeedsHuman: !!opts.keepNeedsHuman })
      .catch((e) => console.warn("[call] summary failed:", e.message));
  }
  return outcome.changed;
}

module.exports = { finalizeCall };
