// Audio helpers for the voice path.
// Phone network (Plivo) side: 8 kHz mu-law.  Everything inside KRAIP and towards Sarvam: mono 16-bit PCM @ 16 kHz.
const RATE = 16000;

// ---------- WAV ----------
function pcmToWav(pcm, sampleRate = RATE) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Returns { pcm (16-bit mono LE), sampleRate } or null when the buffer is not a WAV file.
function wavToPcm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12, sampleRate = RATE, channels = 1, format = 1;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body); channels = buf.readUInt16LE(body + 2); sampleRate = buf.readUInt32LE(body + 4);
    } else if (id === "data") {
      // streamed WAVs often carry 0 or 0xFFFFFFFF as the size: take everything that follows
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      let data = buf.subarray(body, body + size);
      if (format === 7) data = mulawDecode(data);                    // mu-law inside a WAV
      if (channels === 2) data = takeLeftChannel(data);
      if (data.length % 2) data = data.subarray(0, data.length - 1);
      return { pcm: Buffer.from(data), sampleRate };
    }
    off = body + size + (size % 2);
  }
  return null;
}

function takeLeftChannel(stereo) {
  const n = stereo.length >> 2, out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(stereo.readInt16LE(i * 4), i * 2);
  return out;
}

// ---------- G.711 mu-law ----------
const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff, sign = u & 0x80, exp = (u >> 4) & 7, man = u & 15;
  const s = (((man << 3) + 0x84) << exp) - 0x84;
  MULAW_DECODE[i] = sign ? -s : s;
}
function mulawDecode(bytes) {
  const out = Buffer.alloc(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) out.writeInt16LE(MULAW_DECODE[bytes[i]], i * 2);
  return out;
}
function linearToMulaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1);
  return ~(sign | (exp << 4) | ((sample >> (exp + 3)) & 0x0f)) & 0xff;
}
function mulawEncode(pcm) {
  const n = pcm.length >> 1, out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = linearToMulaw(pcm.readInt16LE(i * 2));
  return out;
}

// ---------- Resampling ----------
function lowpassKernel(taps, cutoff /* cycles per sample, < 0.5 */) {
  const m = taps - 1, k = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - m / 2;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    k[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / m));   // Hamming window
    sum += k[i];
  }
  for (let i = 0; i < taps; i++) k[i] /= sum;
  return k;
}
const KLEN = 21;
const HALF_BAND = lowpassKernel(KLEN, 3800 / 16000);   // 16 kHz -> 8 kHz: keep speech up to ~3.8 kHz

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));

// Streaming 16 kHz -> 8 kHz (filters first, so there is no harsh aliasing; keeps state between chunks)
class Downsample2 {
  constructor() { this.hist = new Float64Array(KLEN - 1); this.count = 0; }
  push(pcm) {
    const n = pcm.length >> 1, h = this.hist.length;
    const x = new Float64Array(h + n);
    x.set(this.hist);
    for (let i = 0; i < n; i++) x[h + i] = pcm.readInt16LE(i * 2);
    const out = [];
    for (let i = 0; i < n; i++) {
      if ((this.count + i) % 2 !== 0) continue;
      let acc = 0;
      for (let k = 0; k < KLEN; k++) acc += HALF_BAND[k] * x[h + i - k];
      out.push(clamp16(acc));
    }
    this.hist = x.slice(x.length - h);
    this.count += n;
    const buf = Buffer.alloc(out.length * 2);
    out.forEach((v, i) => buf.writeInt16LE(v, i * 2));
    return buf;
  }
}

// Streaming 8 kHz -> 16 kHz (linear interpolation)
class Upsample2 {
  constructor() { this.prev = 0; }
  push(pcm) {
    const n = pcm.length >> 1, out = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const s = pcm.readInt16LE(i * 2);
      out.writeInt16LE(clamp16((this.prev + s) / 2), i * 4);
      out.writeInt16LE(s, i * 4 + 2);
      this.prev = s;
    }
    return out;
  }
}

// One-shot conversion between any two rates (used for unusual TTS sample rates).
function resample(pcm, from, to) {
  if (from === to || !pcm.length) return pcm;
  if (from === 16000 && to === 8000) return new Downsample2().push(pcm);
  if (from === 8000 && to === 16000) return new Upsample2().push(pcm);
  let src = pcm;
  if (to < from) {   // low-pass first to avoid aliasing
    const kernel = lowpassKernel(KLEN, (0.45 * to) / from), n = pcm.length >> 1, half = (KLEN - 1) >> 1;
    src = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = 0; k < KLEN; k++) {
        const j = Math.min(n - 1, Math.max(0, i + k - half));
        acc += kernel[k] * pcm.readInt16LE(j * 2);
      }
      src.writeInt16LE(clamp16(acc), i * 2);
    }
  }
  const inN = src.length >> 1, outN = Math.floor((inN * to) / from), out = Buffer.alloc(outN * 2), ratio = from / to;
  for (let i = 0; i < outN; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, inN - 1), frac = pos - i0;
    const a = src.readInt16LE(i0 * 2), b = src.readInt16LE(i1 * 2);
    out.writeInt16LE(clamp16(a + (b - a) * frac), i * 2);
  }
  return out;
}

function rms(pcm) {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}
const seconds = (pcm, rate = RATE) => pcm.length / 2 / rate;

module.exports = { RATE, pcmToWav, wavToPcm, mulawDecode, mulawEncode, Downsample2, Upsample2, resample, rms, seconds };
