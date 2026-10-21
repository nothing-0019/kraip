// One mock server standing in for Ollama, Tavily, public web pages, Twilio and Razorpay.
const http = require("http");
let PORT = 0;
const state = { calls: [], razorpay: [] };

const pages = {
  "/site/a": `<html><head><title>Bright Smile Clinic</title></head><body><h1>Bright Smile Clinic</h1><p>Teeth whitening and dental implants in Chennai.</p>
    <a href="tel:+91 98400 11122">Call us</a> <a href="mailto:hello@brightsmile.example.in">Email</a></body></html>`,
  "/site/b": `<html><head><title>City Dental Care</title></head><body><p>We offer teeth whitening. Phone: 044 2345 6789</p></body></html>`,
  "/site/blocked": `<html><body><p>Secret page with teeth whitening and implants. Call 9000000000</p></body></html>`,
  "/site/a2": `<html><body><p>Whitening prices at Bright Smile start around Rs 4000 per session according to their price list page for 2026.</p></body></html>`,
};

function readBody(req) { return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); }); }
const json = (res, obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const body = await readBody(req);

  if (url.pathname === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("User-agent: *\nDisallow: /site/blocked\n"); }
  if (pages[url.pathname]) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(pages[url.pathname]); }

  if (url.pathname === "/api/chat") {
    const j = JSON.parse(body);
    const sys = j.messages[0].content;
    const all = JSON.stringify(j.messages);
    if (all.includes("FAILLLM")) return json(res, { error: "model exploded" }, 500);   // test hook: simulate a model outage
    if (j.format === "json" && sys.startsWith("Read the conversation")) {
      const transcript = j.messages[1].content;
      const cust = transcript.split("\n").filter((l) => l.startsWith("Customer:")).join("\n");
      const last = cust.split("\n").pop() || "";
      const m = (re) => re.exec(cust)?.[1] || null;
      return json(res, { message: { content: JSON.stringify({
        name: m(/I'm ([^.\s]+)/), phone: m(/(\d{10})/), email: m(/([\w.]+@[\w.]+\.\w+)/), need: m(/need (.+?)[.\n]/),
        budget: m(/budget (?:is )?([^.\n]+)/), timeline: m(/by ([^.\n]+)/),
        intent: /price|cost|budget/.test(cust) ? "pricing" : "info", sentiment: /manager/.test(last) ? "negative" : "neutral",
        wants_human: /manager|real person/.test(last), opt_out: /stop calling/.test(last),
        needs_research: /competitor|compare/.test(last), research_query: /competitor|compare/.test(last) ? "teeth whitening price Chennai" : null,
      }) } });
    }
    if (j.format === "json" && sys.includes("careful research analyst")) {
      return json(res, { message: { content: JSON.stringify({ answer: "Whitening costs around Rs 4000 per session [1][4].", confidence: "high", uncertain: ["Prices may vary by clinic"] }) } });
    }
    if (sys.startsWith("Summarise")) return json(res, { message: { content: "Customer asked about whitening and was qualified as a lead." } });
    const reply = all.includes("RESEARCH FINDINGS (confidence") ? "According to the sources, around Rs 4000 [1]." : "Happy to help! What is your budget?";
    return json(res, { message: { content: reply } });
  }

  if (url.pathname === "/search") { // Tavily
    const base = `http://localhost:${PORT}`;
    return json(res, { results: [
      { title: "Bright Smile Clinic", url: `${base}/site/a`, content: "Teeth whitening and implants in Chennai clinic page snippet text." },
      { title: "City Dental Care", url: `http://127.0.0.1:${PORT}/site/b`, content: "Dental care with whitening in Chennai, snippet text here." },
      { title: "Hidden Clinic", url: `http://0.0.0.0:${PORT}/site/blocked`, content: "Snippet for the robots-blocked clinic with whitening mention." },
      { title: "Whitening price list", url: `${base}/site/a2`, content: "Price list snippet for whitening sessions in Chennai region." },
    ] });
  }

  if (url.pathname.endsWith("/Calls.json")) { // Twilio
    const p = Object.fromEntries(new URLSearchParams(body));
    state.calls.push({ ...p, auth: req.headers.authorization });
    return json(res, { sid: "CA" + String(state.calls.length).padStart(4, "0") }, 201);
  }
  if (url.pathname === "/v1/payment_links") { // Razorpay
    const p = JSON.parse(body); state.razorpay.push(p);
    return json(res, { id: "plink_test1", short_url: "https://rzp.io/i/test1" }, 200);
  }
  if (url.pathname === "/__state") return json(res, state);
  res.writeHead(404); res.end("not found");
});

// Starts the mock on a free port. Returns { port, state, close }.
function start() {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    PORT = server.address().port;
    resolve({ port: PORT, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
module.exports = { start };
