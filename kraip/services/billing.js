const crypto = require("crypto");
const db = require("../db");
const usage = require("../lib/usage");
const { httpError } = require("../lib/auth");

const month = (d = new Date()) => d.toISOString().slice(0, 7);

// Creates (or refreshes) the invoice for a month from metered usage. amount_paise is the month's total charge,
// paid_paise is what has actually been paid (only ever increased by a verified payment webhook).
function createInvoice(businessId, period = month()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw httpError(400, "period must look like 2026-10");
  return db.transaction(() => {
    const sum = usage.summarize(businessId, period);
    const existing = db.prepare("SELECT * FROM invoices WHERE business_id = ? AND period = ?").get(businessId, period);
    if (existing) {
      const status = existing.paid_paise > 0 && existing.paid_paise >= sum.total_paise ? "paid" : "open";
      db.prepare("UPDATE invoices SET amount_paise = ?, status = ? WHERE id = ?").run(sum.total_paise, status, existing.id);
    } else {
      db.prepare("INSERT OR IGNORE INTO invoices (business_id, period, amount_paise) VALUES (?, ?, ?)").run(businessId, period, sum.total_paise);
    }
    const invoice = db.prepare("SELECT * FROM invoices WHERE business_id = ? AND period = ?").get(businessId, period);
    return { invoice: { ...invoice, due_paise: Math.max(0, invoice.amount_paise - invoice.paid_paise) }, summary: sum };
  }).immediate();
}

// ---------- Spending limits: postpaid credit limit or prepaid wallet ----------
// Mode and limit come from .env (BILLING_MODE, CREDIT_LIMIT_INR) unless an administrator set them for this business.
//  postpaid: exposure = unpaid usage (all months, minus verified payments); new calls are refused once exposure + reservations reach the limit.
//  prepaid:  balance = wallet credits (top-ups, minus refunds, +/- adjustments) minus all usage; a new call needs enough balance to cover
//            its own worst-case cost plus the worst case of every call already in progress, so the wallet can never go negative.
// Each call in progress reserves MAX_CALL_SECONDS at the lead-call rate. Lower MAX_CALL_SECONDS to allow small wallets.
const globalLimitPaise = () => (Number(process.env.CREDIT_LIMIT_INR) > 0 ? Math.round(Number(process.env.CREDIT_LIMIT_INR) * 100) : null);
const maxCallSeconds = () => Number(process.env.MAX_CALL_SECONDS || 900);

function settings(businessId) {
  const o = db.prepare("SELECT billing_mode, credit_limit_paise FROM pricing_overrides WHERE business_id = ?").get(businessId) || {};
  const mode = o.billing_mode || (process.env.BILLING_MODE === "prepaid" ? "prepaid" : "postpaid");
  const limit = o.credit_limit_paise === null || o.credit_limit_paise === undefined ? globalLimitPaise() : (o.credit_limit_paise > 0 ? o.credit_limit_paise : null);
  return { mode, limit };
}
const totalCharges = (businessId) => usage.monthlyCharges(businessId).reduce((s, m) => s + m.charge_paise, 0);
const walletCredits = (businessId) => db.prepare("SELECT COALESCE(SUM(amount_paise), 0) AS n FROM wallet_ledger WHERE business_id = ?").get(businessId).n;
const walletBalance = (businessId) => walletCredits(businessId) - totalCharges(businessId);

function exposurePaise(businessId) {
  const paid = new Map(db.prepare("SELECT period, paid_paise FROM invoices WHERE business_id = ?").all(businessId).map((r) => [r.period, r.paid_paise]));
  return usage.monthlyCharges(businessId).reduce((sum, m) => sum + Math.max(0, m.charge_paise - (paid.get(m.period) || 0)), 0);
}
const oneCallPaise = (businessId) => Math.ceil(maxCallSeconds() / 60) * usage.rates(businessId).lead_call_minute;
function reservedPaise(businessId) {
  const inflight = db.prepare(`
    SELECT COUNT(*) AS n FROM conversations c JOIN employees e ON e.id = c.employee_id
    WHERE e.business_id = ? AND c.channel = 'phone' AND c.duration_seconds IS NULL
      AND c.created_at > datetime('now', ?)`).get(businessId, `-${maxCallSeconds() + 120} seconds`).n;
  return inflight * oneCallPaise(businessId);
}
function spendStatus(businessId) {
  const { mode, limit } = settings(businessId);
  const reserved = reservedPaise(businessId);
  if (mode === "prepaid") {
    const balance = walletBalance(businessId), required = reserved + oneCallPaise(businessId);
    return { ok: balance >= required, mode, balance_paise: balance, reserved_paise: reserved, required_paise: required, limit_paise: null };
  }
  if (limit === null) return { ok: true, mode, limit_paise: null };
  const exposure = exposurePaise(businessId);
  return { ok: exposure + reserved < limit, mode, limit_paise: limit, exposure_paise: exposure, reserved_paise: reserved };
}

