// Spending limit (concurrency-safe), payment webhooks (fail closed, idempotent, amount from the signed payload).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { boot, sleep, waitFor, startStream, plays, checker } = require("./harness");

const SECRET = "razorpay-webhook-test";
const sign = (body, secret = SECRET) => crypto.createHmac("sha256", secret).update(body).digest("hex");

test("billing: spending limit and payment webhooks", { timeout: 120000 }, async (t) => {
  const T = await boot({ CREDIT_LIMIT_INR: "10", MAX_CALL_SECONDS: "60", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_test_secret", RAZORPAY_WEBHOOK_SECRET: SECRET });
  t.after(() => T.stop());
  const ok = checker();
  const api = T.api;
  const u = await T.signup("b@test.com");
  const biz = (await api("/api/businesses", { method: "POST", token: u, body: { name: "Sunrise Dental" } })).data;
  const emp = (await api("/api/employees", { method: "POST", token: u, body: { business_id: biz.id, name: "Aria" } })).data;
  await api(`/api/employees/${emp.id}/activate`, { method: "POST", token: u });
  const path = (await api("/api/system", { token: u })).data.webhook_paths[emp.id];
  const month = new Date().toISOString().slice(0, 7);
  const status = async () => (await api(`/api/billing/status?business_id=${biz.id}`, { token: u })).data;
  const answer = (uuid) => T.hook(path, { CallUUID: uuid, From: "+919800000001" });
  const run = async (xml, uuid, ms = 1100) => { const ws = await T.connect(T.streamUrl(xml)); startStream(ws, uuid); await waitFor(() => plays(ws) >= 1, 5000); await sleep(ms); ws.close(); };

  // limit INR 10 and one call reserves 1 min x Rs 5: simultaneous calls cannot all get in
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => answer(`BURST-${i}`)));
  const allowed = burst.filter((r) => /<Stream/.test(r.text)), refused = burst.filter((r) => /<Hangup\/>/.test(r.text) && !/<Stream/.test(r.text));
  ok("8 simultaneous calls: only the ones the limit can cover are let in", allowed.length === 2 && refused.length === 6, { allowed: allowed.length, refused: refused.length });
  ok("the same call delivered twice does not use a second slot", (await answer("BURST-0")).text.includes("<Stream"));
  await Promise.all(allowed.map((r, i) => run(r.text, `BURST-${i}`)));
  await waitFor(async () => (await status()).exposure_paise === 700, 6000);
  const s1 = await status();
  ok("exposure counts the usage (2 calls x 1 min x Rs 3.5) and nothing is reserved once calls end", s1.exposure_paise === 700 && s1.reserved_paise === 0 && s1.ok === true, s1);

  const third = await answer("THIRD");
  ok("a call within the remaining limit is accepted", /<Stream/.test(third.text));
  await run(third.text, "THIRD");
  await waitFor(async () => (await status()).exposure_paise === 1050, 6000);
  const s2 = await status();
  ok("limit reached: exposure Rs 10.50 is over Rs 10", s2.ok === false && s2.exposure_paise === 1050, s2);
  const blocked = await answer("FOURTH");
  ok("over the limit: new inbound calls are refused", !/<Stream/.test(blocked.text) && /<Hangup\/>/.test(blocked.text), blocked.text);
  await api("/api/contacts/import", { method: "POST", token: u, body: { business_id: biz.id, csv: "Meena,9123456780,yes,signup form" } });
  const camp = (await api("/api/campaigns", { method: "POST", token: u, body: { business_id: biz.id, employee_id: emp.id, name: "Offer", window_start: 0, window_end: 24 } })).data;
  const cs = await api(`/api/campaigns/${camp.id}/start`, { method: "POST", token: u });
  ok("over the limit: campaigns cannot start", cs.status === 402, cs);

  // ---------- paying brings the business back under the limit ----------
  const inv = (await api("/api/billing/invoice", { method: "POST", token: u, body: { business_id: biz.id } })).data.invoice;
  ok("invoice total equals metered usage", inv.amount_paise === 1050 && inv.due_paise === 1050 && inv.status === "open", inv);
  await api(`/api/billing/invoices/${inv.id}/pay-link`, { method: "POST", token: u });
  const refId = T.svc.state.razorpay.at(-1).reference_id;
  const evt = (over = {}) => JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { reference_id: refId, status: "paid", ...over.link } }, payment: { entity: { id: "pay_A", amount: 1050, currency: "INR", ...over.pay } } } });
  const post = (body, sig = sign(body), extra = {}) => fetch(T.base + "/webhooks/razorpay", { method: "POST", headers: { "X-Razorpay-Signature": sig, ...extra }, body });
  const invoice = async () => (await api(`/api/billing/invoices?business_id=${biz.id}`, { token: u })).data[0];

  ok("webhook with a bad signature is refused and changes nothing", (await post(evt(), "deadbeef")).status === 400 && (await invoice()).paid_paise === 0);
  ok("a payment in the wrong currency is ignored", (await post(evt({ pay: { id: "pay_USD", currency: "USD" } }))).status === 200 && (await invoice()).paid_paise === 0);
  ok("an event whose payment link is not paid is ignored", (await post(evt({ link: { status: "created" }, pay: { id: "pay_X" } }))).status === 200 && (await invoice()).paid_paise === 0);
  ok("an unknown invoice reference is ignored", (await post(evt({ link: { reference_id: "inv_999999" }, pay: { id: "pay_Y" } }))).status === 200 && (await invoice()).paid_paise === 0);
  const part = await post(evt({ pay: { id: "pay_PART", amount: 500 } }));
  let i1 = await invoice();
  ok("a partial payment is recorded but does not mark the invoice paid", part.status === 200 && i1.paid_paise === 500 && i1.status === "open", i1);
  const full = await post(evt({ pay: { id: "pay_REST", amount: 550 } }));
  i1 = await invoice();
  ok("the remaining payment completes it", full.status === 200 && i1.paid_paise === 1050 && i1.status === "paid", i1);
  await post(evt({ pay: { id: "pay_REST", amount: 550 } })); await post(evt({ pay: { id: "pay_REST", amount: 550 } }));
  ok("redelivered webhooks are never counted twice", (await invoice()).paid_paise === 1050);
  const s3 = await status();
  ok("after payment the business is under its limit again", s3.ok === true && s3.exposure_paise === 0, s3);
  const again = await answer("AFTER-PAY");
  ok("calls are accepted again after payment", /<Stream/.test(again.text));

  // usage after a paid invoice in the same month is still billed (not silently free)
  await run(again.text, "AFTER-PAY");
  await waitFor(async () => (await status()).exposure_paise === 350, 6000);
  const re = (await api("/api/billing/invoice", { method: "POST", token: u, body: { business_id: biz.id } })).data.invoice;
  ok("usage after payment reopens the invoice for just the new amount", re.status === "open" && re.amount_paise === 1400 && re.due_paise === 350, re);

  // ---------- payments cannot be forged through the API ----------
  ok("there is no API for a client to set paid status or amount", (await api(`/api/billing/invoices/${inv.id}`, { method: "PUT", token: u, body: { status: "paid" } })).status === 404);
  ok("invoice month is validated", (await api("/api/billing/invoice", { method: "POST", token: u, body: { business_id: biz.id, month: "2026-13" } })).status === 400);
  ok.done(assert);
});

