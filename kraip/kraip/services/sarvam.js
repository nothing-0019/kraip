// Sarvam AI speech: streaming speech-to-text and text-to-speech over WebSocket.
// Written against Sarvam's published WebSocket docs. Run `npm run voice-check` once with your key to confirm the
// exact audio format your account returns; the decoder below copes with WAV, raw PCM, mu-law and MP3 (needs ffmpeg).
const WebSocket = require("ws");
const EventEmitter = require("events");
const { spawn } = require("child_process");
const { pcmToWav, wavToPcm, mulawDecode, resample, RATE } = require("../lib/audio");

const base = () => (process.env.SARVAM_WS_BASE || "wss://api.sarvam.ai").replace(/\/$/, "");
const apiKey = () => process.env.SARVAM_API_KEY || "";
const configured = () => !!apiKey();
const sarvamLang = (l) => (!l || l === "en-US" ? "en-IN" : l);

let forcedCodec = null;   // set automatically if Sarvam refuses the configured codec (then MP3 + ffmpeg is used)
function ttsConfig(speaker) {
  const codec = forcedCodec || process.env.SARVAM_TTS_CODEC || "linear16";
  const defaultRate = codec === "mulaw" || codec === "alaw" ? 8000 : codec === "mp3" ? 22050 : 16000;
  return {
    model: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
    speaker: speaker || process.env.SARVAM_TTS_SPEAKER || process.env.SARVAM_SPEAKER || "shubh",
    pace: Number(process.env.SARVAM_TTS_PACE || 1),
    codec,
    rate: forcedCodec ? defaultRate : Number(process.env.SARVAM_TTS_RATE || defaultRate),
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { "Api-Subscription-Key": apiKey() }, handshakeTimeout: 8000 });
    const onError = (err) => reject(err);
    ws.once("open", () => { ws.off("error", onError); resolve(ws); });
    ws.once("error", onError);
    ws.once("unexpected-response", (req, res) => {
      req.destroy();
      reject(new Error(`Sarvam rejected the connection (HTTP ${res.statusCode}). Check SARVAM_API_KEY.`));
    });
  });
}

// ===================== Speech to text =====================
class SttSession extends EventEmitter {
  constructor({ lang }) { super(); this.lang = lang; this.ws = null; this.closed = false; this.backlog = []; }

  async open() {
    const q = new URLSearchParams({
      "language-code": sarvamLang(this.lang), sample_rate: "16000", input_audio_codec: "wav",
      vad_signals: "true", flush_signal: "true",
    });
    if (process.env.SARVAM_STT_MODEL) q.set("model", process.env.SARVAM_STT_MODEL);
    if (process.env.SARVAM_STT_HIGH_VAD === "1") q.set("high_vad_sensitivity", "true");
    this.ws = await connect(`${base()}/speech-to-text/ws?${q}`);
    this.ws.on("message", (raw) => this.onMessage(raw));
    this.ws.on("close", () => { if (!this.closed) this.emit("close"); });
    this.ws.on("error", (err) => this.safeEmit("error", err));
    for (const pcm of this.backlog.splice(0)) this.sendPcm(pcm);
  }

  safeEmit(event, arg) { if (this.listenerCount(event)) this.emit(event, arg); }

  onMessage(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "data") {
      const text = String(m.data?.transcript || "").trim();
      if (text) this.emit("transcript", text);
    } else if (m.type === "events") {
      const s = m.data?.signal_type;
      if (s === "START_SPEECH") this.emit("speech_start");
      else if (s === "END_SPEECH") this.emit("speech_end");
    } else if (m.type === "error") {
      this.safeEmit("error", new Error(m.data?.error || m.data?.message || "Sarvam speech-to-text error"));
    }
  }

  // pcm: 16-bit mono 16 kHz. Each chunk is sent as a small WAV file (the documented format).
  sendPcm(pcm) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.backlog.length < 40) this.backlog.push(pcm);
      return;
    }
    this.ws.send(JSON.stringify({ audio: { data: pcmToWav(pcm, RATE).toString("base64"), sample_rate: "16000", encoding: "audio/wav" } }));
  }
  flush() { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "flush" })); }
  close() { this.closed = true; try { this.ws?.close(); } catch { /* already closed */ } }
}

// ===================== Text to speech =====================
function ffmpegToPcm(buf) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "pipe:1"]);
    const out = [];
    p.stdout.on("data", (d) => out.push(d));
    p.on("error", (err) => reject(new Error(err.code === "ENOENT"
      ? "Sarvam returned MP3 audio and ffmpeg is not installed. Install ffmpeg, or set SARVAM_TTS_CODEC=linear16."
      : err.message)));
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error("ffmpeg could not decode the MP3 audio"))));
    p.stdin.on("error", () => {});
    p.stdin.end(buf);
  });
}