// ---------- Notifications (low balance, limit reached) ----------
// At most one per kind per day. Shown in the dashboard; also POSTed to ALERT_WEBHOOK_URL (for example a Slack incoming webhook) if set.
function notify(businessId, kind, message) {
  const key = `${kind}:${new Date().toISOString().slice(0, 10)}`;
  const added = db.prepare("INSERT OR IGNORE INTO notifications (business_id, kind, message, dedupe_key) VALUES (?, ?, ?, ?)").run(businessId, kind, message, key).changes;
  if (added && process.env.ALERT_WEBHOOK_URL) {
    fetch(process.env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `KRAIP: ${message}` }), signal: AbortSignal.timeout(5000) })
      .catch((e) => console.warn("[alert] webhook failed:", e.message));
  }
  return !!added;
}
const inr = (paise) => `Rs ${(paise / 100).toFixed(2)}`;
function checkAlerts(businessId) {
  const st = spendStatus(businessId), name = db.prepare("SELECT name FROM businesses WHERE id = ?").get(businessId)?.name || `business ${businessId}`;
  const lowAt = Math.round(Number(process.env.LOW_BALANCE_INR ?? 100) * 100);
  if (st.mode === "prepaid") {
    if (!st.ok) notify(businessId, "limit_reached", `${name}: wallet too low to take new calls (balance ${inr(st.balance_paise)}). Top up to continue.`);
    else if (st.balance_paise < lowAt) notify(businessId, "low_balance", `${name}: wallet balance is low (${inr(st.balance_paise)}).`);
  } else if (st.limit_paise) {
    if (!st.ok) notify(businessId, "limit_reached", `${name}: spending limit ${inr(st.limit_paise)} reached. Pay the outstanding invoice to continue.`);
    else if (st.exposure_paise >= 0.8 * st.limit_paise) notify(businessId, "low_balance", `${name}: unpaid usage ${inr(st.exposure_paise)} is over 80% of the ${inr(st.limit_paise)} limit.`);
  }
  return st;
}

// Runs fn (for example "create the call's conversation") only if the business may spend. The check and fn share one
// write transaction, so two simultaneous calls cannot both slip through.
function withinLimit(businessId, fn) {
  let refused = null;
  try {
    return db.transaction(() => {
      const st = spendStatus(businessId);
      if (!st.ok) { refused = st; throw Object.assign(httpError(402, st.mode === "prepaid" ? "Wallet balance too low. Top up to continue." : "Spending limit reached. Pay the outstanding invoice to continue."), { spend: st }); }
      return fn();
    }).immediate();
  } finally { if (refused) try { checkAlerts(businessId); } catch { /* alerts are best effort */ } }
}

