const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PRO_PASSWORD = "testmonkey6";

// ── Free tier limits ─────────────────────────────────────────────
const FREE_DAILY_MSG_LIMIT = 15;   // messages per day
const FREE_WEEKLY_SESSION_LIMIT = 3; // sessions per week

// In-memory store for rate limiting (resets on server restart)
// In production, replace with Redis or a database
const usageStore = {}; // key: clientId, value: { dailyMsgs, dailyDate, weeklySessions, weekStart, sessionActive }

function getClientId(req) {
  // Use IP address as anonymous client identifier
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function getWeekStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return d.toISOString().split("T")[0];
}

function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

function getUsage(clientId) {
  if (!usageStore[clientId]) {
    usageStore[clientId] = {
      dailyMsgs: 0,
      dailyDate: getTodayStr(),
      weeklySessions: 0,
      weekStart: getWeekStart(),
      sessionActive: false,
    };
  }
  const u = usageStore[clientId];
  // Reset daily count if it's a new day
  if (u.dailyDate !== getTodayStr()) {
    u.dailyMsgs = 0;
    u.dailyDate = getTodayStr();
    u.sessionActive = false;
  }
  // Reset weekly count if it's a new week
  if (u.weekStart !== getWeekStart()) {
    u.weeklySessions = 0;
    u.weekStart = getWeekStart();
    u.sessionActive = false;
  }
  return u;
}

function checkFreeLimits(clientId) {
  const u = getUsage(clientId);
  // Check weekly session limit
  if (!u.sessionActive) {
    if (u.weeklySessions >= FREE_WEEKLY_SESSION_LIMIT) {
      return {
        allowed: false,
        reason: "weekly_sessions",
        message: `You've used all ${FREE_WEEKLY_SESSION_LIMIT} free sessions this week. Your sessions reset every Sunday, or upgrade to Pro for unlimited access.`,
      };
    }
    // Start a new session
    u.weeklySessions++;
    u.sessionActive = true;
    u.dailyMsgs = 0; // reset msg count for new session tracking
  }
  // Check daily message limit
  if (u.dailyMsgs >= FREE_DAILY_MSG_LIMIT) {
    return {
      allowed: false,
      reason: "daily_messages",
      message: `You've reached the ${FREE_DAILY_MSG_LIMIT} message limit for today. Come back tomorrow, or upgrade to Pro for unlimited messages.`,
    };
  }
  return { allowed: true };
}

// ── System prompts ───────────────────────────────────────────────
const DISCLAIMER = `

IMPORTANT: Always end responses that involve electrical components, gas systems, or structural repairs with this disclaimer on its own line:
⚠️ *Disclaimer: SpaFix provides general guidance only and is not a substitute for a licensed technician. For electrical issues (240V wiring, GFCI panels, heater elements), gas systems, or structural damage, always consult a certified spa technician or licensed electrician. Never work on a plugged-in spa.*`;

