// Fixed phrases spoken on calls. Short, fixed lines are cached as audio, so they cost nothing after the first use.
// Hindi, Tamil and Telugu lines should be reviewed by a native speaker before you go live.
const P = {
  en: {
    inbound: (n, b) => `Hello, this is ${n} from ${b}. I'm an AI assistant. How can I help you today?`,
    outbound: (n, b) => `Hello, this is ${n} calling from ${b}. I'm an AI assistant. Is now a good time for a quick question? You can say stop at any time and we won't call again.`,
    stillThere: "Are you still there?",
    goodbye: "Thank you for your time. Our team will follow up with you. Goodbye.",
    handoff: "Of course. I'm passing this to our team and someone will get back to you shortly.",
    optOut: "Understood. We won't contact you again. Sorry for the interruption.",
    error: "I'm having trouble right now. Our team will call you back shortly. Goodbye.",
    unavailable: "Sorry, this number is not available right now.",
  },
  hi: {
    inbound: (n, b) => `नमस्ते, मैं ${b} की एआई असिस्टेंट ${n} हूँ। बताइए, मैं आपकी क्या सहायता करूँ?`,
    outbound: (n, b) => `नमस्ते, मैं ${b} की ओर से एआई असिस्टेंट ${n} हूँ। क्या अभी बात करने के लिए सही समय है? आप कभी भी रुकिए या बंद करो कह दें, हम दोबारा कॉल नहीं करेंगे।`,
    stillThere: "क्या आप लाइन पर हैं?",
    goodbye: "आपके समय के लिए धन्यवाद। हमारी टीम आपसे संपर्क करेगी। नमस्ते।",
    handoff: "ज़रूर। आपकी बात हमारी टीम तक पहुँचाई जा रही है, वे जल्द ही आपसे संपर्क करेंगे।",
    optOut: "ठीक है। हम आपको दोबारा संपर्क नहीं करेंगे। असुविधा के लिए खेद है।",
    error: "अभी कुछ तकनीकी समस्या है। हमारी टीम जल्द ही आपको कॉल करेगी। नमस्ते।",
    unavailable: "क्षमा करें, यह नंबर अभी उपलब्ध नहीं है।",
  },
  ta: {
    inbound: (n, b) => `வணக்கம், நான் ${b} நிறுவனத்தின் AI உதவியாளர் ${n}. உங்களுக்கு எப்படி உதவலாம்?`,
    outbound: (n, b) => `வணக்கம், ${b} சார்பாக AI உதவியாளர் ${n} அழைக்கிறேன். இப்போது பேச சரியான நேரமா? எப்போது வேண்டுமானாலும் நிறுத்துங்கள் என்று சொல்லுங்கள், மீண்டும் அழைக்க மாட்டோம்.`,
    stillThere: "நீங்கள் லைனில் இருக்கிறீர்களா?",
    goodbye: "உங்கள் நேரத்திற்கு நன்றி. எங்கள் குழு உங்களைத் தொடர்பு கொள்ளும். வணக்கம்.",
    handoff: "சரி. உங்கள் கோரிக்கையை எங்கள் குழுவிடம் அனுப்புகிறேன், விரைவில் தொடர்பு கொள்வார்கள்.",
    optOut: "புரிந்தது. இனி உங்களைத் தொடர்பு கொள்ள மாட்டோம். தொந்தரவுக்கு மன்னிக்கவும்.",
    error: "இப்போது தொழில்நுட்பச் சிக்கல் உள்ளது. எங்கள் குழு விரைவில் உங்களை அழைக்கும். வணக்கம்.",
    unavailable: "மன்னிக்கவும், இந்த எண் இப்போது கிடைக்கவில்லை.",
  },
  te: {
    inbound: (n, b) => `నమస్కారం, నేను ${b} AI అసిస్టెంట్ ${n}ని. మీకు ఎలా సహాయం చేయగలను?`,
    outbound: (n, b) => `నమస్కారం, ${b} తరపున AI అసిస్టెంట్ ${n} కాల్ చేస్తున్నాను. ఇప్పుడు మాట్లాడటానికి అనుకూలమా? ఎప్పుడైనా ఆపండి అని చెప్పండి, మళ్లీ కాల్ చేయం.`,
    stillThere: "మీరు లైన్‌లో ఉన్నారా?",
    goodbye: "మీ సమయానికి ధన్యవాదాలు. మా బృందం మిమ్మల్ని సంప్రదిస్తుంది. నమస్కారం.",
    handoff: "సరే. మీ అభ్యర్థనను మా బృందానికి పంపుతున్నాను, త్వరలో సంప్రదిస్తారు.",
    optOut: "అర్థమైంది. ఇకపై మిమ్మల్ని సంప్రదించం. ఇబ్బందికి క్షమించండి.",
    error: "ఇప్పుడు సాంకేతిక సమస్య ఉంది. మా బృందం త్వరలో మీకు కాల్ చేస్తుంది. నమస్కారం.",
    unavailable: "క్షమించండి, ఈ నంబర్ ఇప్పుడు అందుబాటులో లేదు.",
  },
};

const LANGUAGE_NAMES = {
  en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam",
  mr: "Marathi", bn: "Bengali", gu: "Gujarati", pa: "Punjabi", od: "Odia",
};

const base = (code) => String(code || "en").split("-")[0].toLowerCase();
const phrases = (code) => P[base(code)] || P.en;
const languageName = (code) => LANGUAGE_NAMES[base(code)] || "English";

// Sarvam speaks Indian languages and Indian English; map other English variants to en-IN
function sarvamLanguage(code) {
  const c = String(code || "en-IN");
  return base(c) === "en" ? "en-IN" : c;
}

module.exports = { phrases, languageName, sarvamLanguage };