// ---------- Wallet top-ups ----------
const TOPUP_MIN = () => Math.round(Number(process.env.TOPUP_MIN_INR || 100) * 100), TOPUP_MAX = () => Math.round(Number(process.env.TOPUP_MAX_INR || 100000) * 100);
async function createTopup(businessId, user, amountInr) {
  if (!razorpayConfigured()) throw httpError(501, "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env");
  const amount = Math.round(Number(amountInr) * 100);
  if (!Number.isInteger(amount) || amount < TOPUP_MIN() || amount > TOPUP_MAX()) throw httpError(400, `Top-up must be between Rs ${TOPUP_MIN() / 100} and Rs ${TOPUP_MAX() / 100}`);
  const id = Number(db.prepare("INSERT INTO topups (business_id, amount_paise) VALUES (?, ?)").run(businessId, amount).lastInsertRowid);
  const link = await razorpayLink({ amount, description: "KRAIP wallet top-up", reference: `top_${id}_${Date.now().toString(36)}`, user });
  db.prepare("UPDATE topups SET pay_link = ?, razorpay_link_id = ? WHERE id = ?").run(link.short_url, link.id, id);
  return { id, url: link.short_url, amount_paise: amount };
}
function wallet(businessId) {
  return {
    ...spendStatus(businessId), balance_paise: walletBalance(businessId), credits_paise: walletCredits(businessId), charges_paise: totalCharges(businessId),
    ledger: db.prepare("SELECT id, kind, amount_paise, note, created_at FROM wallet_ledger WHERE business_id = ? ORDER BY id DESC LIMIT 50").all(businessId),
    topups: db.prepare("SELECT id, amount_paise, status, pay_link, created_at FROM topups WHERE business_id = ? ORDER BY id DESC LIMIT 20").all(businessId),
  };
}
function adjustWallet(businessId, amountPaise, note, adminUserId) {
  if (!Number.isInteger(amountPaise) || amountPaise === 0 || Math.abs(amountPaise) > 10_000_000) throw httpError(400, "amount must be a non-zero whole number of paise within Rs 100000");
  db.prepare("INSERT INTO wallet_ledger (business_id, kind, amount_paise, note) VALUES (?, 'adjustment', ?, ?)").run(businessId, amountPaise, String(note || "").slice(0, 200));
  usage.audit(businessId, adminUserId, "wallet.adjusted", `${amountPaise} paise: ${note || ""}`);
  checkAlerts(businessId);
}

function razorpayConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

