const crypto = require("crypto");

const publicUrl = () => (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const configured = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER && publicUrl());

// Twilio signs every webhook. Without this check anyone could POST fake calls to your server.
function validSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sig = req.headers["x-twilio-signature"];
  if (!token || !sig) return false;
  const params = req.body || {};
  const data = publicUrl() + req.originalUrl + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", token).update(data).digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const wrap = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const say = (text, lang) => `<Say language="${esc(lang)}">${esc(text)}</Say>`;

function gatherTwiml({ text, action, lang }) {
  return wrap(
    `<Gather input="speech" action="${esc(action)}" method="POST" language="${esc(lang)}" speechTimeout="auto">${say(text, lang)}</Gather>` +
    `${say("I didn't hear anything. Goodbye.", lang)}<Hangup/>`
  );
}
const hangupTwiml = (text, lang = "en-IN") => wrap(`${say(text, lang)}<Hangup/>`);
const dialTwiml = (text, number, lang = "en-IN") => wrap(`${say(text, lang)}<Dial>${esc(number)}</Dial>`);

async function placeCall({ to, employeeId, campaignContactId }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const base = process.env.TWILIO_API_BASE || "https://api.twilio.com";
  const body = new URLSearchParams({
    To: to,
    From: process.env.TWILIO_PHONE_NUMBER,
    Url: `${publicUrl()}/voice/${employeeId}/outbound?cc=${campaignContactId}`,
    StatusCallback: `${publicUrl()}/voice/${employeeId}/status?cc=${campaignContactId}`,
    StatusCallbackEvent: "completed",
    Timeout: "25",
    TimeLimit: String(Number(process.env.MAX_CALL_SECONDS || 900) + 30),   // provider-side cap on call length
  });
  const res = await fetch(`${base}/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio error ${res.status}: ${data.message || "call failed"}`);
  return data.sid;
}

module.exports = { configured, validSignature, gatherTwiml, hangupTwiml, dialTwiml, placeCall, publicUrl };
