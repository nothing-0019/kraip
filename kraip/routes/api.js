const express = require("express");
const db = require("../db");
const { rateLimit } = require("../lib/security");
const { getBusiness, getEmployee, getConversation, httpError } = require("../lib/auth");
const { normalizePhone } = require("../lib/phone");
const usage = require("../lib/usage");
const research = require("../services/research");
const telephony = require("../services/phone"); // Plivo or Twilio, whichever is configured
const sarvam = require("../services/sarvam");
const campaignsSvc = require("../services/campaigns");
const billing = require("../services/billing");
const retention = require("../services/retention");
const { discover } = require("../services/discovery");
const { chat, closeConversation, buildSystemPrompt } = require("../services/employee");

const router = express.Router();
// Endpoints that spend money (model calls, web search, crawling) get a tighter per-user limit than the general one
const costly = rateLimit({ max: Number(process.env.COSTLY_PER_MINUTE || 30), windowMs: 60_000, key: (req) => `c${req.user.id}` });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Text fields are capped and must be strings (an object or array in the body would otherwise crash the query)
const LIMITS = { name: 120, role: 120, description: 4000, services: 8000, faqs: 12000, policies: 8000, hours: 500, tone: 200, instructions: 4000,
  qualification_questions: 2000, greeting: 500, handoff_number: 30, language: 12, voice: 30 };
function cleanFields(body, keys) {
  const out = {};
  for (const k of keys) {
    const v = body?.[k];
    if (v === undefined) continue;
    if (k === "research_enabled") { out[k] = v === true || v === 1 || v === "1" || v === "true" ? 1 : 0; continue; }
    if (v === null) { out[k] = ""; continue; }
    if (typeof v !== "string") throw httpError(400, `${k} must be text`);
    out[k] = v.trim().slice(0, LIMITS[k] || 1000);
  }
  if (out.language !== undefined && !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(out.language)) throw httpError(400, "language must look like en-IN or hi");
  if (out.voice && !/^[a-z0-9_-]{2,30}$/i.test(out.voice)) throw httpError(400, "voice must be a speaker name such as priya");
  if (out.handoff_number) {
    const n = normalizePhone(out.handoff_number);
    if (!n) throw httpError(400, "handoff_number must be a valid phone number");
    out.handoff_number = n;
  }
  if (out.name !== undefined && !out.name) throw httpError(400, "name cannot be empty");
  return out;
}
const insert = (table, data) => {
  const cols = Object.keys(data);
  return Number(db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(data).lastInsertRowid);
};
const bizOf = (req) => {
  const id = Number(req.query.business_id ?? req.body?.business_id);
  if (!id) throw httpError(400, "business_id is required");
  return getBusiness(req, id);
};

router.get("/system", (req, res) => {
  res.json({
    llm: process.env.LLM_PROVIDER || "gemini",
    llm_fallback: process.env.LLM_FALLBACK || null,
    web_search: research.configured(),
    telephony: telephony.configured(),
    phone_provider: telephony.provider(),
    voice_ai: telephony.provider() === "plivo" ? sarvam.configured() : true, // Twilio uses its own speech engine
    razorpay: billing.razorpayConfigured(),
    billing_mode: process.env.BILLING_MODE === "prepaid" ? "prepaid" : "postpaid",
    public_url: telephony.publicUrl() || null,
    webhook_paths: Object.fromEntries(db.prepare("SELECT e.id FROM employees e JOIN businesses b ON b.id = e.business_id WHERE b.owner_id = ?")
      .all(req.user.id).map((e) => [e.id, telephony.webhookPath(e.id)])),
  });
});

// ===== Business Twin =====
const BIZ_FIELDS = ["name", "description", "services", "faqs", "policies", "hours", "tone", "handoff_number"];

router.get("/businesses", (req, res) => {
  res.json(db.prepare("SELECT * FROM businesses WHERE owner_id = ? ORDER BY id DESC").all(req.user.id));
});

router.post("/businesses", wrap(async (req, res) => {
  if (!req.body.name) throw httpError(400, "name is required");
  const id = insert("businesses", { owner_id: req.user.id, ...cleanFields(req.body, BIZ_FIELDS) });
  usage.audit(id, req.user.id, "business.created", req.body.name);
  res.status(201).json(db.prepare("SELECT * FROM businesses WHERE id = ?").get(id));
}));

