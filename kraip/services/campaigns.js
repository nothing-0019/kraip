const db = require("../db");
const telephony = require("./phone"); // Plivo or Twilio, whichever is configured
const usage = require("../lib/usage");
const billing = require("./billing");

const TZ = () => process.env.CALL_TIMEZONE || "Asia/Kolkata";
const RETRY_MS = () => Number(process.env.RETRY_MINUTES || 120) * 60 * 1000;

function localHour() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: TZ() }).format(new Date()));
  return h % 24;
}
const inWindow = (c) => localHour() >= c.window_start && localHour() < c.window_end;

// Why a contact may NOT be called right now (null = OK to call)
function blockReason(campaign, cc, contact) {
  if (!contact.consent) return "no_consent";
  if (contact.opted_out) return "opted_out";
  if (cc.attempts >= campaign.max_attempts) return "max_attempts";
  if (cc.last_attempt_at && Date.now() - cc.last_attempt_at < RETRY_MS()) return "retry_wait";
  return null;
}

function queue(campaignId) {
  return db.prepare(`
    SELECT cc.*, c.phone, c.name AS contact_name, c.consent, c.opted_out
    FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
    WHERE cc.campaign_id = ? AND cc.status IN ('pending','no_answer') ORDER BY cc.id`).all(campaignId);
}

function dryRun(campaignId) {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  const out = { in_call_window: inWindow(campaign), local_hour: localHour(), would_call: [], blocked: [] };
  for (const row of queue(campaignId)) {
    const reason = blockReason(campaign, row, row);
    (reason ? out.blocked : out.would_call).push({ contact_id: row.contact_id, name: row.contact_name, phone: row.phone, reason });
  }
  return out;
}

function progress(campaignId) {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM campaign_contacts WHERE campaign_id = ? GROUP BY status").all(campaignId);
  const p = { pending: 0, calling: 0, completed: 0, no_answer: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows) { p[r.status] = r.n; p.total += r.n; }
  return p;
}

const dispatching = new Set();   // campaigns being worked on by this process (a slow tick must not overlap the next one)
const staleCallingMs = () => (Number(process.env.MAX_CALL_SECONDS || 900) + 300) * 1000;

// Atomically takes one contact for calling. Every rule that protects the contact is re-checked inside this single
// statement, so two workers, a manual start plus the scheduler tick, or an opt-out that lands a moment earlier can never
// produce a second call, a call to an opted-out number, or an attempt beyond the limit. Returns true if this caller won.
const CLAIM = `
  UPDATE campaign_contacts SET status = 'calling', attempts = attempts + 1, last_attempt_at = @now, conversation_id = NULL
  WHERE id = @id AND status IN ('pending', 'no_answer') AND attempts < @max
    AND (last_attempt_at IS NULL OR last_attempt_at <= @retryCutoff)
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = campaign_contacts.contact_id AND c.consent = 1 AND c.opted_out = 0)
    AND EXISTS (SELECT 1 FROM campaigns k WHERE k.id = campaign_contacts.campaign_id AND k.status = 'running')
    AND NOT EXISTS (SELECT 1 FROM campaign_contacts o WHERE o.contact_id = campaign_contacts.contact_id AND o.status = 'calling' AND o.id <> campaign_contacts.id)`;

async function dispatch(campaignId, limit = Number(process.env.CAMPAIGN_CALLS_PER_TICK || 2)) {
  if (dispatching.has(campaignId)) return { placed: 0, reason: "already_running" };
  dispatching.add(campaignId);
  try { return await dispatchOnce(campaignId, limit); } finally { dispatching.delete(campaignId); }
}

async function dispatchOnce(campaignId, limit) {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign || campaign.status !== "running") return { placed: 0 };

  // Calls that never reported back (no hang-up callback long after the maximum call length) go back into the retry pool
  db.prepare("UPDATE campaign_contacts SET status = 'no_answer' WHERE campaign_id = ? AND status = 'calling' AND last_attempt_at < ?")
    .run(campaignId, Date.now() - staleCallingMs());

  let placed = 0, reason;
  if (!inWindow(campaign)) reason = "outside_call_window";
  else if (!billing.spendStatus(campaign.business_id).ok) reason = "spending_limit";

  if (!reason) {
    for (const row of queue(campaignId)) {
      if (placed >= limit) break;
      if (row.attempts >= campaign.max_attempts) continue;
      const why = blockReason(campaign, row, row);
      if (why === "no_consent" || why === "opted_out") {
        db.prepare("UPDATE campaign_contacts SET status = 'skipped' WHERE id = ? AND status IN ('pending','no_answer')").run(row.id);
        usage.audit(campaign.business_id, null, "campaign.skipped", `${row.phone}: ${why}`);
        continue;
      }
      if (why) continue;
      const now = Date.now();
      const won = db.prepare(CLAIM).run({ id: row.id, now, max: campaign.max_attempts, retryCutoff: now - RETRY_MS() }).changes === 1;
      if (!won) continue;   // someone else took it, or a rule changed a moment ago
      try {
        const sid = await telephony.placeCall({ to: row.phone, employeeId: campaign.employee_id, campaignContactId: row.id });
        usage.audit(campaign.business_id, null, "campaign.call_placed", `${row.phone} ${sid}`);
        placed++;
      } catch (err) {
        console.warn("[campaign] call failed:", err.message);
        // Out of attempts = failed for good; otherwise it is retried after the wait
        db.prepare("UPDATE campaign_contacts SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'no_answer' END WHERE id = ? AND status = 'calling'")
          .run(campaign.max_attempts, row.id);
      }
    }
  }

  const open = db.prepare(`SELECT COUNT(*) AS n FROM campaign_contacts WHERE campaign_id = ?
    AND (status = 'calling' OR (status IN ('pending','no_answer') AND attempts < ?))`).get(campaignId, campaign.max_attempts).n;
  if (!open) db.prepare("UPDATE campaigns SET status = 'done' WHERE id = ? AND status = 'running'").run(campaignId);
  return reason ? { placed, reason } : { placed };
}

let timer = null, ticking = false;
async function tick() {
  if (ticking || !telephony.configured()) return;
  ticking = true;
  try {
    for (const c of db.prepare("SELECT id FROM campaigns WHERE status = 'running'").all()) {
      try { await dispatch(c.id); } catch (err) { console.warn("[campaign] tick failed:", err.message); }
    }
  } finally { ticking = false; }
}
function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, Number(process.env.CAMPAIGN_TICK_MS || 60 * 1000));
  timer.unref();
}

module.exports = { dryRun, dispatch, tick, progress, startScheduler, inWindow, localHour };
