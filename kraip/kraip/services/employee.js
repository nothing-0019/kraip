const db = require("../db");
const { generate } = require("../llm");
const research = require("./research");
const usage = require("../lib/usage");
const { normalizePhone } = require("../lib/phone");
const { httpError } = require("../lib/auth");
const { phrases, languageName } = require("../lib/phrases");

const HANDOFF_REPLY = "Of course. I'm passing this to our team and someone will get back to you shortly.";
const OPT_OUT_REPLY = "Understood. We won't contact you again. Sorry for the interruption.";
const OPT_OUT_RE = /\b(stop calling|do not call|don'?t call|do not contact|don'?t contact|remove (me|my number)|unsubscribe|take me off)\b/i;
const HUMAN_RE = /\b(human|real person|manager|representative|speak to someone|talk to someone)\b/i;

// ---------- Business Twin -> system prompt ----------
function buildSystemPrompt(business, employee, { voice = false } = {}) {
  const section = (title, text) => (text && text.trim() ? `\n## ${title}\n${text.trim()}\n` : "");
  const questions = (employee.qualification_questions || "")
    .split("\n").map((q) => q.trim()).filter(Boolean)
    .map((q, i) => `${i + 1}. ${q}`).join("\n");

  return `You are ${employee.name}, the ${employee.role} for ${business.name}. You are an AI assistant; if asked, say so honestly.
Tone: ${business.tone}.

RULES
- Answer ONLY using the business information below (and any RESEARCH FINDINGS provided). If the answer is not there, say you will check with the team. Never invent prices, policies, or contact details.
- Keep replies short (${voice ? "1-2 sentences, spoken style, no lists or markdown" : "1-3 sentences"}) and natural, like a real employee.
- Reply in ${languageName(employee.language)} unless the customer clearly speaks another language, then follow theirs.
- Ask ONE question at a time. Work these qualification questions in naturally, one by one:
${questions || "(none)"}
- Politely ask for the customer's name and a phone number or email once they show interest.
- If you use research findings, mention the source briefly and say if you are not certain.
- If the customer is upset, asks for a human, or the request is out of scope, offer to hand over to the team.
${employee.instructions ? `\nExtra instructions: ${employee.instructions}\n` : ""}
# BUSINESS INFORMATION
${section("About", business.description)}${section("Services", business.services)}${section("FAQs", business.faqs)}${section("Policies", business.policies)}${section("Opening hours", business.hours)}`;
}

// ---------- One analysis call: lead facts + intent + sentiment + handoff + opt-out + research need ----------
function analysisPrompt(business) {
  const known = `${business.services || ""}\n${business.faqs || ""}`.trim().slice(0, 1200);
  return `Read the conversation. Return ONLY JSON with these keys:
name, phone, email, need, budget, timeline: strings or null. Only what the CUSTOMER clearly stated. Never guess or invent.
intent: "pricing" | "booking" | "support" | "complaint" | "info" | "other"
sentiment: "positive" | "neutral" | "negative"
wants_human: true if the customer asks for a human or manager, or is very upset.
opt_out: true if the customer asks not to be contacted or called again.
needs_research: true ONLY if answering needs current public information that is NOT covered by the business info below (competitor prices, nearby options, market comparisons).
research_query: a short web search query, or null.

Business info already known to the employee:
${known || "(none)"}`;
}

function safeJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
const clean = (v) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().slice(0, 300) : null);
const validEmail = (v) => {
  const s = clean(v);
  return s && /^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s) ? s.toLowerCase() : null;
};
const INTENTS = ["pricing", "booking", "support", "complaint", "info", "other"];
const SENTIMENTS = ["positive", "neutral", "negative"];

async function analyze(business, conversationId) {
  const msgs = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId);
  const transcript = msgs.map((m) => `${m.role === "user" ? "Customer" : "Employee"}: ${m.content}`).join("\n");
  try {
    const { text } = await generate(
      [{ role: "system", content: analysisPrompt(business) }, { role: "user", content: transcript }],
      { json: true, temperature: 0, maxTokens: 350 }
    );
    const raw = safeJson(text);
    if (!raw) return null;
    return {
      lead: { name: clean(raw.name), phone: normalizePhone(clean(raw.phone)), email: validEmail(raw.email), need: clean(raw.need), budget: clean(raw.budget), timeline: clean(raw.timeline) },
      intent: INTENTS.includes(raw.intent) ? raw.intent : "other",
      sentiment: SENTIMENTS.includes(raw.sentiment) ? raw.sentiment : "neutral",
      wants_human: raw.wants_human === true,
      opt_out: raw.opt_out === true,
      needs_research: raw.needs_research === true,
      research_query: clean(raw.research_query),
    };
  } catch (err) {
    console.warn("[analysis] failed:", err.message);
    return null;
  }
}

