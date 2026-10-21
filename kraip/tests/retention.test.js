// Data retention, export, erasure, deletion.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os"), fs = require("fs"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kraip-ret-"));
process.env.KRAIP_DB = path.join(dir, "ret.db");
const db = require("../db");
const auth = require("../lib/auth");
const usage = require("../lib/usage");
const retention = require("../services/retention");
const { boot, checker } = require("./harness");

test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const { user } = auth.signup({ email: `r${Math.random().toString(36).slice(2, 8)}@t.com`, password: "password123" });
  const biz = Number(db.prepare("INSERT INTO businesses (owner_id, name) VALUES (?, 'Co')").run(user.id).lastInsertRowid);
  const emp = Number(db.prepare("INSERT INTO employees (business_id, name, status) VALUES (?, 'E', 'active')").run(biz).lastInsertRowid);
  return { user, biz, emp };
}
const conv = (emp, phone, created = "+0 days") => {
  const id = Number(db.prepare("INSERT INTO conversations (employee_id, channel, contact_phone, summary, duration_seconds, created_at, ended_at) VALUES (?, 'phone', ?, 'secret summary', 30, datetime('now', ?), datetime('now', ?))").run(emp, phone, created, created).lastInsertRowid);
  db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'my number is private'), (?, 'assistant', 'ok')").run(id, id);
  usage.record(db.prepare("SELECT business_id FROM employees WHERE id = ?").get(emp).business_id, "call_seconds", 30, { conversation_id: id, lead_call: false });
  return id;
};

test("redaction removes content but keeps billing and counts", () => {
  const { biz, emp } = seed(); const c = conv(emp, "+919800000001");
  assert.equal(retention.redactConversation(c), 2);
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(c);
  assert.equal(row.contact_phone, null); assert.equal(row.summary, ""); assert.ok(row.redacted_at); assert.equal(row.duration_seconds, 30);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(c).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_events WHERE business_id = ? AND type = 'call_seconds'").get(biz).n, 1, "the call is still billed and counted");
});

test("purge removes only data older than the cutoff", () => {
  const { biz, emp } = seed();
  const oldId = conv(emp, "+919800000002", "-40 days"), newId = conv(emp, "+919800000003");
  db.prepare("INSERT INTO research_reports (business_id, query, answer, created_at) VALUES (?, 'q', 'a', datetime('now', '-40 days')), (?, 'q', 'a', datetime('now'))").run(biz, biz);
  assert.throws(() => retention.purgeOlderThan(0, biz), /1 or more/);
  assert.throws(() => retention.purgeOlderThan("x", biz));
  const r = retention.purgeOlderThan(30, biz);
  assert.equal(r.conversations, 1); assert.equal(r.research_reports, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(oldId).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(newId).n, 2, "recent conversation untouched");
  assert.equal(retention.purgeOlderThan(30, biz).conversations, 0, "running again does nothing");
});