router.put("/businesses/:id", wrap(async (req, res) => {
  const biz = getBusiness(req, req.params.id);
  const data = cleanFields(req.body, BIZ_FIELDS);
  const cols = Object.keys(data);
  if (!cols.length) throw httpError(400, "nothing to update");
  // Keep version history of the Business Twin
  db.prepare("INSERT INTO business_versions (business_id, version, snapshot) VALUES (?, ?, ?)").run(biz.id, biz.version, JSON.stringify(biz));
  db.prepare(`UPDATE businesses SET ${cols.map((c) => `${c} = @${c}`).join(",")}, version = version + 1 WHERE id = @id`).run({ ...data, id: biz.id });
  usage.audit(biz.id, req.user.id, "business.updated", cols.join(","));
  res.json(db.prepare("SELECT * FROM businesses WHERE id = ?").get(biz.id));
}));

router.get("/businesses/:id/versions", (req, res) => {
  const biz = getBusiness(req, req.params.id);
  res.json(db.prepare("SELECT id, version, created_at FROM business_versions WHERE business_id = ? ORDER BY id DESC").all(biz.id));
});

// ===== AI employees =====
const EMP_FIELDS = ["name", "role", "instructions", "qualification_questions", "language", "voice", "greeting", "research_enabled"];

router.get("/employees", (req, res) => {
  const biz = bizOf(req);
  res.json(db.prepare("SELECT * FROM employees WHERE business_id = ? ORDER BY id DESC").all(biz.id));
});

router.post("/employees", wrap(async (req, res) => {
  const biz = bizOf(req);
  if (!req.body.name) throw httpError(400, "name is required");
  const id = insert("employees", { business_id: biz.id, ...cleanFields(req.body, EMP_FIELDS) });
  usage.audit(biz.id, req.user.id, "employee.created", req.body.name);
  res.status(201).json(db.prepare("SELECT * FROM employees WHERE id = ?").get(id));
}));

router.put("/employees/:id", wrap(async (req, res) => {
  const emp = getEmployee(req, req.params.id);
  const data = cleanFields(req.body, EMP_FIELDS);
  const cols = Object.keys(data);
  if (!cols.length) throw httpError(400, "nothing to update");
  db.prepare(`UPDATE employees SET ${cols.map((c) => `${c} = @${c}`).join(",")} WHERE id = @id`).run({ ...data, id: emp.id });
  res.json(db.prepare("SELECT * FROM employees WHERE id = ?").get(emp.id));
}));

for (const [action, status] of [["activate", "active"], ["draft", "draft"]]) {
  router.post(`/employees/:id/${action}`, wrap(async (req, res) => {
    const emp = getEmployee(req, req.params.id);
    db.prepare("UPDATE employees SET status = ? WHERE id = ?").run(status, emp.id);
    usage.audit(emp.business_id, req.user.id, `employee.${action}`, String(emp.id));
    res.json(db.prepare("SELECT * FROM employees WHERE id = ?").get(emp.id));
  }));
}

// ===== Conversations / inbox =====
router.get("/conversations", (req, res) => {
  const biz = bizOf(req);
  const status = req.query.status;
  res.json(db.prepare(`
    SELECT c.*, e.name AS employee_name,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c JOIN employees e ON e.id = c.employee_id
    WHERE e.business_id = ? ${status ? "AND c.status = ?" : ""}
    ORDER BY (c.status = 'needs_human') DESC, c.id DESC LIMIT 100`).all(...(status ? [biz.id, status] : [biz.id])));
});

router.post("/conversations", wrap(async (req, res) => {
  const emp = getEmployee(req, req.body.employee_id);
  const id = insert("conversations", { employee_id: emp.id, channel: "playground" });
  res.status(201).json({ id });
}));

router.post("/conversations/:id/messages", costly, wrap(async (req, res) => {
  const conv = getConversation(req, req.params.id);
  const content = String(req.body.content || "").trim();
  if (!content) throw httpError(400, "content is required");
  res.json(await chat(conv.id, content.slice(0, 2000)));
}));

router.get("/conversations/:id/messages", (req, res) => {
  const conv = getConversation(req, req.params.id);
  res.json({
    conversation: conv,
    lead: db.prepare("SELECT * FROM leads WHERE conversation_id = ?").get(conv.id) || null,
    messages: db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id").all(conv.id),
  });
});

