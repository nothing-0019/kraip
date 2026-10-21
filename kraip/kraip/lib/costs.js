// Estimated provider cost of a call, in paise, so you can see your margin. Override the rates in .env if your plans differ.
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? Number(process.env[k]) : d);
const rates = () => ({
  telephonyPerMin: num("COST_TELEPHONY_PAISE_PER_MIN", 38),     // Plivo outbound India, rounded up per minute
  sttPerSec: num("COST_STT_PAISE_PER_SEC", 3000 / 3600),        // Sarvam STT about Rs 30 per hour of audio
  ttsPerChar: num("COST_TTS_PAISE_PER_CHAR", 0.3),              // Sarvam TTS about Rs 30 per 10,000 characters
  llmPerTurn: num("COST_LLM_PAISE_PER_TURN", 10),               // depends on your model; 0 for a self-hosted model
});
function estimate({ seconds, ttsChars = 0, sttSeconds, llmTurns = 0 }) {
  const r = rates(), secs = Math.max(0, seconds || 0), stt = sttSeconds ?? secs;
  const telephony = Math.ceil(secs / 60) * r.telephonyPerMin, sttP = stt * r.sttPerSec, tts = ttsChars * r.ttsPerChar, llm = llmTurns * r.llmPerTurn;
  return { telephony_paise: telephony, stt_paise: sttP, tts_paise: tts, llm_paise: llm, total_paise: telephony + sttP + tts + llm, stt_seconds: stt };
}
module.exports = { rates, estimate };
