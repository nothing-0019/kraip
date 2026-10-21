// End-to-end: accounts, tenant isolation, chat, lead scoring, discovery, consent, campaigns + Twilio, billing, Razorpay.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { boot, checker } = require("./harness");

test("chat, leads, consent, campaigns (Twilio), billing, isolation", { timeout: 120000 }, async (t) => {
  const T = await boot({
    PHONE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "twilio-test-token", TWILIO_PHONE_NUMBER: "+912200000000",
    RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_test_secret", RAZORPAY_WEBHOOK_SECRET: "razorpay-webhook-test",
  });
  t.after(() => T.stop());
  const ck = checker();
  {
  const call = (p, o) => T.api(p, o);
  const twilio = (p, params, o = {}) => T.twilioHook(p, params, o);
  const MOCK = "";
  const getState = async () => T.svc.state;
  const BASE = T.base;
  let pass = 0, fail = 0;
  const ok = ck;
  // ---------- accounts ----------
  const a = (await call("/auth/signup", { method: "POST", body: { email: "a@test.com", password: "password123", name: "Anil" } })).data;
  const b = (await call("/auth/signup", { method: "POST", body: { email: "b@test.com", password: "password123" } })).data;
  ok("signup returns token", !!a.token && !!b.token);
  ok("weak password rejected", (await call("/auth/signup", { method: "POST", body: { email: "c@test.com", password: "short" } })).status === 400);
  ok("duplicate email rejected", (await call("/auth/signup", { method: "POST", body: { email: "a@test.com", password: "password123" } })).status === 409);
  ok("wrong password 401", (await call("/auth/login", { method: "POST", body: { email: "a@test.com", password: "nope-nope" } })).status === 401);
  ok("no token 401", (await call("/api/businesses")).status === 401);
  const A = a.token, B = b.token;

  // ---------- business + employee ----------
  const biz = (await call("/api/businesses", { method: "POST", token: A, body: { name: "Sunrise Dental", services: "Cleaning Rs 800, Whitening Rs 4000", hours: "Mon-Sat 9-6", handoff_number: "+919000000001" } })).data;
  ok("business created", biz.id && biz.version === 1);
  const upd = (await call(`/api/businesses/${biz.id}`, { method: "PUT", token: A, body: { tone: "warm" } })).data;
  ok("business version bumped + history kept", upd.version === 2 && (await call(`/api/businesses/${biz.id}/versions`, { token: A })).data.length === 1);
  const emp = (await call("/api/employees", { method: "POST", token: A, body: { business_id: biz.id, name: "Aria" } })).data;
  ok("employee draft", emp.status === "draft" && emp.language === "en-IN");

  // ---------- public web chat ----------
  ok("draft employee not public", (await call(`/public/chat/${emp.id}/start`, { method: "POST" })).status === 404);
  await call(`/api/employees/${emp.id}/activate`, { method: "POST", token: A });
  const s1 = (await call(`/public/chat/${emp.id}/start`, { method: "POST" })).data;
  ok("public chat starts when active", s1.conversationId && s1.token && /AI assistant/.test(s1.greeting));
  ok("bad token rejected", (await call(`/public/chat/${s1.conversationId}/message`, { method: "POST", body: { token: "x", content: "hi" } })).status === 403);
  const m1 = (await call(`/public/chat/${s1.conversationId}/message`, { method: "POST", body: { token: s1.token, content: "Hi I'm Ravi. I need teeth whitening. My budget is 5000 rupees. Want it by Friday. Call 9876543210" } })).data;
  ok("public reply, no lead data leaked", m1.reply && m1.lead === undefined);
  let leads = (await call(`/api/leads?business_id=${biz.id}`, { token: A })).data;
  ok("lead captured + scored hot", leads.length === 1 && leads[0].score === "hot" && leads[0].phone === "+919876543210", leads);

  // ---------- dedupe ----------
  const c2 = (await call("/api/conversations", { method: "POST", token: A, body: { employee_id: emp.id } })).data;
  await call(`/api/conversations/${c2.id}/messages`, { method: "POST", token: A, body: { content: "Hi I'm Ravi. I need implants. Number 9876543210" } });
  leads = (await call(`/api/leads?business_id=${biz.id}`, { token: A })).data;
  ok("same phone dedupes into one lead", leads.length === 1 && leads[0].conversation_id === c2.id, leads.map((l) => [l.id, l.conversation_id]));

  // ---------- handoff ----------
  const c3 = (await call("/api/conversations", { method: "POST", token: A, body: { employee_id: emp.id } })).data;
  const h = (await call(`/api/conversations/${c3.id}/messages`, { method: "POST", token: A, body: { content: "This is bad, I want a manager" } })).data;
  ok("handoff triggered", h.handoff === true && h.status === "needs_human");
  const h2 = (await call(`/api/conversations/${c3.id}/messages`, { method: "POST", token: A, body: { content: "hello?" } })).data;
  ok("AI silent while human owns it", h2.reply === null);
  await call(`/api/conversations/${c3.id}/human-reply`, { method: "POST", token: A, body: { content: "Hi, this is Anil, how can I help?" } });
  const thread = (await call(`/api/conversations/${c3.id}/messages`, { token: A })).data;
  ok("human reply stored + flagged", thread.messages.some((m) => m.by_human === 1));
  const inbox = (await call(`/api/conversations?business_id=${biz.id}`, { token: A })).data;
  ok("inbox lists needs_human first", inbox[0].status === "needs_human");
  await call(`/api/conversations/${c3.id}/resume-ai`, { method: "POST", token: A });
  const closed = (await call(`/api/conversations/${c3.id}/close`, { method: "POST", token: A })).data;
  ok("close writes a summary", /whitening/.test(closed.summary), closed);

  // ---------- research inside chat + direct ----------
  const c4 = (await call("/api/conversations", { method: "POST", token: A, body: { employee_id: emp.id } })).data;
  const r1 = (await call(`/api/conversations/${c4.id}/messages`, { method: "POST", token: A, body: { content: "Can you compare competitor prices for whitening?" } })).data;
  ok("chat used research with sources", r1.research && r1.research.sources.length >= 3 && /\[1\]/.test(r1.reply), r1);
  const rr = (await call("/api/research", { method: "POST", token: A, body: { business_id: biz.id, query: "whitening price chennai" } })).data;
  ok("research has answer, confidence, dated sources", rr.answer && rr.confidence === "high" && rr.sources.every((s) => s.url && s.retrieved_at), rr);
  ok("robots-blocked page used snippet only", rr.sources.find((s) => s.url.includes("blocked")).fetched === false);
  ok("research history saved", (await call(`/api/research?business_id=${biz.id}`, { token: A })).data.length >= 2);

  // ---------- discovery ----------
  const d = (await call("/api/discovery", { method: "POST", token: A, body: { business_id: biz.id, query: "dental clinics", location: "Chennai", requirements: "whitening, implants" } })).data;
  const pa = d.added.find((p) => p.name.includes("Bright"));
  ok("discovery found prospects", d.added.length >= 2, d);
  ok("published contact extracted, not invented", pa && pa.phone === "+919840011122" && pa.email === "hello@brightsmile.example.in", pa);
  ok("relevance scored from requirements", pa && pa.relevance === 1, pa);
  ok("robots-blocked page: no contacts taken", d.added.find((p) => p.domain === "0.0.0.0")?.phone === null);
  const d2 = (await call("/api/discovery", { method: "POST", token: A, body: { business_id: biz.id, query: "dental clinics", location: "Chennai" } })).data;
  ok("rerun dedupes by domain", d2.added.length === 0 && d2.duplicates.length >= 2);
  const conv = (await call(`/api/prospects/${pa.id}/to-lead`, { method: "POST", token: A })).data;
  ok("prospect -> lead", conv.lead_id && conv.duplicate === false);

  // ---------- consent + contacts ----------
  const imp = (await call("/api/contacts/import", { method: "POST", token: A, body: { business_id: biz.id, csv:
    "name,phone,consent,source\nRavi,9876543210,yes,signup form 12 Oct\nMeena,9123456780,yes,\nKiran,9123456781,no,\nBad,12,yes,x\nSita,9123456782,yes,whatsapp opt-in" } })).data;
  ok("import counts", imp.imported === 4 && imp.with_consent === 2 && imp.no_consent_recorded === 2 && imp.skipped_invalid === 1, imp);
  const contacts = (await call(`/api/contacts?business_id=${biz.id}`, { token: A })).data;
  ok("'yes' without a source is NOT consent", contacts.find((c) => c.name === "Meena").consent === 0);
  const sita = contacts.find((c) => c.name === "Sita");

  // ---------- campaign + Twilio ----------
  const camp = (await call("/api/campaigns", { method: "POST", token: A, body: { business_id: biz.id, employee_id: emp.id, name: "Whitening offer", goal: "book", window_start: 0, window_end: 24, max_attempts: 2 } })).data;
  ok("only consented contacts enrolled", camp.progress.total === 2, camp);
  await call(`/api/contacts/${sita.id}/opt-out`, { method: "POST", token: A });
  const dry = (await call(`/api/campaigns/${camp.id}/dry-run`, { token: A })).data;
  ok("dry run blocks opted-out contact", dry.blocked.some((x) => x.reason === "opted_out") && dry.would_call.length === 1, dry);
  const start = (await call(`/api/campaigns/${camp.id}/start`, { method: "POST", token: A })).data;
  ok("campaign placed 1 call (opted-out skipped)", start.placed === 1 && start.progress.skipped === 1 && start.progress.calling === 1, start);
  const st = T.svc.state;
  ok("Twilio called with auth + callback urls", st.calls.length === 1 && st.calls[0].To === "+919876543210" && /outbound\?cc=/.test(st.calls[0].Url) && /^Basic /.test(st.calls[0].auth), st.calls);
  ok("Twilio call has a provider-side time limit", st.calls[0].TimeLimit === "930", st.calls[0]);
  const ccPath = new URL(st.calls[0].Url).pathname + new URL(st.calls[0].Url).search;

  ok("unsigned webhook rejected", (await twilio(ccPath, { CallSid: "CA0001" }, { sign: false })).status === 403);
  const out = await twilio(ccPath, { CallSid: "CA0001", To: "+919876543210" });
  ok("outbound greeting discloses AI + offers stop", out.status === 200 && /AI assistant/.test(out.text) && /say stop/.test(out.text) && /<Gather/.test(out.text), out.text);
  const convId = Number(/conv=(\d+)/.exec(out.text)[1]);
  const turnPath = `/voice/${emp.id}/turn?conv=${convId}`;
  const t1 = await twilio(turnPath, { CallSid: "CA0001", SpeechResult: "Hi I'm Ravi. I need whitening. My budget is 4500. Want it by Monday." });
  ok("voice turn returns spoken reply + next Gather", /<Say[^>]*>Happy to help/.test(t1.text) && /<Gather/.test(t1.text), t1.text);
  const t2 = await twilio(turnPath, { CallSid: "CA0001", SpeechResult: "please stop calling me" });
  ok("opt-out ends call", /Hangup/.test(t2.text) && /won&apos;t contact you again/.test(t2.text), t2.text);
  const after = (await call(`/api/contacts?business_id=${biz.id}`, { token: A })).data.find((c) => c.name === "Ravi");
  ok("opt-out recorded on contact", after.opted_out === 1);
  const stat = await twilio(`/voice/${emp.id}/status?cc=${ccPath.split("cc=")[1]}`, { CallSid: "CA0001", CallStatus: "completed", CallDuration: "125" });
  ok("status callback ok", stat.status === 204);

  // inbound + handoff by phone
  const inc = await twilio(`/voice/${emp.id}/incoming`, { CallSid: "CA9999", From: "+919811112222" });
  ok("inbound call greets", /Gather/.test(inc.text) && /AI assistant/.test(inc.text));
  const inConv = Number(/conv=(\d+)/.exec(inc.text)[1]);
  const hand = await twilio(`/voice/${emp.id}/turn?conv=${inConv}`, { CallSid: "CA9999", SpeechResult: "let me speak to a manager" });
  ok("phone handoff dials human number", /<Dial>\+919000000001<\/Dial>/.test(hand.text), hand.text);
  await twilio(`/voice/${emp.id}/status`, { CallSid: "CA9999", CallStatus: "completed", CallDuration: "61" });

  // ---------- billing ----------
  const month = new Date().toISOString().slice(0, 7);
  const use = (await call(`/api/billing/usage?business_id=${biz.id}&month=${month}`, { token: A })).data;
  const line = (k) => use.lines.find((l) => l.key === k);
  ok("two-rate billing: lead call 125s=3 min at 5.00, normal call 61s=2 min at 3.50", line("lead_call_minute").quantity === 3 && line("lead_call_minute").amount_paise === 1500 && line("call_minute").quantity === 2 && line("call_minute").amount_paise === 700, [line("lead_call_minute"), line("call_minute")]);
  ok("qualified leads + research metered", line("qualified_lead").quantity >= 1 && line("research").quantity === 2, use.lines);
  ok("total adds up", use.total_paise === use.lines.reduce((s, l) => s + l.amount_paise, 0));
  const inv = (await call("/api/billing/invoice", { method: "POST", token: A, body: { business_id: biz.id } })).data.invoice;
  ok("invoice created from usage", inv.amount_paise === use.total_paise && inv.status === "open");
  const pl = (await call(`/api/billing/invoices/${inv.id}/pay-link`, { method: "POST", token: A })).data;
  ok("Razorpay pay link", pl.url === "https://rzp.io/i/test1");
  const rz = T.svc.state.razorpay[0];
  ok("Razorpay got paise amount + reference", rz.amount === inv.amount_paise && /^inv_\d+_[a-z0-9]+$/.test(rz.reference_id) && rz.reference_id.startsWith(`inv_${inv.id}_`), rz);
  const refId = rz.reference_id;
  const mkEvt = (payId, amount) => JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { reference_id: refId, status: "paid" } }, payment: { entity: { id: payId, amount, currency: "INR" } } } });
  const evt = mkEvt("pay_TEST1", inv.amount_paise);
  const badWh = await fetch(BASE + "/webhooks/razorpay", { method: "POST", headers: { "X-Razorpay-Signature": "bad" }, body: evt });
  ok("bad webhook signature rejected", badWh.status === 400);
  const noSig = await fetch(BASE + "/webhooks/razorpay", { method: "POST", body: evt });
  ok("missing webhook signature rejected", noSig.status === 400);
  const goodSig = crypto.createHmac("sha256", "razorpay-webhook-test").update(evt).digest("hex");
  const goodWh = await fetch(BASE + "/webhooks/razorpay", { method: "POST", headers: { "X-Razorpay-Signature": goodSig }, body: evt });
  const invAfter = (await call(`/api/billing/invoices?business_id=${biz.id}`, { token: A })).data[0];
  ok("valid webhook marks invoice paid with the signed amount", goodWh.status === 200 && invAfter.status === "paid" && invAfter.paid_paise === inv.amount_paise, invAfter);
  await fetch(BASE + "/webhooks/razorpay", { method: "POST", headers: { "X-Razorpay-Signature": goodSig }, body: evt });
  ok("the same webhook delivered again is not counted twice", (await call(`/api/billing/invoices?business_id=${biz.id}`, { token: A })).data[0].paid_paise === inv.amount_paise);
  const under = mkEvt("pay_TEST2", 100), underSig = crypto.createHmac("sha256", "razorpay-webhook-test").update(under).digest("hex");
  await fetch(BASE + "/webhooks/razorpay", { method: "POST", headers: { "X-Razorpay-Signature": underSig }, body: under });
  ok("a further payment is added to the invoice (still paid)", (await call(`/api/billing/invoices?business_id=${biz.id}`, { token: A })).data[0].paid_paise === inv.amount_paise + 100);

  // ---------- CSV injection + fine-tune export ----------
  const c5 = (await call("/api/conversations", { method: "POST", token: A, body: { employee_id: emp.id } })).data;
  await call(`/api/conversations/${c5.id}/messages`, { method: "POST", token: A, body: { content: "Hi I'm =HYPERLINK. I need a cleaning. Call 9555555555" } });
  const csv = (await call(`/api/leads.csv?business_id=${biz.id}`, { token: A })).text;
  ok("CSV formula injection neutralised", !/"=HYPERLINK/.test(csv) && /"'=HYPERLINK/.test(csv), csv.slice(0, 400));
  const mm = (await call(`/api/conversations/${c5.id}/messages`, { token: A })).data.messages.find((m) => m.role === "assistant");
  await call(`/api/messages/${mm.id}/rating`, { method: "POST", token: A, body: { rating: 1 } });
  const ft = (await call(`/api/export/finetune.jsonl?business_id=${biz.id}`, { token: A })).text;
  ok("fine-tune export has rated reply", typeof ft === "string" && ft.includes('"role":"assistant"'));

  // ---------- tenant isolation (user B vs user A's data) ----------
  const bCalls = {
    "leads": `/api/leads?business_id=${biz.id}`, "employees": `/api/employees?business_id=${biz.id}`, "contacts": `/api/contacts?business_id=${biz.id}`,
    "usage": `/api/billing/usage?business_id=${biz.id}`, "audit": `/api/audit?business_id=${biz.id}`, "finetune": `/api/export/finetune.jsonl?business_id=${biz.id}`,
    "conversation": `/api/conversations/${c2.id}/messages`, "research": `/api/research?business_id=${biz.id}`,
  };
  for (const [k, p] of Object.entries(bCalls)) ok(`B cannot read A's ${k}`, (await call(p, { token: B })).status === 404);
  ok("B cannot chat in A's conversation", (await call(`/api/conversations/${c2.id}/messages`, { method: "POST", token: B, body: { content: "hi" } })).status === 404);
  ok("B cannot rate A's message", (await call(`/api/messages/${mm.id}/rating`, { method: "POST", token: B, body: { rating: -1 } })).status === 404);
  ok("B cannot pay A's invoice", (await call(`/api/billing/invoices/${inv.id}/pay-link`, { method: "POST", token: B })).status === 404);
  ok("B cannot convert A's prospect", (await call(`/api/prospects/${pa.id}/to-lead`, { method: "POST", token: B })).status === 404);
  ok("B cannot start A's campaign", (await call(`/api/campaigns/${camp.id}/start`, { method: "POST", token: B })).status === 404);
  ok("B cannot activate A's employee", (await call(`/api/employees/${emp.id}/activate`, { method: "POST", token: B })).status === 404);
  ok("B's own list is empty", (await call("/api/businesses", { token: B })).data.length === 0);

  // ---------- audit + stats ----------
  const audit = (await call(`/api/audit?business_id=${biz.id}`, { token: A })).data;
  ok("audit log records key actions", ["business.created", "contact.opt_out", "campaign.started", "conversation.handoff", "invoice.payment"].every((a) => audit.some((x) => x.action === a)), audit.map((x) => x.action));
  const stats = (await call(`/api/stats?business_id=${biz.id}`, { token: A })).data;
  ok("stats", stats.calls === 2 && stats.leads >= 2, stats);

  // ---------- login rate limit (last: it blocks this IP) ----------
  let limited = false;
  for (let i = 0; i < 12; i++) if ((await call("/auth/login", { method: "POST", body: { email: "a@test.com", password: "wrongwrong" } })).status === 429) limited = true;
  ok("login is rate limited", limited);

  ck.done(assert);
  }
});
