// Voice calls over Plivo + Sarvam, against mock providers: inbound, outbound, barge-in, handoff, opt-out, silence,
// webhook authentication, duplicate callbacks, billing at 3.5 / 5 per minute, and the margin view.
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, sleep, waitFor, startStream, speakTurn, plays, checker } = require("./harness");

test("voice: inbound, outbound, handoff, opt-out, silence, billing", { timeout: 170000 }, async (t) => {
  const T = await boot();
  t.after(() => T.stop());
  const ok = checker();
  const api = T.api;

  const u = await T.signup("v@test.com");
  const biz = (await api("/api/businesses", { method: "POST", token: u, body: { name: "Sunrise Dental", services: "Whitening Rs 4000", handoff_number: "+919000000001" } })).data;
  const emp = (await api("/api/employees", { method: "POST", token: u, body: { business_id: biz.id, name: "Aria", voice: "kavya", language: "hi-IN" } })).data;
  await api(`/api/employees/${emp.id}/activate`, { method: "POST", token: u });
  const sys = (await api("/api/system", { token: u })).data;
  ok("system reports Plivo + voice AI ready", sys.phone_provider === "plivo" && sys.telephony && sys.voice_ai && /^\/plivo\/\d+\/answer\?k=[0-9a-f]{32}$/.test(sys.webhook_paths[emp.id]), sys);
  const answerPath = sys.webhook_paths[emp.id];
  const k = /k=([0-9a-f]+)/.exec(answerPath)[1];

  // ---------- webhook authentication (fails closed) ----------
  ok("webhook without key or signature rejected", (await T.hook(`/plivo/${emp.id}/answer`, { CallUUID: "x" })).status === 403);
  ok("webhook with a wrong key rejected", (await T.hook(`/plivo/${emp.id}/answer?k=${"0".repeat(32)}`, { CallUUID: "x" })).status === 403);
  ok("webhook with a bad Plivo signature rejected", (await T.hook(`/plivo/${emp.id}/answer`, { CallUUID: "x" }, { sig: "bad" })).status === 403);
  const v3 = await T.hook(`/plivo/${emp.id}/answer`, { CallUUID: "V3", From: "+919800000000" }, { sig: "v3" });
  ok("webhook with a valid Plivo V3 signature accepted", v3.status === 200 && /<Stream/.test(v3.text), v3);

  // another business's employee: this key must not work there (keys are per employee)
  const u2 = await T.signup("other@test.com");
  const biz2 = (await api("/api/businesses", { method: "POST", token: u2, body: { name: "Other Co" } })).data;
  const emp2 = (await api("/api/employees", { method: "POST", token: u2, body: { business_id: biz2.id, name: "Bob" } })).data;
  await api(`/api/employees/${emp2.id}/activate`, { method: "POST", token: u2 });
  ok("one business's webhook key does not work on another business's employee", (await T.hook(`/plivo/${emp2.id}/answer?k=${k}`, { CallUUID: "x" })).status === 403);

  // ---------- inbound call ----------
  const ans = await T.hook(answerPath, { CallUUID: "CALL-1", From: "+919876543210", To: "+912212345678" });
  ok("answer returns bidirectional mu-law 8k stream", ans.status === 200 && /<Stream bidirectional="true" keepCallAlive="true" contentType="audio\/x-mulaw;rate=8000">/.test(ans.text), ans.text);
  const url1 = T.streamUrl(ans.text), convId = Number(/conv=(\d+)/.exec(url1)[1]);
  const dup = await T.hook(answerPath, { CallUUID: "CALL-1", From: "+919876543210" });
  ok("a repeated answer webhook for the same call reuses the conversation", Number(/conv=(\d+)/.exec(T.streamUrl(dup.text))[1]) === convId);
  let bad = false; try { await T.connect(url1.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64))); } catch { bad = true; }
  ok("stream with a forged signature is refused", bad);
  bad = false; try { await T.connect(url1.replace(/exp=\d+/, "exp=1000")); } catch { bad = true; }
  ok("stream with an expired token is refused", bad);

  const ws = await T.connect(url1);
  startStream(ws, "CALL-1");
  ok("greeting is spoken on stream start", !!(await waitFor(() => plays(ws) >= 2, 6000)));
  bad = false; try { await T.connect(url1); } catch { bad = true; }
  ok("a second stream cannot be opened for the same call", bad);
  const st0 = T.vox.state, cfg = st0.ttsConfigs[0];
  ok("TTS config: Hindi, chosen voice, linear16 16k", cfg && cfg.language_code === "hi-IN" && cfg.speaker === "kavya" && cfg.output_audio_codec === "linear16", cfg);
  ok("STT connection: Hindi, 16k, VAD, wav", st0.stt[0] && st0.stt[0]["language-code"] === "hi-IN" && st0.stt[0].sample_rate === "16000" && st0.stt[0].vad_signals === "true" && st0.stt[0].input_audio_codec === "wav", st0.stt);
  const pm = ws.msgs.filter((m) => m.event === "playAudio");
  ok("playAudio is mu-law 8000 within the 16 KB limit", pm.every((m) => m.media.contentType === "audio/x-mulaw" && m.media.sampleRate === 8000 && m.media.payload.length <= 16000), pm[0]);
  ok("greeting is in Hindi and discloses AI", /एआई/.test(st0.tts[0].text), st0.tts[0]);

  const before = plays(ws);
  speakTurn(ws, 1);
  ok("barge-in: clearAudio sent when the caller interrupts", !!(await waitFor(() => ws.msgs.find((m) => m.event === "clearAudio" && m.streamId === "STREAM-CALL-1"), 4000)));
  ok("AI answers the caller's sentence", !!(await waitFor(() => plays(ws) > before, 10000)));
  const lead = await waitFor(async () => { const l = (await api(`/api/leads?business_id=${biz.id}`, { token: u })).data[0]; return l && l.score === "hot" ? l : null; }, 8000);
  ok("lead captured in the background (caller ID phone, hot)", lead && lead.phone === "+919876543210" && /whitening/.test(lead.need), lead);

  await sleep(2500);
  const mid = plays(ws);
  speakTurn(ws, 2);
  ok("second turn answered", !!(await waitFor(() => plays(ws) > mid, 10000)));

  // ---------- human handoff ----------
  speakTurn(ws, 3);
  const transfer = await waitFor(() => T.vox.state.plivo.find((p) => p.method === "POST" && p.uuid === "CALL-1"), 20000);
  ok("handoff transfers the live call to the signed handoff URL", transfer && transfer.body.legs === "aleg" && transfer.body.aleg_url === `http://kraip.test/plivo/${emp.id}/handoff?conv=${convId}&k=${k}` && /^Basic /.test(transfer.auth), transfer);
  const ho = await T.hook(`/plivo/${emp.id}/handoff?conv=${convId}&k=${k}`, { CallUUID: "CALL-1" });
  ok("handoff URL dials the human number", /<Dial[^>]*><Number>\+919000000001<\/Number><\/Dial>/.test(ho.text), ho.text);
  ws.close();
  const done = await waitFor(async () => { const d = (await api(`/api/conversations/${convId}/messages`, { token: u })).data; return d.conversation.duration_seconds != null ? d : null; }, 6000);
  ok("call finalised and still flagged for the human team", done && done.conversation.status === "needs_human" && done.conversation.duration_source === "transfer", done && done.conversation);
  ok("transcript has greeting + caller lines", done.messages[0].role === "assistant" && done.messages.some((m) => m.role === "user" && /whitening/.test(m.content)));

  // ---------- opt-out call ----------
  const ans2 = await T.hook(answerPath, { CallUUID: "CALL-2", From: "+919822223333" });
  const ws2 = await T.connect(T.streamUrl(ans2.text)); startStream(ws2, "CALL-2");
  await waitFor(() => plays(ws2) >= 2, 4000);
  let closed = false; ws2.on("close", () => (closed = true));
  speakTurn(ws2, 4);
  ok("opt-out: server ends the call", !!(await waitFor(() => closed, 25000)));
  ok("opt-out: Plivo hangup API called", !!T.vox.state.plivo.find((p) => p.method === "DELETE" && p.uuid === "CALL-2"));
  const ct = (await api(`/api/contacts?business_id=${biz.id}`, { token: u })).data.find((c) => c.phone === "+919822223333");
  ok("opt-out recorded", ct && ct.opted_out === 1, ct);

  // ---------- silence: "are you still there?" then goodbye ----------
  const ans3 = await T.hook(answerPath, { CallUUID: "CALL-5", From: "+919811112222" });
  const ws3 = await T.connect(T.streamUrl(ans3.text)); startStream(ws3, "CALL-5");
  let closed3 = false; ws3.on("close", () => (closed3 = true));
  ok("silent caller: AI asks if they are still there", !!(await waitFor(() => T.vox.state.tts.some((x) => x.text.includes("लाइन पर")), 15000)));
  ok("silent caller: call is ended politely", !!(await waitFor(() => closed3, 20000)));

  // greeting audio that played to the end is cached: a new call needs no TTS request for it
  const ttsBefore = T.vox.state.tts.length;
  const ans6 = await T.hook(answerPath, { CallUUID: "CALL-6", From: "+919833334444" });
  const ws6 = await T.connect(T.streamUrl(ans6.text)); startStream(ws6, "CALL-6");
  await waitFor(() => plays(ws6) >= 2, 4000);
  ok("repeat greeting played from cache (no new TTS request)", T.vox.state.tts.length === ttsBefore && plays(ws6) >= 2, { before: ttsBefore, after: T.vox.state.tts.length });
  ws6.close();

  // ---------- outbound campaign ----------
  await api("/api/contacts/import", { method: "POST", token: u, body: { business_id: biz.id, csv: "Meena,9123456780,yes,whatsapp opt-in\nKiran,9123456781,no," } });
  const camp = (await api("/api/campaigns", { method: "POST", token: u, body: { business_id: biz.id, employee_id: emp.id, name: "Offer", window_start: 0, window_end: 24 } })).data;
  const started = (await api(`/api/campaigns/${camp.id}/start`, { method: "POST", token: u })).data;
  ok("campaign places 1 call (the contact without consent is skipped)", started.placed === 1, started);
  const made = T.vox.state.plivo.find((p) => p.method === "POST" && !p.uuid && p.body.to === "+919123456780");
  ok("Plivo make-call body correct", made && made.body.from === "+912200000000" && /\/plivo\/\d+\/outbound\?cc=\d+&k=[0-9a-f]{32}$/.test(made.body.answer_url) && /hangup\?cc=\d+&k=/.test(made.body.hangup_url) && made.body.time_limit === 930, made);
  const au = new URL(made.body.answer_url), ccPath = au.pathname + au.search;
  const out = await T.hook(ccPath, { CallUUID: "CALL-3", From: "+912200000000", To: "+919123456780" });
  ok("outbound answer streams audio", /<Stream bidirectional="true"/.test(out.text), out.text);
  const convId3 = Number(/conv=(\d+)/.exec(out.text)[1]);
  const replay = await T.hook(ccPath, { CallUUID: "CALL-OTHER", From: "+912200000000" });
  ok("the answer URL cannot be replayed by a different call", /<Hangup\/>/.test(replay.text) && !/<Stream/.test(replay.text), replay.text);
  const ws4 = await T.connect(T.streamUrl(out.text)); startStream(ws4, "CALL-3");
  await waitFor(() => plays(ws4) >= 2, 5000);
  const g3 = (await api(`/api/conversations/${convId3}/messages`, { token: u })).data.messages[0].content;
  ok("outbound greeting discloses AI and offers to stop", /एआई/.test(g3) && /रुकिए/.test(g3), g3);
  await sleep(1100); ws4.close();
  const hu = new URL(made.body.hangup_url), huPath = hu.pathname + hu.search;
  const forged = await T.hook(huPath, { CallUUID: "CALL-3", CallStatus: "completed", Duration: "1" });
  ok("hangup callback with only the key is accepted but cannot change billed time", forged.status === 204);
  await waitFor(async () => (await api(`/api/conversations/${convId3}/messages`, { token: u })).data.conversation.duration_seconds != null, 4000);
  const afterForged = (await api(`/api/conversations/${convId3}/messages`, { token: u })).data.conversation;
  ok("unsigned duration ignored (server-measured stream time kept)", afterForged.duration_source === "stream" && afterForged.duration_seconds <= 10, afterForged);
  const hang = await T.hook(huPath, { CallUUID: "CALL-3", CallStatus: "completed", Duration: "70" }, { sig: "v3" });
  ok("hangup callback signed by Plivo corrects the duration", hang.status === 204);
  await T.hook(huPath, { CallUUID: "CALL-3", CallStatus: "completed", Duration: "70" }, { sig: "v3" });
  await T.hook(huPath, { CallUUID: "CALL-3", CallStatus: "completed", Duration: "70" }, { sig: "v3" });
  const finalConv = (await api(`/api/conversations/${convId3}/messages`, { token: u })).data.conversation;
  ok("duplicate hangup callbacks do not change or double-count the call", finalConv.duration_seconds === 70 && finalConv.duration_source === "provider", finalConv);
  const camps = (await api(`/api/campaigns?business_id=${biz.id}`, { token: u })).data;
  ok("campaign contact marked completed", camps[0].progress.completed === 1, camps[0].progress);

  await api("/api/contacts/import", { method: "POST", token: u, body: { business_id: biz.id, csv: "Sita,9123456782,yes,signup form" } });
  const c2 = (await api("/api/campaigns", { method: "POST", token: u, body: { business_id: biz.id, employee_id: emp.id, name: "Second", window_start: 0, window_end: 24 } })).data;
  await api(`/api/campaigns/${c2.id}/start`, { method: "POST", token: u });
  const made2 = T.vox.state.plivo.filter((p) => p.method === "POST" && !p.uuid).pop();
  const sita = (await api(`/api/contacts?business_id=${biz.id}`, { token: u })).data.find((c) => c.name === "Sita");
  await api(`/api/contacts/${sita.id}/opt-out`, { method: "POST", token: u });
  const p2 = new URL(made2.body.answer_url);
  const refused = await T.hook(p2.pathname + p2.search, { CallUUID: "CALL-4" });
  ok("opted-out contact: answer hangs up instead of streaming", /<Hangup\/>/.test(refused.text) && !/<Stream/.test(refused.text), refused.text);

  // ---------- billing and margin ----------
  const month = new Date().toISOString().slice(0, 7);
  const use = (await api(`/api/billing/usage?business_id=${biz.id}&month=${month}`, { token: u })).data;
  const L = (key) => use.lines.find((l) => l.key === key);
  ok("lead call billed at Rs 5/min", L("lead_call_minute").quantity === 1 && L("lead_call_minute").amount_paise === 500, L("lead_call_minute"));
  ok("normal calls billed at Rs 3.5/min (opt-out 1 + silent 1 + zero-second 0 + outbound 70s=2)", L("call_minute").quantity === 4 && L("call_minute").amount_paise === 1400, L("call_minute"));
  ok("total adds up", use.total_paise === use.lines.reduce((s, l) => s + l.amount_paise, 0));
  const mg = use.margin;
  ok("margin view: cost estimated and margin positive", mg.calls_costed >= 3 && mg.estimated_cost_paise > 0 && mg.margin_paise === mg.call_revenue_paise - mg.estimated_cost_paise && mg.margin_paise > 0, mg);
  ok("server stayed up and logged no crash", !T.crashed() && !/Unhandled|uncaught/i.test(T.logs()), T.logs().slice(-600));
  ok.done(assert);
});