const TEXT_SYSTEM_PROMPT = `You are Jet, SpaFix's friendly and knowledgeable hot tub repair assistant. You're like a helpful friend who happens to know everything about spas — warm, encouraging, and genuinely useful. Help homeowners diagnose and fix their spas themselves.

PERSONALITY:
- Warm, conversational, encouraging — "Great, let's figure this out together"
- Empathetic — acknowledge the frustration of a broken spa before diving in
- Honest — if something is genuinely dangerous or beyond DIY, say so clearly
- Never be dismissive of a user's response — every answer they give is valuable context

CRITICAL DIAGNOSIS RULES:
1. ALWAYS work from cheapest/simplest to most complex/expensive. Never skip steps.
2. NEVER suggest a control board, PCB, or main board issue until ALL of these have been explicitly checked and ruled out IN ORDER:
   a. Filter (clean, rinsed, properly seated)
   b. Water level (at or above skimmer)
   c. Visual inspection of equipment bay (see below)
   d. Fuses (check for burn marks on housing AND broken filaments — most spas have 1-4 blade or glass tube fuses in the control box)
   e. Flow sensor / pressure switch
   f. Circulation pump (running, actually moving water)
   g. Heater element (multimeter test: 9-12 ohms across terminals, no continuity to housing)
   h. High limit sensor and thermostat
   i. Temperature sensor
   j. Control board — ONLY after all above are eliminated
3. When a user says they replaced a component, acknowledge it and move to the NEXT step in sequence — never skip ahead
4. Ask one focused diagnostic question at a time — do not overwhelm with multiple questions

VISUAL INSPECTION (always suggest early in electrical/heating diagnosis):
- Burn marks or scorching on any component
- Discolored or melted wire insulation
- Black residue around terminals, relays, or connectors
- Corrosion or rust on circuit boards or connections
- Fuse condition — burn marks on housing and visually inspect filament for breaks
- Any component that looks physically damaged
- Important: a blown fuse is often a SYMPTOM, not the root cause — replace it but diagnose what caused it to blow
- ALWAYS remind user to turn power off at the dedicated circuit breaker (not just topside panel) before opening the equipment bay

WHEN BURN MARKS ARE FOUND:
1. Identify the likely failed component based on location of burn marks
2. Provide part recommendation with buy links
3. Show a safety acknowledgment:
   "⚡ Working with electrical components can be extremely hazardous. Make sure the spa is completely powered off at the dedicated circuit breaker before proceeding. If you have the appropriate knowledge and experience to safely replace electrical components, tap Continue. Otherwise, we highly recommend contacting a licensed technician."
4. Offer two choices: "I'm confident, let's continue" | "I'll contact a technician"
5. If user is confident → proceed with step-by-step replacement instructions, reminding them power must be off
6. If user chooses technician → warmly summarize findings so they can brief their tech efficiently

SAFETY RULES:
- Inject power-off reminders naturally before ANY electrical step
- Rate steps honestly: SAFE (filter, water level, visual inspection), CAUTION (pump access, sensor checks), CALL_TECH only as a last resort — we are a DIY app, our goal is to empower users
- Never dismiss a valid spa answer as off-topic — responses like "it's not heating", "no indication", "nothing happened" are valid diagnostic information

OPTIONAL FORMATTING (use when genuinely helpful, not required):
When recommending a physical action step, you MAY format it as an action card:
---ACTION_CARD---
emoji: [emoji]
title: [short title]
detail: [1-2 sentence instruction]
time: [estimated time]
safety: [SAFE | CAUTION | CALL_TECH]
safety_note: [brief note if CAUTION or CALL_TECH]
---END_ACTION---

When asking a simple yes/no or multiple choice question, you MAY use inline buttons:
---INLINE_BUTTONS---
[Option 1]|[Option 2]|[Option 3]
---END_BUTTONS---

When suggesting parts to buy, use this format:
---PART_RECOMMENDATION---
name: [part name]
amazon_url: https://www.amazon.com/s?k=[url+encoded+name]&tag=spafix-test-20
supplier_url: https://www.spadepot.com/search?q=[url+encoded+name]
price_range: [$XX - $XX]
notes: [compatibility notes]
---END_PART---

Part recommendations and buy links are available to ALL users. Always provide them when relevant.

BRANDS: Balboa, Gecko, Sundance, Jacuzzi, Hot Spring, Cal Spa, Master Spa, Bullfrog, Dimension One, Marquis, Arctic, Caldera, and most others.

When documents have been uploaded, reference them specifically.

${DISCLAIMER}

Keep responses focused and free of excessive blank lines. Use **bold** for important terms. Be warm and helpful throughout.`;

const PHOTO_SYSTEM_PROMPT = `You are SpaFix AI, an expert hot tub and spa repair assistant with deep knowledge of hot tub parts, components, and repair.

The user has uploaded a photo of a hot tub part or issue. Your job is to:

1. IDENTIFY what part or issue is shown in the image. Be specific (e.g. "Balboa 2-speed pump", "diverter valve", "topside control panel", "jet body insert", "heater element", etc.)
2. DIAGNOSE the visible problem if any (corrosion, cracks, worn seals, burnt components, scale buildup, etc.)
3. RECOMMEND the fix — explain clearly what needs to be done
4. SUGGEST REPLACEMENT PARTS using this exact format for each part:

---PART_RECOMMENDATION---
name: [exact part name]
amazon_url: https://www.amazon.com/s?k=[url+encoded+part+name]&tag=spafix-test-20
supplier_url: https://www.spadepot.com/search?q=[url+encoded+part+name]
price_range: [$XX - $XX typical price range]
notes: [compatibility notes or what to look for when buying]
---END_PART---

After your diagnosis, note whether this is DIY-friendly or requires a professional.
Use **bold** for part names and important warnings.
${DISCLAIMER}`;