test("erasing a contact removes their data but keeps an opt-out", () => {
  const { biz, emp } = seed();
  const mk = (phone, opted) => Number(db.prepare("INSERT INTO contacts (business_id, name, phone, consent, consent_source, opted_out) VALUES (?, 'Ravi', ?, 1, 'form', ?)").run(biz, phone, opted).lastInsertRowid);
  const plain = mk("+919810000001", 0), optedOut = mk("+919810000002", 1);
  for (const p of ["+919810000001", "+919810000002"]) { conv(emp, p); db.prepare("INSERT INTO leads (business_id, phone, name) VALUES (?, ?, 'Ravi')").run(biz, p); }
  const ex = retention.exportContact(biz, plain);
  assert.equal(ex.conversations.length, 1); assert.equal(ex.conversations[0].messages.length, 2); assert.equal(ex.leads.length, 1); assert.equal(ex.conversations[0].public_token_hash, undefined);
  const r1 = retention.eraseContact(biz, plain, null);
  assert.deepEqual([r1.contact_removed, r1.leads, r1.conversations], [true, 1, 1]);
  assert.equal(db.prepare("SELECT 1 FROM contacts WHERE id = ?").get(plain), undefined);
  const r2 = retention.eraseContact(biz, optedOut, null);
  assert.deepEqual([r2.contact_removed, r2.opt_out_kept], [false, true]);
  const kept = db.prepare("SELECT * FROM contacts WHERE id = ?").get(optedOut);
  assert.equal(kept.opted_out, 1); assert.equal(kept.name, null); assert.equal(kept.consent, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE business_id = ?").get(biz).n, 0);
  assert.equal(retention.eraseContact(biz, 999999, null), null);
  assert.equal(retention.eraseContact(biz + 1000, optedOut, null), null, "another business's id finds nothing");
});

test("API: ownership, deletion and business removal", { timeout: 90000 }, async (t) => {
  const T = await boot({ RAZORPAY_KEY_ID: null });
  t.after(() => T.stop());
  const ok = checker(), api = T.api;
  const A = await T.signup(), B = await T.signup();
  const biz = (await api("/api/businesses", { method: "POST", token: A, body: { name: "Sunrise Dental" } })).data;
  const emp = (await api("/api/employees", { method: "POST", token: A, body: { business_id: biz.id, name: "Aria" } })).data;
  await api(`/api/employees/${emp.id}/activate`, { method: "POST", token: A });
  const c = (await api("/api/conversations", { method: "POST", token: A, body: { employee_id: emp.id } })).data;
  await api(`/api/conversations/${c.id}/messages`, { method: "POST", token: A, body: { content: "Hi I'm Ravi. I need whitening. Call 9876543210" } });
  await api("/api/contacts/import", { method: "POST", token: A, body: { business_id: biz.id, csv: "Ravi,9876543210,yes,signup form" } });
  const contact = (await api(`/api/contacts?business_id=${biz.id}`, { token: A })).data[0];
  const lead = (await api(`/api/leads?business_id=${biz.id}`, { token: A })).data[0];

  ok("B cannot delete A's conversation, lead or contact, nor export or purge", (await api(`/api/conversations/${c.id}`, { method: "DELETE", token: B })).status === 404 && (await api(`/api/leads/${lead.id}`, { method: "DELETE", token: B })).status === 404
    && (await api(`/api/contacts/${contact.id}`, { method: "DELETE", token: B })).status === 404 && (await api(`/api/contacts/${contact.id}/export`, { token: B })).status === 404
    && (await api("/api/retention/purge", { method: "POST", token: B, body: { business_id: biz.id, older_than_days: 1 } })).status === 404 && (await api(`/api/businesses/${biz.id}`, { method: "DELETE", token: B, body: { confirm: "Sunrise Dental" } })).status === 404);
  ok("purge needs a sensible number of days", (await api("/api/retention/purge", { method: "POST", token: A, body: { business_id: biz.id, older_than_days: 0 } })).status === 400);
  const exp = await api(`/api/contacts/${contact.id}/export`, { token: A });
  ok("the owner can export a contact's data", exp.status === 200 && exp.data.contact.phone === "+919876543210" && exp.data.leads.length === 1);
  const del = await api(`/api/conversations/${c.id}`, { method: "DELETE", token: A });
  ok("deleting a conversation removes its messages", del.status === 200 && del.data.messages_deleted >= 2 && (await api(`/api/conversations/${c.id}/messages`, { token: A })).data.messages.length === 0);
  ok("deleting a lead works", (await api(`/api/leads/${lead.id}`, { method: "DELETE", token: A })).status === 200 && (await api(`/api/leads?business_id=${biz.id}`, { token: A })).data.length === 0);
  const er = await api(`/api/contacts/${contact.id}`, { method: "DELETE", token: A });
  ok("erasing a contact works and is logged", er.status === 200 && er.data.contact_removed === true && (await api(`/api/audit?business_id=${biz.id}`, { token: A })).data.some((a) => a.action === "contact.erased"));
  ok("deleting a business needs its exact name", (await api(`/api/businesses/${biz.id}`, { method: "DELETE", token: A, body: { confirm: "nope" } })).status === 400 && (await api(`/api/businesses/${biz.id}`, { method: "DELETE", token: A, body: {} })).status === 400);
  const owed = (await api("/api/businesses", { method: "POST", token: A, body: { name: "Owes Money" } })).data;
  ok("an unused business can be deleted with the exact name", (await api(`/api/businesses/${owed.id}`, { method: "DELETE", token: A, body: { confirm: "Owes Money" } })).data.deleted === true && (await api("/api/businesses", { token: A })).data.every((b) => b.id !== owed.id));
  ok("the deleted business is gone for good", (await api(`/api/leads?business_id=${owed.id}`, { token: A })).status === 404);
  ok.done(assert);
});
