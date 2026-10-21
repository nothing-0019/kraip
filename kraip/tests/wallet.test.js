// Prepaid wallet, top-ups, refunds, failed payments, low-balance notifications, admin-only pricing.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { boot, sleep, waitFor, startStream, plays, checker } = require("./harness");

const SECRET = "razorpay-webhook-test";
const sign = (body) => crypto.createHmac("sha256", SECRET).update(body).digest("hex");

test("prepaid wallet, refunds, alerts, admin pricing", { timeout: 150000 }, async (t) => {
  const T = await boot({ BILLING_MODE: "prepaid", MAX_CALL_SECONDS: "60", LOW_BALANCE_INR: "20", ADMIN_EMAILS: "admin@test.com",
    RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_test_secret", RAZORPAY_WEBHOOK_SECRET: SECRET });
  t.after(() => T.stop());
  const ok = checker();
  const api = T.api;
  const admin = await T.signup("admin@test.com"), u = await T.signup("cust@test.com"), other = await T.signup("other@test.com");
  const biz = (await api("/api/businesses", { method: "POST", token: u, body: { name: "Sunrise Dental" } })).data;
  const emp = (await api("/api/employees", { method: "POST", token: u, body: { business_id: biz.id, name: "Aria" } })).data;
  await api(`/api/employees/${emp.id}/activate`, { method: "POST", token: u });
  const path = (await api("/api/system", { token: u })).data.webhook_paths[emp.id];
  const wallet = async () => (await api(`/api/billing/wallet?business_id=${biz.id}`, { token: u })).data;
  const answer = (uuid) => T.hook(path, { CallUUID: uuid, From: "+919800000001" });
  const run = async (xml, uuid) => { const ws = await T.connect(T.streamUrl(xml)); startStream(ws, uuid); await waitFor(() => plays(ws) >= 1, 5000); await sleep(1100); ws.close(); };
  const post = (obj) => { const body = JSON.stringify(obj); return fetch(T.base + "/webhooks/razorpay", { method: "POST", headers: { "X-Razorpay-Signature": sign(body) }, body }); };

  // ---------- admin boundary ----------
  ok("a normal customer is not an administrator", (await api("/api/admin/me", { token: u })).data.admin === false && (await api("/api/admin/me", { token: admin })).data.admin === true);
  for (const [m, p, b] of [["GET", "/api/admin/businesses"], ["GET", `/api/admin/pricing/${biz.id}`], ["PUT", `/api/admin/pricing/${biz.id}`, { call_minute_inr: 0 }], ["POST", `/api/admin/wallet/${biz.id}/adjust`, { amount_inr: 1000 }]]) {
    ok(`customers cannot use ${m} ${p}`, (await api(p, { method: m, token: u, body: b })).status === 403);
  }

  // ---------- empty wallet: no calls ----------
  const empty = await answer("W0");
  ok("prepaid with an empty wallet: calls are refused", /<Hangup\/>/.test(empty.text) && !/<Stream/.test(empty.text), empty.text);
  ok("a notification explains why", !!(await waitFor(async () => (await api(`/api/notifications?business_id=${biz.id}`, { token: u })).data.some((n) => n.kind === "limit_reached"), 3000)));

  // ---------- admin credits Rs 12: exactly two simultaneous calls fit (each reserves 1 min x Rs 5) ----------
  const adj = await api(`/api/admin/wallet/${biz.id}/adjust`, { method: "POST", token: admin, body: { amount_inr: 12, note: "welcome credit" } });
  ok("admin credit lands in the wallet and is logged", adj.status === 200 && adj.data.balance_paise === 1200 && (await api(`/api/audit?business_id=${biz.id}`, { token: u })).data.some((a) => a.action === "wallet.adjusted"), adj.data);
  ok("invalid adjustment rejected", (await api(`/api/admin/wallet/${biz.id}/adjust`, { method: "POST", token: admin, body: { amount_inr: "abc" } })).status === 400);
  const burst = await Promise.all(Array.from({ length: 4 }, (_, i) => answer(`WB-${i}`)));
  const allowed = burst.filter((r) => /<Stream/.test(r.text));
  ok("4 simultaneous calls on Rs 12: exactly 2 are let in (wallet can never go negative)", allowed.length === 2, allowed.length);
  await Promise.all(allowed.map((r, i) => run(r.text, `WB-${i}`)));
  await waitFor(async () => (await wallet()).balance_paise === 500, 6000);
  const w1 = await wallet();
  ok("usage is deducted automatically (2 calls x 1 min x Rs 3.5)", w1.balance_paise === 500 && w1.charges_paise === 700 && w1.credits_paise === 1200, w1);
  ok("low-balance notification created (balance under Rs 20)", (await api(`/api/notifications?business_id=${biz.id}`, { token: u })).data.some((n) => n.kind === "low_balance" || n.kind === "limit_reached"));
  const one = await answer("W-LAST");
  ok("with exactly one call's worth left, one more call is accepted", /<Stream/.test(one.text));
  await run(one.text, "W-LAST");
  await waitFor(async () => (await wallet()).balance_paise === 150, 6000);
  ok("then the wallet is too low for another", /<Hangup\/>/.test((await answer("W-NO")).text));

  // ---------- top-up through Razorpay ----------
  ok("top-up outside the allowed range is rejected", (await api("/api/billing/topup", { method: "POST", token: u, body: { business_id: biz.id, amount_inr: 5 } })).status === 400);
  const top = await api("/api/billing/topup", { method: "POST", token: u, body: { business_id: biz.id, amount_inr: 500 } });
  const ref = T.svc.state.razorpay.at(-1);
  ok("top-up creates a payment link for the right amount", top.status === 201 && ref.amount === 50000 && /^top_\d+_/.test(ref.reference_id), { top: top.data, ref });
  const paid = (id, amount = 50000, over = {}) => ({ event: "payment_link.paid", payload: { payment_link: { entity: { reference_id: ref.reference_id, status: "paid" } }, payment: { entity: { id, amount, currency: "INR", ...over } } } });
  await post(paid("pay_T1", 50000, { currency: "USD" }));
  ok("wrong-currency payment ignored", (await wallet()).credits_paise === 1200);
  await post(paid("pay_T1")); await post(paid("pay_T1")); await post(paid("pay_T1"));
  const w2 = await wallet();
  ok("verified top-up credited exactly once (webhook delivered 3 times)", w2.credits_paise === 51200 && w2.balance_paise === 50150 && w2.topups[0].status === "paid", w2);
  const refund = (id, amount) => ({ event: "refund.processed", payload: { refund: { entity: { id, payment_id: "pay_T1", amount } } } });
  await post(refund("rfnd_1", 10000)); await post(refund("rfnd_1", 10000));
  ok("refund debits the wallet once, however often it is delivered", (await wallet()).balance_paise === 40150 && (await wallet()).ledger.some((l) => l.kind === "refund" && l.amount_paise === -10000));
  await post(refund("rfnd_x", 5)); const bogus = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "r9", payment_id: "pay_unknown", amount: 100 } } } });
  ok("refund for an unknown payment changes nothing", (await fetch(T.base + "/webhooks/razorpay", { method: "POST", headers: { "X-Razorpay-Signature": sign(bogus) }, body: bogus })).status === 200 && (await wallet()).balance_paise === 40145);
  const top2 = await api("/api/billing/topup", { method: "POST", token: u, body: { business_id: biz.id, amount_inr: 200 } });
  const ref2 = T.svc.state.razorpay.at(-1).reference_id;
  await post({ event: "payment_link.expired", payload: { payment_link: { entity: { reference_id: ref2 } } } });
  ok("an expired payment link is recorded as expired and credits nothing", (await wallet()).topups[0].status === "expired" && (await wallet()).credits_paise === 51200 - 10000 - 5);
  ok("after top-up calls are accepted again", /<Stream/.test((await answer("W-AFTER")).text));

  // ---------- admin pricing ----------
  const pr = await api(`/api/admin/pricing/${biz.id}`, { method: "PUT", token: admin, body: { call_minute_inr: 2, lead_call_minute_inr: 4, credit_limit_inr: 50 } });
  ok("admin sets per-business rates", pr.status === 200 && pr.data.effective_rates_paise.call_minute === 200 && pr.data.effective_rates_paise.lead_call_minute === 400, pr.data);
  ok("the customer sees their effective rates (read-only)", (await api(`/api/billing/pricing?business_id=${biz.id}`, { token: u })).data.rates_paise.call_minute === 200);
  ok("bad pricing input rejected", (await api(`/api/admin/pricing/${biz.id}`, { method: "PUT", token: admin, body: { call_minute_inr: -1 } })).status === 400 && (await api(`/api/admin/pricing/${biz.id}`, { method: "PUT", token: admin, body: { billing_mode: "free" } })).status === 400);
  ok("pricing changes are in the audit log", (await api(`/api/audit?business_id=${biz.id}`, { token: u })).data.some((a) => a.action === "admin.pricing_changed"));
  const m = new Date().toISOString().slice(0, 7);
  const use = (await api(`/api/billing/usage?business_id=${biz.id}&month=${m}`, { token: u })).data;
  ok("usage summary uses the business's own rate", use.lines.find((l) => l.key === "call_minute").rate_paise === 200, use.lines);
  await api(`/api/admin/pricing/${biz.id}`, { method: "PUT", token: admin, body: { billing_mode: "postpaid", credit_limit_inr: 0 } });
  ok("admin can switch one business to postpaid", (await api(`/api/billing/status?business_id=${biz.id}`, { token: u })).data.mode === "postpaid");
  await api(`/api/admin/pricing/${biz.id}`, { method: "PUT", token: admin, body: { call_minute_inr: null } });
  ok("clearing an override restores the default rate", (await api(`/api/billing/pricing?business_id=${biz.id}`, { token: u })).data.rates_paise.call_minute === 350);
  ok("another customer cannot see this wallet", (await api(`/api/billing/wallet?business_id=${biz.id}`, { token: other })).status === 404 && (await api(`/api/billing/topup`, { method: "POST", token: other, body: { business_id: biz.id, amount_inr: 500 } })).status === 404);
  ok("admin list shows every business with its balance", (await api("/api/admin/businesses", { token: admin })).data.some((b) => b.id === biz.id && b.owner_email === "cust@test.com"));
  ok.done(assert);
});