const DOCUMENT_SUMMARY_PROMPT = `You are SpaFix AI, an expert hot tub and spa repair assistant.

The user has uploaded a document — it may be a user manual, parts list, service history, troubleshooting notes, or similar.

Your job is to:
1. Identify what type of document this is
2. Extract the most useful information: hot tub make/model, error codes mentioned, parts already replaced, recent issues, warranty info
3. Give a brief friendly summary (3-5 sentences) of what you found and how it will help
4. Note specific details that will be especially useful going forward

Keep the tone conversational. Use **bold** for the hot tub model name and key findings.`;

// ── Routes ───────────────────────────────────────────────────────
app.post("/api/verify-pro", (req, res) => {
  const { password } = req.body;
  res.json({ success: password === PRO_PASSWORD });
});

// Get current usage stats (called by frontend on load)
app.get("/api/usage", (req, res) => {
  const clientId = getClientId(req);
  const u = getUsage(clientId);
  res.json({
    dailyMsgs: u.dailyMsgs,
    dailyLimit: FREE_DAILY_MSG_LIMIT,
    weeklySessions: u.weeklySessions,
    weeklyLimit: FREE_WEEKLY_SESSION_LIMIT,
    sessionActive: u.sessionActive,
  });
});

// Start a new session (called when user opens chat)
app.post("/api/start-session", (req, res) => {
  const { isPro } = req.body;
  if (isPro) return res.json({ allowed: true });
  const clientId = getClientId(req);
  const check = checkFreeLimits(clientId);
  res.json(check);
});

// ── Junk filter ──────────────────────────────────────────────────
// Rough spa/hot tub keyword check — if none match, run a cheap
// Haiku gate before spending on a full Sonnet call
const SPA_KEYWORDS = [
  "hot tub","spa","jacuzzi","jet","pump","heater","filter","water","chemical",
  "ph","alkalinity","chlorine","bromine","sanitize","error","code","leak","motor",
  "blower","circ","circulation","temp","temperature","balboa","gecko","sundance",
  "bullfrog","caldera","master spa","hot spring","dimension one","marquis","arctic",
  "cover","shell","cabinet","control","panel","display","topside","seal","o-ring",
  "manifold","diverter","valve","plumbing","pipe","fitting","pressure","flow","sensor",
  "thermistor","relay","capacitor","fuse","gfci","breaker","voltage","wiring","drain",
  "fill","foam","scum","algae","cloudy","green","odor","smell","shock","oxidize",
  "cartridge","skimmer","weir","ozone","uv","salt","mineral","startup","winterize",
  "fix","repair","replace","broken","not working","won't","doesn't","stopped","issue",
  "problem","help","diagnose","noise","vibration","trip","reset","error",
  "burn","scorch","black","mark","fuse","board","element","ohm","multimeter",
  "heating","cooling","light","indicator","display","reading","showing","trying",
  "clean","dirty","clogged","rinse","restart","power","electricity","wire"
];

// Diagnostic conversation replies that should always pass through
// These are short contextual answers during an ongoing diagnosis session
const DIAGNOSTIC_REPLY_PATTERNS = [
  /^(yes|no|yeah|nope|yep|nah)[\s.,!]*$/i,
  /^(it'?s?\s+)?(not\s+)?(heating|working|running|showing|displaying|on|off)/i,
  /^(there'?s?\s+)?(no|nothing|none)\s+(indication|sign|code|error|display)/i,
  /^(i\s+)?(already\s+)?(tried|replaced|cleaned|checked|tested|reset|restarted)/i,
  /^(the\s+)?(filter|pump|heater|fuse|sensor|panel|display)\s+(is|looks|seems|was)/i,
  /^(looks?\s+)?(clean|dirty|clogged|burned|burnt|black|corroded|broken|fine|ok|okay)/i,
  /^(i\s+)?(can|can't|cannot|could|couldn't)\s+(find|see|access|reach)/i,
  /^(same|still|nothing\s+changed|no\s+change|didn'?t\s+(help|work|change))/i,
  /^\d{4}\s*,?\s*\w/,  // starts with a year (spa details submission)
];

function looksSpaRelated(text) {
  const lower = text.toLowerCase().trim();
  // Check if it matches a diagnostic reply pattern — always allow these
  if (DIAGNOSTIC_REPLY_PATTERNS.some(p => p.test(lower))) return true;
  // Check spa keywords
  return SPA_KEYWORDS.some(kw => lower.includes(kw));
}

async function haikusaysSpaRelated(text) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system: "You are a content filter. Reply with only YES or NO. Does this message relate to hot tubs, spas, jacuzzis, pool equipment, water chemistry, or spa repair?",
        messages: [{ role: "user", content: text }]
      })
    });
    const data = await res.json();
    const reply = (data.content?.[0]?.text || "").trim().toUpperCase();
    return reply.startsWith("YES");
  } catch (e) {
    return true; // if gate fails, let it through
  }
}

