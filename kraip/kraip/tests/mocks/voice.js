// Mock Sarvam (speech-to-text + text-to-speech WebSockets) and the Plivo REST API.
const http = require("http");
const { WebSocketServer } = require("ws");
const { wavToPcm } = require("../../lib/audio");

const state = { tts: [], ttsConfigs: [], plivo: [], stt: [] };
const TRANSCRIPTS = ["", "Hi I'm Ravi. I need whitening. My budget is 4500. Want it by Monday.", "What are your timings?", "let me speak to a manager", "please stop calling me", "FAILLLM tell me everything"];

const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const json = (res, obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/v1/Account/AUTH123/Call/")) {
    const rest = path.replace("/v1/Account/AUTH123/Call/", "").replace(/\/$/, "");
    state.plivo.push({ method: req.method, uuid: rest || null, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
    if (req.method === "POST" && !rest && body && JSON.parse(body).to === "+919000000099") return json(res, { error: "number not allowed" }, 400);   // test hook: placing this call fails
    if (req.method === "DELETE" && rest.startsWith("NODELETE")) return json(res, { error: "refused" }, 500);                                   // test hook: hang-up API refused
    if (req.method === "POST" && !rest) return json(res, { message: "call fired", request_uuid: "REQ-" + state.plivo.length }, 201);
    return json(res, { message: "ok" }, req.method === "DELETE" ? 204 : 202);
  }
  if (path === "/__state") return json(res, state);
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (req.headers["api-subscription-key"] !== "sarvam-key") { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return socket.destroy(); }
  if (url.pathname === "/speech-to-text/ws" && url.searchParams.get("language-code") === "kn-IN") { socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n"); return socket.destroy(); }   // test hook: STT outage
  if (url.pathname === "/speech-to-text/ws") return wss.handleUpgrade(req, socket, head, (ws) => sttConn(ws, url));
  if (url.pathname === "/text-to-speech/ws") return wss.handleUpgrade(req, socket, head, (ws) => ttsConn(ws, url));
  socket.destroy();
});

function sttConn(ws, url) {
  state.stt.push(Object.fromEntries(url.searchParams));
  let lastLoud = 0;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (!m.audio) return;
    const wav = wavToPcm(Buffer.from(m.audio.data, "base64"));
    if (!wav || m.audio.encoding !== "audio/wav" || m.audio.sample_rate !== "16000") return ws.send(JSON.stringify({ type: "error", data: { error: "bad audio format" } }));
    let sum = 0; const n = wav.pcm.length >> 1;
    for (let i = 0; i < n; i++) sum += Math.abs(wav.pcm.readInt16LE(i * 2));
    const level = n ? sum / n : 0;
    if (level < 1000) return;
    const now = Date.now(), fresh = now - lastLoud > 600; lastLoud = now;
    if (!fresh) return;
    const k = Math.round(level / 2000);
    ws.send(JSON.stringify({ type: "events", data: { event_type: "speech_event", signal_type: "START_SPEECH" } }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "events", data: { event_type: "speech_event", signal_type: "END_SPEECH" } }));
      ws.send(JSON.stringify({ type: "data", data: { transcript: TRANSCRIPTS[k] || "hello", language_code: "en-IN" } }));
    }, 150);
  });
}

function ttsConn(ws, url) {
  let cfg = null, text = "";
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "config") { cfg = m.data; state.ttsConfigs.push({ ...m.data, query: Object.fromEntries(url.searchParams) }); }
    else if (m.type === "text") text += m.data.text;
    else if (m.type === "flush") {
      state.tts.push({ text, speaker: cfg?.speaker, language: cfg?.language_code });
      if (text.includes("FAILTTS")) { text = ""; return ws.send(JSON.stringify({ type: "error", data: { message: "synthesis failed" } })); }   // test hook: TTS outage
      const pcm = Buffer.alloc(19200);           // 0.6 s at 16 kHz, a low tone
      for (let i = 0; i < 9600; i++) pcm.writeInt16LE(Math.round(3000 * Math.sin(i / 8)), i * 2);
      text = "";
      ws.send(JSON.stringify({ type: "audio", data: { audio: pcm.subarray(0, 9600).toString("base64"), content_type: "audio/L16" } }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "audio", data: { audio: pcm.subarray(9600).toString("base64"), content_type: "audio/L16" } }));
        ws.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
      }, 40);
    }
  });
}
function start() {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: server.address().port, state,
    close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections?.(); server.close(r); }),
  })));
}
module.exports = { start };
