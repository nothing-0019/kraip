// Plivo: call control (REST), webhook authentication and the XML Plivo expects back.
const crypto = require("crypto");

const API = () => (process.env.PLIVO_API_BASE || "https://api.plivo.com").replace(/\/$/, "");
const publicUrl = () => (process.env.PUBLIC_URL || "").replace(/\/$/, "");
// Signs the webhook key and the audio-stream token. WEBHOOK_SECRET is optional: without it a secret is derived from your Plivo token.
const secret = () => process.env.WEBHOOK_SECRET ||
  (process.env.PLIVO_AUTH_TOKEN ? crypto.createHash("sha256").update(`kraip-webhook:${process.env.PLIVO_AUTH_TOKEN}`).digest("hex") : "");
const hmacHex = (data) => crypto.createHmac("sha256", secret()).update(data).digest("hex");
const maxCallSeconds = () => Number(process.env.MAX_CALL_SECONDS || 900);

const configured = () => !!(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN && process.env.PLIVO_PHONE_NUMBER &&
  publicUrl() && process.env.SARVAM_API_KEY && secret());

// ---------- Webhook authentication ----------
// 1) every URL we hand to Plivo carries ?k=<key>, derived per employee, so the key one business sees
//    in its own settings can never be used against another business's endpoints
// 2) Plivo's own X-Plivo-Signature-V3 is also accepted (HMAC-SHA256 with your Auth Token). Only a V3-signed request
//    is allowed to set the billed duration of a call (the ?k= key alone proves routing, not that Plivo sent it).
const webhookKey = (employeeId) => hmacHex(`plivo-webhook:${Number(employeeId)}`).slice(0, 32);
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const seenNonces = new Map();   // replay protection: a captured signed request cannot be sent again
function freshNonce(nonce) {
  const now = Date.now();
  if (seenNonces.size > 10000) for (const [n, t] of seenNonces) if (now - t > 10 * 60_000) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now);
  return true;
}

function signatureV3Valid(req) {
  const header = req.headers["x-plivo-signature-v3"], nonce = req.headers["x-plivo-signature-v3-nonce"];
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!header || !nonce || !token) return false;
  const url = publicUrl() + req.originalUrl;
  const params = req.method === "POST" ? req.body || {} : {};
  const sorted = Object.keys(params).sort().map((k) => k + params[k]).join("");
  // Plivo's docs are not explicit about the separators, so accept the documented variants (all need your Auth Token)
  // A POST signature must cover the body parameters; a variant that ignores them would let a captured header be reused with a new body
  const candidates = req.method === "POST" ? [`${url}.${sorted}.${nonce}`, `${url}${sorted}.${nonce}`] : [`${url}.${nonce}`];
  const signatures = String(header).split(",").map((s) => s.trim());
  const ok = candidates.some((c) => {
    const expected = crypto.createHmac("sha256", token).update(c).digest("base64");
    return signatures.some((s) => safeEqual(expected, s));
  });
  return ok && freshNonce(String(nonce));
}
// Returns { ok, signed }: ok = the request may be processed, signed = Plivo's own signature was verified
function authenticate(req, employeeId) {
  if (signatureV3Valid(req)) return { ok: true, signed: true };
  const key = req.query.k;
  const good = typeof key === "string" && !!secret() && !!employeeId && safeEqual(key, webhookKey(employeeId));
  return { ok: good, signed: false };
}
const validRequest = (req, employeeId) => authenticate(req, employeeId).ok;

// ---------- Signed WebSocket URL for the audio stream ----------
const streamSig = (convId, exp) => hmacHex(`stream.${convId}.${exp}`);
function streamUrl(convId) {
  const exp = Math.floor(Date.now() / 1000) + 120;   // Plivo connects within seconds of the answer
  const host = publicUrl().replace(/^http/, "ws");
  return `${host}/plivo-stream?conv=${convId}&exp=${exp}&sig=${streamSig(convId, exp)}`;
}
function verifyStreamToken(convId, exp, sig) {
  if (!convId || !exp || !sig || !secret() || exp < Date.now() / 1000) return false;
  return safeEqual(sig, streamSig(convId, exp));
}

// ---------- XML ----------
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const wrap = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const streamXml = (convId) => wrap(`<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${esc(streamUrl(convId))}</Stream>`);
const speakHangupXml = (text) => wrap(`<Speak>${esc(text)}</Speak><Hangup/>`);
const hangupXml = (text) => (text ? speakHangupXml(text) : wrap("<Hangup/>"));
function dialXml({ number, text }) {
  const callerId = process.env.PLIVO_PHONE_NUMBER ? ` callerId="${esc(process.env.PLIVO_PHONE_NUMBER)}"` : "";
  return wrap(`${text ? `<Speak>${esc(text)}</Speak>` : ""}<Dial${callerId}><Number>${esc(number)}</Number></Dial>`);
}

// ---------- REST ----------
async function api(method, path, body) {
  const id = process.env.PLIVO_AUTH_ID;
  const res = await fetch(`${API()}/v1/Account/${id}${path}`, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${process.env.PLIVO_AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 404) throw new Error(`Plivo error ${res.status}: ${data.error || data.message || "request failed"}`);
  return { status: res.status, data };
}

async function placeCall({ to, employeeId, campaignContactId }) {
  const k = webhookKey(employeeId), base = publicUrl();
  const body = {
    from: process.env.PLIVO_PHONE_NUMBER, to,
    answer_url: `${base}/plivo/${employeeId}/outbound?cc=${campaignContactId}&k=${k}`, answer_method: "POST",
    hangup_url: `${base}/plivo/${employeeId}/hangup?cc=${campaignContactId}&k=${k}`, hangup_method: "POST",
    ring_timeout: 25,
    time_limit: maxCallSeconds() + 30,   // provider-side safety cap, a little above our own limit
  };
  // Optional: drop calls that reach voicemail instead of paying to talk to a machine
  if (process.env.PLIVO_MACHINE_DETECTION === "hangup") { body.machine_detection = "hangup"; body.machine_detection_time = 3000; }
  const { data } = await api("POST", "/Call/", body);
  return data.request_uuid || data.requestUuid || null;
}
const hangup = (callUuid) => api("DELETE", `/Call/${encodeURIComponent(callUuid)}/`);
const transfer = (callUuid, url) => api("POST", `/Call/${encodeURIComponent(callUuid)}/`, { legs: "aleg", aleg_url: url, aleg_method: "POST" });
const transferUrl = (employeeId, convId, speak = false) => `${publicUrl()}/plivo/${employeeId}/handoff?conv=${convId}${speak ? "&s=1" : ""}&k=${webhookKey(employeeId)}`;

const endUrl = (employeeId) => `${publicUrl()}/plivo/${employeeId}/end?k=${webhookKey(employeeId)}`;   // XML that just hangs up (fallback if DELETE is refused)

// Paths (relative to PUBLIC_URL) to paste into the Plivo Application, per employee
const answerPath = (employeeId) => `/plivo/${employeeId}/answer?k=${webhookKey(employeeId)}`;
const hangupPath = (employeeId) => `/plivo/${employeeId}/hangup?k=${webhookKey(employeeId)}`;

module.exports = {
  configured, validRequest, authenticate, webhookKey, streamUrl, verifyStreamToken, streamXml, speakHangupXml, hangupXml, dialXml,
  placeCall, hangup, transfer, transferUrl, endUrl, maxCallSeconds, answerPath, hangupPath, publicUrl,
};
