// Customer-facing chat (no login). Used by public/widget.html, which you can embed or link on any website.
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { chat } = require("../services/employee");
const { rateLimit } = require("../lib/security");
const { sha256, httpError } = require("../lib/auth");

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(rateLimit({ max: 40, windowMs: 60_000 }));

router.post("/chat/:employeeId/start", wrap(async (req, res) => {
  const emp = db.prepare("SELECT e.*, b.name AS business_name FROM employees e JOIN businesses b ON b.id = e.business_id WHERE e.id = ?").get(req.params.employeeId);
  if (!emp || emp.status !== "active") throw httpError(404, "This assistant is not available");
  const token = crypto.randomBytes(24).toString("hex");
  const info = db.prepare("INSERT INTO conversations (employee_id, channel, public_token_hash) VALUES (?, 'web', ?)").run(emp.id, sha256(token));
  res.status(201).json({
    conversationId: Number(info.lastInsertRowid), token, language: emp.language,
    greeting: emp.greeting || `Hi, I'm ${emp.name} from ${emp.business_name}. I'm an AI assistant. How can I help?`,
  });
}));

router.post("/chat/:conversationId/message", wrap(async (req, res) => {
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ? AND channel = 'web'").get(req.params.conversationId);
  const given = Buffer.from(sha256(String(req.body.token || "")));
  const stored = Buffer.from(conv?.public_token_hash || "x".repeat(64));
  if (!conv || given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) throw httpError(403, "Invalid conversation");
  const content = String(req.body.content || "").trim().slice(0, 1000);
  if (!content) throw httpError(400, "content is required");
  // Cap what one anonymous conversation can cost (every message is a model call)
  const used = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'").get(conv.id).n;
  if (used >= Number(process.env.MAX_PUBLIC_MESSAGES || 80)) throw httpError(429, "This conversation has reached its message limit");
  const r = await chat(conv.id, content);
  // Customers only see the reply and whether a human is taking over, never internal lead data
  res.json({ reply: r.reply, handoff: r.handoff, closed: r.status === "closed" });
}));

module.exports = router;
