require("dotenv").config();
const path = require("path");
const express = require("express");
const db = require("./db");
const auth = require("./lib/auth");
const { rateLimit } = require("./lib/security");
const billing = require("./services/billing");
const campaigns = require("./services/campaigns");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === undefined ? 1 : (Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY));
app.use((req, res, next) => {
  if (/^https:/.test(process.env.PUBLIC_URL || "")) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const embeddable = req.path === "/widget.html";   // the chat widget is meant to be embedded on customers' websites
  if (!embeddable) res.setHeader("X-Frame-Options", "DENY");
  // The pages load nothing from other sites, so everything external is blocked (inline script/style are used by the built-in pages)
  res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${embeddable ? "*" : "'none'"}`);
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Health checks (no login, no secrets): /healthz = process is up, /readyz = database answers
app.get("/healthz", (req, res) => res.json({ ok: true, uptime_s: Math.round(process.uptime()) }));
app.get("/readyz", (req, res) => {
  try { db.prepare("SELECT 1").get(); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

// Phone webhooks: form-encoded bodies, verified by each provider's signature
app.use("/voice", require("./routes/voice"));   // Twilio
app.use("/plivo", require("./routes/plivo"));   // Plivo (+ Sarvam speech over the audio stream)

// Razorpay webhook needs the raw body to verify its signature
app.post("/webhooks/razorpay", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(503).send("Webhook secret not configured");   // fail closed
  if (!billing.verifyWebhook(req.body, req.headers["x-razorpay-signature"])) return res.status(400).send("Invalid signature");
  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("Malformed body"); }
  try { billing.handleWebhook(event, req.headers["x-razorpay-event-id"]); }
  catch (err) { console.error("[razorpay] webhook failed:", err.message); return res.status(500).send("Try again"); }   // Razorpay retries on 5xx
  res.sendStatus(200);
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Public customer chat
app.use("/public", require("./routes/public"));

// Accounts
const authLimit = rateLimit({ max: 10, windowMs: 60_000 });
// Also limit guessing against one account from many addresses
const emailKey = (req) => `e:${typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : ""}`;
const loginAccountLimit = rateLimit({ max: Number(process.env.LOGIN_ATTEMPTS_PER_15MIN || 10), windowMs: 15 * 60_000, key: emailKey });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.post("/auth/signup", authLimit, wrap((req, res) => res.status(201).json(auth.signup(req.body))));
app.post("/auth/login", authLimit, loginAccountLimit, wrap((req, res) => res.json(auth.login(req.body))));
app.post("/auth/logout", auth.requireAuth, (req, res) => { auth.logout(req.token); res.json({ ok: true }); });
app.get("/auth/me", auth.requireAuth, (req, res) => res.json(req.user));

// Everything else needs login and is scoped to the logged-in owner
app.use("/api", auth.requireAuth, rateLimit({ max: 240, windowMs: 60_000, key: (req) => `u${req.user.id}` }), require("./routes/api"));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large" });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong" });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`KRAIP running at http://localhost:${PORT}  (LLM: ${process.env.LLM_PROVIDER || "gemini"})`);
    campaigns.startScheduler();
    require("./services/retention").startScheduler();   // only runs when RETENTION_DAYS is set
  });
  require("./services/voiceStream").attach(server); // live phone audio (Plivo) at /plivo-stream
  auth.purgeExpiredSessions();
  setInterval(() => { try { auth.purgeExpiredSessions(); } catch (e) { console.warn("[sessions] purge failed:", e.message); } }, 60 * 60 * 1000).unref();
  const shutdown = () => { console.log("Shutting down"); server.close(() => { try { db.close(); } catch { /* closing */ } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
module.exports = app;
