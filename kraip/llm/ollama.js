// Local open-weight models via Ollama (http://localhost:11434 by default).
// Requires Node 18+ (built-in fetch).

const BASE_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";

/**
 * @param {{role: "system"|"user"|"assistant", content: string}[]} messages
 * @param {{temperature?: number, maxTokens?: number, json?: boolean}} [opts]
 * @returns {Promise<{text: string, model: string, latencyMs: number}>}
 */
async function generate(messages, opts = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      format: opts.json ? "json" : undefined,
      options: {
        temperature: opts.temperature ?? 0.4,
        num_predict: opts.maxTokens ?? 512,
      },
    }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 30000)),   // a hung model must not hang a live call
  });

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return {
    text: data.message?.content ?? "",
    model: `ollama:${MODEL}`,
    latencyMs: Date.now() - started,
  };
}

module.exports = { generate };
