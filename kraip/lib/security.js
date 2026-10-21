const dns = require("dns").promises;
const net = require("net");

// ---------- Rate limiting (in-memory; use Redis when you run more than one server) ----------
function rateLimit({ max, windowMs, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(k, h); }
    if (++h.count > max) {
      res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: "Too many requests, slow down" });
    }
    next();
  };
}

// ---------- Safe outbound fetching (blocks requests to private networks) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
  }
  return true;
}

async function assertPublicUrl(urlString) {
  const u = new URL(urlString);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http/https URLs are allowed");
  if (process.env.KRAIP_ALLOW_PRIVATE_URLS === "1") return u; // for automated tests only
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Blocked: private address");
  return u;
}

const UA = process.env.CRAWLER_USER_AGENT || "KRAIPBot/0.1";

async function safeFetch(urlString, { timeoutMs = 8000, maxBytes = 400_000, accept = "text/html,text/plain,application/json" } = {}) {
  let url = urlString;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: "manual", signal: ctrl.signal,
        headers: { "User-Agent": UA, Accept: accept },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location"), url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      if (!/text|json|xml/i.test(type)) throw new Error("Unsupported content type");
      const reader = res.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size >= maxBytes) { ctrl.abort(); break; }
      }
      return { url, body: Buffer.concat(chunks).toString("utf8").slice(0, maxBytes) };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects");
}

// ---------- robots.txt (be a polite crawler) ----------
const robotsCache = new Map();
async function allowedByRobots(urlString) {
  try {
    const u = new URL(urlString);
    let rules = robotsCache.get(u.origin);
    if (!rules || rules.expires < Date.now()) {
      let disallow = [];
      try {
        const { body } = await safeFetch(`${u.origin}/robots.txt`, { timeoutMs: 4000, maxBytes: 50_000, accept: "text/plain" });
        let applies = false;
        for (const raw of body.split(/\r?\n/)) {
          const line = raw.split("#")[0].trim();
          const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
          if (!m) continue;
          const field = m[1].toLowerCase(), value = m[2].trim();
          if (field === "user-agent") applies = value === "*" || UA.toLowerCase().startsWith(value.toLowerCase());
          else if (field === "disallow" && applies && value) disallow.push(value);
        }
      } catch { /* no robots.txt reachable: allowed */ }
      rules = { disallow, expires: Date.now() + 60 * 60 * 1000 };
      robotsCache.set(u.origin, rules);
    }
    return !rules.disallow.some((p) => (u.pathname + u.search).startsWith(p));
  } catch { return false; }
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|header|footer|nav)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

// ---------- Tiny concurrency gate so a traffic burst cannot overload the model ----------
function createGate(limit) {
  let active = 0; const queue = [];
  const next = () => { if (active < limit && queue.length) { active++; queue.shift()(); } };
  return async (fn) => {
    await new Promise((resolve) => { queue.push(resolve); next(); });
    try { return await fn(); } finally { active--; next(); }
  };
}

module.exports = { rateLimit, safeFetch, allowedByRobots, htmlToText, assertPublicUrl, isPrivateIp, createGate };
