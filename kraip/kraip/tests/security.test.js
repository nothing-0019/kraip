// Authentication, sessions, input validation, rate limits, tenant isolation, health checks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, checker } = require("./harness");

test("security: auth, validation, isolation, limits, health", { timeout: 120000 }, async (t) => {
  const T = await boot({ COSTLY_PER_MINUTE: "4", MAX_PUBLIC_MESSAGES: "3" });
  t.after(() => T.stop());
  const ok = checker();
  const api = T.api;

  // ---------- health ----------
  const hz = await api("/healthz"), rz = await api("/readyz");
  ok("health endpoints answer without login and expose no secrets", hz.status === 200 && hz.data.ok && rz.status === 200 && !/key|token|secret/i.test(hz.text + rz.text));
  ok("X-Powered-By header is off", !hz.headers.get("x-powered-by"));
  const page = await fetch(T.base + "/"), widget = await fetch(T.base + "/widget.html");
  ok("pages carry a strict Content-Security-Policy and cannot be framed", /default-src 'self'/.test(page.headers.get("content-security-policy")) && /frame-ancestors 'none'/.test(page.headers.get("content-security-policy")) && page.headers.get("x-frame-options") === "DENY");
  ok("the chat widget can be embedded on other sites", /frame-ancestors \*/.test(widget.headers.get("content-security-policy")) && !widget.headers.get("x-frame-options"));

  // ---------- accounts ----------
  const A = await T.signup("a@test.com"), B = await T.signup("b@test.com");
  ok("password over 200 chars rejected", (await api("/auth/signup", { method: "POST", body: { email: "long@test.com", password: "x".repeat(201) } })).status === 400);
  ok("non-text email/password rejected, not a crash", (await api("/auth/signup", { method: "POST", body: { email: { a: 1 }, password: ["x"] } })).status === 400);
  ok("login with non-text password is a clean 401", (await api("/auth/login", { method: "POST", body: { email: "a@test.com", password: { $ne: 1 } } })).status === 401);
  ok("invalid JSON body is a 400, not a 500", (await api("/auth/login", { method: "POST", body: "{not json" })).status === 400);
  ok("oversized body is refused", (await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "x@test.com", password: "y".repeat(2_000_000) }) })).status === 413);
  ok("no token / garbage token / wrong scheme all 401", (await api("/api/businesses")).status === 401 && (await api("/api/businesses", { token: "x".repeat(300) })).status === 401 && (await api("/api/businesses", { headers: { Authorization: "Basic abc" } })).status === 401);
  ok("unknown API route is a JSON 404", (await api("/api/nope", { token: A })).status === 404);
  const tok = await T.signup("c@test.com");
  ok("session works, then logout kills it", (await api("/auth/me", { token: tok })).status === 200 && (await api("/auth/logout", { method: "POST", token: tok })).status === 200 && (await api("/auth/me", { token: tok })).status === 401);

  // ---------- mass assignment and input validation ----------
  const biz = (await api("/api/businesses", { method: "POST", token: A, body: { name: "Sunrise", owner_id: 9999, version: 50, handoff_number: "+91 90000 00001" } })).data;
  ok("owner_id / version in the body are ignored; phone number normalised", biz.version === 1 && (await api("/api/businesses", { token: A })).data.length === 1 && biz.handoff_number === "+919000000001", biz);
  ok("invalid handoff number rejected", (await api(`/api/businesses/${biz.id}`, { method: "PUT", token: A, body: { handoff_number: "abc" } })).status === 400);
  ok("object where text is expected is rejected", (await api("/api/businesses", { method: "POST", token: A, body: { name: { x: 1 } } })).status === 400);
  const emp = (await api("/api/employees", { method: "POST", token: A, body: { business_id: biz.id, name: "Aria", status: "active", business_id_override: 1, language: "en-IN" } })).data;
  ok("employee status cannot be set through the body", emp.status === "draft", emp);
  ok("bad language / voice values rejected", (await api(`/api/employees/${emp.id}`, { method: "PUT", token: A, body: { language: "english please" } })).status === 400 && (await api(`/api/employees/${emp.id}`, { method: "PUT", token: A, body: { voice: "../../etc" } })).status === 400);
  const upd = (await api(`/api/employees/${emp.id}`, { method: "PUT", token: A, body: { name: "N".repeat(500), business_id: 99 } })).data;
  ok("long text is capped and business_id cannot be moved", upd.name.length === 120 && upd.business_id === biz.id, upd);
  ok("research_enabled is coerced to 0/1", (await api(`/api/employees/${emp.id}`, { method: "PUT", token: A, body: { research_enabled: "nope" } })).data.research_enabled === 0);
  await api(`/api/employees/${emp.id}/activate`, { method: "POST", token: A });

  // ---------- tenant isolation (writes as well as reads) ----------
  ok("B cannot create an employee inside A's business", (await api("/api/employees", { method: "POST", token: B, body: { business_id: biz.id, name: "Evil" } })).status === 404);
  ok("B cannot edit A's business or employee", (await api(`/api/businesses/${biz.id}`, { method: "PUT", token: B, body: { name: "Hacked" } })).status === 404 && (await api(`/api/employees/${emp.id}`, { method: "PUT", token: B, body: { name: "Hacked" } })).status === 404);
  const bBiz = (await api("/api/businesses", { method: "POST", token: B, body: { name: "B Co" } })).data;
  ok("B cannot build a campaign mixing B's business with A's employee", (await api("/api/campaigns", { method: "POST", token: B, body: { business_id: bBiz.id, employee_id: emp.id, name: "x" } })).status === 404);
  ok("B cannot import contacts into A's business", (await api("/api/contacts/import", { method: "POST", token: B, body: { business_id: biz.id, csv: "X,9876543210,yes,form" } })).status === 404);
  ok("B cannot read A's billing status", (await api(`/api/billing/status?business_id=${biz.id}`, { token: B })).status === 404);
  ok("business_id must be provided and numeric", (await api("/api/leads", { token: A })).status === 400 && (await api("/api/leads?business_id=abc", { token: A })).status === 400);

  // ---------- public chat ----------
  const s = (await api(`/public/chat/${emp.id}/start`, { method: "POST" })).data;
  const other = (await api(`/public/chat/${emp.id}/start`, { method: "POST" })).data;
  ok("a customer cannot use another conversation's id with their own token", (await api(`/public/chat/${other.conversationId}/message`, { method: "POST", body: { token: s.token, content: "hi" } })).status === 403);
  ok("conversation id of a login-only (playground) chat is not reachable publicly", (await api(`/public/chat/99999/message`, { method: "POST", body: { token: "x", content: "hi" } })).status === 403);
  let last;
  for (let i = 0; i < 4; i++) last = await api(`/public/chat/${s.conversationId}/message`, { method: "POST", body: { token: s.token, content: `hello ${i}` } });
  ok("one anonymous conversation has a message cap", last.status === 429, last);

  // ---------- static files / traversal ----------
  const trav = await fetch(T.base + "/..%2f..%2fdb.js"), env = await fetch(T.base + "/.env"), dbf = await fetch(T.base + "/data/kraip.db");
  ok("no source, .env or database is served", [trav, env, dbf].every((r) => r.status === 404), [trav.status, env.status, dbf.status]);

  // ---------- rate limits ----------
  const costly = [];
  for (let i = 0; i < 6; i++) costly.push((await api("/api/research", { method: "POST", token: A, body: { business_id: biz.id, query: "whitening price chennai" } })).status);
  ok("costly endpoints (research) are limited per user", costly.includes(429), costly);
  ok("another user is not affected by A's limit", (await api("/api/research", { method: "POST", token: B, body: { business_id: bBiz.id, query: "whitening price chennai" } })).status !== 429);
  const logins = [];
  for (let i = 0; i < 14; i++) logins.push((await api("/auth/login", { method: "POST", body: { email: "victim@test.com", password: "guess-guess" } })).status);
  ok("repeated wrong logins are rate limited", logins.includes(429), logins);

  ok("no crash and no stack traces leaked in responses", !T.crashed() && !/at .*\.js:\d+/.test((await api("/auth/login", { method: "POST", body: "{bad" })).text));
  ok.done(assert);
});