router.post("/conversations/:id/human-reply", wrap(async (req, res) => {
  const conv = getConversation(req, req.params.id);
  const content = String(req.body.content || "").trim();
  if (!content) throw httpError(400, "content is required");
  db.prepare("INSERT INTO messages (conversation_id, role, content, by_human) VALUES (?, 'assistant', ?, 1)").run(conv.id, content.slice(0, 2000));
  usage.audit(conv.business_id, req.user.id, "conversation.human_reply", String(conv.id));
  res.json({ ok: true });
}));

router.post("/conversations/:id/resume-ai", wrap(async (req, res) => {
  const conv = getConversation(req, req.params.id);
  db.prepare("UPDATE conversations SET status = 'open' WHERE id = ? AND status = 'needs_human'").run(conv.id);
  res.json({ ok: true });
}));

router.post("/conversations/:id/close", costly, wrap(async (req, res) => {
  const conv = getConversation(req, req.params.id);
  res.json({ summary: await closeConversation(conv.id) });
}));

router.post("/messages/:id/rating", wrap(async (req, res) => {
  const rating = Number(req.body.rating);
  if (![1, -1, 0].includes(rating)) throw httpError(400, "rating must be 1, -1 or 0");
  const msg = db.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(req.params.id);
  if (!msg) throw httpError(404, "Message not found");
  getConversation(req, msg.conversation_id);
  db.prepare("UPDATE messages SET rating = ? WHERE id = ?").run(rating === 0 ? null : rating, req.params.id);
  res.json({ ok: true });
}));

// ===== Leads =====
router.get("/leads", (req, res) => {
  const biz = bizOf(req);
  const score = req.query.score;
  res.json(db.prepare(`SELECT * FROM leads WHERE business_id = ? ${score ? "AND score = ?" : ""} ORDER BY updated_at DESC`)
    .all(...(score ? [biz.id, score] : [biz.id])));
});

// Phone numbers are normalised server-side to "+digits" so they are safe as-is; every other text
// column gets a leading apostrophe if it starts with = + - @ (blocks spreadsheet formula injection).
const SAFE_COLUMNS = new Set(["id", "phone", "updated_at"]);
const csvCell = (v, column) => {
  let s = v == null ? "" : String(v);
  if (!SAFE_COLUMNS.has(column) && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};
router.get("/leads.csv", (req, res) => {
  const biz = bizOf(req);
  const rows = db.prepare("SELECT * FROM leads WHERE business_id = ? ORDER BY updated_at DESC").all(biz.id);
  const cols = ["id", "name", "phone", "email", "need", "budget", "timeline", "score", "next_action", "source", "source_url", "updated_at"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=kraip-leads.csv");
  res.send([cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c], c)).join(","))].join("\n"));
});

// ===== Web research =====
router.post("/research", costly, wrap(async (req, res) => {
  const biz = bizOf(req);
  res.json(await research.research(req.body.query, { businessId: biz.id }));
}));
router.get("/research", (req, res) => {
  const biz = bizOf(req);
  res.json(db.prepare("SELECT * FROM research_reports WHERE business_id = ? ORDER BY id DESC LIMIT 30").all(biz.id)
    .map((r) => ({ ...r, sources: JSON.parse(r.sources || "[]"), uncertain: JSON.parse(r.uncertain || "[]") })));
});

// ===== Lead discovery (public sources) =====
router.post("/discovery", costly, wrap(async (req, res) => {
  const biz = bizOf(req);
  const out = await discover(biz.id, { query: req.body.query, location: req.body.location, requirements: req.body.requirements });
  usage.audit(biz.id, req.user.id, "discovery.run", `${req.body.query} ${req.body.location || ""}`);
  res.json(out);
}));
router.get("/prospects", (req, res) => {
  const biz = bizOf(req);
  res.json(db.prepare("SELECT * FROM prospects WHERE business_id = ? ORDER BY relevance DESC, id DESC").all(biz.id));
});
router.post("/prospects/:id/to-lead", wrap(async (req, res) => {
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(req.params.id);
  if (!p) throw httpError(404, "Prospect not found");
  getBusiness(req, p.business_id);
  const existing = (p.phone && db.prepare("SELECT id FROM leads WHERE business_id = ? AND phone = ?").get(p.business_id, p.phone)) ||
    (p.email && db.prepare("SELECT id FROM leads WHERE business_id = ? AND email = ?").get(p.business_id, p.email));
  const id = existing ? existing.id : insert("leads", {
    business_id: p.business_id, name: p.name, phone: p.phone, email: p.email, source: "discovery", source_url: p.source_url,
    need: p.matched_terms ? `Matches: ${p.matched_terms}` : null, score: "unqualified",
    next_action: "Review fit, then reach out through a permitted channel (not an automated call without consent)",
  });
  db.prepare("UPDATE prospects SET status = 'converted' WHERE id = ?").run(p.id);
  res.json({ lead_id: id, duplicate: !!existing });
}));