// Turns whatever Sarvam sends back into 16 kHz mono PCM.
function makeDecoder(cfg) {
  let mp3 = [], carry = null, rate = cfg.rate;
  return {
    push(contentType, buf) {
      const ct = String(contentType || "").toLowerCase();
      if (/mp3|mpeg/.test(ct)) { mp3.push(buf); return null; }
      if (/aac|opus|flac|ogg|webm/.test(ct)) throw new Error(`Sarvam returned "${ct}" audio, which KRAIP cannot play. Set SARVAM_TTS_CODEC=linear16.`);
      const wav = wavToPcm(buf);
      if (wav) { rate = wav.sampleRate; return resample(wav.pcm, wav.sampleRate, RATE); }
      let raw = buf;
      if (/mulaw|ulaw|pcmu/.test(ct) || cfg.codec === "mulaw") return resample(mulawDecode(raw), rate, RATE);
      if (carry) { raw = Buffer.concat([carry, raw]); carry = null; }
      if (raw.length % 2) { carry = raw.subarray(raw.length - 1); raw = raw.subarray(0, raw.length - 1); }
      return resample(Buffer.from(raw), rate, RATE);
    },
    async finish() {
      if (!mp3.length) return null;
      const all = Buffer.concat(mp3); mp3 = [];
      return ffmpegToPcm(all);
    },
  };
}

class TtsSession {
  constructor({ lang, speaker }) { this.lang = lang; this.speaker = speaker || undefined; this.ws = null; this.pending = null; this.pingTimer = null; }

  async ensure() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const cfg = ttsConfig(this.speaker);
    const ws = await connect(`${base()}/text-to-speech/ws?model=${encodeURIComponent(cfg.model)}&send_completion_event=true`);
    this.ws = ws;
    ws.send(JSON.stringify({
      type: "config",
      data: {
        model: cfg.model, language_code: sarvamLang(this.lang), speaker: cfg.speaker, pace: cfg.pace,
        speech_sample_rate: String(cfg.rate), output_audio_codec: cfg.codec,
        enable_preprocessing: true, min_buffer_size: 30, max_chunk_length: 150,
      },
    }));
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); } catch { /* closing */ } }, 20000);
    this.pingTimer.unref();
    ws.on("close", () => { if (this.ws === ws) { this.ws = null; clearInterval(this.pingTimer); } });
    ws.on("error", () => {});
  }

  // Streams decoded 16 kHz PCM pieces to onPcm while Sarvam generates them. Resolves when the sentence is complete.
  // If Sarvam refuses the requested codec/sample rate, retries once with MP3 output (MP3 needs ffmpeg on the server).
  async synthesize(text, onPcm) {
    try { return await this._synthesize(text, onPcm); }
    catch (err) {
      if (err.cancelled || forcedCodec || ttsConfig().codec === "mp3" || !/codec|format|sample.?rate/i.test(err.message)) throw err;
      console.warn(`[sarvam] ${err.message} - switching to MP3 output (needs ffmpeg)`);
      forcedCodec = "mp3";
      try { this.ws?.close(); } catch { /* closing */ }
      this.ws = null;
      return this._synthesize(text, onPcm);
    }
  }

  async _synthesize(text, onPcm) {
    await this.ensure();
    const ws = this.ws, dec = makeDecoder(ttsConfig(this.speaker));
    return new Promise((resolve, reject) => {
      let done = false, timer;
      const finish = async (err) => {
        if (done) return;
        done = true; clearTimeout(timer);
        ws.off("message", onMessage); ws.off("close", onClose);
        if (this.pending && this.pending.finish === finish) this.pending = null;
        if (err) return reject(err);
        try { const tail = await dec.finish(); if (tail && tail.length) onPcm(tail); resolve(); } catch (e) { reject(e); }
      };
      const onMessage = (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === "audio" && m.data?.audio) {
          try { const pcm = dec.push(m.data.content_type, Buffer.from(m.data.audio, "base64")); if (pcm && pcm.length) onPcm(pcm); }
          catch (e) { finish(e); }
        } else if (m.type === "event" && m.data?.event_type === "final") finish();
        else if (m.type === "error") finish(new Error(m.data?.message || "Sarvam text-to-speech error"));
      };
      const onClose = () => finish(new Error("Sarvam text-to-speech connection closed"));
      ws.on("message", onMessage); ws.on("close", onClose);
      timer = setTimeout(() => finish(new Error("Sarvam text-to-speech timed out")), Number(process.env.SARVAM_TTS_TIMEOUT_MS || 10000));
      this.pending = { finish };
      ws.send(JSON.stringify({ type: "text", data: { text: text.slice(0, 2400) } }));
      ws.send(JSON.stringify({ type: "flush" }));
    });
  }

  // Used on barge-in: stop generating (and stop paying for) the rest of the reply.
  cancel() {
    if (this.pending) { const e = new Error("cancelled"); e.cancelled = true; this.pending.finish(e); }
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
  close() { clearInterval(this.pingTimer); this.cancel(); }
}

// ===================== Phrase cache =====================
// Fixed phrases (greetings, "are you still there?", handoff lines) are synthesised once and replayed free.
const cache = new Map();
let cacheBytes = 0;
const CACHE_MAX_BYTES = 40 * 1024 * 1024;
const cacheKey = (lang, text, speaker) => { const c = ttsConfig(speaker); return `${c.model}|${c.speaker}|${c.codec}|${sarvamLang(lang)}|${text}`; };
const cacheGet = (lang, text, speaker) => cache.get(cacheKey(lang, text, speaker));
function cacheSet(lang, text, pcm, speaker) {
  const key = cacheKey(lang, text, speaker);
  if (cache.has(key)) return;
  cache.set(key, pcm); cacheBytes += pcm.length;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size) {   // evict oldest first
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).length; cache.delete(oldest);
  }
}

module.exports = { configured, SttSession, TtsSession, makeDecoder, ttsConfig, cacheGet, cacheSet, sarvamLang };
