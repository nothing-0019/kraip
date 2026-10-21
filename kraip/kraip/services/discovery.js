const db = require("../db");
const { search } = require("./research");
const { safeFetch, allowedByRobots, htmlToText } = require("../lib/security");
const { normalizePhone } = require("../lib/phone");

// Contact details are only taken when the page itself publishes them (tel:/mailto: links or
// "Phone: ..." style text). Nothing is guessed. A published number is NOT consent to be cold-called.
function extractPhone(html, text) {
  const found = [];
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) found.push(m[1]);
  for (const m of text.matchAll(/(?:phone|tel|call|mobile|whatsapp)[^\d+]{0,15}(\+?\d[\d\s().-]{8,16}\d)/gi)) found.push(m[1]);
  for (const f of found) {
    const n = normalizePhone(decodeURIComponent(f));
    if (n) return n;
  }
  return null;
}

function extractEmail(html, text) {
  const bad = /\.(png|jpe?g|gif|svg|webp)$|^(example|test|your)@|sentry|wixpress/i;
  for (const m of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) if (!bad.test(m[1])) return m[1].toLowerCase();
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!bad.test(m[0])) return m[0].toLowerCase();
  return null;
}

async function discover(businessId, { query, location = "", requirements = [], limit = 8 }) {
  query = String(query || "").trim();
  if (!query) throw Object.assign(new Error("query is required"), { status: 400 });
  const reqs = (Array.isArray(requirements) ? requirements : String(requirements).split(","))
    .map((r) => r.trim().toLowerCase()).filter(Boolean);

  const results = await search(`${query} ${location}`.trim(), Math.min(limit, 10));
  const retrievedAt = new Date().toISOString();
  const added = [], duplicates = [], skipped = [];

  for (const r of results.slice(0, limit)) {
    let domain;
    try { domain = new URL(r.url).hostname.replace(/^www\./, ""); } catch { continue; }
    if (db.prepare("SELECT 1 FROM prospects WHERE business_id = ? AND domain = ?").get(businessId, domain)) {
      duplicates.push(domain); continue;
    }
    let html = "", text = r.snippet || "";
    try {
      if (await allowedByRobots(r.url)) {
        html = (await safeFetch(r.url)).body;
        text = htmlToText(html);
      } else skipped.push(`${domain} (robots.txt)`);
    } catch { /* keep the snippet only */ }

    const lower = (text + " " + (r.title || "")).toLowerCase();
    const matched = reqs.filter((q) => lower.includes(q));
    const relevance = reqs.length ? matched.length / reqs.length : 0;

    const info = db.prepare(`INSERT OR IGNORE INTO prospects
      (business_id, name, website, domain, phone, email, query, source_url, retrieved_at, relevance, matched_terms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      businessId, (r.title || domain).slice(0, 120), new URL(r.url).origin, domain,
      extractPhone(html, text), extractEmail(html, text),
      `${query} ${location}`.trim(), r.url, retrievedAt, relevance, matched.join(", "));
    if (info.changes) added.push(db.prepare("SELECT * FROM prospects WHERE id = ?").get(info.lastInsertRowid));
  }
  return { added, duplicates, skipped };
}

module.exports = { discover };
