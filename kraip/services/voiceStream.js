// Live phone conversation over Plivo's audio stream:
//   caller audio (8 kHz mu-law) -> 16 kHz PCM -> Sarvam speech-to-text -> KRAIP employee -> Sarvam text-to-speech -> mu-law -> caller
// Handles interruptions (barge-in), handoff to a human, opt-out hang-ups, silence and a maximum call length,
// and records an estimated provider cost per call for the margin view.
const { WebSocketServer, WebSocket } = require("ws");
const db = require("../db");
const plivo = require("./plivo");
const sarvam = require("./sarvam");
const calls = require("./calls");
const costs = require("../lib/costs");
const audio = require("../lib/audio");
const { phrases, sarvamLanguage } = require("../lib/phrases");
const { chat, loadContext } = require("./employee");

const SEND_BYTES = 3200;                                   // ~100 ms of 16 kHz audio per speech-to-text message
const PLAY_CHUNK = 8000;                                   // mu-law bytes per playAudio message (<16 KB once base64-encoded)
const DEBOUNCE_MS = Number(process.env.VOICE_DEBOUNCE_MS || 700);
const IDLE_MS = Number(process.env.VOICE_IDLE_MS || 9000);
const splitSentences = (t) => String(t).replace(/\s+/g, " ").trim().split(/(?<=[.!?।])\s+/).filter(Boolean).slice(0, 6);

const active = new Set();   // conversations with a live audio stream: a signed URL cannot be used to open a second one

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    const convId = Number(url.searchParams.get("conv"));
    const ok = url.pathname === "/plivo-stream" && convId &&
      plivo.verifyStreamToken(convId, Number(url.searchParams.get("exp")), url.searchParams.get("sig"));
    if (!ok) {
      if (url.pathname === "/plivo-stream") { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); }
      return;   // other upgrade paths belong to someone else
    }
    const done = db.prepare("SELECT duration_seconds FROM conversations WHERE id = ?").get(convId);
    if (!done || done.duration_seconds != null || active.has(convId)) { socket.write("HTTP/1.1 409 Conflict\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => handleCall(ws, convId));
  });
}

