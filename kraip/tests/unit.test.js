// In-process unit tests on a throwaway database: billing idempotency, claims, auth helpers, audio, parsing.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kraip-unit-"));
process.env.KRAIP_DB = path.join(dir, "unit.db");
process.env.PLIVO_AUTH_TOKEN = "unit-plivo-token"; process.env.PUBLIC_URL = "http://kraip.test";
process.env.PLIVO_AUTH_ID = "AUTH123"; process.env.PLIVO_PHONE_NUMBER = "+912200000000"; process.env.SARVAM_API_KEY = "k";
process.env.PHONE_PROVIDER = "plivo"; process.env.RETRY_MINUTES = "0";

const db = require("../db");
const auth = require("../lib/auth");
const usage = require("../lib/usage");
const calls = require("../services/calls");
const billing = require("../services/billing");
const plivo = require("../services/plivo");
const campaigns = require("../services/campaigns");
const audio = require("../lib/audio");
const costs = require("../lib/costs");
const { normalizePhone } = require("../lib/phone");
const { isPrivateIp, rateLimit, createGate } = require("../lib/security");
const { phrases, languageName, sarvamLanguage } = require("../lib/phrases");
const voiceMock = require("./mocks/voice");

test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function seed(email = `u${crypto.randomBytes(3).toString("hex")}@t.com`) {
  const { user } = auth.signup({ email, password: "password123" });
  const biz = Number(db.prepare("INSERT INTO businesses (owner_id, name) VALUES (?, 'B')").run(user.id).lastInsertRowid);
  const emp = Number(db.prepare("INSERT INTO employees (business_id, name, status) VALUES (?, 'E', 'active')").run(biz).lastInsertRowid);
  return { user, biz, emp };
}
const conv = (emp, sid) => Number(db.prepare("INSERT INTO conversations (employee_id, channel, call_sid) VALUES (?, 'phone', ?)").run(emp, sid || null).lastInsertRowid);
const rowsFor = (id) => db.prepare("SELECT * FROM usage_events WHERE type = 'call_seconds' AND json_extract(meta, '$.conversation_id') = ?").all(id);

test("finalizeCall records usage once, however many times it is called", async () => {
  const { biz, emp } = seed(); const c = conv(emp, "X1");
  assert.equal(calls.finalizeCall(c, 61, "stream"), true);
  for (let i = 0; i < 5; i++) assert.equal(calls.finalizeCall(c, 61, "stream"), false);
  assert.equal(rowsFor(c).length, 1);
  assert.equal(rowsFor(c)[0].quantity, 61);
  // a carrier figure corrects the stream time once; repeats change nothing
  assert.equal(calls.finalizeCall(c, 130, "provider"), true);
  assert.equal(calls.finalizeCall(c, 130, "provider"), false);
  assert.equal(calls.finalizeCall(c, 9999, "provider"), false, "after the carrier figure is in, no later report may change it");
  assert.equal(rowsFor(c).length, 1); assert.equal(rowsFor(c)[0].quantity, 130);
  // transferred calls are never corrected by the carrier (it includes the human's talk time)
  const t = conv(emp, "X2");
  calls.finalizeCall(t, 40, "stream", { transferred: true });
  assert.equal(calls.finalizeCall(t, 600, "provider"), false);
  assert.equal(rowsFor(t)[0].quantity, 40);
  // absurd, negative or non-numeric durations are clamped
  const a = conv(emp, "X3"), b = conv(emp, "X4"), n = conv(emp, "X5");
  calls.finalizeCall(a, 10 ** 9, "provider"); calls.finalizeCall(b, -50, "stream"); calls.finalizeCall(n, "abc", "stream");
  assert.equal(rowsFor(a)[0].quantity, 4 * 3600); assert.equal(rowsFor(b)[0].quantity, 0); assert.equal(rowsFor(n)[0].quantity, 0);
  assert.equal(calls.finalizeCall(999999, 5), false, "unknown conversation");
});

test("the database itself refuses a second call_seconds record for a conversation", () => {
  const { biz, emp } = seed(); const c = conv(emp);
  usage.record(biz, "call_seconds", 10, { conversation_id: c });
  assert.throws(() => usage.record(biz, "call_seconds", 10, { conversation_id: c }), /UNIQUE/);
  usage.record(biz, "message", 1); usage.record(biz, "message", 1);   // other event types are unaffected
});

test("two conversations cannot share one call id within an employee", () => {
  const { emp } = seed(); conv(emp, "DUP");
  assert.throws(() => conv(emp, "DUP"), /UNIQUE/);
});