async function razorpayLink({ amount, description, reference, user }) {
  const base = process.env.RAZORPAY_URL || "https://api.razorpay.com";
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const res = await fetch(`${base}/v1/payment_links`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount, currency: "INR", accept_partial: false, description,
      customer: { name: user.name || user.email, email: user.email },
      notify: { sms: false, email: false },
      reference_id: reference,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Razorpay error: ${data.error?.description || res.status}`);
  return data;
}

async function createPayLink(invoice, user) {
  if (!razorpayConfigured()) throw httpError(501, "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env");
  const due = invoice.amount_paise - (invoice.paid_paise || 0);
  if (invoice.status === "paid" || due <= 0) throw httpError(409, "Invoice already paid");
  if (due < 100) throw httpError(400, "Amount is below the minimum payable amount (INR 1)");
  const data = await razorpayLink({ amount: due, description: `KRAIP usage ${invoice.period}`, reference: `inv_${invoice.id}_${Date.now().toString(36)}`, user });   // unique per link; the invoice id is read back from it
  db.prepare("UPDATE invoices SET pay_link = ?, razorpay_link_id = ? WHERE id = ?").run(data.short_url, data.id, invoice.id);
  return data.short_url;
}

// Razorpay signs the raw request body with your webhook secret
function verifyWebhook(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Applies a verified Razorpay event. Safe to receive any number of times: each payment/refund id is recorded once (UNIQUE),
// and amounts come from the signed payload, never from anything a browser sent.
//  payment_link.paid     invoice payment (reference inv_<id>_...) or wallet top-up (reference top_<id>_...)
//  payment_link.expired / payment_link.cancelled   marks an unpaid top-up
//  refund.processed      reverses an invoice payment or a top-up
function handleWebhook(event, eventId = null) {
  const type = event?.event;
  const payload = event?.payload || {};
  if (type === "payment_link.paid") return handlePaid(payload, eventId);
  if (type === "payment_link.expired" || type === "payment_link.cancelled") {
    const m = String(payload.payment_link?.entity?.reference_id || "").match(/^top_(\d+)_/);
    if (!m) return false;
    return db.prepare("UPDATE topups SET status = ? WHERE id = ? AND status = 'created'").run(type === "payment_link.expired" ? "expired" : "cancelled", Number(m[1])).changes > 0;
  }
  if (type === "refund.processed") return handleRefund(payload.refund?.entity || {});
  return false;
}

function handlePaid(payload, eventId) {
  const link = payload.payment_link?.entity || {}, pay = payload.payment?.entity || {};
  if (link.status && link.status !== "paid") return false;
  const ref = String(link.reference_id || "");
  const paymentId = String(pay.id || eventId || "");
  const amount = Number(pay.amount ?? link.amount_paid);
  const currency = pay.currency || link.currency || "INR";
  if (!paymentId || currency !== "INR" || !Number.isInteger(amount) || amount <= 0) return false;

  const top = ref.match(/^top_(\d+)(?:_|$)/);
  if (top) {
    const done = db.transaction(() => {
      const t = db.prepare("SELECT * FROM topups WHERE id = ?").get(Number(top[1]));
      if (!t) return null;
      const added = db.prepare("INSERT OR IGNORE INTO wallet_ledger (business_id, kind, amount_paise, provider_ref, note) VALUES (?, 'topup', ?, ?, ?)").run(t.business_id, amount, paymentId, `top-up ${t.id}`).changes;
      if (!added) return null;
      db.prepare("UPDATE topups SET status = 'paid' WHERE id = ?").run(t.id);
      usage.audit(t.business_id, null, "wallet.topup", `top-up ${t.id}: ${amount} paise (${paymentId})`);
      return t.business_id;
    }).immediate();
    if (done) { try { checkAlerts(done); } catch { /* best effort */ } }
    return !!done;
  }

  const m = ref.match(/^inv_(\d+)(?:_|$)/);
  if (!m) return false;
  return db.transaction(() => {
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(Number(m[1]));
    if (!inv) return false;
    const added = db.prepare("INSERT OR IGNORE INTO payments (invoice_id, provider_payment_id, amount_paise) VALUES (?, ?, ?)").run(inv.id, paymentId, amount).changes;
    if (!added) return false;   // this payment was already counted
    const paid = inv.paid_paise + amount;
    db.prepare("UPDATE invoices SET paid_paise = ?, paid_at = datetime('now'), status = ? WHERE id = ?").run(paid, paid >= inv.amount_paise ? "paid" : "open", inv.id);
    usage.audit(inv.business_id, null, "invoice.payment", `invoice ${inv.id} ${inv.period}: ${amount} paise (${paymentId})`);
    return true;
  }).immediate();
}

function handleRefund(refund) {
  const refundId = String(refund.id || ""), paymentId = String(refund.payment_id || ""), amount = Number(refund.amount);
  if (!refundId || !paymentId || !Number.isInteger(amount) || amount <= 0) return false;
  return db.transaction(() => {
    const topup = db.prepare("SELECT business_id FROM wallet_ledger WHERE provider_ref = ? AND kind = 'topup'").get(paymentId);
    if (topup) {
      const added = db.prepare("INSERT OR IGNORE INTO wallet_ledger (business_id, kind, amount_paise, provider_ref, note) VALUES (?, 'refund', ?, ?, ?)").run(topup.business_id, -amount, `refund:${refundId}`, `refund of ${paymentId}`).changes;
      if (added) usage.audit(topup.business_id, null, "wallet.refund", `${amount} paise (${refundId})`);
      return !!added;
    }
    const pay = db.prepare("SELECT * FROM payments WHERE provider_payment_id = ?").get(paymentId);
    if (!pay) return false;
    const added = db.prepare("INSERT OR IGNORE INTO payments (invoice_id, provider_payment_id, amount_paise) VALUES (?, ?, ?)").run(pay.invoice_id, `refund:${refundId}`, -amount).changes;
    if (!added) return false;
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(pay.invoice_id);
    const paid = Math.max(0, inv.paid_paise - amount);
    db.prepare("UPDATE invoices SET paid_paise = ?, status = ? WHERE id = ?").run(paid, paid >= inv.amount_paise && paid > 0 ? "paid" : "open", inv.id);
    usage.audit(inv.business_id, null, "invoice.refund", `invoice ${inv.id}: ${amount} paise (${refundId})`);
    return true;
  }).immediate();
}

module.exports = { spendStatus, withinLimit, exposurePaise, checkAlerts, notify, createTopup, wallet, adjustWallet, walletBalance, settings, createInvoice, createPayLink, verifyWebhook, handleWebhook, razorpayConfigured, month };
