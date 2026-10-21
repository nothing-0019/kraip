// Chooses the phone provider. PHONE_PROVIDER=plivo (cheaper, India-focused, Sarvam speech) or twilio.
// Default: Plivo if its keys are set, otherwise Twilio.
const plivo = require("./plivo");
const twilio = require("./telephony");

function provider() {
  const want = (process.env.PHONE_PROVIDER || "").toLowerCase();
  if (want === "plivo" || want === "twilio") return want;
  return plivo.configured() ? "plivo" : "twilio";
}
const impl = () => (provider() === "plivo" ? plivo : twilio);

const configured = () => impl().configured();
const placeCall = (args) => impl().placeCall(args);
const publicUrl = () => impl().publicUrl();

// Paths to give the provider, per employee (Plivo ones include the secret key, so paste them exactly as shown)
const webhookPath = (employeeId) => (provider() === "plivo" ? plivo.answerPath(employeeId) : `/voice/${employeeId}/incoming`);
const hangupPath = (employeeId) => (provider() === "plivo" ? plivo.hangupPath(employeeId) : `/voice/${employeeId}/status`);

module.exports = { provider, configured, placeCall, publicUrl, webhookPath, hangupPath };