test("monthlyCharges (SQL) agrees with summarize (JS) to the paisa", () => {
  const { biz, emp } = seed();
  const plan = [[59, true], [60, false], [61, true], [1, false], [125, false], [0, true]];
  for (const [secs, lead] of plan) { const c = conv(emp); usage.record(biz, "call_seconds", secs, { conversation_id: c, lead_call: lead }); }
  usage.record(biz, "research", 3); usage.record(biz, "qualified_lead", 2); usage.record(biz, "message", 7);
  const month = new Date().toISOString().slice(0, 7);
  const sql = usage.monthlyCharges(biz).find((m) => m.period === month).charge_paise;
  assert.equal(sql, usage.summarize(biz, month).total_paise);
  assert.equal(sql, (1 + 2) * 500 + (1 + 3 + 1) * 350 + 3 * 200, "minutes: lead 1+2, normal 1+3(125s)+... plus research");
});

test("spending limit: reservation + exposure, atomic with the action", () => {
  process.env.CREDIT_LIMIT_INR = "10"; process.env.MAX_CALL_SECONDS = "60";
  try {
    const { biz, emp } = seed();
    let made = 0, refused = 0;
    for (let i = 0; i < 6; i++) {
      try { billing.withinLimit(biz, () => conv(emp, `L${i}`)); made++; } catch (e) { assert.equal(e.status, 402); refused++; }
    }
    assert.deepEqual([made, refused], [2, 4]);
    assert.equal(billing.spendStatus(biz).reserved_paise, 1000);
    delete process.env.CREDIT_LIMIT_INR;
    assert.equal(billing.spendStatus(biz).ok, true, "no limit configured = no limit");
  } finally { delete process.env.CREDIT_LIMIT_INR; delete process.env.MAX_CALL_SECONDS; }
});

test("payment webhook: idempotent, amount from payload, ignores junk", () => {
  const { biz, emp } = seed();
  for (let i = 0; i < 3; i++) { const c = conv(emp); usage.record(biz, "call_seconds", 60, { conversation_id: c, lead_call: false }); }
  const { invoice } = billing.createInvoice(biz);
  assert.equal(invoice.amount_paise, 1050);
  const ev = (id, amount, extra = {}) => ({ event: "payment_link.paid", payload: { payment_link: { entity: { reference_id: `inv_${invoice.id}_abc`, status: "paid" } }, payment: { entity: { id, amount, currency: "INR", ...extra } } } });
  assert.equal(billing.handleWebhook(ev("p1", 1050)), true);
  assert.equal(billing.handleWebhook(ev("p1", 1050)), false);
  assert.equal(billing.handleWebhook(ev("p2", -5)), false);
  assert.equal(billing.handleWebhook(ev("p3", 10.5)), false);
  assert.equal(billing.handleWebhook(ev("", 100)), false);
  assert.equal(billing.handleWebhook({ event: "payment.failed" }), false);
  assert.equal(billing.handleWebhook(null), false);
  const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoice.id);
  assert.equal(row.paid_paise, 1050); assert.equal(row.status, "paid");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments WHERE invoice_id = ?").get(invoice.id).n, 1);
  assert.throws(() => billing.createInvoice(biz, "2026-99"), /period/);
});

test("Plivo authentication: per-employee keys, V3 signature, nonce replay", () => {
  const req = (url, k, headers = {}, body = {}) => ({ query: k ? { k } : {}, headers, method: "POST", originalUrl: url, body });
  const k1 = plivo.webhookKey(1), k2 = plivo.webhookKey(2);
  assert.notEqual(k1, k2);
  assert.equal(plivo.authenticate(req("/plivo/1/answer"), 1).ok, false, "no credentials");
  assert.equal(plivo.authenticate(req("/plivo/1/answer", k1), 1).ok, true);
  assert.equal(plivo.authenticate(req("/plivo/1/answer", k1), 1).signed, false, "a key alone is never 'signed'");
  assert.equal(plivo.authenticate(req("/plivo/2/answer", k1), 2).ok, false, "employee 1's key on employee 2");
  assert.equal(plivo.authenticate(req("/plivo/1/answer", ["a"]), 1).ok, false, "non-string key");
  const body = { CallUUID: "u", Duration: "5" }, url = "/plivo/1/hangup?k=" + k1;
  const sig = (nonce, token = process.env.PLIVO_AUTH_TOKEN) => crypto.createHmac("sha256", token).update(`http://kraip.test${url}.CallUUIDuDuration5.${nonce}`).digest("base64");
  const good = req(url, k1, { "x-plivo-signature-v3": sig("n1"), "x-plivo-signature-v3-nonce": "n1" }, body);
  assert.deepEqual(plivo.authenticate(good, 1), { ok: true, signed: true });
  assert.equal(plivo.authenticate(good, 1).signed, false, "replaying the same signed request is not accepted as signed");
  const tampered = req(url, null, { "x-plivo-signature-v3": sig("n2"), "x-plivo-signature-v3-nonce": "n2" }, { ...body, Duration: "9999" });
  assert.equal(plivo.authenticate(tampered, 1).ok, false, "changing the body breaks the signature");
  const wrong = req(url, null, { "x-plivo-signature-v3": sig("n3", "other-token"), "x-plivo-signature-v3-nonce": "n3" }, body);
  assert.equal(plivo.authenticate(wrong, 1).ok, false);
});