// ===== Contacts & consent =====
const YES = /^(yes|y|true|1|consented)$/i;
router.post("/contacts/import", wrap(async (req, res) => {
  const biz = bizOf(req);
  // CSV lines: name,phone,consent(yes/no),consent_source   e.g.  Ravi,9876543210,yes,signup form 12 Oct
  const result = { imported: 0, with_consent: 0, no_consent_recorded: 0, skipped_invalid: 0, kept_opted_out: 0 };
  const upsert = db.prepare(`INSERT INTO contacts (business_id, name, phone, consent, consent_source, consent_at)
    VALUES (@business_id, @name, @phone, @consent, @source, CASE WHEN @consent = 1 THEN datetime('now') END)
    ON CONFLICT(business_id, phone) DO UPDATE SET name = COALESCE(excluded.name, name),
      consent = CASE WHEN contacts.opted_out = 1 THEN 0 ELSE MAX(contacts.consent, excluded.consent) END,
      consent_source = CASE WHEN excluded.consent = 1 AND contacts.opted_out = 0 THEN excluded.consent_source ELSE contacts.consent_source END,
      consent_at = CASE WHEN excluded.consent = 1 AND contacts.opted_out = 0 AND contacts.consent = 0 THEN datetime('now') ELSE contacts.consent_at END`);
  const lines = String(req.body.csv || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5000);
  db.transaction(() => {
    for (const line of lines) {
      const [name, phoneRaw, consentRaw = "", source = ""] = line.split(",").map((s) => s.trim());
      if (/^name$/i.test(name) && /phone/i.test(phoneRaw || "")) continue; // header row
      const phone = normalizePhone(phoneRaw);
      if (!phone) { result.skipped_invalid++; continue; }
      const existing = db.prepare("SELECT opted_out FROM contacts WHERE business_id = ? AND phone = ?").get(biz.id, phone);
      if (existing?.opted_out) { result.kept_opted_out++; continue; }
      // Consent only counts when the CSV says yes AND names where/how it was given
      const consent = YES.test(consentRaw) && source ? 1 : 0;
      upsert.run({ business_id: biz.id, name: name || null, phone, consent, source: source || null });
      result.imported++;
      consent ? result.with_consent++ : result.no_consent_recorded++;
    }
  })();
  usage.audit(biz.id, req.user.id, "contacts.import", JSON.stringify(result));
  res.json(result);
}));
router.get("/contacts", (req, res) => {
  const biz = bizOf(req);
  res.json(db.prepare("SELECT * FROM contacts WHERE business_id = ? ORDER BY id DESC LIMIT 500").all(biz.id));
});
router.post("/contacts/:id/opt-out", wrap(async (req, res) => {
  const c = db.prepare("SELECT * FROM contacts WHERE id = ?").get(req.params.id);
  if (!c) throw httpError(404, "Contact not found");
  getBusiness(req, c.business_id);
  db.prepare("UPDATE contacts SET opted_out = 1, opted_out_at = datetime('now') WHERE id = ?").run(c.id);
  usage.audit(c.business_id, req.user.id, "contact.opt_out", c.phone);
  res.json({ ok: true });
}));

