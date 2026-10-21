// Provider failures during calls (model, TTS, STT outages, refused hang-up, early hang-up) and campaign retry/concurrency
// behaviour. All providers are mocks: no real calls are made.
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, sleep, waitFor, startStream, speakTurn, plays, checker } = require("./harness");

const localHour = () => Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date())) % 24;

test("voice: provider failures and campaign reliability", { timeout: 170000 }, async (t) => {
  const T = await boot({ RETRY_MINUTES: "0", CAMPAIGN_TICK_MS: "400", CAMPAIGN_CALLS_PER_TICK: "5", MAX_CALL_SECONDS: "120" });
  t.after(() => T.stop());
  const ok = checker();
  const api = T.api;
  const u = await T.signup("f@test.com");
  const biz = (await api("/api/businesses", { method: "POST", token: u, body: { name: "Sunrise Dental", services: "Whitening Rs 4000" } })).data;     // no handoff number
  const mk = async (body) => {
    const e = (await api("/api/employees", { method: "POST", token: u, body: { business_id: biz.id, ...body } })).data;
    await api(`/api/employees/${e.id}/activate`, { method: "POST", token: u });
    return { e, path: (await api("/api/system", { token: u })).data.webhook_paths[e.id] };
  };
  const call = async (path, uuid, from = "+919800000001") => {
    const r = await T.hook(path, { CallUUID: uuid, From: from });
    const ws = await T.connect(T.streamUrl(r.text)); startStream(ws, uuid);
    ws.closed = false; ws.on("close", () => (ws.closed = true));
    return { ws, convId: Number(/conv=(\d+)/.exec(r.text)[1]) };
  };
  const conv = async (id) => (await api(`/api/conversations/${id}/messages`, { token: u })).data;
  const ended = async (id) => waitFor(async () => { const d = await conv(id); return d.conversation.duration_seconds != null ? d : null; }, 8000);

  // ---------- the language model is down ----------
  const en = await mk({ name: "Eng", language: "en-IN" });
  let c = await call(en.path, "FAIL-LLM");
  await waitFor(() => plays(c.ws) >= 2, 5000);
  speakTurn(c.ws, 5);   // caller says something that makes the mock model fail
  ok("model outage: the caller hears an apology", !!(await waitFor(() => T.vox.state.tts.some((x) => /having trouble/.test(x.text)), 12000)));
  ok("model outage: the call is ended", !!(await waitFor(() => c.ws.closed, 15000)));
  let d = await ended(c.convId);
  ok("model outage: call finalised and flagged for a human callback", d && d.conversation.status === "needs_human" && d.conversation.duration_seconds >= 0, d && d.conversation);

  // ---------- text-to-speech is down ----------
  const tts = await mk({ name: "Tts", language: "en-IN", greeting: "FAILTTS hello there" });
  c = await call(tts.path, "FAIL-TTS");
  await sleep(1500);
  speakTurn(c.ws, 2);
  ok("TTS outage: the call survives and later replies still play", !!(await waitFor(() => T.vox.state.tts.some((x) => /opening hours|timings|budget/i.test(x.text) || x.text.includes("Happy to help")), 12000)) && plays(c.ws) > 0 && !c.ws.closed);
  c.ws.close();
  d = await ended(c.convId);
  ok("TTS outage: call still finalised and billed", !!d && d.conversation.duration_seconds != null);

  // ---------- speech-to-text is down ----------
  const stt = await mk({ name: "Stt", language: "kn-IN" });
  c = await call(stt.path, "FAIL-STT");
  ok("STT outage: greeting still plays", !!(await waitFor(() => plays(c.ws) >= 2, 6000)));
  ok("STT outage: silent line is hung up politely instead of hanging forever", !!(await waitFor(() => c.ws.closed, 25000)));
  ok("STT outage is logged", /could not open speech-to-text/.test(T.logs()));
  d = await ended(c.convId);
  ok("STT outage: call finalised", !!d);

  // ---------- caller hangs up while the AI is speaking ----------
  c = await call(en.path, "HANGUP-EARLY");
  await waitFor(() => plays(c.ws) >= 1, 5000);
  c.ws.close();
  d = await ended(c.convId);
  ok("early hang-up: conversation finalised with a duration", !!d && Number.isInteger(d.conversation.duration_seconds));
  const dbRows = (await api(`/api/billing/usage?business_id=${biz.id}&month=${new Date().toISOString().slice(0, 7)}`, { token: u })).data;
  ok("early hang-up: one cost row per call", dbRows.margin.calls_costed >= 3, dbRows.margin);

  // ---------- hang-up API refused: the call is still ended ----------
  c = await call(en.path, "NODELETE-1");
  await waitFor(() => plays(c.ws) >= 2, 5000);
  speakTurn(c.ws, 4);   // opt-out
  ok("hang-up refused: server falls back to transferring the call to a hang-up URL", !!(await waitFor(() => T.vox.state.plivo.find((p) => p.method === "POST" && p.uuid === "NODELETE-1" && /\/end\?k=/.test(p.body.aleg_url)), 20000)));
  c.ws.close();

  // ---------- handoff requested but no human number configured ----------
  c = await call(en.path, "NO-HANDOFF-NUMBER");
  await waitFor(() => plays(c.ws) >= 2, 5000);
  speakTurn(c.ws, 3);   // "let me speak to a manager"
  ok("no handoff number: call ends politely and no transfer is attempted", !!(await waitFor(() => c.ws.closed, 25000)) && !T.vox.state.plivo.some((p) => p.uuid === "NO-HANDOFF-NUMBER" && p.method === "POST"));
  d = await ended(c.convId);
  ok("no handoff number: conversation left flagged for the team", d && d.conversation.status === "needs_human", d && d.conversation);

  // ---------- campaigns: retry limit, failure handling ----------
  await api("/api/contacts/import", { method: "POST", token: u, body: { business_id: biz.id, csv: "Blocked,9000000099,yes,signup form\nGood,9123456770,yes,signup form" } });
  const camp = (await api("/api/campaigns", { method: "POST", token: u, body: { business_id: biz.id, employee_id: en.e.id, name: "Retry", window_start: 0, window_end: 24, max_attempts: 2 } })).data;
  // five simultaneous starts must not place duplicate calls
  const starts = await Promise.all(Array.from({ length: 5 }, () => api(`/api/campaigns/${camp.id}/start`, { method: "POST", token: u })));
  ok("concurrent starts all succeed", starts.every((s) => s.status === 200), starts.map((s) => s.status));
  await waitFor(async () => (await api(`/api/campaigns?business_id=${biz.id}`, { token: u })).data.find((x) => x.id === camp.id).progress.failed === 1, 15000);
  const placed = (n) => T.vox.state.plivo.filter((p) => p.method === "POST" && !p.uuid && p.body?.to === n);
  ok("a number that always fails is retried up to max_attempts (2) and then marked failed", placed("+919000000099").length === 2, placed("+919000000099").length);
  ok("a good number is called exactly once despite 5 concurrent starts + the scheduler", placed("+919123456770").length === 1, placed("+919123456770").length);
  const prog = (await api(`/api/campaigns?business_id=${biz.id}`, { token: u })).data.find((x) => x.id === camp.id);
  ok("campaign has one failed and one in-call contact; attempts never exceed the limit", prog.progress.failed === 1 && prog.progress.calling === 1, prog.progress);

  // ---------- calling hours ----------
  const h = localHour(), start = h < 22 ? h + 1 : 0;
  await api("/api/contacts/import", { method: "POST", token: u, body: { business_id: biz.id, csv: "Late,9123456771,yes,signup form" } });
  const night = (await api("/api/campaigns", { method: "POST", token: u, body: { business_id: biz.id, employee_id: en.e.id, name: "Night", window_start: start, window_end: start + 1 } })).data;
  const before = T.vox.state.plivo.filter((p) => p.method === "POST" && !p.uuid).length;
  const ns = (await api(`/api/campaigns/${night.id}/start`, { method: "POST", token: u })).data;
  await sleep(1200);   // let the scheduler tick several times as well
  ok("outside the calling window nothing is dialled", ns.reason === "outside_call_window" && T.vox.state.plivo.filter((p) => p.method === "POST" && !p.uuid).length === before, ns);
  ok("window that ends before it starts is rejected", (await api("/api/campaigns", { method: "POST", token: u, body: { business_id: biz.id, employee_id: en.e.id, name: "Bad", window_start: 20, window_end: 9 } })).status === 400);

  ok("server never crashed during the failure scenarios", !T.crashed() && !/Unhandled|uncaught|TypeError|ReferenceError/i.test(T.logs()), T.logs().slice(-800));
  ok.done(assert);
});
