// Test harness: starts mock providers (model, search, Plivo/Twilio/Razorpay REST, Sarvam speech sockets) and a real
// KRAIP server process against a throwaway database, all on free ports. No real calls, no real payments, no secrets.
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const services = require("./mocks/services");
const voice = require("./mocks/voice");

const PUBLIC_URL = "http://kraip.test";
const TEST_PLIVO_TOKEN = "plivo-test-token";   // fake values, only ever used against the mocks
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function waitFor(fn, ms = 12000, step = 80) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

async function boot(extraEnv = {}) {
  const svc = await services.start(), vox = await voice.start();
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kraip-test-"));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
    PORT: String(port), KRAIP_DB: path.join(dir, "test.db"), KRAIP_ALLOW_PRIVATE_URLS: "1",
    LLM_PROVIDER: "ollama", OLLAMA_URL: `http://127.0.0.1:${svc.port}`, LLM_TIMEOUT_MS: "4000",
    TAVILY_API_KEY: "test", TAVILY_URL: `http://127.0.0.1:${svc.port}`,
    PUBLIC_URL, PHONE_PROVIDER: "plivo",
    PLIVO_AUTH_ID: "AUTH123", PLIVO_AUTH_TOKEN: TEST_PLIVO_TOKEN, PLIVO_PHONE_NUMBER: "+912200000000",
    PLIVO_API_BASE: `http://127.0.0.1:${vox.port}`, SARVAM_API_KEY: "sarvam-key", SARVAM_WS_BASE: `ws://127.0.0.1:${vox.port}`,
    TWILIO_API_BASE: `http://127.0.0.1:${svc.port}`, RAZORPAY_URL: `http://127.0.0.1:${svc.port}`,
    VOICE_IDLE_MS: "2500", COSTLY_PER_MINUTE: "1000",
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  const child = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  let exited = false; child.on("exit", () => (exited = true));
  const base = `http://127.0.0.1:${port}`;
  const up = await waitFor(async () => { try { return (await fetch(base + "/healthz")).ok; } catch { return false; } }, 15000, 100);
  if (!up) { child.kill(); throw new Error("server did not start:\n" + log); }

  const ctx = {
    base, port, svc, vox, env, dbPath: env.KRAIP_DB,
    logs: () => log, crashed: () => exited,
    async stop() {
      child.kill("SIGTERM"); await waitFor(() => exited, 6000); if (!exited) child.kill("SIGKILL");
      await svc.close(); await vox.close(); fs.rmSync(dir, { recursive: true, force: true });
    },
    async api(p, { method = "GET", body, token, headers = {}, raw = false } = {}) {
      const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
      const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, text, headers: res.headers };
    },
    // Form-encoded provider webhook. sig: "v3" adds a valid Plivo V3 signature, "bad" a wrong one.
    async hook(p, params, { sig, token = TEST_PLIVO_TOKEN } = {}) {
      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
      if (sig) {
        const nonce = crypto.randomBytes(8).toString("hex");
        const sorted = Object.keys(params).sort().map((k) => k + params[k]).join("");
        const mac = crypto.createHmac("sha256", sig === "bad" ? "wrong-token" : token).update(`${PUBLIC_URL}${p}.${sorted}.${nonce}`).digest("base64");
        headers["X-Plivo-Signature-V3"] = mac; headers["X-Plivo-Signature-V3-Nonce"] = nonce;
      }
      const res = await fetch(base + p, { method: "POST", headers, body: new URLSearchParams(params).toString() });
      return { status: res.status, text: await res.text() };
    },
    async twilioHook(p, params, { token = "twilio-test-token", sign = true } = {}) {
      const sig = crypto.createHmac("sha1", token).update(PUBLIC_URL + p + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
      const res = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(sign ? { "X-Twilio-Signature": sig } : {}) }, body: new URLSearchParams(params).toString() });
      return { status: res.status, text: await res.text() };
    },
    // Opens the audio socket from the <Stream> URL in an answer response
    streamUrl: (xml) => /<Stream[^>]*>([^<]+)<\/Stream>/.exec(xml)[1].replace(/&amp;/g, "&").replace("ws://kraip.test", `ws://127.0.0.1:${port}`),
    connect: (url) => new Promise((resolve, reject) => {
      const ws = new WebSocket(url); ws.msgs = [];
      ws.on("message", (m) => ws.msgs.push(JSON.parse(m.toString())));
      ws.on("open", () => resolve(ws)); ws.on("error", reject);
    }),
    async signup(email = `u${crypto.randomBytes(4).toString("hex")}@test.com`) {
      const r = await ctx.api("/auth/signup", { method: "POST", body: { email, password: "password123" } });
      return r.data.token;
    },
  };
  return ctx;
}

// ---- audio helpers for simulated callers ----
const { mulawEncode } = require("../lib/audio");
const startStream = (ws, call) => ws.send(JSON.stringify({ event: "start", start: { callId: call, streamId: "STREAM-" + call } }));
// Constant level k*2000 for 100 ms: the mock speech-to-text turns the level into a sentence
function speakTurn(ws, k) {
  const pcm = Buffer.alloc(1600); for (let i = 0; i < 800; i++) pcm.writeInt16LE(k * 2000, i * 2);
  const mu = mulawEncode(pcm);
  for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: mu.subarray(i * 160, i * 160 + 160).toString("base64") } }));
}
const plays = (ws) => ws.msgs.filter((m) => m.event === "playAudio").length;

// Collects named checks (so one failing check does not hide the rest) and fails the test at the end if any failed
function checker() {
  const failed = [];
  const ok = (name, cond, extra) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + JSON.stringify(extra)}`);
    if (!cond) failed.push(name);
  };
  ok.done = (assert) => assert.deepEqual(failed, [], `${failed.length} check(s) failed: ${failed.join("; ")}`);
  return ok;
}

module.exports = { boot, sleep, waitFor, freePort, startStream, speakTurn, plays, checker, PUBLIC_URL, TEST_PLIVO_TOKEN };