// ===== Campaigns =====
function getCampaign(req, id) {
  const c = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  if (!c) throw httpError(404, "Campaign not found");
  getBusiness(req, c.business_id);
  return c;
}
router.post("/campaigns", wrap(async (req, res) => {
  const biz = bizOf(req);
  const emp = getEmployee(req, req.body.employee_id);
  if (emp.business_id !== biz.id) throw httpError(400, "Employee belongs to a different business");
  if (typeof req.body.name !== "string" || !req.body.name.trim()) throw httpError(400, "name is required");
  const windowStart = Math.min(Math.max(Math.floor(Number(req.body.window_start ?? 9)) || 0, 0), 23);
  const windowEnd = Math.min(Math.max(Math.floor(Number(req.body.window_end ?? 20)) || 0, 1), 24);
  if (windowStart >= windowEnd) throw httpError(400, "Calling window must end after it starts (for example 9 to 20)");
  const id = insert("campaigns", {
    business_id: biz.id, employee_id: emp.id, name: req.body.name.trim().slice(0, 120), goal: String(req.body.goal || "").slice(0, 500),
    max_attempts: Math.min(Math.max(Number(req.body.max_attempts) || 2, 1), 5),
    window_start: windowStart, window_end: windowEnd,
  });
  // Enrol every contact that has recorded consent and has not opted out
  db.prepare(`INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id)
    SELECT ?, id FROM contacts WHERE business_id = ? AND consent = 1 AND opted_out = 0`).run(id, biz.id);
  usage.audit(biz.id, req.user.id, "campaign.created", req.body.name);
  res.status(201).json({ id, progress: campaignsSvc.progress(id) });
}));
router.get("/campaigns", (req, res) => {
  const biz = bizOf(req);
  res.json(db.prepare("SELECT * FROM campaigns WHERE business_id = ? ORDER BY id DESC").all(biz.id)
    .map((c) => ({ ...c, progress: campaignsSvc.progress(c.id) })));
});
router.get("/campaigns/:id/dry-run", (req, res) => res.json(campaignsSvc.dryRun(getCampaign(req, req.params.id).id)));
router.post("/campaigns/:id/start", wrap(async (req, res) => {
  const c = getCampaign(req, req.params.id);
  if (!telephony.configured()) throw httpError(501, "Phone calling is not configured. Set the PLIVO_* (or TWILIO_*) values and PUBLIC_URL in .env");
  if (telephony.provider() === "plivo" && !sarvam.configured()) throw httpError(501, "Set SARVAM_API_KEY in .env for AI voice on Plivo calls");
  const emp = db.prepare("SELECT status FROM employees WHERE id = ?").get(c.employee_id);
  if (emp.status !== "active") throw httpError(409, "Activate the employee before starting a campaign");
  if (!billing.spendStatus(c.business_id).ok) throw httpError(402, "Spending limit reached. Pay the outstanding invoice to start a campaign.");
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(c.id);
  usage.audit(c.business_id, req.user.id, "campaign.started", String(c.id));
  res.json({ ...(await campaignsSvc.dispatch(c.id)), progress: campaignsSvc.progress(c.id) });
}));
router.post("/campaigns/:id/pause", wrap(async (req, res) => {
  const c = getCampaign(req, req.params.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(c.id);
  usage.audit(c.business_id, req.user.id, "campaign.paused", String(c.id));
  res.json({ ok: true });
}));

// ===== Billing =====
router.get("/billing/usage", wrap(async (req, res) => {
  const biz = bizOf(req);
  const month = String(req.query.month || billing.month());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw httpError(400, "month must look like 2026-10");
  res.json(usage.summarize(biz.id, month));
}));
router.get("/billing/status", (req, res) => res.json(billing.spendStatus(bizOf(req).id)));
router.post("/billing/invoice", wrap(async (req, res) => {
  const biz = bizOf(req);
  res.json(billing.createInvoice(biz.id, req.body.month || billing.month()));
}));
router.get("/billing/invoices", (req, res) => {
  const biz = bizOf(req);
  res.json(db.prepare("SELECT * FROM invoices WHERE business_id = ? ORDER BY period DESC").all(biz.id)
    .map((i) => ({ ...i, due_paise: Math.max(0, i.amount_paise - (i.paid_paise || 0)) })));
});
router.post("/billing/invoices/:id/pay-link", wrap(async (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) throw httpError(404, "Invoice not found");
  getBusiness(req, inv.business_id);
  res.json({ url: await billing.createPayLink(inv, req.user) });
}));

// ----- Wallet, notifications, effective pricing -----
router.get("/billing/wallet", (req, res) => res.json(billing.wallet(bizOf(req).id)));
router.post("/billing/topup", wrap(async (req, res) => {
  const biz = bizOf(req);
  res.status(201).json(await billing.createTopup(biz.id, req.user, req.body.amount_inr));
}));
router.get("/billing/pricing", (req, res) => {
  const biz = bizOf(req), r = usage.rates(biz.id), s = billing.settings(biz.id);
  res.json({ rates_paise: r, billing_mode: s.mode, credit_limit_paise: s.limit });
});
router.get("/notifications", (req, res) => {
  const biz = bizOf(req);
  res.json(db.prepare("SELECT id, kind, message, read_at, created_at FROM notifications WHERE business_id = ? ORDER BY id DESC LIMIT 50").all(biz.id));
});
router.post("/notifications/read", wrap(async (req, res) => {
  const biz = bizOf(req);
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE business_id = ? AND read_at IS NULL").run(biz.id);
  res.json({ ok: true });
}));