function handleCall(ws, convId) {
  let ctx;
  try { ctx = loadContext(convId); } catch { return ws.close(1008, "unknown conversation"); }
  const { employee, business, conv } = ctx;
  active.add(convId);
  ws.on("close", () => active.delete(convId));
  const lang = sarvamLanguage(employee.language);
  const say = phrases(employee.language);
  const speaker = employee.voice || undefined;

  const s = {
    streamId: null, callUuid: null, startedAt: null, speakUntil: 0, gen: 0, busy: false, again: false, pending: "",
    debounce: null, idle: null, ended: false, transferred: false, handoff: false, idleStrikes: 0,
    inBuf: [], inLen: 0, timers: [], ttsChars: 0, llmTurns: 0, upsample: new audio.Upsample2(),
  };
  const later = (fn, ms) => { const t = setTimeout(fn, ms); s.timers.push(t); return t; };
  const isOpen = () => ws.readyState === WebSocket.OPEN;
  const stt = new sarvam.SttSession({ lang });
  let tts = new sarvam.TtsSession({ lang, speaker });

  // ----- speaking -----
  function sendMulaw(mu) {
    if (!isOpen() || !mu.length) return;
    for (let i = 0; i < mu.length; i += PLAY_CHUNK) {
      ws.send(JSON.stringify({ event: "playAudio", media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: mu.subarray(i, i + PLAY_CHUNK).toString("base64") } }));
    }
    s.speakUntil = Math.max(Date.now(), s.speakUntil) + mu.length / 8;   // 8000 bytes per second
  }
  const sendPcm16k = (pcm, ds) => sendMulaw(audio.mulawEncode(ds.push(pcm)));

  // Speaks one sentence. Fixed phrases are cached (free after the first time); other text streams as it is generated.
  async function speakSentence(text, gen, cacheable) {
    const hit = sarvam.cacheGet(lang, text, speaker);
    if (hit) return sendPcm16k(hit, new audio.Downsample2());
    const ds = new audio.Downsample2(), kept = [];
    const run = () => tts.synthesize(text, (pcm) => { if (gen !== s.gen || s.ended) return; if (cacheable) kept.push(pcm); sendPcm16k(pcm, ds); });
    s.ttsChars += text.length;
    try { await run(); }
    catch (err) {
      if (err.cancelled) return;
      if (speaker && /speaker|voice/i.test(err.message)) {   // unknown speaker name: fall back to Sarvam's default voice
        console.warn(`[voice] speaker "${speaker}" refused, using the default voice`);
        tts.close(); tts = new sarvam.TtsSession({ lang });
        try { await run(); } catch (e) { if (!e.cancelled) console.warn("[voice] tts failed:", e.message); return; }
      } else { console.warn("[voice] tts failed:", err.message); return; }
    }
    if (cacheable && kept.length && gen === s.gen) sarvam.cacheSet(lang, text, Buffer.concat(kept), speaker);
  }
  async function speak(text, { cacheable = false } = {}) {
    const gen = ++s.gen;
    for (const sentence of splitSentences(text)) {
      if (gen !== s.gen || s.ended) break;
      await speakSentence(sentence, gen, cacheable);
    }
    if (gen === s.gen) armIdle();
  }
  function interrupt() {
    s.gen++;
    s.speakUntil = 0;
    tts.cancel();   // stop generating (and paying for) the rest of the reply
    if (isOpen() && s.streamId) ws.send(JSON.stringify({ event: "clearAudio", streamId: s.streamId }));
  }

  // ----- silence handling -----
  function armIdle() {
    clearTimeout(s.idle);
    if (s.ended) return;
    const wait = Math.max(0, s.speakUntil - Date.now()) + IDLE_MS;
    s.idle = setTimeout(async () => {
      if (s.ended || s.busy || s.pending) return;
      if (++s.idleStrikes >= 2) { await speak(say.goodbye, { cacheable: true }); return endAfterSpeech(); }
      await speak(say.stillThere, { cacheable: true });
    }, wait);
    s.timers.push(s.idle);
  }

  // ----- ending the call -----
  async function endNow() {
    if (s.ended || s.hangingUp) return;
    s.hangingUp = true;
    let done = false;
    try {
      if (s.callUuid) { const r = await plivo.hangup(s.callUuid); done = r.status >= 200 && r.status < 300; }
    } catch (e) { console.warn("[voice] hangup failed:", e.message); }
    // The stream keeps the call alive, so if hanging up by API was refused, hand the call to XML that hangs up
    if (!done && s.callUuid) { try { await plivo.transfer(s.callUuid, plivo.endUrl(employee.id)); } catch (e) { console.warn("[voice] end-call transfer failed:", e.message); } }
    if (isOpen()) ws.close(1000);
  }
  const endAfterSpeech = () => later(endNow, Math.max(0, s.speakUntil - Date.now()) + 700);
  function handoffAfterSpeech() {
    if (!business.handoff_number || !s.callUuid) return endAfterSpeech();
    later(async () => {
      s.transferred = true;
      s.transferAt = Date.now();
      try { await plivo.transfer(s.callUuid, plivo.transferUrl(employee.id, convId)); }
      catch (e) { s.transferred = false; console.warn("[voice] transfer failed:", e.message); endNow(); }
    }, Math.max(0, s.speakUntil - Date.now()) + 500);
  }

  // ----- conversation turns -----
  async function runTurn() {
    if (s.ended || s.hangingUp) return;
    if (s.busy) { s.again = true; return; }
    const text = s.pending.trim();
    if (!text) return;
    s.pending = "";
    s.busy = true; s.idleStrikes = 0; clearTimeout(s.idle);
    try {
      const r = await chat(convId, text, { voice: true });
      s.llmTurns++;
      if (s.ended) return;
      if (r.reply) await speak(r.reply, { cacheable: r.optOut || r.handoff });
      if (r.optOut) endAfterSpeech();
      else if (r.handoff) { s.handoff = true; handoffAfterSpeech(); }
    } catch (err) {
      console.error("[voice] turn failed:", err.message);
      db.prepare("UPDATE conversations SET status = 'needs_human' WHERE id = ?").run(convId);
      s.handoff = true;
      await speak(say.error, { cacheable: true });
      endAfterSpeech();
    } finally {
      s.busy = false;
      if (s.again && !s.ended) { s.again = false; if (s.pending.trim()) runTurn(); }
    }
  }
  function onTranscript(text) {
    s.pending += (s.pending ? " " : "") + text;
    clearTimeout(s.debounce);
    s.debounce = setTimeout(runTurn, DEBOUNCE_MS);
  }

  stt.on("transcript", onTranscript);
  stt.on("speech_start", () => {
    clearTimeout(s.debounce); clearTimeout(s.idle);                  // caller is talking: wait for them
    if (process.env.VOICE_BARGE_IN !== "0" && Date.now() < s.speakUntil) interrupt();
  });
  stt.on("speech_end", () => {
    if (s.pending) { clearTimeout(s.debounce); s.debounce = setTimeout(runTurn, DEBOUNCE_MS); }
  });
  stt.on("error", (e) => console.warn("[voice] stt error:", e.message));

  // ----- messages from Plivo -----
  ws.on("message", async (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
    if (ev.event === "start") {
      if (s.startedAt) return;
      s.streamId = ev.start?.streamId; s.callUuid = ev.start?.callId; s.startedAt = Date.now();
      if (s.callUuid) { try { db.prepare("UPDATE conversations SET call_sid = COALESCE(call_sid, ?) WHERE id = ?").run(s.callUuid, convId); } catch { /* call id already belongs to another conversation */ } }
      const limit = plivo.maxCallSeconds();
      later(async () => { if (s.ended) return; console.log(`[voice] call ${convId} reached the ${limit}s limit`); interrupt(); await speak(say.goodbye, { cacheable: true }); endAfterSpeech(); }, limit * 1000);
      stt.open().catch((e) => console.warn("[voice] could not open speech-to-text:", e.message));
      const greeting = conv.direction === "outbound" ? say.outbound(employee.name, business.name)
        : employee.greeting || say.inbound(employee.name, business.name);
      db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(convId, greeting);
      speak(greeting, { cacheable: true });
    } else if (ev.event === "media" && ev.media?.payload) {
      if (s.ended || s.transferred) return;
      const pcm = s.upsample.push(audio.mulawDecode(Buffer.from(ev.media.payload, "base64")));
      s.inBuf.push(pcm); s.inLen += pcm.length;
      if (s.inLen >= SEND_BYTES) { stt.sendPcm(Buffer.concat(s.inBuf)); s.inBuf = []; s.inLen = 0; }
    } else if (ev.event === "stop") {
      if (isOpen()) ws.close(1000);
    }
  });

  ws.on("close", () => {
    if (s.ended) return;
    s.ended = true;
    [s.debounce, s.idle, ...s.timers].forEach(clearTimeout);
    stt.close(); tts.close();
    if (!s.startedAt) return;
    const end = s.transferred ? s.transferAt : Date.now();
    const seconds = (end - s.startedAt) / 1000;
    try {
      calls.finalizeCall(convId, seconds, "stream", { transferred: s.transferred, keepNeedsHuman: s.handoff });
      const c = costs.estimate({ seconds, ttsChars: s.ttsChars, llmTurns: s.llmTurns });
      db.prepare(`INSERT OR REPLACE INTO call_costs (business_id, conversation_id, seconds, tts_chars, stt_seconds, llm_turns, telephony_paise, stt_paise, tts_paise, llm_paise)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(business.id, convId, Math.round(seconds), s.ttsChars, c.stt_seconds, s.llmTurns, c.telephony_paise, c.stt_paise, c.tts_paise, c.llm_paise);
    } catch (e) { console.warn("[voice] finalize failed:", e.message); }
  });
  ws.on("error", (e) => console.warn("[voice] socket error:", e.message));
  later(() => { if (!s.streamId && !s.ended) ws.close(1001); }, 15000);   // stream never started
}

module.exports = { attach };