test("stream tokens bind the conversation and expire", () => {
  const u = new URL(plivo.streamUrl(42).replace(/^ws/, "http")), p = (n) => u.searchParams.get(n);
  assert.equal(plivo.verifyStreamToken(42, Number(p("exp")), p("sig")), true);
  assert.equal(plivo.verifyStreamToken(43, Number(p("exp")), p("sig")), false);
  assert.equal(plivo.verifyStreamToken(42, Number(p("exp")) + 1000, p("sig")), false);
  assert.equal(plivo.verifyStreamToken(42, 1, p("sig")), false);
  assert.equal(plivo.verifyStreamToken(42, Number(p("exp")), "x"), false);
  assert.equal(plivo.verifyStreamToken(0, 0, ""), false);
});

test("sessions: expired ones do not authenticate and are purged", () => {
  const { user } = seed();
  const token = auth.login({ email: user.email, password: "password123" }).token;
  const run = (t) => { let status = null, called = false; auth.requireAuth({ headers: { authorization: `Bearer ${t}` } }, { status(s) { status = s; return { json() {} }; } }, () => { called = true; }); return { status, called }; };
  assert.equal(run(token).called, true);
  db.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1000);
  assert.deepEqual(run(token), { status: 401, called: false });
  assert.ok(auth.purgeExpiredSessions() >= 1);
});

test("campaign claim: atomic, re-checks consent/opt-out/attempts, one call per contact", async () => {
  const vox = await voiceMock.start();
  process.env.PLIVO_API_BASE = `http://127.0.0.1:${vox.port}`;
  try {
    const { biz, emp } = seed();
    const contact = (phone, consent = 1, opted = 0) => Number(db.prepare("INSERT INTO contacts (business_id, phone, consent, opted_out) VALUES (?, ?, ?, ?)").run(biz, phone, consent, opted).lastInsertRowid);
    const camp = Number(db.prepare("INSERT INTO campaigns (business_id, employee_id, name, status, max_attempts, window_start, window_end) VALUES (?, ?, 'c', 'running', 2, 0, 24)").run(biz, emp).lastInsertRowid);
    const enrol = (cid) => Number(db.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES (?, ?)").run(camp, cid).lastInsertRowid);
    const dialled = (n) => vox.state.plivo.filter((p) => p.method === "POST" && !p.uuid && p.body?.to === n).length;

    const good = enrol(contact("+919111111111")), optedAfter = enrol(contact("+919222222222")), noConsentAfter = enrol(contact("+919333333333"));
    db.prepare("UPDATE contacts SET opted_out = 1 WHERE phone = '+919222222222'").run();       // opt-out lands after enrolment
    db.prepare("UPDATE contacts SET consent = 0 WHERE phone = '+919333333333'").run();         // consent withdrawn
    const results = await Promise.all([1, 2, 3, 4].map(() => campaigns.dispatch(camp, 10)));
    assert.equal(dialled("+919111111111"), 1, "four concurrent dispatches = one call");
    assert.equal(dialled("+919222222222"), 0, "opted-out contact never dialled");
    assert.equal(dialled("+919333333333"), 0, "contact without consent never dialled");
    assert.equal(results.filter((r) => r.reason === "already_running").length, 3, "overlapping dispatches in one process are skipped");
    assert.equal(db.prepare("SELECT status FROM campaign_contacts WHERE id = ?").get(optedAfter).status, "skipped");
    assert.equal(db.prepare("SELECT status FROM campaign_contacts WHERE id = ?").get(noConsentAfter).status, "skipped");
    assert.equal(db.prepare("SELECT attempts, status FROM campaign_contacts WHERE id = ?").get(good).attempts, 1);

    // while a call to a person is in progress, another campaign row for the same person cannot start a second call
    const camp2 = Number(db.prepare("INSERT INTO campaigns (business_id, employee_id, name, status, window_start, window_end) VALUES (?, ?, 'c2', 'running', 0, 24)").run(biz, emp).lastInsertRowid);
    db.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id) SELECT ?, contact_id FROM campaign_contacts WHERE id = ?").run(camp2, good);
    await campaigns.dispatch(camp2, 10);
    assert.equal(dialled("+919111111111"), 1, "same person is never on two calls at once");

    // retry limit: unanswered twice, then no third call
    db.prepare("UPDATE campaign_contacts SET status = 'no_answer' WHERE id = ?").run(good);
    await campaigns.dispatch(camp, 10);
    assert.equal(dialled("+919111111111"), 2);
    db.prepare("UPDATE campaign_contacts SET status = 'no_answer' WHERE id = ?").run(good);
    await campaigns.dispatch(camp, 10);
    assert.equal(dialled("+919111111111"), 2, "max_attempts (2) is a hard limit");
    assert.equal(db.prepare("SELECT status FROM campaigns WHERE id = ?").get(camp).status, "done");

    // retry wait is honoured
    process.env.RETRY_MINUTES = "120";
    const camp3 = Number(db.prepare("INSERT INTO campaigns (business_id, employee_id, name, status, max_attempts, window_start, window_end) VALUES (?, ?, 'c3', 'running', 3, 0, 24)").run(biz, emp).lastInsertRowid);
    const slow = Number(db.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES (?, ?)").run(camp3, contact("+919444444444")).lastInsertRowid);
    await campaigns.dispatch(camp3, 10);
    db.prepare("UPDATE campaign_contacts SET status = 'no_answer' WHERE id = ?").run(slow);
    await campaigns.dispatch(camp3, 10);
    assert.equal(dialled("+919444444444"), 1, "no retry before RETRY_MINUTES has passed");
    process.env.RETRY_MINUTES = "0";

    // paused campaigns place nothing
    const camp4 = Number(db.prepare("INSERT INTO campaigns (business_id, employee_id, name, status, window_start, window_end) VALUES (?, ?, 'c4', 'paused', 0, 24)").run(biz, emp).lastInsertRowid);
    db.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES (?, ?)").run(camp4, contact("+919555555555"));
    assert.deepEqual(await campaigns.dispatch(camp4, 10), { placed: 0 });
    assert.equal(dialled("+919555555555"), 0);
  } finally { await vox.close(); }
});

test("phone, SSRF, rate limiter, gate", async () => {
  assert.equal(normalizePhone("98765 43210"), "+919876543210"); assert.equal(normalizePhone("+1 (415) 555-0100"), "+14155550100");
  assert.equal(normalizePhone("12"), null); assert.equal(normalizePhone(null), null); assert.equal(normalizePhone("1".repeat(20)), null);
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0", "not-an-ip"]) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
  const rl = rateLimit({ max: 2, windowMs: 60000 }), out = [];
  for (let i = 0; i < 4; i++) rl({ ip: "1.1.1.1" }, { setHeader() {}, status(s) { out.push(s); return { json() {} }; } }, () => out.push(200));
  assert.deepEqual(out, [200, 200, 429, 429]);
  let active = 0, peak = 0; const gate = createGate(2);
  await Promise.all(Array.from({ length: 6 }, () => gate(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; })));
  assert.equal(peak, 2);
});

