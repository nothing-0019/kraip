// A database created by an older KRAIP version (no payments table, no paid_paise column, duplicate call billing rows,
// duplicate call ids) must open, be cleaned up, and keep working.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os"), fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

test("upgrade from an older database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kraip-mig-"));
  const file = path.join(dir, "old.db");
  const old = new Database(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT DEFAULT '', password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE businesses (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', services TEXT DEFAULT '', faqs TEXT DEFAULT '', policies TEXT DEFAULT '', hours TEXT DEFAULT '', tone TEXT DEFAULT 'x', handoff_number TEXT DEFAULT '', version INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE employees (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL, name TEXT NOT NULL, role TEXT DEFAULT 'Sales assistant', instructions TEXT DEFAULT '', qualification_questions TEXT DEFAULT '', language TEXT DEFAULT 'en-IN', greeting TEXT DEFAULT '', research_enabled INTEGER DEFAULT 1, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, channel TEXT DEFAULT 'playground', direction TEXT DEFAULT 'inbound', status TEXT DEFAULT 'open', contact_phone TEXT, call_sid TEXT, public_token_hash TEXT, intent TEXT, sentiment TEXT, summary TEXT DEFAULT '', duration_seconds INTEGER, created_at TEXT DEFAULT (datetime('now')), ended_at TEXT);
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL, type TEXT NOT NULL, quantity INTEGER DEFAULT 1, meta TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL, period TEXT NOT NULL, amount_paise INTEGER NOT NULL, status TEXT DEFAULT 'open', pay_link TEXT, razorpay_link_id TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE (business_id, period));
    INSERT INTO users (email, password_hash, salt) VALUES ('old@test.com', 'x', 'y');
    INSERT INTO businesses (owner_id, name) VALUES (1, 'Old Co');
    INSERT INTO employees (business_id, name) VALUES (1, 'E');
    INSERT INTO conversations (employee_id, channel, call_sid) VALUES (1, 'phone', 'SID'), (1, 'phone', 'SID');
    INSERT INTO usage_events (business_id, type, quantity, meta) VALUES (1, 'call_seconds', 60, '{"conversation_id":1}'), (1, 'call_seconds', 60, '{"conversation_id":1}'), (1, 'call_seconds', 30, '{"conversation_id":2}');
    INSERT INTO invoices (business_id, period, amount_paise, status) VALUES (1, '2026-01', 700, 'paid');
  `);
  old.close();

  const r = spawnSync(process.execPath, ["-e", `
    const db = require("./db");
    const q = (s) => db.prepare(s).all();
    console.log(JSON.stringify({
      usage: q("SELECT id, quantity FROM usage_events ORDER BY id"),
      cols: q("PRAGMA table_info(invoices)").map((c) => c.name),
      payments: q("SELECT name FROM sqlite_master WHERE name = 'payments'").length,
      employeeVoice: q("PRAGMA table_info(employees)").some((c) => c.name === "voice"),
      callIdx: q("SELECT name FROM sqlite_master WHERE name = 'idx_conv_call_sid'").length,
    }));`], { cwd: path.join(__dirname, ".."), env: { ...process.env, KRAIP_DB: file }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(out.usage.map((u) => u.id), [1, 3], "the duplicate billing row for conversation 1 is removed, the first kept");
  assert.ok(out.cols.includes("paid_paise") && out.cols.includes("paid_at"), "invoice columns added");
  assert.equal(out.payments, 1, "payments table created");
  assert.equal(out.employeeVoice, true, "employees.voice added");
  assert.equal(out.callIdx, 0, "duplicate call ids: guard postponed rather than crashing");
  assert.match(r.stderr + r.stdout, /duplicate call ids/, "and it says so");
  fs.rmSync(dir, { recursive: true, force: true });
});
