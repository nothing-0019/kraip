// Gemini adapter (REST API, no SDK needed). Same interface as ollama.js.
// If you already have a Gemini adapter, wrap it to match this signature instead.

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

async function generate(messages, opts = {}) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const started = Date.now();

  const system = messages.find((m) => m.role === "system");
  // Gemini wants alternating turns that start with the user (a spoken greeting is the assistant's first message)
  const contents = [];
  for (const m of messages.filter((x) => x.role !== "system")) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + m.content;
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  while (contents.length && contents[0].role === "model") contents.shift();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system.content }] } : undefined,
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 512,
        responseMimeType: opts.json ? "application/json" : undefined,
      },
    }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 30000)),
  });

  if (!res.ok) {
    throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return {
    text: data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "",
    model: `gemini:${MODEL}`,
    latencyMs: Date.now() - started,
  };
}

module.exports = { generate };