// ===== Administration (ADMIN_EMAILS only) =====
// Pricing and limits are the platform operator's to set, never the customer's. With ADMIN_EMAILS unset nobody is an admin.
const adminEmails = () => String(process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const requireAdmin = (req, res, next) => (adminEmails().includes(String(req.user.email).toLowerCase()) ? next() : res.status(403).json({ error: "Administrator access required" }));
router.get("/admin/me", (req, res) => res.json({ admin: adminEmails().includes(String(req.user.email).toLowerCase()) }));
router.get("/admin/businesses", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT b.id, b.name, u.email AS owner_email, b.created_at FROM businesses b JOIN users u ON u.id = b.owner_id ORDER BY b.id DESC LIMIT 500").all()
    .map((b) => ({ ...b, ...billing.spendStatus(b.id), overrides: db.prepare("SELECT * FROM pricing_overrides WHERE business_id = ?").get(b.id) || null })));
});
const PRICE_FIELDS = { call_minute_inr: "call_minute_paise", lead_call_minute_inr: "lead_call_minute_paise", research_inr: "research_paise",
  discovered_lead_inr: "discovered_lead_paise", qualified_lead_inr: "qualified_lead_paise", message_inr: "message_paise", credit_limit_inr: "credit_limit_paise" };
router.get("/admin/pricing/:businessId", requireAdmin, (req, res) => {
  const id = Number(req.params.businessId);
  if (!db.prepare("SELECT 1 FROM businesses WHERE id = ?").get(id)) throw httpError(404, "Business not found");
  res.json({ overrides: db.prepare("SELECT * FROM pricing_overrides WHERE business_id = ?").get(id) || null, effective_rates_paise: usage.rates(id), ...billing.settings(id) });
});
router.put("/admin/pricing/:businessId", requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.businessId);
  if (!db.prepare("SELECT 1 FROM businesses WHERE id = ?").get(id)) throw httpError(404, "Business not found");
  const data = {};
  for (const [field, col] of Object.entries(PRICE_FIELDS)) {
    if (req.body[field] === undefined) continue;
    if (req.body[field] === null || req.body[field] === "") { data[col] = null; continue; }   // back to the default
    const v = Math.round(Number(req.body[field]) * 100);
    if (!Number.isFinite(v) || v < 0 || v > 100_000_000) throw httpError(400, `${field} must be a number of rupees, 0 or more`);
    data[col] = v;
  }
  if (req.body.billing_mode !== undefined) {
    if (req.body.billing_mode !== null && !["postpaid", "prepaid"].includes(req.body.billing_mode)) throw httpError(400, "billing_mode must be postpaid or prepaid");
    data.billing_mode = req.body.billing_mode;
  }
  const cols = Object.keys(data);
  if (!cols.length) throw httpError(400, "nothing to update");
  db.prepare("INSERT OR IGNORE INTO pricing_overrides (business_id) VALUES (?)").run(id);
  db.prepare(`UPDATE pricing_overrides SET ${cols.map((c) => `${c} = @${c}`).join(",")}, updated_at = datetime('now') WHERE business_id = @id`).run({ ...data, id });
  usage.audit(id, req.user.id, "admin.pricing_changed", JSON.stringify(req.body));
  res.json({ overrides: db.prepare("SELECT * FROM pricing_overrides WHERE business_id = ?").get(id), effective_rates_paise: usage.rates(id), ...billing.settings(id) });
}));
router.post("/admin/wallet/:businessId/adjust", requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.businessId);
  if (!db.prepare("SELECT 1 FROM businesses WHERE id = ?").get(id)) throw httpError(404, "Business not found");
  billing.adjustWallet(id, Math.round(Number(req.body.amount_inr) * 100), req.body.note, req.user.id);
  res.json(billing.wallet(id));
}));