test("billing: webhooks fail closed when the secret is not configured", { timeout: 60000 }, async (t) => {
  const T = await boot({ RAZORPAY_WEBHOOK_SECRET: null, TWILIO_AUTH_TOKEN: null, PLIVO_AUTH_TOKEN: null, WEBHOOK_SECRET: null });
  t.after(() => T.stop());
  const body = JSON.stringify({ event: "payment_link.paid", payload: {} });
  const r = await fetch(T.base + "/webhooks/razorpay", { method: "POST", headers: { "X-Razorpay-Signature": sign(body, "") }, body });
  assert.equal(r.status, 503, "Razorpay webhook must refuse everything when no secret is set");
  const r2 = await fetch(T.base + "/webhooks/razorpay", { method: "POST", body });
  assert.equal(r2.status, 503);
  assert.equal((await T.hook("/plivo/1/answer?k=anything", { CallUUID: "x" })).status, 403, "Plivo webhook must refuse when no secret/token exists");
  assert.equal((await T.hook("/plivo/1/answer", { CallUUID: "x" }, { sig: "v3" })).status, 403, "a signature made with a guessed token must not pass");
  assert.equal((await T.twilioHook("/voice/1/incoming", { CallSid: "x" }, { token: "" })).status, 403, "Twilio webhook must refuse when no auth token is set");
  assert.equal((await T.twilioHook("/voice/1/incoming", { CallSid: "x" }, { sign: false })).status, 403);
});