// ---------- Transparent lead scoring ----------
//  hot  = need + budget + timeline + a way to contact them
//  warm = need + at least one of budget / timeline / contact
//  else = unqualified
function scoreLead(l) {
  const contact = !!(l.phone || l.email);
  if (l.need && l.budget && l.timeline && contact) return "hot";
  if (l.need && (l.budget || l.timeline || contact)) return "warm";
  return "unqualified";
}
const NEXT_ACTION = {
  hot: "Call or message within 1 hour to close",
  warm: "Follow up within 24 hours and confirm missing details",
  unqualified: "Keep in nurture list; ask about their need",
};
const FIELDS = ["name", "phone", "email", "need", "budget", "timeline"];

// Dedupes by phone or email inside the same business, merges new facts into the existing lead
function saveLead(businessId, conversationId, found, source) {
  if (!FIELDS.some((f) => found[f])) return null;
  const byPhone = found.phone && db.prepare("SELECT * FROM leads WHERE business_id = ? AND phone = ? ORDER BY id LIMIT 1").get(businessId, found.phone);
  const byEmail = found.email && db.prepare("SELECT * FROM leads WHERE business_id = ? AND email = ? ORDER BY id LIMIT 1").get(businessId, found.email);
  const byConv = db.prepare("SELECT * FROM leads WHERE conversation_id = ?").get(conversationId);
  const target = byPhone || byEmail || byConv;

  const tx = db.transaction(() => {
    let row;
    if (!target) {
      const info = db.prepare("INSERT INTO leads (business_id, conversation_id, source) VALUES (?, ?, ?)").run(businessId, conversationId, source);
      row = db.prepare("SELECT * FROM leads WHERE id = ?").get(info.lastInsertRowid);
    } else {
      row = target;
      // merge a conversation-only lead into the matched (older) lead, then drop the duplicate
      if (byConv && byConv.id !== target.id) {
        for (const f of FIELDS) if (!row[f] && byConv[f]) row[f] = byConv[f];
        db.prepare("DELETE FROM leads WHERE id = ?").run(byConv.id);
      }
    }
    const merged = {};
    for (const f of FIELDS) merged[f] = found[f] ?? row[f] ?? null;
    merged.score = scoreLead(merged);
    merged.next_action = NEXT_ACTION[merged.score];
    db.prepare(`UPDATE leads SET name=@name, phone=@phone, email=@email, need=@need, budget=@budget, timeline=@timeline,
      score=@score, next_action=@next_action, conversation_id=@conversation_id, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...merged, conversation_id: conversationId, id: row.id });
    const saved = db.prepare("SELECT * FROM leads WHERE id = ?").get(row.id);
    if ((saved.score === "hot" || saved.score === "warm") && !saved.billed) {
      db.prepare("UPDATE leads SET billed = 1 WHERE id = ?").run(saved.id);
      usage.record(businessId, "qualified_lead", 1, { lead_id: saved.id });
    }
    return db.prepare("SELECT * FROM leads WHERE id = ?").get(row.id);
  });
  return tx();
}

function markOptOut(businessId, phone) {
  const p = normalizePhone(phone);
  if (!p) return;
  const info = db.prepare("UPDATE contacts SET opted_out = 1, opted_out_at = datetime('now') WHERE business_id = ? AND phone = ?").run(businessId, p);
  if (!info.changes) {
    db.prepare("INSERT OR IGNORE INTO contacts (business_id, phone, consent, opted_out, opted_out_at) VALUES (?, ?, 0, 1, datetime('now'))").run(businessId, p);
  }
  usage.audit(businessId, null, "contact.opt_out", p);
}

function loadContext(conversationId) {
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId);
  if (!conv) throw httpError(404, "Conversation not found");
  const employee = db.prepare("SELECT * FROM employees WHERE id = ?").get(conv.employee_id);
  const business = db.prepare("SELECT * FROM businesses WHERE id = ?").get(employee.business_id);
  return { conv, employee, business };
}

function saveAssistant(conversationId, content, model = null, latencyMs = null) {
  const info = db.prepare("INSERT INTO messages (conversation_id, role, content, model, latency_ms) VALUES (?, 'assistant', ?, ?, ?)")
    .run(conversationId, content, model, latencyMs);
  return Number(info.lastInsertRowid);
}

// Saves lead facts, intent and sentiment from one analysis result
function applyAnalysis(business, conv, analysis) {
  const found = { ...analysis.lead };
  if (!found.phone && conv.contact_phone) found.phone = conv.contact_phone; // caller ID from the phone network
  const lead = saveLead(business.id, conv.id, found, conv.channel === "phone" ? "phone" : "chat");
  db.prepare("UPDATE conversations SET intent = ?, sentiment = ? WHERE id = ?").run(analysis.intent, analysis.sentiment, conv.id);
  return lead;
}

// Voice calls: the LLM analysis runs after the reply has been sent. If it finds an opt-out the person did not
// say in plain keywords, the contact is suppressed immediately (the live call will end at the next turn).
function analyzeInBackground(business, conv) {
  analyze(business, conv.id).then((a) => {
    if (!a) return;
    applyAnalysis(business, conv, a);
    if (a.opt_out) markOptOut(business.id, conv.contact_phone);
    if (a.wants_human) db.prepare("UPDATE conversations SET status = 'needs_human' WHERE id = ? AND status = 'open'").run(conv.id);
  }).catch((e) => console.warn("[analysis] background failed:", e.message));
}

// ---------- One customer turn (chat, web widget, phone) ----------
async function chat(conversationId, userText, { voice = false } = {}) {
  const { conv, employee, business } = loadContext(conversationId);
  if (conv.channel !== "playground" && employee.status !== "active") throw httpError(409, "Employee is still in draft. Activate it first.");
  const base = { conversationId, status: conv.status, handoff: false, optOut: false, research: null, lead: null };

  db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)").run(conversationId, userText);

  // A human has taken over: store the message, no AI reply
  if (conv.status === "needs_human") return { ...base, reply: null, handoff: true };
  if (conv.status === "closed") throw httpError(409, "This conversation is closed");

  const lang = phrases(employee.language);
  // Phone calls answer first and analyse in the background (saves a full LLM round trip of silence per turn).
  // Opt-out and "human please" are still caught instantly by keyword; the LLM check follows right after.
  const analysis = voice ? null : await analyze(business, conversationId);
  const optOut = OPT_OUT_RE.test(userText) || analysis?.opt_out === true;
  const wantsHuman = HUMAN_RE.test(userText) || analysis?.wants_human === true;

  if (optOut) {
    markOptOut(business.id, conv.contact_phone);
    db.prepare("UPDATE conversations SET status = 'closed', ended_at = datetime('now') WHERE id = ?").run(conversationId);
    const id = saveAssistant(conversationId, lang.optOut);
    return { ...base, reply: lang.optOut, messageId: id, optOut: true, status: "closed" };
  }

  let lead = null;
  if (analysis) lead = applyAnalysis(business, conv, analysis);

  if (wantsHuman) {
    db.prepare("UPDATE conversations SET status = 'needs_human' WHERE id = ?").run(conversationId);
    usage.audit(business.id, null, "conversation.handoff", String(conversationId));
    const id = saveAssistant(conversationId, lang.handoff);
    if (voice) analyzeInBackground(business, conv);
    return { ...base, reply: lang.handoff, messageId: id, handoff: true, status: "needs_human", lead };
  }

  // Live web research only when the employee allows it and the customer needs outside information
  let researchReport = null, researchNote = null;
  if (employee.research_enabled && analysis?.needs_research && analysis.research_query && research.configured()) {
    try {
      researchReport = await research.research(analysis.research_query, { businessId: business.id, conversationId });
      const src = researchReport.sources.map((s) => `[${s.n}] ${s.title} (${s.url}) retrieved ${s.retrieved_at.slice(0, 10)}`).join("\n");
      researchNote = `RESEARCH FINDINGS (confidence: ${researchReport.confidence})\n${researchReport.answer}\n` +
        (researchReport.uncertain.length ? `Uncertain: ${researchReport.uncertain.join("; ")}\n` : "") + `Sources:\n${src}`;
    } catch (err) {
      console.warn("[research] failed:", err.message);
    }
  }

  const history = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20")
    .all(conversationId).reverse();
  const system = [{ role: "system", content: buildSystemPrompt(business, employee, { voice }) }];
  if (researchNote) system.push({ role: "system", content: researchNote });

  const gen = generate([...system, ...history], { maxTokens: voice ? 160 : 512 });
  const result = await gen;
  const reply = (result.text || "").trim() || "Sorry, I didn't catch that. Could you say it again?";
  const messageId = saveAssistant(conversationId, reply, result.model, result.latencyMs);
  usage.record(business.id, "message", 1);
  if (voice) analyzeInBackground(business, conv);

  return {
    ...base, reply, messageId, model: result.model, latencyMs: result.latencyMs, lead, status: "open",
    research: researchReport && { id: researchReport.id, confidence: researchReport.confidence, sources: researchReport.sources },
  };
}

// ---------- Close + summary ----------
async function closeConversation(conversationId, { keepNeedsHuman = false } = {}) {
  const { conv, business } = loadContext(conversationId);
  const msgs = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId);
  let summary = conv.summary || "";
  if (msgs.length) {
    try {
      const transcript = msgs.map((m) => `${m.role === "user" ? "Customer" : "Employee"}: ${m.content}`).join("\n");
      const { text } = await generate([
        { role: "system", content: "Summarise this customer conversation in 2 short sentences: what they wanted and the outcome. Plain text only." },
        { role: "user", content: transcript },
      ], { temperature: 0.2, maxTokens: 120 });
      summary = (text || "").trim().slice(0, 600) || summary;
    } catch (err) { console.warn("[summary] failed:", err.message); }
  }
  // A call that ended while waiting for a human stays flagged so the team still sees it
  const keep = keepNeedsHuman || conv.status === "needs_human" && conv.channel === "phone";
  db.prepare(`UPDATE conversations SET status = CASE WHEN ? AND status = 'needs_human' THEN 'needs_human' ELSE 'closed' END,
    summary = ?, ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?`).run(keep ? 1 : 0, summary, conversationId);
  usage.audit(business.id, null, "conversation.closed", String(conversationId));
  return summary;
}

module.exports = { buildSystemPrompt, chat, closeConversation, scoreLead, saveLead, markOptOut, loadContext, HANDOFF_REPLY, OPT_OUT_REPLY };