// ===== Data retention, export and deletion =====
router.delete("/conversations/:id", wrap(async (req, res) => {
  const conv = getConversation(req, req.params.id);
  const messages = retention.redactConversation(conv.id);
  usage.audit(conv.business_id, req.user.id, "conversation.deleted", String(conv.id));
  res.json({ ok: true, messages_deleted: messages });
}));
router.delete("/leads/:id", wrap(async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) throw httpError(404, "Lead not found");
  getBusiness(req, lead.business_id);
  db.prepare("DELETE FROM leads WHERE id = ?").run(lead.id);
  usage.audit(lead.business_id, req.user.id, "lead.deleted", String(lead.id));
  res.json({ ok: true });
}));
router.get("/contacts/:id/export", wrap(async (req, res) => {
  const c = db.prepare("SELECT business_id FROM contacts WHERE id = ?").get(req.params.id);
  if (!c) throw httpError(404, "Contact not found");
  getBusiness(req, c.business_id);
  usage.audit(c.business_id, req.user.id, "contact.exported", String(req.params.id));
  res.json(retention.exportContact(c.business_id, Number(req.params.id)));
}));
router.delete("/contacts/:id", wrap(async (req, res) => {
  const c = db.prepare("SELECT business_id FROM contacts WHERE id = ?").get(req.params.id);
  if (!c) throw httpError(404, "Contact not found");
  getBusiness(req, c.business_id);
  res.json(retention.eraseContact(c.business_id, Number(req.params.id), req.user.id));
}));
router.post("/retention/purge", wrap(async (req, res) => {
  const biz = bizOf(req);
  const result = retention.purgeOlderThan(req.body.older_than_days, biz.id);
  usage.audit(biz.id, req.user.id, "retention.purge", JSON.stringify({ older_than_days: req.body.older_than_days, ...result }));
  res.json(result);
}));
router.delete("/businesses/:id", wrap(async (req, res) => {
  const biz = getBusiness(req, req.params.id);
  if (req.body?.confirm !== biz.name) throw httpError(400, "Send {\"confirm\": \"<the exact business name>\"} to delete this business and all its data");
  res.json(retention.deleteBusiness(biz.id, req.user.id));
}));

// ===== Dashboard, audit, fine-tune export =====
router.get("/stats", (req, res) => {
  const biz = bizOf(req);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const conv = "FROM conversations c JOIN employees e ON e.id = c.employee_id WHERE e.business_id = ?";
  res.json({
    conversations: one(`SELECT COUNT(*) AS n ${conv}`, biz.id).n,
    needs_human: one(`SELECT COUNT(*) AS n ${conv} AND c.status = 'needs_human'`, biz.id).n,
    calls: one(`SELECT COUNT(*) AS n ${conv} AND c.channel = 'phone'`, biz.id).n,
    leads: one("SELECT COUNT(*) AS n FROM leads WHERE business_id = ?", biz.id).n,
    hot: one("SELECT COUNT(*) AS n FROM leads WHERE business_id = ? AND score = 'hot'", biz.id).n,
    warm: one("SELECT COUNT(*) AS n FROM leads WHERE business_id = ? AND score = 'warm'", biz.id).n,
    avgLatencyMs: Math.round(one(`SELECT AVG(m.latency_ms) AS a FROM messages m JOIN conversations c ON c.id = m.conversation_id
      JOIN employees e ON e.id = c.employee_id WHERE e.business_id = ? AND m.latency_ms IS NOT NULL`, biz.id).a || 0),
  });
});
router.get("/audit", (req, res) => {
  const biz = bizOf(req);
  res.json(db.prepare("SELECT * FROM audit_log WHERE business_id = ? ORDER BY id DESC LIMIT 100").all(biz.id));
});

// Only replies you rated thumbs-up, only from your own business. Use only data you are allowed to train on.
router.get("/export/finetune.jsonl", (req, res) => {
  const biz = bizOf(req);
  const good = db.prepare(`
    SELECT m.id, m.conversation_id, m.content, c.employee_id FROM messages m
    JOIN conversations c ON c.id = m.conversation_id JOIN employees e ON e.id = c.employee_id
    WHERE m.rating = 1 AND e.business_id = ?`).all(biz.id);
  const lines = good.map((g) => {
    const emp = db.prepare("SELECT * FROM employees WHERE id = ?").get(g.employee_id);
    const prior = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id").all(g.conversation_id, g.id);
    return JSON.stringify({ messages: [{ role: "system", content: buildSystemPrompt(biz, emp) }, ...prior, { role: "assistant", content: g.content }] });
  });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Content-Disposition", "attachment; filename=kraip-finetune.jsonl");
  res.send(lines.join("\n"));
});

module.exports = router;