test("audio, costs, phrases", () => {
  const pcm = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
  const round = audio.mulawDecode(audio.mulawEncode(pcm));
  let err = 0; for (let i = 0; i < 1600; i++) err = Math.max(err, Math.abs(round.readInt16LE(i * 2) - pcm.readInt16LE(i * 2)));
  assert.ok(err < 600, `mu-law error ${err}`);
  const wav = audio.wavToPcm(audio.pcmToWav(pcm, 16000)); assert.ok(wav.pcm.equals(pcm)); assert.equal(wav.sampleRate, 16000);
  assert.equal(audio.wavToPcm(Buffer.from("not a wav file at all")), null);
  assert.equal(new audio.Downsample2().push(pcm).length, pcm.length / 2); assert.equal(new audio.Upsample2().push(pcm.subarray(0, 1600)).length, 3200);
  assert.equal(audio.resample(pcm, 16000, 16000), pcm);
  const c = costs.estimate({ seconds: 60, ttsChars: 300, llmTurns: 6 }); assert.equal(Math.round(c.total_paise), 238);
  assert.equal(costs.estimate({ seconds: 61 }).telephony_paise, 76, "telephony rounds up per minute");
  for (const l of ["en", "hi", "ta", "te", "kn", "xx"]) { const p = phrases(l); assert.ok(p.inbound("A", "B") && p.outbound("A", "B") && p.stillThere && p.goodbye && p.handoff && p.optOut && p.error && p.unavailable); }
  assert.match(phrases("en-IN").outbound("A", "B"), /AI assistant/); assert.match(phrases("hi").outbound("A", "B"), /एआई/);
  assert.equal(languageName("ta-IN"), "Tamil"); assert.equal(sarvamLanguage("en"), "en-IN"); assert.equal(sarvamLanguage("hi-IN"), "hi-IN");
});
