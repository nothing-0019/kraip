const crypto = require("crypto");
const db = require("../db");

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), userId, Date.now() + SESSION_MS);
  return token;
}

const MAX_PASSWORD = 200;   // scrypt on a huge input is an easy way to burn CPU

function signup({ email, name, password }) {
  email = typeof email === "string" ? email.trim().toLowerCase() : "";
  password = typeof password === "string" ? password : "";
  name = typeof name === "string" ? name.trim().slice(0, 100) : "";
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "Enter a valid email");
  if (password.length < 8) throw httpError(400, "Password must be at least 8 characters");
  if (password.length > MAX_PASSWORD) throw httpError(400, `Password must be at most ${MAX_PASSWORD} characters`);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw httpError(409, "Email already registered");
  const salt = crypto.randomBytes(16).toString("hex");
  let info;
  try {
    info = db.prepare("INSERT INTO users (email, name, password_hash, salt) VALUES (?, ?, ?, ?)").run(email, name, hashPw(password, salt), salt);
  } catch (e) {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw httpError(409, "Email already registered");   // two signups raced
    throw e;
  }
  const user = { id: Number(info.lastInsertRowid), email, name };
  return { user, token: createSession(user.id) };
}

function login({ email, password }) {
  email = typeof email === "string" ? email.trim().toLowerCase() : "";
  password = typeof password === "string" ? password.slice(0, MAX_PASSWORD) : "";
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  // Same work whether or not the user exists, so timing does not reveal accounts
  const salt = row ? row.salt : "0".repeat(32);
  const attempt = Buffer.from(hashPw(password, salt), "hex");
  const stored = Buffer.from(row ? row.password_hash : "0".repeat(128), "hex");
  if (!row || !crypto.timingSafeEqual(attempt, stored)) throw httpError(401, "Wrong email or password");
  return { user: { id: row.id, email: row.email, name: row.name }, token: createSession(row.id) };
}

function purgeExpiredSessions() {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now()).changes;
}

function logout(token) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || token.length > 200) return res.status(401).json({ error: "Login required" });
  const row = db.prepare(`
    SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now());
  if (!row) return res.status(401).json({ error: "Session expired, please log in again" });
  req.user = row;
  req.token = token;
  next();
}

// ---------- Tenant isolation: every lookup is scoped to the logged-in owner ----------
function getBusiness(req, id) {
  const row = db.prepare("SELECT * FROM businesses WHERE id = ? AND owner_id = ?").get(id, req.user.id);
  if (!row) throw httpError(404, "Business not found");
  return row;
}
function getEmployee(req, id) {
  const row = db.prepare(`
    SELECT e.* FROM employees e JOIN businesses b ON b.id = e.business_id
    WHERE e.id = ? AND b.owner_id = ?`).get(id, req.user.id);
  if (!row) throw httpError(404, "Employee not found");
  return row;
}
function getConversation(req, id) {
  const row = db.prepare(`
    SELECT c.*, e.business_id FROM conversations c
    JOIN employees e ON e.id = c.employee_id JOIN businesses b ON b.id = e.business_id
    WHERE c.id = ? AND b.owner_id = ?`).get(id, req.user.id);
  if (!row) throw httpError(404, "Conversation not found");
  return row;
}

module.exports = { signup, login, logout, purgeExpiredSessions, requireAuth, getBusiness, getEmployee, getConversation, httpError, sha256 };
