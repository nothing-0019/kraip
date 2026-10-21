const db = require("../db");

// Prices in INR, configurable in .env. Stored/computed in paise (integers) to avoid rounding errors.
const paise = (inr) => Math.round(Number(inr) * 100);
const OVERRIDE_COLS = { call_minute: "call_minute_paise", lead_call_minute: "lead_call_minute_paise", research: "research_paise",
  discovered_lead: "discovered_lead_paise", qualified_lead: "qualified_lead_paise", message: "message_paise" };

// Global defaults from .env, then any per-business override set by an administrator
function rates(businessId = null) {
  const r = {
    call_minute: paise(process.env.RATE_PER_MINUTE_INR ?? 3.5),           // normal calls
    lead_call_minute: paise(process.env.RATE_PER_LEAD_MINUTE_INR ?? 5),   // calls that produced a qualified (hot/warm) lead
    qualified_lead: paise(process.env.RATE_PER_LEAD_INR ?? 0),            // optional extra flat fee per qualified lead
    research: paise(process.env.RATE_PER_RESEARCH_INR ?? 2),              // one web-research report
    discovered_lead: paise(process.env.RATE_PER_DISCOVERED_LEAD_INR ?? 0),// one qualified lead found by a discovery job
    message: paise(process.env.RATE_PER_MESSAGE_INR ?? 0),
  };
  if (businessId) {
    const o = db.prepare("SELECT * FROM pricing_overrides WHERE business_id = ?").get(businessId);
    if (o) for (const [key, col] of Object.entries(OVERRIDE_COLS)) if (o[col] !== null && o[col] !== undefined) r[key] = o[col];
  }
  return r;
}

function record(businessId, type, quantity = 1, meta = null) {
  db.prepare("INSERT INTO usage_events (business_id, type, quantity, meta) VALUES (?, ?, ?, ?)")
    .run(businessId, type, quantity, meta ? JSON.stringify(meta) : null);
}

function summarize(businessId, month) {
  const r = rates(businessId);
  const rows = db.prepare(`
    SELECT type, quantity, meta FROM usage_events
    WHERE business_id = ? AND strftime('%Y-%m', created_at) = ?`).all(businessId, month);

  const t = { message: 0, research: 0, discovered_lead: 0, qualified_lead: 0, call_seconds: 0, normal_minutes: 0, lead_minutes: 0, calls: 0 };
  for (const e of rows) {
    if (e.type === "call_seconds") {
      const minutes = Math.ceil(e.quantity / 60); // each call rounds up to a full minute
      let meta = {};
      try { meta = JSON.parse(e.meta || "{}"); } catch { /* no meta */ }
      // decided once when the call ended, so a later lead edit cannot silently change a past invoice
      if (meta.lead_call) t.lead_minutes += minutes; else t.normal_minutes += minutes;
      t.call_seconds += e.quantity;
      t.calls += 1;
    } else if (t[e.type] !== undefined) t[e.type] += e.quantity;
  }
  const lines = [
    { key: "call_minute", label: "Call minutes (rounded up per call)", quantity: t.normal_minutes, rate_paise: r.call_minute },
    { key: "lead_call_minute", label: "Lead call minutes (call produced a hot/warm lead)", quantity: t.lead_minutes, rate_paise: r.lead_call_minute },
    { key: "qualified_lead", label: "Qualified lead fee", quantity: t.qualified_lead, rate_paise: r.qualified_lead },
    { key: "research", label: "Web research reports", quantity: t.research, rate_paise: r.research },
    { key: "discovered_lead", label: "Leads found by discovery jobs", quantity: t.discovered_lead, rate_paise: r.discovered_lead },
    { key: "message", label: "Chat messages", quantity: t.message, rate_paise: r.message },
  ].map((l) => ({ ...l, amount_paise: l.quantity * l.rate_paise }));

  const total = lines.reduce((s, l) => s + l.amount_paise, 0);

  // Estimated provider cost of the month's calls (telephony + speech + LLM) and what is left after it
  const c = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(telephony_paise),0) tel, COALESCE(SUM(stt_paise),0) stt, COALESCE(SUM(tts_paise),0) tts, COALESCE(SUM(llm_paise),0) llm
    FROM call_costs WHERE business_id = ? AND strftime('%Y-%m', created_at) = ?`).get(businessId, month);
  const cost = Math.round(c.tel + c.stt + c.tts + c.llm);
  const callRevenue = lines.filter((l) => l.key === "call_minute" || l.key === "lead_call_minute").reduce((s, l) => s + l.amount_paise, 0);
  const margin = {
    estimated_cost_paise: cost, calls_costed: c.n,
    breakdown: { telephony: Math.round(c.tel), speech_to_text: Math.round(c.stt), text_to_speech: Math.round(c.tts), llm: Math.round(c.llm) },
    call_revenue_paise: callRevenue,
    margin_paise: callRevenue - cost,
    margin_pct: callRevenue > 0 ? Math.round(((callRevenue - cost) / callRevenue) * 1000) / 10 : null,
    note: "Estimate from published provider rates; check against your real Plivo, Sarvam and LLM bills.",
  };

  return { month, calls: t.calls, call_seconds: t.call_seconds, lines, total_paise: total, margin };
}

// Usage charges per calendar month in paise, computed in SQL with the same rules as summarize()
// (each call rounds up to a full minute, lead calls use the lead rate).
function monthlyCharges(businessId) {
  const r = rates(businessId);
  return db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS period,
      COALESCE(SUM(CASE type
        WHEN 'call_seconds' THEN ((quantity + 59) / 60) * (CASE WHEN json_extract(meta, '$.lead_call') THEN @lead ELSE @normal END)
        WHEN 'research' THEN quantity * @research
        WHEN 'discovered_lead' THEN quantity * @discovered
        WHEN 'qualified_lead' THEN quantity * @leadFee
        WHEN 'message' THEN quantity * @message
        ELSE 0 END), 0) AS charge_paise
    FROM usage_events WHERE business_id = @b GROUP BY period`)
    .all({ b: businessId, lead: r.lead_call_minute, normal: r.call_minute, research: r.research, discovered: r.discovered_lead, leadFee: r.qualified_lead, message: r.message });
}

function audit(businessId, userId, action, detail = "") {
  db.prepare("INSERT INTO audit_log (business_id, user_id, action, detail) VALUES (?, ?, ?, ?)")
    .run(businessId ?? null, userId ?? null, action, typeof detail === "string" ? detail : JSON.stringify(detail));
}

module.exports = { record, summarize, monthlyCharges, audit, rates };
