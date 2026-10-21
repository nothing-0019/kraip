// One entry point for every model KRAIP uses.
// Switch with LLM_PROVIDER=gemini | ollama. Add new providers by dropping in a file.
const { createGate } = require("../lib/security");

const providers = {
  gemini: () => require("./gemini"),
  ollama: () => require("./ollama"),
};

// Limits how many model calls run at once so a burst of customers queues instead of crashing the model
const gate = createGate(Number(process.env.MAX_CONCURRENT_LLM || 4));

function getProvider(name = process.env.LLM_PROVIDER || "gemini") {
  const load = providers[name];
  if (!load) throw new Error(`Unknown LLM provider "${name}". Options: ${Object.keys(providers).join(", ")}`);
  return load();
}

async function generate(messages, opts = {}) {
  const primary = opts.provider || process.env.LLM_PROVIDER || "gemini";
  return gate(async () => {
    try {
      return await getProvider(primary).generate(messages, opts);
    } catch (err) {
      const fallback = process.env.LLM_FALLBACK;
      if (fallback && fallback !== primary) {
        console.warn(`[llm] ${primary} failed (${err.message}); falling back to ${fallback}`);
        return getProvider(fallback).generate(messages, opts);
      }
      throw err;
    }
  });
}

module.exports = { generate, getProvider };
