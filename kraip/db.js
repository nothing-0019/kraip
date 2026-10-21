const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dir = path.join(__dirname, "data");
fs.mkdirSync(dir, { recursive: true });
const db = new Database(process.env.KRAIP_DB || path.join(dir, "kraip.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");   // wait instead of failing when another process holds the write lock

db.exec(`
-- ===== Accounts & tenants =====
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- ===== Business Twin =====
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  services TEXT DEFAULT '',
  faqs TEXT DEFAULT '',
  policies TEXT DEFAULT '',
  hours TEXT DEFAULT '',
  tone TEXT DEFAULT 'friendly and professional',
  handoff_number TEXT DEFAULT '',
  version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS business_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===== AI employees =====
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'Sales assistant',
  instructions TEXT DEFAULT '',
  qualification_questions TEXT DEFAULT 'What are you looking for?
What is your budget?
When do you need it?',
  language TEXT DEFAULT 'en-IN',
  voice TEXT DEFAULT '',                  -- text-to-speech speaker, e.g. priya (blank = default)
  greeting TEXT DEFAULT '',
  research_enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'draft',            -- draft | active
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===== Conversations =====
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  channel TEXT DEFAULT 'playground',      -- playground | web | phone
  direction TEXT DEFAULT 'inbound',       -- inbound | outbound
  status TEXT DEFAULT 'open',             -- open | needs_human | closed
  contact_phone TEXT,
  call_sid TEXT,
  public_token_hash TEXT,
  intent TEXT, sentiment TEXT,
  summary TEXT DEFAULT '',
  duration_seconds INTEGER,
  duration_source TEXT,                   -- stream (our own timing) | provider (the carrier's figure, authoritative)
  created_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_call ON conversations(call_sid);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                     -- user | assistant
  content TEXT NOT NULL,
  by_human INTEGER DEFAULT 0,
  model TEXT,
  latency_ms INTEGER,
  rating INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===== Leads & prospects =====
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  name TEXT, phone TEXT, email TEXT,
  need TEXT, budget TEXT, timeline TEXT,
  score TEXT DEFAULT 'unqualified',       -- hot | warm | unqualified
  next_action TEXT,
  source TEXT DEFAULT 'chat',             -- chat | phone | discovery
  source_url TEXT,
  billed INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_conv ON leads(conversation_id);

CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT, website TEXT, domain TEXT,
  phone TEXT, email TEXT,
  query TEXT, source_url TEXT, retrieved_at TEXT,
  relevance REAL DEFAULT 0, matched_terms TEXT DEFAULT '',
  status TEXT DEFAULT 'unverified',       -- unverified | converted
  UNIQUE (business_id, domain)
);

CREATE TABLE IF NOT EXISTS research_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  query TEXT, answer TEXT, confidence TEXT,
  uncertain TEXT DEFAULT '',
  sources TEXT,                           -- JSON [{title,url,retrieved_at}]
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===== Consent, campaigns =====
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT, phone TEXT NOT NULL,
  consent INTEGER DEFAULT 0,
  consent_source TEXT, consent_at TEXT,
  opted_out INTEGER DEFAULT 0, opted_out_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (business_id, phone)
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name TEXT NOT NULL, goal TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',            -- draft | running | paused | done
  max_attempts INTEGER DEFAULT 2,
  window_start INTEGER DEFAULT 9,         -- local hour, inclusive
  window_end INTEGER DEFAULT 20,          -- local hour, exclusive
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaign_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending',          -- pending | calling | completed | no_answer | failed | skipped
  attempts INTEGER DEFAULT 0,
  last_attempt_at INTEGER,
  conversation_id INTEGER,
  UNIQUE (campaign_id, contact_id)
);

-- ===== Billing, audit =====
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                     -- message | call_seconds | research | qualified_lead
  quantity INTEGER DEFAULT 1,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_biz ON usage_events(business_id, created_at);

CREATE TABLE IF NOT EXISTS payments (          -- one row per confirmed payment, so a repeated webhook can never count twice
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  provider_payment_id TEXT NOT NULL UNIQUE,
  amount_paise INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period TEXT NOT NULL,                   -- YYYY-MM
  amount_paise INTEGER NOT NULL,
  status TEXT DEFAULT 'open',             -- open | paid
  pay_link TEXT, razorpay_link_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (business_id, period)
);

-- Estimated provider cost of each streamed call (for the margin view)
CREATE TABLE IF NOT EXISTS call_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  seconds INTEGER, tts_chars INTEGER, stt_seconds REAL, llm_turns INTEGER,
  telephony_paise REAL, stt_paise REAL, tts_paise REAL, llm_paise REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Prepaid wallet: every credit and debit that is not metered usage (top-ups, refunds, manual adjustments)
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- topup | refund | adjustment
  amount_paise INTEGER NOT NULL,          -- positive = credit, negative = debit
  provider_ref TEXT UNIQUE,               -- Razorpay payment / refund id: a repeated webhook cannot count twice
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL,
  status TEXT DEFAULT 'created',          -- created | paid | expired | cancelled
  pay_link TEXT, razorpay_link_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Per-business pricing and limits, set by an administrator (blank column = use the global default from .env)
CREATE TABLE IF NOT EXISTS pricing_overrides (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  call_minute_paise INTEGER, lead_call_minute_paise INTEGER, research_paise INTEGER,
  discovered_lead_paise INTEGER, qualified_lead_paise INTEGER, message_paise INTEGER,
  credit_limit_paise INTEGER,             -- postpaid: most unpaid usage allowed
  billing_mode TEXT,                      -- postpaid | prepaid
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- low_balance | limit_reached | ...
  message TEXT NOT NULL,
  dedupe_key TEXT,                        -- at most one notification per key (for example low_balance:2026-10-20)
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (business_id, dedupe_key)
);

-- Callback and booking requests captured from conversations
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                     -- callback | booking
  name TEXT, phone TEXT, preferred_time TEXT, notes TEXT,
  status TEXT DEFAULT 'open',             -- open | done | cancelled
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (conversation_id, kind)
);

-- Knowledge base: uploaded documents, split into searchable pieces
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_biz ON kb_chunks(business_id);

CREATE TABLE IF NOT EXISTS employee_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Discovery (research) jobs: run in the background, with progress and cost
CREATE TABLE IF NOT EXISTS research_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  query TEXT NOT NULL, location TEXT DEFAULT '', requirements TEXT DEFAULT '',
  target INTEGER DEFAULT 100,             -- qualified leads wanted
  max_queries INTEGER DEFAULT 20,         -- search calls allowed (cost cap)
  status TEXT DEFAULT 'queued',           -- queued | running | done | failed | cancelled
  found INTEGER DEFAULT 0, qualified INTEGER DEFAULT 0, queries_run INTEGER DEFAULT 0,
  cost_paise INTEGER DEFAULT 0, error TEXT,
  created_at TEXT DEFAULT (datetime('now')), finished_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER, user_id INTEGER,
  action TEXT NOT NULL, detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Upgrades for databases created by an earlier version of KRAIP
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("employees", "voice", "TEXT DEFAULT ''");
for (const [col, ddl] of [["website", "TEXT DEFAULT ''"], ["address", "TEXT DEFAULT ''"], ["products", "TEXT DEFAULT ''"], ["contact_phone", "TEXT DEFAULT ''"], ["contact_email", "TEXT DEFAULT ''"]]) ensureColumn("businesses", col, ddl);
ensureColumn("conversations", "redacted_at", "TEXT");
ensureColumn("employees", "version", "INTEGER DEFAULT 1");
ensureColumn("employees", "escalation_rules", "TEXT DEFAULT ''");
ensureColumn("employees", "objective", "TEXT DEFAULT ''");
ensureColumn("campaigns", "daily_limit", "INTEGER DEFAULT 0");
ensureColumn("contacts", "dnd", "INTEGER DEFAULT 0");
ensureColumn("contacts", "prospect_id", "INTEGER");
ensureColumn("prospects", "qualified", "INTEGER DEFAULT 0");
ensureColumn("prospects", "phone_valid", "INTEGER DEFAULT 0");
ensureColumn("prospects", "website_ok", "INTEGER DEFAULT 0");
ensureColumn("prospects", "job_id", "INTEGER");
ensureColumn("invoices", "paid_paise", "INTEGER DEFAULT 0");
ensureColumn("invoices", "paid_at", "TEXT");
ensureColumn("campaign_contacts", "claimed_at", "INTEGER");

// One call-time usage record per conversation, enforced by the database (a duplicate provider callback or a second
// worker cannot bill the same call twice). Older databases may already hold duplicates: keep the first of each.
db.exec(`DELETE FROM usage_events WHERE type = 'call_seconds' AND json_extract(meta, '$.conversation_id') IS NOT NULL AND id NOT IN (
  SELECT MIN(id) FROM usage_events WHERE type = 'call_seconds' AND json_extract(meta, '$.conversation_id') IS NOT NULL
  GROUP BY json_extract(meta, '$.conversation_id'))`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_call_once ON usage_events (json_extract(meta, '$.conversation_id')) WHERE type = 'call_seconds'`);
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_call_sid ON conversations (employee_id, call_sid) WHERE call_sid IS NOT NULL"); }
catch { console.warn("[db] duplicate call ids exist from an older version; the one-conversation-per-call guard is not active until they are cleaned up"); }
db.exec("CREATE INDEX IF NOT EXISTS idx_cc_status ON campaign_contacts (campaign_id, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (expires_at)");

module.exports = db;
