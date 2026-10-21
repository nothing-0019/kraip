// Run once with your real keys:  npm run voice-check
// Confirms Sarvam text-to-speech and speech-to-text work with your key and the audio format your account returns.
require("dotenv").config();
const sarvam = require("../services/sarvam");
const audio = require("../lib/audio");
const plivo = require("../services/plivo");

const ok = (m) => console.log("  OK   " + m), bad = (m) => { console.log("  FAIL " + m); process.exitCode = 1; };

(async () => {
  console.log("Configuration");
  for (const k of ["SARVAM_API_KEY", "PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN", "PLIVO_PHONE_NUMBER", "PUBLIC_URL"]) (process.env[k] ? ok : bad)(`${k} ${process.env[k] ? "is set" : "is missing"}`);
  if (process.env.PUBLIC_URL && !/^https:/.test(process.env.PUBLIC_URL)) bad("PUBLIC_URL must be https:// (Plivo streams over wss://)");
  if (!sarvam.configured()) return;

  console.log("\nText to speech");
  const tts = new sarvam.TtsSession({ lang: process.env.CHECK_LANG || "en-IN", speaker: process.env.SARVAM_SPEAKER || undefined });
  const chunks = [], t0 = Date.now();
  let firstMs = null;
  try {
    await tts.synthesize("Hello, this is a KRAIP voice check. Can you hear me clearly?", (pcm) => { if (firstMs === null) firstMs = Date.now() - t0; chunks.push(pcm); });
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) bad("Sarvam finished but returned no audio");
    else {
      ok(`${audio.seconds(pcm).toFixed(1)}s of audio, first audio after ${firstMs} ms, level ${Math.round(audio.rms(pcm))} (0 would be silence)`);
      require("fs").writeFileSync("voice-check.wav", audio.pcmToWav(pcm));
      ok("saved voice-check.wav, play it to hear the voice");
      console.log("\nSpeech to text (sending that same audio back)");
      const stt = new sarvam.SttSession({ lang: "en-IN" });
      const heard = [];
      stt.on("transcript", (t) => heard.push(t)); stt.on("error", (e) => bad(e.message));
      await stt.open();
      for (let i = 0; i < pcm.length; i += 3200) stt.sendPcm(pcm.subarray(i, i + 3200));
      stt.sendPcm(Buffer.alloc(16000 * 2));   // 1 s of silence so the end of speech is detected
      stt.flush();
      await new Promise((r) => setTimeout(r, 6000));
      stt.close();
      heard.length ? ok(`heard: "${heard.join(" ")}"`) : bad("no transcript came back (check the key, language and account access)");
    }
  } catch (e) { bad(e.message); }
  tts.close();
  if (plivo.configured()) ok("Plivo + Sarvam fully configured; next, attach your number to a Plivo Application (see README)");
})();
