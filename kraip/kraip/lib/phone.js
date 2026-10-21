// Normalises phone numbers so "98765 43210", "+91 98765-43210" and "9876543210" match as one contact.
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  const plus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  if (plus) return "+" + digits;
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  const cc = (process.env.DEFAULT_COUNTRY_CODE || "91").replace(/\D/g, "");
  if (digits.length === 10) return "+" + cc + digits;
  if (digits.startsWith("0") && digits.length === 11) return "+" + cc + digits.slice(1);
  return "+" + digits;
}

module.exports = { normalizePhone };