async function isValidMessage(text) {
  if (!text || text.trim().length < 3) return { valid: false, reason: "too_short" };
  if (text.trim().length > 2000) return { valid: false, reason: "too_long" };
  // Fast keyword check first (free)
  if (looksSpaRelated(text)) return { valid: true };
  // If no keywords matched, ask Haiku (very cheap)
  const related = await haikusaysSpaRelated(text);
  if (!related) return { valid: false, reason: "off_topic" };
  return { valid: true };
}
// ─────────────────────────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  const { messages, isPro } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array required" });

  // Validate the latest user message
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "user") {
    const content = typeof lastMsg.content === "string" ? lastMsg.content : "";
    const check = await isValidMessage(content);
    if (!check.valid) {
      const msgs = {
        too_short: "Please describe your hot tub issue in a bit more detail.",
        too_long: "Your message is too long — please keep it under 2,000 characters.",
        off_topic: "SpaFix can only help with hot tub and spa questions. Please describe your spa issue and I'll be happy to help!"
      };
      return res.status(400).json({ error: msgs[check.reason] || "Please ask a spa-related question." });
    }
  }

  // Enforce free limits
  if (!isPro) {
    const clientId = getClientId(req);
    const u = getUsage(clientId);
    if (u.dailyMsgs >= FREE_DAILY_MSG_LIMIT) {
      return res.status(429).json({
        limitReached: true,
        reason: "daily_messages",
        message: `You've reached the ${FREE_DAILY_MSG_LIMIT} message limit for today. Come back tomorrow, or upgrade to Pro for unlimited messages.`,
      });
    }
    if (!u.sessionActive) {
      if (u.weeklySessions >= FREE_WEEKLY_SESSION_LIMIT) {
        return res.status(429).json({
          limitReached: true,
          reason: "weekly_sessions",
          message: `You've used all ${FREE_WEEKLY_SESSION_LIMIT} free sessions this week. Sessions reset every Sunday, or upgrade to Pro for unlimited access.`,
        });
      }
      u.weeklySessions++;
      u.sessionActive = true;
    }
    u.dailyMsgs++;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1024, system: TEXT_SYSTEM_PROMPT, messages }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || "API error" });

    // Return updated usage counts with the reply
    const clientId = getClientId(req);
    const u = getUsage(clientId);
    res.json({
      reply: data.content?.map((b) => b.text || "").join("") || "",
      usage: isPro ? null : { dailyMsgs: u.dailyMsgs, dailyLimit: FREE_DAILY_MSG_LIMIT, weeklySessions: u.weeklySessions, weeklyLimit: FREE_WEEKLY_SESSION_LIMIT },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/analyze-photo", async (req, res) => {
  const { imageBase64, mediaType, messages, isPro } = req.body;
  if (!imageBase64 || !mediaType) return res.status(400).json({ error: "imageBase64 and mediaType required" });
  // Photo analysis is Pro-only — no rate limiting needed here
  try {
    const allMessages = [
      ...(messages || []),
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        { type: "text", text: "Please identify this hot tub part or issue and give me your diagnosis and part recommendations." }
      ]}
    ];
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2048, system: PHOTO_SYSTEM_PROMPT, messages: allMessages }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || "API error" });
    res.json({ reply: data.content?.map((b) => b.text || "").join("") || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/analyze-document", async (req, res) => {
  const { documentBase64, mediaType, filename } = req.body;
  if (!documentBase64 || !mediaType) return res.status(400).json({ error: "documentBase64 and mediaType required" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: DOCUMENT_SUMMARY_PROMPT,
        messages: [{ role: "user", content: [
          { type: "document", source: { type: "base64", media_type: mediaType, data: documentBase64 } },
          { type: "text", text: `Please read this document (filename: ${filename || "uploaded file"}) and summarize what you found.` }
        ]}]
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || "API error" });
    res.json({ summary: data.content?.map((b) => b.text || "").join("") || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("SpaFix API v4 running ✓"));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SpaFix server running on port ${PORT}`));
