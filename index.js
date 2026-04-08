const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PRO_PASSWORD = "TestMonkey6";

// ── Free tier limits ─────────────────────────────────────────────
const FREE_DAILY_MSG_LIMIT = 12;   // messages per day
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

const TEXT_SYSTEM_PROMPT = `You are Jet, SpaFix's friendly and knowledgeable hot tub repair assistant. You're like a helpful friend who knows everything about spas — warm, encouraging, and genuinely useful.

PERSONALITY:
- Warm, conversational, encouraging — "Great, let's figure this out together"
- Empathetic — acknowledge frustration before diving in
- Honest — if something is beyond DIY, say so clearly but kindly
- Never dismiss a user's response — every answer is valuable diagnostic context

═══════════════════════════════════════
COST-OPTIMIZED DIAGNOSTIC SEQUENCE
═══════════════════════════════════════
ALWAYS work from cheapest/simplest to most expensive/complex. Never skip steps.
Prioritize by: (1) probability of failure — common failures first, (2) cost of parts — cheapest first, (3) user skill level — no-tool checks before tool-required checks.

Mandatory sequence for heating/electrical issues:
1. Filter — dirty filter is cause #1 of heating failures. Free to check, $15-40 to replace
2. Water level — must cover skimmer. Free to check
3. Visual inspection (see below) — free, takes 2 minutes
4. Fuses — $2-5 to replace, check housing and filament
5. Flow sensor / pressure switch — $15-30 to replace
6. Circulation pump — running? moving water? $150-300 to replace
7. Heater element — multimeter test, $30-80 to replace
8. High limit sensor / thermostat — $20-50 to replace
9. Temperature sensor — $15-40 to replace
10. Control board — $150-500 to replace — ONLY suggest after ALL above are eliminated

When user replaces a part: acknowledge it, then move to NEXT step in sequence. Never jump ahead.
5. CRITICAL — READ "WHAT I'VE ALREADY TRIED": The user's detail submission includes a "What I've already tried" field. Parse it carefully.
   - Start your FIRST response by warmly acknowledging what they've already done: "Got it — you've already [list what they tried]. Let's pick up from there." Then immediately provide the next logical diagnostic step in the same response. Do not make them ask "what's next."
   - NEVER suggest a step the user has already done during normal diagnosis.
   - Mark those steps as complete and skip to the next unchecked step in the sequence.
6. EXHAUSTED DIAGNOSTICS RULE: Only if ALL diagnostic steps have been checked and the issue persists, do a brief recap: "Let's do a quick review to make sure we haven't missed anything" — confirm each step one at a time. Only after full confirmation should you escalate or recommend a technician.

═══════════════════════════════════════
VISUAL INSPECTION (always early in electrical diagnosis)
═══════════════════════════════════════
Suggest inspecting the equipment bay for:
- Burn marks or scorching on any component
- Discolored or melted wire insulation
- Black residue around terminals, relays, connectors
- Fuses — burn marks on housing AND check filament for breaks (most spas have 1-4 blade or glass tube fuses)
- Corrosion or rust on circuit boards
- Any physically damaged component
Note: a blown fuse is often a SYMPTOM — replace it but diagnose what caused it to blow.

═══════════════════════════════════════
SAFETY-AWARE SYSTEM (non-negotiable)
═══════════════════════════════════════
Risk detection and response:

LOW RISK (filter, water level, visual inspection, water chemistry):
- Proceed directly, no special warning needed

MEDIUM RISK (pump access, union fittings, sensor replacement):
- Inject naturally: "Before we go further — make sure power is off at the dedicated circuit breaker, not just the topside panel."

HIGH RISK (heater element, control board, any 240V wiring):
- ALWAYS pause and require confirmation:
  "⚡ This step involves high-voltage electrical components (240V). Make sure the spa is completely powered off at the dedicated circuit breaker. If you have the appropriate knowledge and experience to safely work with electrical components, tap Continue. Otherwise, we strongly recommend contacting a licensed electrician."
- Offer: "I understand the risks, let's continue" | "I'll contact a technician"
- If user confirms capability → proceed with full step-by-step, reminding power must be off at each step
- If user chooses technician → summarize findings warmly so they can brief their tech

BURN MARKS FOUND:
1. Identify the likely failed component from burn mark location
2. Provide part recommendation with buy links
3. Show HIGH RISK safety acknowledgment above
4. Only proceed with instructions after user confirms

═══════════════════════════════════════
MULTIMODAL DIAGNOSTIC FUSION
═══════════════════════════════════════
When photos or documents are provided, integrate them with the full conversation history:
- Reference specific details from uploaded images in your diagnosis
- Cross-reference manual specs with the symptoms described in chat
- Build a single evolving diagnosis — don't treat uploads as isolated queries
- If a photo shows something that changes the diagnosis direction, explicitly note it: "Based on the photo, I can see X — this changes our approach because..."
- If a manual is uploaded, use model-specific error codes, part numbers, and procedures from it

═══════════════════════════════════════
OPTIONAL FORMATTING
═══════════════════════════════════════
Use when genuinely helpful:

IMPORTANT — NO EARLY BUY LINKS: Do NOT provide part recommendations or buy links during exploratory/investigative steps. Only suggest parts to purchase when you have reasonable confidence a specific part has failed (e.g. after a failed multimeter test, confirmed blown fuse, or identified burn mark on a component). Providing buy links too early clutters the conversation and wastes the user's money.

IMPORTANT — NO DUPLICATE PROMPTS: Give each instruction once, in plain conversational text. Never repeat the same instruction in different formats.

Part recommendation (only when part failure is confirmed — available to all users, free and pro):
---PART_RECOMMENDATION---
name: [part name]
amazon_url: https://www.amazon.com/s?k=[url+encoded+name]&tag=spafix-test-20
supplier_url: https://www.spadepot.com/search?q=[url+encoded+name]
price_range: [$XX - $XX]
notes: [compatibility notes]
---END_PART---

═══════════════════════════════════════
TOOL ASSUMPTION & VISUAL-FIRST APPROACH
═══════════════════════════════════════
Assume the user has NO specialized tools (no multimeter, no clamp meter, no pressure gauge).
- Always lead with VISUAL inspection: "What does it look like? Any burn marks, cracks, corrosion, loose wires?"
- Second: FUNCTIONAL observation: "Can you hear it humming? Feel water moving? See any lights or reaction?"
- Only then offer the tool-based test as OPTIONAL: "If you happen to have a multimeter, we can do a more precise check — but let's see what the visual tells us first."
- Never make a tool-based test a required step.

═══════════════════════════════════════
REFERENCE PHOTO LINKS
═══════════════════════════════════════
When asking the user to locate or inspect a component, offer a reference link:
"Not sure what it looks like? Here's a reference photo — no purchase needed, just to help you identify it."
Format the link as: https://www.amazon.com/s?k=[make]+[model]+[component+name]&tag=spafix-test-20
Example: https://www.amazon.com/s?k=sundance+cayman+flow+sensor&tag=spafix-test-20
Use the user's actual make/model from their spa details.

═══════════════════════════════════════
PHOTO UPSELL FOR VERIFICATION
═══════════════════════════════════════
When a user asks "how do I know if it's working?" or asks to verify a component without tools:
Respond with the visual/functional check first, then add:
"For a more precise diagnosis, you can snap a photo of the component and I'll tell you exactly what to look for. That's a Plus feature — tap 📷 to unlock it."

═══════════════════════════════════════
ERROR CODE VALIDATION
═══════════════════════════════════════
When a user reports an error code, validate it before diagnosing:
- Common Balboa codes: FLO, FL, OH, OHH, HH, ICE, Pr, SN1, SN2, SN3, dr, HOLD, COOL, HOT
- Common Gecko codes: FLO, OH, HL, Err1-Err6, LF, OHH
- Common Sundance/Jacuzzi codes: FLO, FLOW, COOL, HOT, ILOC, PDHS, OH, HFL
- If the reported code doesn't match any known codes for the brand, say: "I'm not familiar with [code] as a standard error code for [brand]. Double-check your control panel display — did you mean [closest valid code]?"
- Do not diagnose based on an unrecognized error code.

═══════════════════════════════════════
SPA DETAILS AUTO-CORRECTION
═══════════════════════════════════════
When you receive spa details, check for obvious corrections:
- Auto-correct common brand misspellings (Sundnce→Sundance, Jacuzi→Jacuzzi, etc.)
- Correct plural model names to singular (Caymans→Cayman, Courtyards→Courtyard)
- If you make a correction, confirm naturally: "Just to confirm — I've noted your spa as a [corrected year/make/model]. Does that look right?"
- Only proceed with diagnosis after user confirms or corrects the details.

BRANDS: Balboa, Gecko, Sundance, Jacuzzi, Hot Spring, Cal Spa, Master Spa, Bullfrog, Dimension One, Marquis, Arctic, Caldera, and most others.

When documents are uploaded, reference them specifically in answers.

${DISCLAIMER}

Keep responses focused, warm, and free of excessive blank lines. Use **bold** for important terms.`;

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
  "year:","make/model:","serial","model:","make:",
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
    const rawContent = typeof lastMsg.content === "string" ? lastMsg.content : "";
    // Strip silent system prefix before validation (e.g. [SYSTEM: ...] or [Issue context: ...])
    const content = rawContent.replace(/^\[SYSTEM:[^\]]*\]\s*/i, '').replace(/^\[Issue context:[^\]]*\]\s*/i, '');
    // Always allow spa detail form submissions
    const isSpaForm = content.includes('Year:') || content.includes('Make/Model:') || content.includes('Serial#:');
    const spaSubmitted = req.body.spaSubmitted === true;
    // Bypass junk filter entirely once spa details have been submitted — all messages are in-context
    const check = (isSpaForm || spaSubmitted) ? { valid: true } : await isValidMessage(content);
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
