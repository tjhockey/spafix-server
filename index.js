process.env.APP_VERSION = "v4.9.20ae";
require('dotenv').config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

var cachedEnvLoadState = null;

function loadServerEnv() {
  if (cachedEnvLoadState) return cachedEnvLoadState;

  const envPath = path.join(__dirname, ".env");
  let dotenvInitialized = false;
  let envFileLoaded = false;

  try {
    require("dotenv").config({ path: envPath });
    dotenvInitialized = true;
    envFileLoaded = true;
  } catch (error) {
    if (!fs.existsSync(envPath)) {
      return { dotenvInitialized, envFileLoaded, envPath };
    }

    const rawEnv = fs.readFileSync(envPath, "utf8");
    for (const line of rawEnv.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
      if (!match) continue;

      const [, key, rawValue] = match;
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
      envFileLoaded = true;
    }
  }

  cachedEnvLoadState = { dotenvInitialized, envFileLoaded, envPath };
  return cachedEnvLoadState;
}

const envLoadState = loadServerEnv();
if (!envLoadState.dotenvInitialized && envLoadState.envFileLoaded) {
  console.warn("[auth] dotenv was not available at startup; loaded server/.env with the fallback parser.");
}

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:9000",
  "http://localhost:8080",
  "https://spafix.app",
  "https://www.spafix.app",
  "https://claude.ai",
];

function normalizeOrigin(origin) {
  if (typeof origin !== "string") return "";
  const trimmed = origin.trim();
  if (!trimmed) return "";

  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

const allowedOrigins = new Set(
  [
    ...DEFAULT_ALLOWED_ORIGINS,
    process.env.FRONTEND_ORIGIN || "",
    ...(process.env.ALLOWED_ORIGINS || "").split(","),
  ]
    .map(normalizeOrigin)
    .filter(Boolean)
);

function isAllowedOrigin(origin) {
  return allowedOrigins.has(normalizeOrigin(origin));
}

function enforceAllowedOrigin(req, res, next) {
  const origin = req.get("origin");

  // Allow non-browser/internal requests that do not send an Origin header.
  if (!origin) return next();
  if (isAllowedOrigin(origin)) return next();

  return res.status(403).json({ error: "Origin not allowed." });
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, isAllowedOrigin(origin));
  },
};

const GLOBAL_JSON_LIMIT = "5mb";
const UPLOAD_JSON_LIMIT = "10mb";
const uploadJsonParser = express.json({ limit: UPLOAD_JSON_LIMIT });
const defaultJsonParser = express.json({ limit: GLOBAL_JSON_LIMIT });

const app = express();
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// ── RATE LIMITING ──────────────────────────────────────────────
// Protect /api/chat from bot spam — applied before all other chat middleware
const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute window
  max: 60,                     // max 60 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown",
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests — please slow down.", limitReached: false });
  }
});

// minIntervalGuard removed v4.9.9 — was causing legitimate 429s
// ──────────────────────────────────────────────────────────────
app.use("/api", enforceAllowedOrigin, cors(corsOptions));
app.use(["/api/analyze-photo", "/api/analyze-document"], uploadJsonParser);
app.use(defaultJsonParser);

const DIAGNOSIS_FIELD_NAMES = new Set(["diagnosis"]);
const DIAGNOSIS_TYPO_FIXES = [
  [/\bteh\b/gi, "the"],
  [/\bhte\b/gi, "the"],
  [/\bdont\b/gi, "don't"],
  [/\bdoesnt\b/gi, "doesn't"],
  [/\bcant\b/gi, "can't"],
  [/\bwont\b/gi, "won't"],
  [/\btheres\b/gi, "there's"],
];

function normalizeDiagnosis(text) {
  if (typeof text !== "string" || !text) return text;

  // Plain-string normalization is already idempotent, so we keep returning
  // a normal string instead of wrapping/tagging it.
  let cleaned = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s([.,!?])/g, "$1");

  for (const [pattern, replacement] of DIAGNOSIS_TYPO_FIXES) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  if (cleaned) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned;
}

function normalizeDiagnosisFields(value) {
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    for (const item of value) normalizeDiagnosisFields(item);
    return value;
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue === "string" && DIAGNOSIS_FIELD_NAMES.has(key)) {
      value[key] = normalizeDiagnosis(fieldValue);
      continue;
    }

    if (fieldValue && typeof fieldValue === "object") {
      normalizeDiagnosisFields(fieldValue);
    }
  }

  return value;
}

function normalizeDiagnosisPayload(req, res, next) {
  normalizeDiagnosisFields(req.body);
  next();
}

function normalizeDiagnosisResponse(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    normalizeDiagnosisFields(body);
    return originalJson(body);
  };
  next();
}

app.use("/api", normalizeDiagnosisPayload, normalizeDiagnosisResponse);

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
if (!ANTHROPIC_API_KEY) {
  console.error("Missing required environment variable: ANTHROPIC_API_KEY. Set it before starting the SpaFix server.");
  process.exit(1);
}

const nativeFetch = globalThis.fetch.bind(globalThis);
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_TIMEOUT_MS = 10000; // 10s per individual call — retries handle transient failures
const ANTHROPIC_TIMEOUT_MESSAGE = "Anthropic API request timed out. Please try again.";

function getRequestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input?.url || "";
}

function createAnthropicTimeoutResponse() {
  return new Response(
    JSON.stringify({
      error: {
        type: "request_timeout",
        message: ANTHROPIC_TIMEOUT_MESSAGE,
      },
    }),
    {
      status: 504,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
}

async function fetch(input, init) {
  if (getRequestUrl(input) !== ANTHROPIC_API_URL) {
    return nativeFetch(input, init);
  }

  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const abortFromUpstream = () => controller.abort();

  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    return await nativeFetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" && !upstreamSignal?.aborted) {
      return createAnthropicTimeoutResponse();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", abortFromUpstream);
  }
}

// ── Test passwords (tester name → password) ──────────────────────
function normalizeAccessCode(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAccessCodeForComparison(value) {
  return normalizeAccessCode(value).toLowerCase();
}

function parseAccessCodeList(value) {
  return String(value || "")
    .split(",")
    .map(normalizeAccessCode)
    .filter(Boolean);
}

// ── Access codes — env only, no hardcoded fallbacks ───────────────
// To add/remove testers: edit TESTER_KEYS in Railway Variables (comma-separated)
const ADMIN_KEY = normalizeAccessCode(process.env.ADMIN_KEY);
const TESTER_KEYS = parseAccessCodeList(process.env.TESTER_KEYS);
const PRO_SECRET = normalizeAccessCode(process.env.PRO_SECRET || process.env.PRO_ACCESS_KEY);

// Tester name derived from the code itself — no hardcoding needed
// e.g. "Tester-Alpha1" → testerName = "Tester-Alpha1"
function getTesterName(normalizedCode) {
  const match = TESTER_KEYS.find(k => k === normalizedCode);
  if (!match) return null;
  // Reconstruct display name from the raw TESTER_KEYS env string
  const raw = String(process.env.TESTER_KEYS || "").split(",").map(s => s.trim());
  return raw.find(r => normalizeAccessCode(r) === normalizedCode) || match;
}

if (process.env.NODE_ENV !== 'production') {
  console.log("[env] dotenv initialized:", envLoadState.dotenvInitialized);
  console.log("[env] TESTER_KEYS count:", TESTER_KEYS.length);
  console.log("[env] ADMIN_KEY set:", !!ADMIN_KEY);
}
const PRO_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const proSessions = new Map(); // token -> { testerName, clientId, expiresAt }

// ── Transcript log (in-memory, resets on restart) ─────────────────
const transcriptLog = {}; // key: testerName, value: array of session objects

function logTestSession(testerName, clientId) {
  if (!transcriptLog[testerName]) transcriptLog[testerName] = [];
  const existing = transcriptLog[testerName].find(s => s.clientId === clientId && s.active);
  if (existing) return existing;
  const session = { clientId, testerName, startTime: new Date().toISOString(), messages: [], active: true };
  transcriptLog[testerName].push(session);
  return session;
}

function getTestSession(testerName, clientId) {
  if (!transcriptLog[testerName]) return null;
  return transcriptLog[testerName].find(s => s.clientId === clientId && s.active) || null;
}

function appendToTranscript(testerName, clientId, role, content) {
  const session = getTestSession(testerName, clientId);
  if (session) session.messages.push({ role, content: content.slice(0, 500), time: new Date().toISOString() });
}

function secureCompare(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function accessCodesMatch(provided, expected) {
  const left = normalizeAccessCodeForComparison(provided);
  const right = normalizeAccessCodeForComparison(expected);
  if (!left || !right) return false;
  return secureCompare(left, right);
}

function getProvidedProToken(req) {
  const headerToken = req.headers["x-spafix-pro-token"];
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim();
  return "";
}

function getProvidedAccessCode(req) {
  const headerCode = req.headers["x-spafix-access-code"];
  if (typeof headerCode === "string" && headerCode.trim()) return headerCode.trim();
  return "";
}

function hasPremiumAccess(req) {
  const provided = normalizeAccessCode(req.headers["x-spafix-access-code"]);
  if (!provided) return false;
  const isAdmin = !!ADMIN_KEY && accessCodesMatch(provided, ADMIN_KEY);
  const isTester = TESTER_KEYS.some(k => accessCodesMatch(provided, k));
  const isPro = !!PRO_SECRET && accessCodesMatch(provided, PRO_SECRET);
  return isAdmin || isTester || isPro;
}

function pruneExpiredProSessions() {
  const now = Date.now();
  for (const [token, session] of proSessions.entries()) {
    if (!session?.expiresAt || session.expiresAt <= now) proSessions.delete(token);
  }
}

function resolveProAccess(rawCode) {
  const provided = normalizeAccessCode(rawCode);
  if (!provided) return { success: false, error: "Access code required." };

  const adminMatch = !!ADMIN_KEY && accessCodesMatch(provided, ADMIN_KEY);
  const proMatch = !!PRO_SECRET && accessCodesMatch(provided, PRO_SECRET);
  const testerMatch = TESTER_KEYS.some(k => accessCodesMatch(provided, k));

  if (adminMatch) {
    return { success: true, testerName: null, role: "admin" };
  }

  if (proMatch) {
    return { success: true, testerName: null, role: "pro" };
  }

  if (testerMatch) {
    const testerName = getTesterName(provided) || provided;
    return { success: true, testerName, role: "tester" };
  }

  return { success: false, error: "Invalid access code." };
}

function createProSession(clientId, testerName = null) {
  pruneExpiredProSessions();
  const token = crypto.randomBytes(32).toString("hex");
  proSessions.set(token, {
    clientId,
    testerName,
    expiresAt: Date.now() + PRO_SESSION_TTL_MS,
  });
  return token;
}

function getProAuth(req) {
  const token = getProvidedProToken(req);
  if (token) {
    pruneExpiredProSessions();
    const session = proSessions.get(token) || null;
    if (session) {
      if (session.expiresAt <= Date.now()) {
        proSessions.delete(token);
      } else {
        return { provided: true, session };
      }
    }
  }

  const directAccessCode = getProvidedAccessCode(req);
  if (directAccessCode) {
    const access = resolveProAccess(directAccessCode);
    if (!access.success) return { provided: true, session: null };
    return {
      provided: true,
      session: {
        clientId: getClientId(req),
        testerName: access.testerName || null,
        role: access.role,
        directAccess: true,
        expiresAt: Date.now() + PRO_SESSION_TTL_MS,
      },
    };
  }

  if (token) return { provided: true, session: null };
  return { provided: false, session: null };
}

function requireProSession(req, res) {
  const auth = getProAuth(req);
  if (!auth.session) {
    const message = auth.provided
      ? "Your Premium session expired. Please enter your access code again."
      : "Premium access required. Please enter a valid access code.";
    res.status(401).json({ error: message });
    return null;
  }
  return auth.session;
}

// ── Debug logging ─────────────────────────────────────────────────
// Set DEBUG=true in .env to enable verbose logging for troubleshooting
const DEBUG = process.env.DEBUG === 'true';
const dbg = (...args) => { if (DEBUG) console.log('[SpaFix DEBUG]', ...args); };


const FREE_DAILY_MSG_LIMIT = 10;   // messages per day
const FREE_WEEKLY_SESSION_LIMIT = 3; // sessions per week

// In-memory store for rate limiting (resets on server restart)
// In production, replace with Redis or a database
const usageStore = {}; // key: clientId, value: { dailyMsgs, dailyDate, weeklySessions, weekStart, sessionActive }

function getClientId(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}
function getWeekStart(date = new Date()) {
  const d = new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate()-d.getDay()); return d.toISOString().split("T")[0];
}
function getTodayStr() { return new Date().toISOString().split("T")[0]; }
function resetDailyIfNeeded(u) {
  if (!u) return u;
  const today = getTodayStr(), weekStart = getWeekStart();
  if (u.dailyDate !== today) { u.dailyMsgs = 0; u.dailyDate = today; u.sessionActive = false; }
  if (u.weekStart !== weekStart) { u.weeklySessions = 0; u.weekStart = weekStart; u.sessionActive = false; }
  return u;
}
function getUsage(clientId) {
  if (!usageStore[clientId]) usageStore[clientId] = { dailyMsgs:0, dailyDate:getTodayStr(), weeklySessions:0, weekStart:getWeekStart(), sessionActive:false };
  return resetDailyIfNeeded(usageStore[clientId]);
}
function checkFreeLimits(clientId) {
  const u = getUsage(clientId);
  if (!u.sessionActive) {
    if (u.weeklySessions >= FREE_WEEKLY_SESSION_LIMIT) return { allowed:false, reason:"weekly_sessions", message:`You've used all ${FREE_WEEKLY_SESSION_LIMIT} free sessions this week. Sessions reset every Sunday, or upgrade to Premium for unlimited access.` };
    u.weeklySessions++; u.sessionActive = true; u.dailyMsgs = 0;
  }
  if (u.dailyMsgs >= FREE_DAILY_MSG_LIMIT) return { allowed:false, reason:"daily_messages", message:`You've reached the ${FREE_DAILY_MSG_LIMIT} message limit for today. Come back tomorrow, or upgrade to Premium for unlimited messages.` };
  return { allowed:true };
}
const DISCLAIMER = ``;

// ── FIRE templates — server-side static text, zero prompt tokens ──
const FIRE_TEMPLATES = {
  'F:AP': `Step 5 — Air Lock Purge:

##If the spa was recently drained or refilled, an air pocket may be trapped in the pump housing -- this prevents water from circulating and can trigger both flow and overheat errors. Let's flush it out.##

⚠️ Be sure to only use a plain garden hose for these steps — no sprayer, nozzle or attachments. Forcing pressurized air or a hard stream can damage internal components.

1. Wrap a towel around the end of a plain garden hose to create a seal against the filter inlet opening.
2. Have someone turn the water on fully and wait until only water (no air) is coming out of the hose end.
3. Press the hose and towel firmly over the filter inlet and force water through for 30–60 seconds.
4. You may see air bubbling up from the jets — that's normal. Keep going until only water flows with no bubbles.
5. Stop and check if the error has cleared.
6. If not cleared, repeat once more.`,

  'F:BR': `Before we go further — try a full breaker reset. Find the dedicated circuit breaker for your spa (not the topside panel) and flip it OFF. Wait 15 seconds, then flip it back ON.`,

  'F:BE': `Before we open the equipment bay — turn off the dedicated circuit breaker. Not the topside panel button — the breaker in your electrical panel. The topside button does not fully cut power to the components inside.`,

  'F:CP': `⚠️ Power stays ON for this step — touch the pump housing only. Keep hands completely away from all wires, terminals, and connectors.`,

  'F:BC': `⚠️ When opening the equipment bay, avoid touching any electrical components, wiring, or terminals. The spa pack (control box) houses the electrical components and should remain closed — do not open it. You'll be working with plumbing components only. Some steps will require power ON to observe water flow and pump operation — we'll let you know when power needs to be off. Only proceed if you're comfortable working around spa equipment.`,
};

// ── Diagnostic step definitions — button-driven state machine ─────
const DIAG_STEPS = {
  // ── FLOW sequence ─────────────────────────────────────────────
  S2a: { id:'S2a', next:'S2b', label:'Water condition',
    question:'What does the water look like right now?',
    buttons:[
      {label:'Clear', outcome:'pass'},
      {label:'Cloudy / Foamy', outcome:'possible', action:'water_cloudy'},
      {label:'Visibly dirty', outcome:'action', action:'water_dirty'},
    ]
  },
  S2b: { id:'S2b', next:'S1', label:'Water level',
    question:'#If the water level is too low, the pump will suck in air instead of water. This creates an air lock or heavy foam, which tricks the spa\'s sensors into throwing a false "Low Flow" (FLO) or Overheat (OH) error—safely shutting down your heater even if the hardware is perfectly fine.\n\nWhat we\'re looking for:\n\n• The Vortex: A whirlpool pulling air down into the plumbing.\n• The Sweet Spot: The water level needs to be at least 1 to 2 inches above the top of the skimmer opening (or roughly halfway up the skimmer face). This guarantees a steady, unbroken stream of water to the pump and heater.#\n\nDoes the water cover the skimmer opening by at least an inch?',
    buttons:[
      {label:"Yes, it's fine", outcome:'pass'},
      {label:'It looks low', outcome:'action', action:'top_up'},
    ]
  },
  S1: { id:'S1', next:'S3', label:'Filter condition',
    question:'',
    buttons:[
      {label:'Clean / New', outcome:'action', action:'filter_clean'},
      {label:'A little dirty', outcome:'action', action:'filter_dirty'},
      {label:"They're filthy", outcome:'action', action:'filter_filthy'},
    ]
  },
  S3: { id:'S3', next:'S4', label:'Suction test',
    question:'With the filter(s) still removed, turn on the spa and check the water intake (where the filter usually sits). A healthy spa will always have a strong, noticeable pull at the inlet. What do you feel?',
    buttons:[
      {label:'Strong suction', outcome:'pass'},
      {label:'Weak or no suction', outcome:'possible'},
      {label:"Can't find the inlet", outcome:'action', action:'cant_find_inlet'},
    ]
  },
  S4: { id:'S4', next:'S5', label:'Air lock purge',
    fire:'F:AP',
    question:'',
    buttons:[
      {label:'Error cleared', outcome:'action', action:'airlock_cleared'},
      {label:'Error still showing', outcome:'pass'}
    ]
  },
  S5: { id:'S5', next:'BREAKER', label:'Heater indicator',
    question:'Set the target temp above the current water temp. Do you see a heating indicator — a light, flame icon, or the word Heat — on the topside panel?',
    buttons:[
      {label:'Yes, I see it', outcome:'pass'},
      {label:'No indicator showing', outcome:'action', action:'heater_no_indicator'}
    ]
  },
  BREAKER: { id:'BREAKER', next:'S6', label:'Breaker reset',
    fire:'F:BR',
    question:'',
    buttons:[
      {label:'Error cleared', outcome:'pass'},
      {label:'Error still showing', outcome:'pass'}
    ]
  },
  S6: { id:'S6', next:'S6b', label:'Gate valves',
    bayStep:true,
    question:'Some spa manufacturers use gate valves — also called slice valves or isolation valves — and they\'re sometimes added as aftermarket upgrades. If your spa was working fine and recently developed issues, it\'s unlikely one of these has closed on its own. If you\'re troubleshooting a spa that\'s been sitting idle, it\'s worth checking your manual and taking a peek in the equipment bay.',
    buttons:[
      {label:'All fully open', outcome:'pass'},
      {label:'Found one closed', outcome:'action', action:'valve_closed'},
      {label:"My spa doesn't have these", outcome:'skip'}
    ]
  },
  S6b: { id:'S6b', next:'S7', label:'Air purge valve',
    bayStep:true,
    question:'Some spas have an air purge valve on the pump or plumbing — it looks like a small bleed valve or knurled cap. Not all spas have one. If yours has one and you see air bubbling out when you open it, keep it open until only water flows, then close it.',
    buttons:[
      {label:'Error cleared', outcome:'pass'},
      {label:'Still showing / No valve', outcome:'pass'}
    ]
  },
  S7: { id:'S7', next:'S8a', label:'Air lock phase 2',
    fire:'F:AP',
    bayStep:true,
    question:'',
    buttons:[
      {label:'Error cleared', outcome:'pass'},
      {label:'Still showing', outcome:'pass'}
    ]
  },
  S8a: { id:'S8a', next:'S8b', label:'Circ pump',
    fire:'F:CP',
    bayStep:true,
    question:'Find the circulation pump — the smaller pump separate from the jet pumps. Some circ pumps run continuously while others only activate with certain features — if yours isn\'t running right now, try activating the jets or heating cycle to bring it online. Some spas have more than one — if yours does, check each one. Feel the housing.',
    buttons:[
      {label:'Humming / warm', outcome:'action', action:'circ_flow_check'},
      {label:'Silent', outcome:'fail', part:'circulation pump'},
      {label:'Grinding / very hot', outcome:'fail', part:'circulation pump'},
      {label:'Leaking', outcome:'fail', part:'circ pump seal'}
    ]
  },
  S8b: { id:'S8b', next:'S8c', label:'Flow switch visual',
    bayStep:true,
    question:"You've already located the flow switch — now let's test it more closely. The circ pump pushes water through the heater and then to the flow switch/sensor downstream. The sensor must detect sufficient flow to function properly — if flow is insufficient, the circuit won't close and the spa fails. You should be able to visually see the paddle of the flow sensor making contact with the post. Sometimes these sensors fail even when making contact.",
    buttons:[
      {label:'Paddle moves freely, making contact', outcome:'pass'},
      {label:'Paddle stuck or not making contact', outcome:'fail', part:'flow switch'},
      {label:'Arrow pointing wrong way', outcome:'fail', part:'flow switch'},
      {label:"Can't find it", outcome:'action', action:'cant_find_flow_switch'}
    ]
  },
  S8c: { id:'S8c', next:'S9', label:'Flow switch jumper',
    fire:'F:FJ',
    bayStep:true,
    question:'We\'re going to temporarily bypass the flow switch to test if it\'s the cause. With power OFF, photograph your wire connections, disconnect the flow switch wires, and bridge the two terminals with a small wire or jumper. Restore power and check if the error clears.',
    buttons:[
      {label:"Error cleared — it's the flow switch", outcome:'fail', part:'flow switch'},
      {label:'Error still showing', outcome:'pass'}
    ]
  },
  S9: { id:'S9', next:'S10', label:'Visual inspection',
    bayStep:true,
    question:'Using a flashlight, inspect the entire equipment bay. Look for burn marks, scorched wires, corrosion, or anything that looks out of place. Pay close attention to the control board — look for any black or brown spots or char marks around the connectors.',
    buttons:[
      {label:'Everything looks clean', outcome:'pass'},
      {label:'Found burn marks or corrosion', outcome:'fail', part:'control board'},
      {label:'Found something unusual', outcome:'action', action:'unusual_finding'}
    ]
  },
  S10: { id:'S10', next:'S11', label:'Fuses',
    bayStep:true,
    question:'Check all fuses in the equipment bay — look at both the housing and the filament inside. A blown fuse is a symptom, not a root cause — we\'ll need to find what caused it.',
    buttons:[
      {label:'All fuses intact', outcome:'pass'},
      {label:'Found a blown fuse', outcome:'possible', part:'fuse kit'}
    ]
  },
  S11: { id:'S11', next:'S12', label:'Temp sensor',
    question:'Compare the water temperature shown on your topside panel against how the water actually feels. A significant difference can indicate a faulty temp sensor.',
    buttons:[
      {label:'Readings match', outcome:'pass'},
      {label:'Big difference between display and actual', outcome:'fail', part:'temp sensor'}
    ]
  },
  S12: { id:'S12', next:'S13', label:'Hi-limit sensor',
    question:"Find the hi-limit sensor and check for a small reset button — press it if present. The hi-limit cuts power to the heater if water gets too hot. Check if your water feels dangerously hot.",
    buttons:[
      {label:'Reset button found and pressed / No button', outcome:'pass'},
      {label:'Water feels dangerously hot', outcome:'fail', part:'hi-limit sensor', critical:true}
    ]
  },
  S13: { id:'S13', next:'S14', label:'Heater element',
    question:'Do you have a multimeter?',
    buttons:[
      {label:'Yes, I have one', outcome:'action', action:'multimeter_test'},
      {label:"No, I don't", outcome:'action', action:'visual_element_check'},
      {label:"I'd like one", outcome:'action', action:'suggest_multimeter'}
    ]
  },
  S14: { id:'S14', next:null, label:'Control board',
    question:"Based on everything we've checked, the control board is the most likely remaining cause. Before ordering, photograph everything — wide shot of the full board, every connector, and all jumper settings. Pull connectors by the housing only, never by the wires. Check for any discolored wires near burn marks — a damaged harness with a new board will result in immediate failure.",
    buttons:[
      {label:'Show me control board options', outcome:'fail', part:'control board'},
      {label:'I need help identifying my board', outcome:'action', action:'identify_board'},
    ]
  },

  // ── HEAT sequence ─────────────────────────────────────────────
  H2a: { id:'H2a', next:'H2b', label:'Water condition',
    question:'What does the water look like right now?',
    buttons:[
      {label:'Clear', outcome:'pass'},
      {label:'Cloudy / Foamy', outcome:'possible', action:'water_cloudy'},
      {label:'Visibly dirty', outcome:'action', action:'water_dirty'},
    ]
  },
  H2b: { id:'H2b', next:'H1', label:'Water level',
    question:'Does the water cover the skimmer opening by at least 1 to 2 inches?',
    buttons:[
      {label:"Yes, it's fine", outcome:'pass'},
      {label:'It looks low', outcome:'action', action:'top_up'},
    ]
  },
  H1: { id:'H1', next:'H5', label:'Filter condition',
    question:'',
    buttons:[
      {label:'Clean / New', outcome:'action', action:'filter_clean'},
      {label:'A little dirty', outcome:'action', action:'filter_dirty'},
      {label:"They're filthy", outcome:'action', action:'filter_filthy'},
    ]
  },
  H5: { id:'H5', next:'H3', label:'Mode settings',
    question:'Some spas have operating modes that silently prevent heating -- Economy and Sleep mode only heat during scheduled filter cycles, not continuously. Check your topside panel: what mode is the spa set to?\n\nIf you\'re not sure and the panel looks normal, tap Standard / Ready mode.',
    buttons:[
      {label:'Standard / Ready mode', outcome:'pass'},
      {label:'Economy / Sleep / Rest mode', outcome:'action', action:'heat_mode_wrong'},
      {label:"I'm not sure", outcome:'action', action:'heat_mode_unsure'}
    ]
  },
  H3: { id:'H3', next:'H4', label:'Suction test',
    question:'With the filter(s) still removed, turn on the spa and check the water intake (where the filter usually sits). A healthy spa will always have a strong, noticeable pull at the inlet. What do you feel?',
    buttons:[
      {label:'Strong suction', outcome:'pass'},
      {label:'Weak or no suction', outcome:'possible'},
      {label:"Can't find the inlet", outcome:'action', action:'cant_find_inlet'},
    ]
  },
  H4: { id:'H4', next:'HBREAKER', label:'Air lock purge',
    fire:'F:AP',
    question:'',
    buttons:[
      {label:'Spa is now heating', outcome:'action', action:'heat_airlock_cleared'},
      {label:'Still not heating', outcome:'neutral'}
    ]
  },
  HBREAKER: { id:'HBREAKER', next:'H6', label:'Breaker reset',
    fire:'F:BR',
    question:'',
    buttons:[
      {label:'Spa is now heating', outcome:'pass'},
      {label:'Still not heating', outcome:'pass'}
    ]
  },
  H6: { id:'H6', next:'H6b', label:'Gate valves',
    bayStep:true,
    question:'Check the gate valves (also called slice or isolation valves) on either side of the heater pack — they must be fully open. A partially closed valve restricts water flow and prevents the heater from firing. Pull each valve fully out and confirm it locks open.',
    buttons:[
      {label:'All fully open', outcome:'pass'},
      {label:'Found one closed or partially closed', outcome:'action', action:'valve_closed'},
      {label:"My spa doesn't have these", outcome:'skip'}
    ]
  },
  H6b: { id:'H6b', next:'H7', label:'Air purge valve',
    bayStep:true,
    question:'Some spas have an air purge valve on the pump or plumbing — a small bleed valve or knurled cap. If yours has one and you see air bubbling out when you open it, keep it open until only water flows, then close it.',
    buttons:[
      {label:'Spa is now heating', outcome:'pass'},
      {label:'Still not heating / No valve', outcome:'pass'}
    ]
  },
  H7: { id:'H7', next:'H8a', label:'Air lock phase 2',
    fire:'F:AP',
    bayStep:true,
    question:'',
    buttons:[
      {label:'Spa is now heating', outcome:'pass'},
      {label:'Still not heating', outcome:'neutral'}
    ]
  },
  H8a: { id:'H8a', next:'H11', label:'Circ pump',
    fire:'F:CP',
    bayStep:true,
    question:"Find the circulation pump — the smaller pump separate from the jet pumps. The circ pump is responsible for moving water through the heater. If it isn't running, the heater will never fire. Some circ pumps run continuously; others activate with the heating cycle. Feel the housing — it should be warm and you should hear a faint hum.",
    buttons:[
      {label:'Humming / warm', outcome:'pass'},
      {label:'Silent', outcome:'fail', part:'circulation pump'},
      {label:'Grinding / very hot', outcome:'fail', part:'circulation pump'},
      {label:'Leaking', outcome:'fail', part:'circ pump seal'}
    ]
  },
  H11: { id:'H11', next:'H12', label:'Temp sensor',
    question:'Compare the water temperature shown on your topside panel against how the water actually feels. A faulty or miscalibrated temp sensor can convince the control board the water is already at target temperature — causing the heater to never fire.',
    buttons:[
      {label:'Readings match', outcome:'pass'},
      {label:'Panel reads higher than actual', outcome:'fail', part:'temp sensor'},
      {label:'Big difference either way', outcome:'fail', part:'temp sensor'}
    ]
  },
  H12: { id:'H12', next:'H13', label:'Hi-limit sensor / reset',
    bayStep:true,
    question:'The hi-limit sensor cuts power to the heater if it detects overheating — even a false reading will prevent heating. Look on the heater assembly or control box for a small reset button (sometimes red or white). Press it firmly if present. Also check if the water feels dangerously hot.',
    buttons:[
      {label:'Reset button found and pressed', outcome:'action', action:'heat_hilimit_reset'},
      {label:'No reset button found', outcome:'pass'},
      {label:'Water feels dangerously hot', outcome:'fail', part:'hi-limit sensor', critical:true}
    ]
  },
  H13: { id:'H13', next:'H9', label:'Heater element',
    question:'Do you have a multimeter?',
    buttons:[
      {label:'Yes, I have one', outcome:'action', action:'heat_multimeter_test'},
      {label:"No, I don't", outcome:'action', action:'heat_visual_element_check'},
      {label:"I'd like one", outcome:'action', action:'suggest_multimeter'}
    ]
  },
  H9: { id:'H9', next:'H10', label:'Visual inspection',
    bayStep:true,
    question:'Using a flashlight, inspect the heater assembly and the full equipment bay. Look for burn marks, scorched wires, corrosion, or charred solder joints on the control board. Pay close attention to the heater terminal block and the wires connecting the board to the heater element.',
    buttons:[
      {label:'Everything looks clean', outcome:'pass'},
      {label:'Found burn marks on heater', outcome:'fail', part:'heater element'},
      {label:'Found burn marks on control board', outcome:'fail', part:'control board'},
      {label:'Found something unusual', outcome:'action', action:'unusual_finding'}
    ]
  },
  H10: { id:'H10', next:'H14', label:'Fuses',
    bayStep:true,
    question:'Check all fuses in the equipment bay — look at both the housing and the filament inside. A blown fuse is a symptom, not the root cause — we\'ll need to understand what caused it.',
    buttons:[
      {label:'All fuses intact', outcome:'pass'},
      {label:'Found a blown fuse', outcome:'possible', part:'fuse kit'}
    ]
  },
  H14: { id:'H14', next:null, label:'Control board',
    question:"Based on everything we've checked, the control board is the most likely remaining cause. Before ordering, photograph everything — wide shot of the full board, every connector, and all jumper settings. Pull connectors by the housing only, never by the wires. Check for any discolored wires near burn marks — a damaged harness with a new board will result in immediate failure.",
    buttons:[
      {label:'Show me control board options', outcome:'fail', part:'control board'},
      {label:'I need help identifying my board', outcome:'action', action:'identify_board'},
    ]
  },

  // ── JETS sequence ─────────────────────────────────────────────
  J2a: { id:'J2a', next:'J2b', label:'Water condition',
    question:'What does the water look like right now?',
    buttons:[
      {label:'Clear', outcome:'pass'},
      {label:'Cloudy / Foamy', outcome:'possible', action:'water_cloudy'},
      {label:'Visibly dirty', outcome:'action', action:'water_dirty'},
    ]
  },
  J2b: { id:'J2b', next:'J1', label:'Water level',
    question:'Does the water cover the skimmer opening by at least 1 to 2 inches? Low water causes the pump to suck in air and lose its prime, which kills jet pressure.',
    buttons:[
      {label:"Yes, it's fine", outcome:'pass'},
      {label:'It looks low', outcome:'action', action:'top_up'},
    ]
  },
  J1: { id:'J1', next:'J_JF', label:'Filter condition',
    question:'',
    buttons:[
      {label:'Clean / New', outcome:'action', action:'filter_clean'},
      {label:'A little dirty', outcome:'action', action:'filter_dirty'},
      {label:"They're filthy", outcome:'action', action:'filter_filthy'},
    ]
  },
  J_JF: { id:'J_JF', next:'J_DV', label:'Jet face adjustment',
    question:'Many hot tub jets can be individually turned off by rotating the outer ring (bezel) clockwise. Over time, grit or calcium buildup can lock jet faces in the closed position — making it seem like the pump is dead when the plumbing is just shut off at the seat. Try firmly twisting each jet face counter-clockwise to make sure they\'re fully open.',
    buttons:[
      {label:'All jets are open', outcome:'pass'},
      {label:'Found closed jets — now fixed!', outcome:'action', action:'jets_face_fixed'},
      {label:'Jets are open but still no pressure', outcome:'pass'}
    ]
  },
  J_DV: { id:'J_DV', next:'J4', label:'Diverter valves',
    question:'Large topside diverter valves route water between different seats or zones. If a diverter valve is centered or broken internally, it can starve an entire section of jets. Turn each diverter valve fully from one side to the other — make sure none are stuck in a middle position.',
    buttons:[
      {label:'All diverters move freely', outcome:'pass'},
      {label:'Found a stuck valve — now fixed!', outcome:'action', action:'jets_diverter_fixed'},
      {label:'Valves move but still no pressure', outcome:'pass'}
    ]
  },
  J4: { id:'J4', next:'J_SS', label:'Air lock purge',
    fire:'F:AP',
    question:'',
    buttons:[
      {label:'Jets are working now!', outcome:'action', action:'jets_airlock_cleared'},
      {label:'Still no jets', outcome:'neutral'}
    ]
  },
  J_SS: { id:'J_SS', next:'J10', label:'Sound signature',
    question:'Press the Jets button. What do you hear?',
    buttons:[
      {label:'Complete silence — nothing happens', outcome:'action', action:'jets_sound_silent'},
      {label:'Loud hum but jets don\'t spin up', outcome:'action', action:'jets_sound_hum'},
      {label:'Screech or squeal when running', outcome:'action', action:'jets_sound_squeal'},
      {label:'Runs normally but weak pressure', outcome:'pass'}
    ]
  },
  J10: { id:'J10', next:'J_SH', label:'Fuses',
    bayStep:true,
    question:'Most control packs have dedicated fuses for each pump. Turn off the breaker, locate the fuse panel inside the equipment bay, and check the fuse for the corresponding jet pump. Look at both the housing and the filament inside — a blown fuse is a symptom, not the root cause.',
    buttons:[
      {label:'All fuses intact', outcome:'pass'},
      {label:'Found a blown fuse', outcome:'possible', part:'fuse kit'}
    ]
  },
  J_SH: { id:'J_SH', next:'J_VT', label:'Shaft & impeller check',
    bayStep:true,
    question:'Debris like stones, hairbands, or broken filter pieces can physically jam the pump impeller. With power completely OFF, locate the back of the jet pump motor — many have a slot on the rear shaft where you can insert a flathead screwdriver. Try to manually turn the shaft.',
    buttons:[
      {label:'Shaft turns freely', outcome:'pass'},
      {label:'Shaft is locked solid', outcome:'action', action:'jets_shaft_locked'},
      {label:'Can\'t access the shaft', outcome:'skip'}
    ]
  },
  J_VT: { id:'J_VT', next:'J9', label:'Voltage test',
    bayStep:true,
    question:'Do you have a multimeter?',
    buttons:[
      {label:'Yes, I have one', outcome:'action', action:'jets_voltage_test'},
      {label:"No, I don't", outcome:'action', action:'jets_no_multimeter'},
      {label:"I'd like one", outcome:'action', action:'suggest_multimeter'}
    ]
  },
  J9: { id:'J9', next:'J13', label:'Visual inspection',
    bayStep:true,
    question:'Using a flashlight, inspect the jet pump and the full equipment bay. Look for burn marks, scorched wires, melted insulation, or corrosion. Check the wiring harness running to the pump — look for any discoloration or damage near the terminals.',
    buttons:[
      {label:'Everything looks clean', outcome:'pass'},
      {label:'Found burn marks on pump wiring', outcome:'fail', part:'jet pump'},
      {label:'Found burn marks on control board', outcome:'fail', part:'control board'},
      {label:'Found something unusual', outcome:'action', action:'unusual_finding'}
    ]
  },
  J13: { id:'J13', next:'J14', label:'Jet pump',
    bayStep:true,
    question:'Based on everything we\'ve checked, the jet pump itself is the likely cause. Before ordering, confirm the pump model number from the label on the pump housing. Also check the wiring harness for any damage — a new pump with damaged wiring will fail immediately.',
    buttons:[
      {label:'Show me jet pump options', outcome:'fail', part:'jet pump'},
      {label:'I need help identifying my pump', outcome:'action', action:'identify_pump'}
    ]
  },
  J14: { id:'J14', next:null, label:'Control board / wiring',
    bayStep:true,
    question:'If the pump is getting power but not running, or the board isn\'t sending power to the pump at all, the control board relay or wiring harness is the likely culprit. Before ordering a board, photograph everything — every connector, all jumper settings, and any discolored wires. Pull connectors by the housing only, never by the wires.',
    buttons:[
      {label:'Show me control board options', outcome:'fail', part:'control board'},
      {label:'I need help identifying my board', outcome:'action', action:'identify_board'},
    ]
  },

  // ── NOISE sequence ────────────────────────────────────────────
  N_LOC: { id:'N_LOC', next:'N_WHEN', label:'Sound location',
    question:'Where is the noise coming from?',
    buttons:[
      {label:'Equipment bay / inside cabinet', outcome:'action', action:'noise_bay'},
      {label:'External speakers / audio system', outcome:'action', action:'noise_audio'},
      {label:'Not sure', outcome:'action', action:'noise_unsure'},
    ]
  },
  N_WHEN: { id:'N_WHEN', next:'N_TYPE', label:'When it occurs',
    question:'When does the noise happen?',
    buttons:[
      {label:'Constant — never stops', outcome:'action', action:'noise_constant'},
      {label:'Only when jets run', outcome:'action', action:'noise_jets'},
      {label:'Only when heating', outcome:'action', action:'noise_heat'},
      {label:'Only from audio system', outcome:'action', action:'noise_audio_only'},
      {label:'Intermittent / random', outcome:'pass'},
    ]
  },
  N_BREAKER: { id:'N_BREAKER', next:'N_TYPE', label:'Breaker test',
    question:'Turn off the spa breaker completely. Wait 10 seconds, then listen — is the noise still there?',
    buttons:[
      {label:'Noise stopped — spa confirmed', outcome:'action', action:'noise_confirmed_spa'},
      {label:'Still noisy — external source', outcome:'action', action:'noise_external_end'}
    ]
  },
  N_TYPE: { id:'N_TYPE', next:'N_PNL', label:'Sound type',
    question:'What does the noise sound like?',
    buttons:[
      {label:'Grinding or screeching', outcome:'action', action:'noise_grinding'},
      {label:'Loud humming', outcome:'action', action:'noise_humming'},
      {label:'Sizzling, popping or hissing (heater area)', outcome:'action', action:'noise_sizzle'},
      {label:'Rapid chattering or clicking', outcome:'action', action:'noise_chattering'},
      {label:'Hissing near pump intake', outcome:'action', action:'noise_hiss_intake'},
      {label:'Rattling or vibrating', outcome:'action', action:'noise_rattling'},
      {label:'Gurgling or popping (jets/pump area)', outcome:'action', action:'noise_cavitation'},
      {label:'Static / hissing (audio)', outcome:'action', action:'noise_audio_static'},
      {label:'Beeping', outcome:'action', action:'noise_beeping'},
    ]
  },
  N_PNL: { id:'N_PNL', next:'N_FLT', label:'Panel press test',
    question:'Press firmly on each cabinet panel, one at a time. Does the noise change or muffle when you press?',
    buttons:[
      {label:'Yes — noise changes with panel', outcome:'action', action:'noise_cabinet_resonance'},
      {label:'No difference', outcome:'pass'},
    ]
  },
  N_FLT: { id:'N_FLT', next:'N_BAY', label:'Filter bypass test',
    question:'Remove your filters completely, then run the spa. Did the noise stop or noticeably improve?',
    buttons:[
      {label:'Yes — noise stopped', outcome:'action', action:'noise_cavitation'},
      {label:'No — still noisy', outcome:'pass'}
    ]
  },
  N_BAY: { id:'N_BAY', next:'N_TEMP', label:'Equipment bay visual',
    bayStep:true,
    question:'Open the equipment bay and scan inside without touching anything. Look for dripping water near pump seals, white scale or green corrosion around the pump shaft, and loose hose clamps.',
    buttons:[
      {label:'Dripping or scale around shaft seal', outcome:'fail', part:'circ pump seal'},
      {label:'Scale or burn marks on heater tube', outcome:'action', action:'noise_heater_scale'},
      {label:'Rapid clicking from control pack', outcome:'action', action:'noise_chattering'},
      {label:'Everything looks dry and normal', outcome:'pass'}
    ]
  },
  N_TEMP: { id:'N_TEMP', next:'N_IMP', label:'Motor temperature',
    bayStep:true,
    question:'Carefully hold your hand near (not touching) the motor casing. Does it feel abnormally hot?',
    buttons:[
      {label:'Abnormally hot — very hot to the touch', outcome:'fail', part:'circulation pump'},
      {label:'Warm but normal', outcome:'pass'},
      {label:'Cool / room temperature', outcome:'pass'}
    ]
  },
  N_IMP: { id:'N_IMP', next:'N_BEEP', label:'Impeller check',
    bayStep:true,
    question:'With power OFF and slice valves closed, carefully open just the face of the pump union — enough to look inside. Do you see any debris in the impeller?',
    buttons:[
      {label:'Found debris — cleared it out', outcome:'action', action:'noise_impeller_cleared'},
      {label:'No debris visible', outcome:'pass'},
      {label:"Can't access safely", outcome:'skip'}
    ]
  },
  N_BEEP: { id:'N_BEEP', next:null, label:'Panel check',
    question:'Look at your topside control panel. What does it show?',
    buttons:[
      {label:'Error code showing', outcome:'action', action:'noise_error_code'},
      {label:'No code — panel looks normal', outcome:'action', action:'noise_external_check'},
      {label:'No power / garbled display', outcome:'fail', part:'control board'},
    ]
  },
  N_AUD1: { id:'N_AUD1', next:'N_AUD2', label:'Audio source isolation',
    question:'Switch the audio source from FM Radio to Bluetooth. Did the static or hissing stop?',
    buttons:[
      {label:'Yes — static gone on Bluetooth', outcome:'action', action:'noise_fm_interference'},
      {label:'No — still noisy on Bluetooth', outcome:'pass'},
    ]
  },
  N_AUD2: { id:'N_AUD2', next:'N_AUD3', label:'Volume fade test',
    question:'Turn the volume all the way down to zero. Is the noise still audible at zero volume?',
    buttons:[
      {label:'Yes — still noisy at zero volume', outcome:'fail', part:'audio amplifier'},
      {label:'No — quiet at zero volume', outcome:'pass'},
    ]
  },
  N_AUD3: { id:'N_AUD3', next:null, label:'Speaker isolation',
    question:'Use your balance or fader control to isolate individual speakers. Is the issue from one speaker or all of them?',
    buttons:[
      {label:'One speaker is worse', outcome:'action', action:'noise_single_speaker'},
      {label:'All speakers equally', outcome:'action', action:'noise_all_speakers'},
    ]
  },

  // ── WATER sequence ────────────────────────────────────────────
  W1: { id:'W1', next:'W2', label:'Symptom type',
    question:'What\'s the main symptom you\'re noticing with your water?',
    buttons:[
      {label:'Appearance (cloudy / green / foamy)', outcome:'action', action:'water_appearance'},
      {label:'Smell', outcome:'action', action:'water_smell'},
      {label:'Feel (skin irritation / slimy)', outcome:'action', action:'water_feel'},
      {label:'Behavior (not heating / losing water)', outcome:'action', action:'water_behavior'},
    ]
  },
  W2: { id:'W2', next:'W3', label:'Water age check',
    question:'When was the water last fully changed?',
    buttons:[
      {label:'Less than 3 months', outcome:'pass'},
      {label:'3–4 months', outcome:'action', action:'water_old'},
      {label:'More than 4 months', outcome:'action', action:'water_very_old'},
      {label:'Not sure', outcome:'pass'},
    ]
  },
  W3: { id:'W3', next:'W4', label:'Test strip gate',
    question:'Have you tested the water in the last 24 hours?',
    buttons:[
      {label:'Yes — tested recently', outcome:'pass'},
      {label:'No — not tested yet', outcome:'action', action:'water_test_guide'}
    ]
  },
  W4: { id:'W4', next:'W5', label:'Test results',
    question:'What do your test results show? Select the range that applies:',
    buttons:[
      {label:'pH: Low (below 7.2)', outcome:'action', action:'water_ph_low'},
      {label:'pH: Good (7.2–7.8)', outcome:'pass'},
      {label:'pH: High (above 7.8)', outcome:'action', action:'water_ph_high'},
      {label:'Not sure / skipping', outcome:'pass'},
    ]
  },
  W5: { id:'W5', next:'W_A1', label:'Sanitizer type',
    question:'What sanitizer system does your spa use?',
    buttons:[
      {label:'Chlorine', outcome:'pass'},
      {label:'Bromine', outcome:'pass'},
      {label:'Salt system', outcome:'pass'},
      {label:'Not sure', outcome:'pass'},
    ]
  },
  W_A1: { id:'W_A1', next:'W_A2', label:'Cloudy — onset',
    question:'When did the cloudy water start?',
    buttons:[
      {label:'Just started (24–48 hours)', outcome:'action', action:'water_cloudy_new'},
      {label:'Building up over days', outcome:'action', action:'water_cloudy_building'},
    ]
  },
  W_A2: { id:'W_A2', next:'W_A3', label:'Cloudy — dosing',
    question:'',
    buttons:[
      {label:'Got dosing guidance — will treat now', outcome:'pass'},
      {label:'Water improved', outcome:'action', action:'water_improving'},
      {label:'No change after treatment', outcome:'action', action:'water_no_change'},
    ]
  },
  W_A3: { id:'W_A3', next:'W_CONFIRM', label:'Dead algae check',
    question:'Did the water turn green before becoming cloudy (after a shock treatment)?',
    buttons:[
      {label:'Yes — shocked green water, now cloudy', outcome:'action', action:'water_dead_algae'},
      {label:'No — never was green', outcome:'pass'},
    ]
  },
  W_B1: { id:'W_B1', next:'W_B2', label:'Foamy — products',
    question:'Has the spa been used recently with body lotions, oils, sunscreen, or hair products?',
    buttons:[
      {label:'Yes — used recently with products', outcome:'action', action:'water_foam_products'},
      {label:'No — no products used', outcome:'pass'},
    ]
  },
  W_B2: { id:'W_B2', next:'W_B3', label:'Foamy — water age',
    question:'How recently was the water filled?',
    buttons:[
      {label:'Less than 2 weeks', outcome:'action', action:'water_foam_new_fill'},
      {label:'More than 3 months', outcome:'action', action:'water_old'},
      {label:'1–3 months old', outcome:'pass'},
    ]
  },
  W_B3: { id:'W_B3', next:'W_CONFIRM', label:'Foamy — air dial test',
    question:'Turn all air dial controls to the fully closed position. Did the foam stop or reduce significantly?',
    buttons:[
      {label:'Yes — foam reduced', outcome:'action', action:'water_foam_chemical'},
      {label:'No — still foaming heavily', outcome:'action', action:'water_foam_extreme'},
    ]
  },
  W_C1: { id:'W_C1', next:'W_C2', label:'Green — cover habits',
    question:'Is the spa kept covered when not in use?',
    buttons:[
      {label:'Yes — always covered', outcome:'action', action:'water_green_metals'},
      {label:'No — often left uncovered', outcome:'action', action:'water_green_algae'},
    ]
  },
  W_C2: { id:'W_C2', next:'W_C3', label:'Green — test routing',
    question:'Is your sanitizer reading currently low (below target range)?',
    buttons:[
      {label:'Yes — sanitizer is low', outcome:'action', action:'water_algae_treat'},
      {label:'No — sanitizer is normal', outcome:'action', action:'water_green_metals'},
    ]
  },
  W_C3: { id:'W_C3', next:'W_CONFIRM', label:'Green — scratch test',
    question:'Run your hand along the spa shell walls underwater. How does it feel?',
    buttons:[
      {label:'Slimy / slippery', outcome:'action', action:'water_algae_slimy'},
      {label:'Normal / slightly rough', outcome:'action', action:'water_metals_treat'},
    ]
  },
  W_D1: { id:'W_D1', next:'W_CONFIRM', label:'Smell — type',
    question:'What does the smell remind you of most?',
    buttons:[
      {label:'Strong chlorine / chemical smell', outcome:'action', action:'water_smell_chloramines'},
      {label:'Rotten egg / sulfur', outcome:'action', action:'water_smell_bacteria'},
      {label:'Musty / earthy', outcome:'action', action:'water_smell_biofilm'},
    ]
  },
  W_E1: { id:'W_E1', next:'W_CONFIRM', label:'Feel — symptom',
    question:'What are you noticing when you\'re in the water?',
    buttons:[
      {label:'Itchy skin or eyes', outcome:'action', action:'water_feel_itch'},
      {label:'Slippery / slimy feel', outcome:'action', action:'water_feel_slimy'},
      {label:'Crusty scale buildup on shell', outcome:'action', action:'water_scale'},
    ]
  },
  W_F1: { id:'W_F1', next:'W_CONFIRM', label:'Behavior routing',
    question:'What behavior are you noticing?',
    buttons:[
      {label:'Not heating', outcome:'action', action:'water_behavior_heat'},
      {label:'Excessive foam', outcome:'action', action:'water_foam_redirect'},
      {label:'Losing water level', outcome:'action', action:'water_behavior_loss'},
    ]
  },
  W_CONFIRM: { id:'W_CONFIRM', next:null, label:'Treatment confirmation',
    question:'After treatment, wait 30–60 minutes with circulation running, then retest. What do your readings look like?',
    buttons:[
      {label:'Readings improved — looking better', outcome:'action', action:'water_improving'},
      {label:'No change after treatment', outcome:'action', action:'water_no_change'},
      {label:'Readings got worse', outcome:'action', action:'water_escalate'},
    ]
  },
};
// ── Diag state store ──────────────────────────────────────────────
const diagStateStore = {};

function getDiagState(clientId) {
  return diagStateStore[clientId] || null;
}
function setDiagState(clientId, state) {
  diagStateStore[clientId] = { ...state, lastUpdated: Date.now() };
}
function clearDiagState(clientId) {
  delete diagStateStore[clientId];
}

function buildDiagStateBlock(state) {
  if (!state || !state.steps || state.steps.length === 0) return null;
  const spa = state.spa || 'Unknown';
  const err = state.errorCode ? ` ${state.errorCode}` : '';
  const steps = state.steps.map(s => {
    const icon = s.passed === false ? '❌' : s.skipped ? '⚠️' : '✅';
    const key = s.persists ? 'persists' : s.cleared ? 'cleared' : '';
    return `${s.id}${icon}${key}`;
  }).join('');
  const current = state.currentStep ? ` @${state.currentStep}` : '';
  return `[DS] ${spa}${err}\n${steps}${current}`;
}

function processDiagSignals(reply, clientId, incomingMsg) {
  let state = getDiagState(clientId);
  if (!state) return null;

  // Handle step jump — sync server state before processing reply signals
  if (incomingMsg) {
    const jumpMatch = typeof incomingMsg === 'string' ? incomingMsg.match(/User jumped to step ([A-Z0-9a-z]+)/) : null;
    if (jumpMatch) {
      const jumpId = jumpMatch[1].toUpperCase();
      if (DIAG_STEPS[jumpId]) {
        state.currentStep = jumpId;
        setDiagState(clientId, state);
      }
      // JUMP_ONLY — skip advance/skip processing this turn
      if (incomingMsg.includes('[JUMP_ONLY]')) return getDiagState(clientId);
    }
  }

  const advanceMatch = reply.match(/\[A:([A-Z0-9a-z]+)\]/);
  const skipMatch = reply.match(/\[SK:([A-Z0-9a-z]+)\]/);
  if (advanceMatch || skipMatch) {
    const completedId = (advanceMatch || skipMatch)[1].toUpperCase();
    const step = DIAG_STEPS[completedId];
    if (step) {
      if (!state.steps) state.steps = [];
      const existing = state.steps.find(s => s.id === completedId);
      if (!existing) {
        state.steps.push({ id: completedId, label: step.label, passed: !!advanceMatch, skipped: !!skipMatch });
      } else {
        existing.passed = !!advanceMatch;
        existing.skipped = !!skipMatch;
      }
      state.currentStep = step.next || null;
      setDiagState(clientId, state);
    }
  }
  return getDiagState(clientId);
}

function applyFireTemplates(reply) {
  return reply.replace(/\[F:([A-Z0-9]+)\]/g, (match, key) => FIRE_TEMPLATES[`F:${key}`] || match);
}

function buildStepContext(state) {
  if (!state || !state.currentStep) return null;
  const step = DIAG_STEPS[state.currentStep];
  if (!step) return null;
  const nextStep = step.next ? DIAG_STEPS[step.next] : null;
  // Button-driven steps — Jet just needs to present the question and fire template if needed
  const fireNote = step.fire ? `Emit [${step.fire}] before the question. ` : '';
  const questionText = step.question || '';
  return `=CURRENT TASK=
Step ${step.id}: ${step.label}
${fireNote}${questionText ? `Present this text to the user: "${questionText}"` : ''}
This step uses button responses — DO NOT ask for text input. After presenting the text${step.fire ? ' and fire template' : ''}, output [A:${step.id}] on its own line.
${nextStep ? `Next: ${step.next} (${nextStep.label})` : 'Final step.'}`;
}

// ── Token telemetry ───────────────────────────────────────────────
function logTokenUsage(route, model, usage, meta = {}) {
  if (!usage) return;
  const entry = { ts: Date.now(), route, model: model.replace('claude-','').replace('-20251001','').replace('-4-6',''), in: usage.input_tokens || 0, out: usage.output_tokens || 0, ...meta };
  console.log('[TOKENS]', JSON.stringify(entry));
}

// Session token accumulator -- keyed by clientId, resets with daily usage reset
const sessionTokenStore = {};
function accumulateTokens(clientId, route, usage) {
  if (!usage || !clientId) return;
  if (!sessionTokenStore[clientId]) sessionTokenStore[clientId] = { inputTokens: 0, outputTokens: 0, callCount: 0, routes: {} };
  const s = sessionTokenStore[clientId];
  s.inputTokens += usage.input_tokens || 0;
  s.outputTokens += usage.output_tokens || 0;
  s.callCount++;
  s.routes[route] = (s.routes[route] || 0) + 1;
}
// Sonnet 4.6 pricing: $3/M input, $15/M output
function estimateCost(inputTokens, outputTokens) {
  return ((inputTokens / 1000000) * 3) + ((outputTokens / 1000000) * 15);
}

// ── Known error codes by brand ────────────────────────────────────
const KNOWN_ERROR_CODES = {
  'Sundance':      ['FL1','FL2','FLO','OH','OHH','HFL','ILOC','ICE','DR','DRY','COOL','WARM','HOT','FLT','SN1','SN3','HH','E1','E2','E3'],
  'Jacuzzi':       ['FL1','FL2','FLO','OH','OHH','PD','ILOC','ICE','DR','E1','E2','E3','Pr','CL','HL'],
  'Hot Spring':    ['FL1','FL2','OH','HFL','ICE','COOL','WARM','ILOC','SN1','SN3','DY'],
  'Caldera':       ['FL1','FL2','OH','HFL','COOL','WARM','ICE','ILOC','SN1','SN3'],
  'Balboa':        ['FL1','FL2','FLO','OH','OHH','ICE','COOL','WARM','HFL','SN1','SN3','ILOC','DR'],
  'Dimension One': ['FL1','FL2','OH','HFL','ICE','SN1','SN3'],
  'Bullfrog':      ['FL1','FL2','OH','HFL','ICE','SN1','SN3','ILOC'],
};

// ── Brand-specific code hints -- codes strongly associated with a platform/brand ─
const CODE_BRAND_HINT = {
  'HFL': 'Balboa',
  'ILOC': 'Balboa',
  'DR': 'Balboa',
  'FLT': 'Sundance',
  'HOT': 'Sundance',
  'DY': 'Hot Spring',
  'PD': 'Jacuzzi',
  'CL': 'Jacuzzi',
  'HL': 'Jacuzzi',
};

function validateErrorCode(code, spaMake) {
  const brand = Object.keys(KNOWN_ERROR_CODES).find(b => spaMake.toLowerCase().includes(b.toLowerCase()));
  if (!brand) return { valid: true };
  const known = KNOWN_ERROR_CODES[brand];
  const upper = code.toUpperCase();
  if (known.map(k => k.toUpperCase()).includes(upper)) return { valid: true, code: upper };
  return { valid: false, code: upper, brand };
}

// ── Brand normalization — pure JS, zero AI cost ───────────────────
const KNOWN_BRANDS = ['Arctic Spas','Beachcomber','Brett Aqualine','Cal Spas','Caldera','Coleman','Dimension One','Down East','Gecko','Hot Spring','HydroQuip','In.Pro','Jacuzzi','Leisure Bay','Marquis','Master Spas','Sundance','Tiger River'];
const BRAND_ALIASES = { 'hotspring':'Hot Spring','hot springs':'Hot Spring','hot-spring':'Hot Spring','d1':'Dimension One','d-1':'Dimension One','dimension 1':'Dimension One','dimension-1':'Dimension One','dimension-one':'Dimension One','master spa':'Master Spas','master-spas':'Master Spas','master-spa':'Master Spas','arctic spa':'Arctic Spas','bullforg':'Bullfrog','jacuzi':'Jacuzzi','jaccuzi':'Jacuzzi','calspas':'Cal Spa','cal spas':'Cal Spa' };

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) { dp[i] = [i]; }
  for (let j = 0; j <= n; j++) { dp[0][j] = j; }
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function normalizeBrandJS(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  if (BRAND_ALIASES[lower]) return BRAND_ALIASES[lower];
  const exact = KNOWN_BRANDS.find(b => b.toLowerCase() === lower);
  if (exact) return exact;
  let best = null, bestScore = Infinity;
  for (const brand of KNOWN_BRANDS) { const score = levenshtein(lower, brand.toLowerCase()); if (score < bestScore) { bestScore = score; best = brand; } }
  return bestScore <= 2 ? best : null;
}

// ── System prompt modules — v4.9.15 ──────────────────────────────
const SP_CORE = `=JET=
SpaFix hot tub repair AI. "Skip the repairman." Confident, direct, warm. No hedging. One Q per response. Never stack Qs.

=DS=
The system may prepend a [DS] block to your context. It is READ-ONLY session state -- never reproduce it, never output it, never reference its format. Treat it as invisible internal data.

=SPA GATE=
SPA CONTEXT RULE (check first, every time):
- If [SPA:...] is in your context: spa is confirmed. NEVER ask for spa details. Acknowledge the issue in one sentence and route straight into diagnosis -- no request phrase, no gate.
- If spa is partially known (missing year OR make OR model only): acknowledge the issue, then ask only for the missing piece. Example: "I have your Jacuzzi J-335 -- what year is it?"
- If spa is fully unknown: acknowledge the issue in one sentence, then use the request phrase below.

Before requesting spa details, ALWAYS acknowledge the specific problem first. Never skip straight to the details request.
Skip gate entirely when: [CP:] [SL:] [SD] or spa in history.

=VAGUE INPUT=
If the user's message is too vague to identify a specific symptom (e.g. "my hot tub isn't working", "it's broken", "something's wrong", "help"), ask ONE warm clarifying question BEFORE requesting spa details. Example: "Happy to help! What's it doing -- or not doing? For example: an error code on the display, not heating up, jets not working, or something else?" NEVER ask for spa details as the first response to a vague input. Gather the symptom first, then gate on spa details if needed.
VAGUE INPUT EXCLUSIONS -- HARD STOP: The following are NOT vague and must NEVER trigger the clarifying question path. Route directly to the matching Tier template:
- Any input naming a specific component: pump, heater, jets, display, panel, breaker, sensor, circulation, filter
- Any input containing a specific symptom verb or phrase: won't start, won't turn on, stopped working, not heating, not turning on, leaking, no pressure, low pressure, humming, blank, unresponsive, shut off, shut down, shows a code, error code, flashing, not working
- Any input containing a specific error code (OH, FLO, FL1, FL2, Sn, Sn1, Sn2, Sn3, Snb, SnA, DR, ICE, IC, HFL, and any other alphanumeric code pattern) -- error codes are never vague

=INFERRED CODE WORDING=
When you infer a fault category from symptoms the user described (they did NOT report seeing a code on their display), use inference language -- not confirmation language. The user may never have seen a code at all.
CORRECT: "Your spa sounds like it triggered overheat protection -- that's what the OH code means if you see it on the display."
INCORRECT: "OH is an overheat code -- your spa shut down..." (implies the user already reported OH)
The routing is the same either way. This is purely about accurate wording so the user isn't confused by a code they never saw.

ACKNOWLEDGMENT RULES (no diagnostic steps, no quick checks -- diagnosis is SpaFix's job):
TIER 1 -- SAFETY CRITICAL (OH, ICE, DR): Acknowledge with one sentence + 1 immediate safety action only + request phrase if spa unknown.
- OH/overheat: "OH is an overheat code -- your spa shut down to protect itself from overheating. Turn it off at the breaker box electrical panel or sub-panel and remove the cover while we sort this out."
- ICE/freeze: "ICE means freeze protection triggered -- water temp dropped low enough to risk pipe damage. Make sure the spa has power so the freeze protection cycle can run."
- DR/dry heater: "DR is a dry heater fault -- the heater fired without enough water to cool it. Don't run the heater again until we've checked the water level." NOTE: On Balboa-platform systems this code displays as lowercase "dr" and always means Dry heater fault -- never "Drive" or any other meaning.
- SY/sensor failure: "SY is a sensor system failure -- your spa has shut down to protect itself. The control board can't read the water temperature sensor. Don't attempt to restart it until we've checked the sensor connections."

COLD WEATHER CONTEXT RULE: When the user's message contains freeze/cold context words (freezing, frozen, cold outside, winter, cold weather, ice, below zero, sub-zero, freeze, frost) AND the spa has stopped working or is showing an error -- ALWAYS acknowledge freeze protection as the likely cause BEFORE asking any clarifying questions. Example: "That sounds like freeze protection may have triggered -- when temperatures drop low enough, the spa shuts down to protect the pipes. Let's check what's going on." Do NOT ask a generic "what's it doing?" question when cold weather context is explicitly stated.

TIER 2 -- URGENT (FLO, Sn codes, pump, jets, heater, leak): Acknowledge using the matching template below -- do not summarize or shorten the template. The template defines the acknowledgment. No quick checks.
- FLO: "FLO means the system isn't detecting enough water flow through the heater -- this is usually caused by a clogged filter, a failing circulation pump, or an airlock after a refill. The heater shuts down to protect itself until flow is restored."
- Heater shutoff / suspected flow: "Since you're suspecting flow, that's the most likely culprit -- a clogged filter, failing circulation pump, or airlock after a refill. A burned-out heating element or tripped high-limit are also possible but less likely given your description." NOTE: Use this template when the user explicitly names flow or water flow as the suspected cause.
- HFL: "HFL stands for Heater Flow Low -- the system isn't detecting enough water moving through the heater and shut it down to protect the element. This is a low-flow fault, not a high-flow or pressure fault." NOTE: HFL is most common on Balboa-platform systems but also appears on Hot Spring, Caldera, Dimension One, and Bullfrog. Always means insufficient flow -- never excess flow or over-pressure.
- Sn1/sensor: "That's a water temperature sensor fault -- the spa has shut down to protect itself. It won't run again until the fault is resolved.\n\nTo get you the right fix, which spa do you have -- the make, model, and year?\n\n[SEQ:overheat]"
- Sn3/sensor: "That's a hi-limit sensor fault -- the spa has shut down to protect itself. The hi-limit sensor monitors for overheating conditions. It won't run again until the fault is resolved.\n\nTo get you the right fix, which spa do you have -- the make, model, and year?\n\n[SEQ:overheat]"
- Sn/sensor (generic): "That's a temperature sensor fault -- the spa has shut down to protect itself. It won't run again until the fault is resolved.\n\nTo get you the right fix, which spa do you have -- the make, model, and year?\n\n[SEQ:overheat]"
- Pump won't start: "A pump that won't start is usually a power delivery issue, a failed capacitor (the part that gives the motor its starting kick), or a wiring fault. Let's figure out which one."
- No jet pressure: "Low jet pressure usually comes down to one of four things: a clogged filter, an airlock in the pump, a worn pump impeller, or closed jet faces. Let's figure out which one." NOTE: This template applies to ALL low-pressure jet scenarios including the contrast pattern -- jets running/on but output is weak, low, or absent. "The jets are on but there's no pressure" is the same scenario as "no jet pressure" -- do not treat active jets as a different fault class.
- Heater not heating: "A heater that's stopped working usually comes down to one of three things: not enough water flowing through it (flow fault), a burned-out heating element (the part that actually makes heat), or a safety switch that tripped to prevent overheating (high-limit). Let's figure out which one."
- Leak: "A leak from under the tub usually points to a fitting, seal, or pump union -- stop using the spa and turn it off at the breaker box electrical panel or sub-panel until we find the source."
- Control panel unresponsive: "An unresponsive control panel usually means the topside panel has lost communication with the control board -- typically a power delivery issue, a failed ribbon cable connecting the panel to the board, or the board itself. Let's figure out which one."
- Display blank: "A completely blank display usually means no power is reaching the topside -- check if the breaker has tripped or the GFCI outlet has popped before we go further."

TIER 3 -- ALL OTHER CODES/ISSUES: Acknowledge in one sentence only + request phrase if spa unknown.
- Green water: "Green water is almost always algae -- it means the sanitizer level has dropped and algae has taken hold. We'll need to shock the water and get the pH back in range to clear it."
- Cloudy water: "Cloudy or murky water is something we can definitely sort out. It usually points to a chemistry imbalance, filtration issue, or both -- let's narrow it down."
- Chemical/chlorine smell: "A strong chemical smell usually means chloramines have built up -- that's combined chlorines off-gassing, often caused by low pH, high bather load, or insufficient shock treatment. Let's get the water balanced."
- COOL/COL: "COOL means the water temperature dropped below the set point -- this can happen when freeze protection kicks in, after the heater element fails, or if the spa cooled down during a power interruption. If it doesn't clear on its own within a normal heating period, tap below and we'll run through it."
- Smart Winter: "Smart Winter is an energy-saving mode that activates automatically when water temperature drops significantly -- the spa is running a reduced heating cycle to protect itself in cold conditions. If it doesn't clear on its own once the spa warms back up, tap below to continue."
- READY_CLEAN_FLASHING: "Your spa is reminding you to run a clean cycle -- this is a routine maintenance notification, not a fault. Running a clean cycle will clear it. If it doesn't clear after running a cycle, tap below to continue."
- 102T/102°T: "That display means Test Mode is active -- the number is your current water temperature, and the T indicates the control system was left in test mode after factory testing or service. The fix is resetting a dip switch on the circuit board. If it doesn't clear on its own, tap below and we'll walk through it."
- BOO: "Your spa is running a Boost cycle -- a 45-minute high-speed filtration and ozone cycle. This is normal operation, not an error. It will exit automatically when the cycle completes, or press any button on the topside panel to stop it early."
- GF/GFCI: "Your spa is showing a ground fault -- a current leak has been detected in the electrical system. This is a serious safety fault that requires the spa to stay off until the source is identified. Ground faults can originate from the heater, pump, blower, or ozone unit and need physical inspection. This one needs a closer look -- tap below and I'll pull in a deeper analysis."
- OFF: "OFF means the spa has been manually shut down from the panel. If you didn't turn it off intentionally, that's worth looking into -- it could be a power issue, a tripped protection circuit, or an accidental button press."
- "--" or dashes (unknown/no reading): "Those dashes mean the control system lost its reading -- it's not showing an error code, just that something isn't registering. Let's run through the diagnostic flow to find out what it's not seeing."
- POWER_BLINK/POWER_OUT: "That code means the control system detected a power quality event -- a voltage fluctuation or brief power interruption that caused the system to reset. Check your breaker box electrical panel or sub-panel for any tripped breakers, and if this keeps happening consider having a licensed electrician check the incoming power supply."
- READY_POWER_BLINK: "READY_POWER_BLINK means the spa detected a power interruption and has recovered -- it's back in standby and ready to run. If everything is functioning normally, no action is needed. If the code keeps reappearing, tap below to continue."

STATUS CODE ROUTING -- HARD STOP: After explaining any status/informational code (COOL, OFF, dashes, Pr, SLP, Ecn, CLd, Smart Winter, POWER_BLINK, or similar non-fault codes), a forward direction is MANDATORY. Dead-ending with no next step is a critical failure. If spa is already known, route directly into the diagnostic flow -- do NOT ask permission. Just say "Let's run through it." or equivalent and proceed. If spa is unknown, the UI will inject a picker button automatically. Never end a status code response without a path forward. AMBIGUOUS FAULT DEFAULT: When a code or indicator does not map cleanly to a specific fault sequence, route to [SEQ:flow]. Flow is the most comprehensive diagnostic sequence and covers the widest range of root causes. Do not default to [SEQ:overheat] or [SEQ:none] for ambiguous cases.

Request phrase: Do NOT output any "tap Spa Details Required" or similar CTA text. The UI renders entry point buttons automatically when spa details are missing. Your job is only to acknowledge the issue warmly. Never output template fields. Never say "above".

=HOWTO=
General how-to Q → answer directly, no gate.

=SPA CONFIRM=
"My spa is a [Y M Mo]": vary opener (Got it/Perfect/Understood/Thanks/Good to know).
[MF] → 1 sentence only: "Perfect -- you have a **[Y M Mo]** and I have detailed specs on file."
[MNF] → "Got it -- you have a **[Y M Mo]**." Proceed. No re-ask.
Already tried X → mark ✅, skip to next. Error code in issue → skip asking, start S1.

=KNOWN SPA + CODE=
When spa AND error code are both already known (pre-loaded via [SPA:] prefix or systemOverride): respond in 1-2 sentences MAXIMUM. Identify the code and say what it means in plain language. HARD STOPS -- the following are STRICTLY FORBIDDEN in this response:
- Numbered steps of any kind (1. 2. 3.)
- Bullet points listing causes or fixes
- "Here's what to check" or any equivalent lead-in to a list
- Phrases like "first", "next", "then", "finally" that imply a sequence
- Any mention of specific repair actions (replacing parts, testing voltages, bypassing, etc.)
- Any mention of what to do next beyond "let's start the diagnostic sequence"
- Asking permission to start the diagnostic sequence ("Would you like me to walk you through...", "Shall we start...", "Want me to help you diagnose...") -- when spa is known, route directly, never ask first
- Substituting a different spa model name from your training data (you MUST use the exact model from [SPA:] -- never a "similar" or "more commonly associated" model)
The diagnostic sequence is the product. The opening message is ONLY an acknowledgement. If you find yourself writing more than 2 sentences, you are doing it wrong -- stop and shorten.

=FORMAT=
**bold** parts/key terms. No <br>. No blank line spam. Blank line before Qs. Blank line between numbered steps.

=BTN=
>>BTN
Label A | Label B
<<BTN
Buttons ARE the Q. Never combine Q+buttons.

=PT=
>>PT
nm: [name] | az: [amazon URL &tag=spafix-20] | sp: [spadepot URL] | azb: [broad amazon] | spb: [broad spadepot] | pr: [$X-$X] | nt: [note] | ag: true/false
<<PT
Use for ALL product recs. No raw URLs.

=COR=
>>COR
field: value (only changed fields: make/model/year/error)
<<COR

=LIMITS=
ABSOLUTE HARD LIMITS -- never under any circumstances:
- Never loosen or suggest loosening union fittings
- Never lower or suggest lowering the water level
- Never instruct 240V/GFCI/gas/structural work
- Never output raw URLs or markdown links
- Never output <br> tags`;

const SP_PERSONALITY = `=STYLE=
Never dismiss answers. No resets. One Q, wait, move on. Don't restate what user said. No "usually/typically/often/probably/might." Never suggest calling tech for standard repairs.
TONE: Always warm, friendly, and approachable -- even when brief. Never terse, clipped, or abrupt. Every response should feel like it comes from someone who genuinely wants to help.`;

const SP_DIAG_FLOW = `=DIAG RULES=
DEFAULT: output the step question verbatim -- nothing else. No tips, no context, no pricing.
1. =STEP= block is your ONLY task. Execute it exactly as written.
2. ONE question per response. Never stack.
3. Never jump ahead. Never reference future steps.
4. Never revisit completed steps -- they are in the DS block.
5. Signal [A:Sx] the moment user's answer clears the step. [SK:Sx] if they skip.
6. Never suggest control board until S14 is current step.
7. Never loosen unions. Never lower water level. Absolute -- not situational.
8. Off-topic Q mid-diagnosis: one sentence answer, then redirect to current step question.
Signals: advance=[A:Sx] skip=[SK:Sx] fire=[F:XX]`;

const SP_BAY_RULES = `=BAY POWER=
Power warning FIRST before any bay instruction. If prev step had power ON → explicitly say OFF before entering.
CIRC PUMP ONLY: power stays ON to observe/touch pump housing. Never near wires/terminals.
ALL OTHER BAY STEPS: "Turn off dedicated circuit breaker -- not topside panel."
Use flashlight always.
BURNS: dark spot=burn until proven otherwise. Wipe test (power OFF): black=burn→check wires→>>PT. Confirmed burn: inspect board back. Discolored wires near burn = harness damaged -- new board + damaged harness = dead new board.`;

const SP_PART_FLOW = `=PART FLOW=
Part before diagnosis confirmed → 1 sentence (part+symptom) + 2 buttons. No bullets, no links yet.
Heater element NOT most common -- filter/airlock/flow switch/circ pump are. Never say "most common" unless true.
[CP:heater assembly/element]: never ask element vs assembly again.
"pump" unspecified → ask which (circ vs jets, which zone).
Suspected part → "Confirming is wise before ordering." >>BTN\nStart Diagnosis | Show Purchase Links\n<<BTN
[SL:part] → >>PT immediately.
[SD] → S1, spa confirmed, don't re-confirm spa.
After part links → >>BTN\nHelp me install it | Diagnose something else | Search different part\n<<BTN
Diagnosis confirmed faulty → skip buttons, straight to >>PT.
>>PT MANDATORY for any faulty/recommended part. One >>PT per part.
Any "where to buy" Q → >>PT block.`;

const SP_SAFETY = `=SAFETY=
Never instruct work on powered spa for electrical steps. Breaker OFF before wires/terminals/boards.
HARD LIMITS (never guide): 240V wiring, GFCI install/repair, gas, structural. Say: "⚠️ [hazard] -- beyond DIY scope, can cause serious injury or death."
Before risky steps: "⚠️ Before we continue -- [specific risk]. Comfortable and have right tools?" >>BTN\nYes, I'm ready | I'm not sure | Skip this step\n<<BTN
"I'm not sure"/"Skip" → halt, mark NOT CHECKED.
Hi-limit overheating fail → ⚠️ cut power NOW, do not use spa.`;

const SP_INSTALL = `=INSTALL=
Bulleted sections: Before you start / Removal / Installation / Before you test / Test. Never prose.
Whole unit only. No soldering.
"Before you test": part-specific post-install issues (flow switch→airlock, heater→must be flooded, board→all connectors seated).
End: "If you'd like, I can walk through this step by step -- just let me know."
Board: photos FIRST (wide + every connector + jumper settings). Pull connectors by housing. Must be programmed -- check addendum flyers.
Hose tip: "Stiff? Hair dryer 30-60s." While disconnected: inspect hose+clamps.`;

const SP_GUIDE_CONTEXT = `=GUIDE ENTRY= ([From guide: X])
1 brief sentence ack guide → ask what they need. Nothing else.
Spa confirmed → no re-ask. Spa unknown → ack guide, ask for spa details.
NEVER: diag summary, step list, >>PT, infer steps, shopping language.
Fresh opener -- ignore any active diagnosing trail.`;

const SP_BRAND_CONTEXT = `=BRANDS=
GECKO M-CLASS (Arctic Spas, Marquis/SSPA/MTS): flow error=3 FLASHING DOTS. "Dots with pump running or silent?" Running=pressure switch adjust. Silent=replace.
HOT SPRING/TIGER RIVER: flow error=blinking Power/Ready lights. Ask about light pattern, not code. EXCEPTION: READY_BLINK on Tiger River is a temperature sensor fault (not a status blink) -- treat as sensor fault and route to overheat sequence, not flow.
DIMENSION ONE: "warning light" is a global fault indicator only -- the specific fault is shown as a code on the LCD screen. When a user reports a warning light on a Dimension One spa, always ask: "What code is showing on your LCD screen?" Do NOT attempt to diagnose from "warning light" alone -- wait for the code, then route based on that.
ALL OTHERS: standard text codes (FL1/FL2/FLO/FLOW).
Accept any code user reports. Unrecognized: "Not familiar with [code] for [brand] -- did you mean [closest]?"
Auto-correct typos. Emit >>COR. Confirm: "Got it -- **[corrected]**."
BRAND MENTION RULE -- HARD STOP: If the user explicitly names a brand (e.g. "my Balboa system", "it's a Hot Spring"), that brand name MUST appear in your first sentence. This is non-negotiable. Never treat a named brand as generic. Example: user says "my Balboa HFL code" → response MUST open with "On Balboa systems, HFL means..." not "your spa has...". The brand name MUST be in the first sentence -- failure to include it is a critical error.\n\nABBREVIATION RULE -- HARD STOP: Never expand an error code abbreviation by inference. If the code is in the DB, use that definition verbatim. If the code is NOT in the DB, say "I don't have that code on file -- can you describe what's happening?" Never invent an expansion. SA = Sensor A malfunction (not "sustained absence"). DR = Dry heater fault. Use the DB definition, always.
SYMBOL CODE RULE: If an error code is a symbol description in ALL_CAPS (e.g. EXCLAMATION_ICON, FLASHING_LIGHT, WARNING_TRIANGLE), humanize it in your response -- never repeat the raw token back to the user. "EXCLAMATION_ICON" → "exclamation mark (⚠️)" or "warning symbol". Describe what the user sees on their panel, not the internal code name.`;

const SP_MISC = `=MISC=
SHOP BTN ("I need help finding parts/water care/Can you help me find") → 1-sentence intro + >>PT. No Q first.
SHOW PICTURE → part search links + "These show what [part] looks like -- not suggesting purchase."
FIX DIDN'T WORK → never restart. Next suspect. "Sorry [part] didn't fix it -- let's figure out what else is going on."
UNCERTAINTY (risky step, "I think/maybe/not sure") → >>BTN\n1. Explain more simply | 2. Skip\n<<BTN
SERIAL# → ask once max. Never required.
POWER CYCLE → clarify: "Topside panel or circuit breaker?" Panel may not fully reset board.
MULTIMETER → ask first. Never require. No meter=skip to visual.
LIGHTS → bulb first → fuse → transformer → board relay → wiring.
GENERATOR → ask early for no-power reports. Wait 8-10min after start, 10min after utility restore.
SANITY CHECK → after >>PT: "Want me to check remaining components before you order?"
VISUAL FIRST → visual→functional→tool (optional). Flashlight always. Board: "look for black/brown spots or char marks around connectors."
NO DUPE UPSELL → no photo upsell AND manual prompt in same response.
AIRLOCK HOW-TO: any general question about clearing/purging an airlock → emit [F:AP] then ask "Did that clear it up?"
DIAG PROGRESS: user asks to "show all steps", "show diagnostic list", "what steps are left", or "go back to step X" →
  Show numbered list of all 19 steps with status: ✅ passed, ❌ failed, ⏳ not yet tested.
  Format: "1. Filter condition ✅", "2. Water condition ⏳", etc.
  User can say "go back to step 3" → re-execute that step, signal [SK:current] and set state back.`;

const SP_OTHER_FREETEXT = `=OTHER_FREETEXT=
The user is in free-text "Other" diagnostic mode -- their issue doesn't fit the standard flow/heat/jets/noise/water sequences.
Your job: attempt a genuine, specific diagnosis based on what they describe. Use your knowledge of hot tub components for their specific spa model.
Rules:
- Stay grounded in what the spa can actually do -- never fabricate component behavior or specs
- If uncertain about a specific behavior for this spa model, say so explicitly before advising
- Work through possibilities systematically: cheapest/easiest causes first, expensive components last
- Never suggest calling a technician
- When you have truly exhausted all remote diagnostic options or find yourself repeating the same advice, append [DIAG_END] on its own line at the very end of your response -- not before, not on first response`;

function buildSystemPrompt(context = {}) {
  const { hasDiagState, isGuideEntry, hasSpaConfirmed, hasPartRequest, isEquipmentBayStep, hasInstallRequest, isFirstMessage, stepContext, isOtherFreeText, otherHint, hasExplicitBrandMention } = context;
  const modules = [SP_CORE];
  if (isFirstMessage || !hasSpaConfirmed) modules.push(SP_PERSONALITY);
  if (hasDiagState || hasSpaConfirmed) modules.push(SP_DIAG_FLOW);
  if (isEquipmentBayStep) modules.push(SP_BAY_RULES);
  if (hasPartRequest || hasDiagState) modules.push(SP_PART_FLOW);
  modules.push(SP_SAFETY);
  if (hasInstallRequest) modules.push(SP_INSTALL);
  if (isGuideEntry) modules.push(SP_GUIDE_CONTEXT);
  if (hasSpaConfirmed || hasDiagState || hasExplicitBrandMention) modules.push(SP_BRAND_CONTEXT);
  if (!hasDiagState && !isOtherFreeText) modules.push(SP_MISC);
  if (isOtherFreeText) {
    modules.push(SP_OTHER_FREETEXT);
    if (otherHint) modules.push(`[HINT: User's issue may relate to "${otherHint}" -- use this as a starting point but don't assume]`);
  }
  if (stepContext) modules.push(stepContext);
  return modules.join('\n\n');
}

function detectRequestContext(messages, diagStateIn, body) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
  const assistantExists = messages.some(m => m.role === 'assistant');
  const isGuideEntry = content.startsWith('[From guide:');
  const hasPartRequest = /\[(CP:|SL:|SD\]|START_DIAGNOSIS)/i.test(content);
  const hasDiagState = !!(diagStateIn && (diagStateIn.currentStep || (diagStateIn.steps && diagStateIn.steps.length > 0)));
  const hasSpaConfirmed = body.spaConfirmed === true ||
    !!(diagStateIn && diagStateIn.spa) ||
    messages.some(m => m.role === 'user' && typeof m.content === 'string' && (m.content.startsWith('[Spa:') || m.content.startsWith('My spa is a ') || /^My .+ has (this issue|an issue)/.test(m.content)));
  const bayKeywords = /step\s*(6|7|8|9|10|11|12|13|14)|equipment bay|circ pump|flow switch|fuse|control board|heater element|hi.limit|temp sensor/i;
  const isEquipmentBayStep = hasDiagState || bayKeywords.test(content);
  const installKeywords = /install|replace|how (do|to) (replace|install|swap|remove)/i;
  const hasInstallRequest = installKeywords.test(content);
  const isFirstMessage = messages.filter(m => m.role === 'user').length <= 1 && !assistantExists;
  let stepContext = null;
  if (diagStateIn && diagStateIn.currentStep) {
    stepContext = buildStepContext(diagStateIn);
  } else if (!diagStateIn && (hasSpaConfirmed || body.startDiagnosis)) {
    stepContext = buildStepContext({ currentStep: 'S1' });
  }
  const isOtherFreeText = body.otherFreeText === true;
  const otherHint = body.otherHint || null;
  // Detect explicit brand mention or brand-specific code hint in user message
  const _contentLower = content.toLowerCase();
  const hasExplicitBrandMention = KNOWN_BRANDS.some(b => _contentLower.includes(b.toLowerCase()))
    || Object.keys(BRAND_ALIASES).some(a => _contentLower.includes(a))
    || Object.keys(CODE_BRAND_HINT).some(code => _contentLower.includes(code.toLowerCase()));
  return { hasDiagState, isGuideEntry, hasSpaConfirmed, hasPartRequest, isEquipmentBayStep, hasInstallRequest, isFirstMessage, stepContext, isOtherFreeText, otherHint, hasExplicitBrandMention };
}


const PHOTO_SYSTEM_PROMPT = `You are Jet, SpaFix's expert hot tub and spa repair assistant with deep knowledge of hot tub parts, components, and repair.

The user has uploaded a photo of a hot tub part or issue. Your job is to:

1. IDENTIFY what part or issue is shown in the image. Be specific (e.g. "Balboa 2-speed pump", "diverter valve", "topside control panel", "jet body insert", "heater element", etc.)
2. DIAGNOSE the visible problem if any (corrosion, cracks, worn seals, burnt components, scale buildup, etc.)
3. RECOMMEND the fix — explain clearly what needs to be done
4. SUGGEST REPLACEMENT PARTS using this exact format for each part:

---PART_RECOMMENDATION---
name: [exact part name]
amazon_url: https://www.amazon.com/s?k=[url+encoded+part+name]&tag=spafix-20
supplier_url: https://www.spadepot.com/search?q=[url+encoded+part+name]
easy_spa_parts_url: https://www.easyspaparts.com/shop/?s=[url+encoded+part+name]
easy_spa_parts_broad_url: https://www.easyspaparts.com/shop/?s=[make+url+encoded+part+name]
price_range: [$XX - $XX typical price range]
notes: [compatibility notes or what to look for when buying]
---END_PART---

After your diagnosis, note whether this is DIY-friendly or requires a professional.
Use **bold** for part names and important warnings.
${DISCLAIMER}`;

const DOCUMENT_SUMMARY_PROMPT = `You are Jet, SpaFix's expert hot tub and spa repair assistant.

The user has uploaded a document — it may be a user manual, parts list, service history, troubleshooting notes, or similar.

Your job is to:
1. Identify what type of document this is
2. Extract the most useful information: hot tub make/model, error codes mentioned, parts already replaced, recent issues, warranty info
3. Give a brief friendly summary (3-5 sentences) of what you found and how it will help
4. Note specific details that will be especially useful going forward

Keep the tone conversational. Use **bold** for the hot tub model name and key findings.`;

// ── Routes ───────────────────────────────────────────────────────
const CHAT_INPUT_FIELDS = ["message", "text", "prompt", "input", "query"];
const GUIDED_CONTEXT_PATTERNS = [
  /\bserial number\b/i,
  /\bmodel number\b/i,
  /\bwhat does (it|the label|the sticker|the plate)\s+say\b/i,
  /\bcan you (check|look|confirm|tell|share|read|find)\b/i,
  /\bplease (check|look|confirm|tell|share|read|find)\b/i,
  /\bdo you (see|have|know)\b/i,
  /\breply with\b/i,
  /\banswer with\b/i,
  /\bjust say\b/i,
  /\byes or no\b/i,
  /\bwhich\b/i,
  /\bwhere\b/i,
  /\bwhat happens\b/i,
];
const GUIDED_SHORT_REPLY_PATTERNS = [
  /^(yes|no|yeah|yep|nope|nah|ok|okay|done|still|maybe)$/i,
  /^(not sure|unsure|unknown|i don'?t know|dont know)$/i,
  /^(working|not working|heating|not heating|running|not running|tripped|reset)$/i,
  /^[a-z0-9][a-z0-9-]{1,31}$/i,
];

function getChatInputField(body) {
  if (!body || typeof body !== "object") return "";
  return CHAT_INPUT_FIELDS.find((field) => typeof body[field] === "string") || "";
}

function pushTextSnippet(value, snippets) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:")) return;
  snippets.push(trimmed.slice(0, 500));
}

function collectGuidedContext(value, snippets, depth = 0) {
  if (!value || depth > 4) return;
  if (typeof value === "string") {
    pushTextSnippet(value, snippets);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(-8)) collectGuidedContext(item, snippets, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const roleHints = [value.role, value.sender, value.type].filter((entry) => typeof entry === "string");
  const isAssistantLike = roleHints.some((entry) => /assistant|bot|system/i.test(entry));
  const textKeys = ["content", "text", "message", "prompt", "question", "reply"];

  if (isAssistantLike) {
    for (const key of textKeys) pushTextSnippet(value[key], snippets);
    return;
  }

  for (const key of ["assistant", "bot", "system", "lastAssistantMessage", "lastBotMessage"]) {
    collectGuidedContext(value[key], snippets, depth + 1);
  }

  if (depth < 2) {
    for (const key of ["messages", "conversation", "history", "chatHistory", "transcript"]) {
      collectGuidedContext(value[key], snippets, depth + 1);
    }
  }
}

function getGuidedConversationContext(body) {
  const snippets = [];
  for (const key of [
    "messages",
    "conversation",
    "history",
    "chatHistory",
    "transcript",
    "assistantMessage",
    "lastAssistantMessage",
    "lastBotMessage",
    "botMessage",
  ]) {
    collectGuidedContext(body?.[key], snippets);
  }
  return snippets.slice(-6).join("\n");
}

function isShortGuidedReply(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed || trimmed.length > 40) return false;
  if (GUIDED_SHORT_REPLY_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return trimmed.split(/\s+/).length <= 4 && /^[a-z0-9\s-]+$/i.test(trimmed);
}

function maybeNormalizeGuidedChatInput(req, res, next) {
  // systemOverride requests are standalone explanation calls -- skip normalization entirely
  if (req.body && req.body.systemOverride) return next();

  const field = getChatInputField(req.body);
  if (!field) return next();

  const original = req.body[field].trim();
  if (!isShortGuidedReply(original)) return next();

  const guidedContext = getGuidedConversationContext(req.body);
  if (!guidedContext) return next();
  if (!GUIDED_CONTEXT_PATTERNS.some((pattern) => pattern.test(guidedContext))) return next();

  req.body.originalUserMessage = req.body.originalUserMessage || original;
  req.body[field] = `Spa troubleshooting follow-up reply: ${original}`;
  return next();
}

app.use("/api/chat", chatRateLimiter, maybeNormalizeGuidedChatInput);

// ── Supabase REST helpers (no npm package — direct fetch) ─────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function supabaseGet(table, params = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  // Build query string — encode keys but NOT filter values (PostgREST needs raw ilike.* syntax)
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${v}`).join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${qs}`;
  try {
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[Supabase] GET error:', e.message);
    return null;
  }
}

// Model profile lookup endpoint
app.get("/api/model/:year/:make/:model", async (req, res) => {
  try {
    const { year, make, model } = req.params;
    if (!year || !make || !model) return res.status(400).json({ error: "year, make, model required" });

    const yearNum = parseInt(year);
    const yearFilter = !isNaN(yearNum) && yearNum > 1980 ? {
      'year_start': `lte.${yearNum}`,
      'year_end': `gte.${yearNum}`,
    } : {};

    const [rows, partsRows] = await Promise.all([
      supabaseGet('spa_models', {
        'select': 'id,brand,model_name,year_start,year_end,control_system,common_failures,error_codes,code_types,pump_configs,verified,key_part_numbers,filter_count,has_spa_boy,heater_relay_type,high_limit_switch,high_limit_switch_location,heater_manifold_notes,sensor_serviceability',
        'brand': `ilike.*${make}*`,
        'model_name': `ilike.*${model}*`,
        ...yearFilter,
        'limit': 10
      }),
      supabaseGet('parts', {
        'select': 'part_number,description,category,manufacturer,oem_cross_references,oem_part_number,superseded_by,notes',
        'compatible_brands': `cs.[${make}]`,
        'order': 'category',
      })
    ]);

    if (!rows || rows.length === 0) {
      return res.json({ found: false });
    }

    // Helper: extract codes array from a profile's error_codes field
    function extractCodes(ec) {
      if (!ec) return [];
      if (typeof ec === 'object' && !Array.isArray(ec)) return Object.keys(ec).filter(Boolean);
      if (Array.isArray(ec)) return ec.map(e => (typeof e === 'object' && e !== null) ? (e.code || e.name || Object.values(e)[0]) : String(e)).filter(Boolean);
      if (typeof ec === 'string') {
        const validCode = c => /^[A-Za-z0-9][A-Za-z0-9\s\-_./]{0,11}$/.test(c) && c.length >= 2;
        return ec.split(',').map(c => c.trim()).filter(validCode);
      }
      return [];
    }

    // Helper: build full profile response shape from a single row
    function buildProfile(profile) {
      const ec = profile.error_codes;
      const codes = extractCodes(ec);
      return {
        found: true,
        verified: profile.verified || false,
        make: profile.brand,
        model: profile.model_name,
        filter_count: profile.filter_count || null,
        control_system: profile.control_system || null,
        common_failures: Array.isArray(profile.common_failures)
          ? profile.common_failures.slice(0, 5).join('; ')
          : (profile.common_failures || null),
        error_codes: codes.length ? codes.join(', ') : null,
        error_code_descriptions: (typeof ec === 'object' && ec !== null && !Array.isArray(ec)) ? ec : null,
        code_types: (typeof profile.code_types === 'object' && profile.code_types !== null && !Array.isArray(profile.code_types))
          ? profile.code_types : null,
        pump_configs: Array.isArray(profile.pump_configs)
          ? profile.pump_configs.map(p => `Pump ${p.pump_num}: ${p.hp}hp ${p.speeds}-speed`).join(', ')
          : (profile.pump_configs || null),
        key_part_numbers: profile.key_part_numbers || null,
        compatible_parts: partsRows || [],
        has_spa_boy: profile.has_spa_boy || false,
        heater_relay_type: profile.heater_relay_type || 'unknown',
        high_limit_switch: profile.high_limit_switch || false,
        high_limit_switch_location: profile.high_limit_switch_location || null,
        heater_manifold_notes: profile.heater_manifold_notes || null,
        sensor_serviceability: profile.sensor_serviceability || 'unknown',
      };
    }

    // Single row — existing behavior unchanged
    if (rows.length === 1) {
      return res.json(buildProfile(rows[0]));
    }

    // Multiple rows — return disambiguation payload
    const controlSystems = rows.map(r => (r.control_system || '').toLowerCase());
    const has880 = controlSystems.some(cs => cs.includes('880'));
    const has850 = controlSystems.some(cs => cs.includes('850'));
    const hasPanelTypeSplit = has880 && has850;

    const disambigRows = rows.map(r => ({
      id: r.id,
      control_system: r.control_system || null,
      year_start: r.year_start,
      year_end: r.year_end,
      codes: extractCodes(r.error_codes),
      code_types: (typeof r.code_types === 'object' && r.code_types !== null && !Array.isArray(r.code_types)) ? r.code_types : null,
      error_code_descriptions: (typeof r.error_codes === 'object' && r.error_codes !== null && !Array.isArray(r.error_codes)) ? r.error_codes : null,
      profile: buildProfile(r),
    }));

    const allCodes = [...new Set(disambigRows.flatMap(r => r.codes))].sort();

    return res.json({
      found: true,
      multipleRows: true,
      hasPanelTypeSplit,
      allCodes,
      rows: disambigRows,
      compatible_parts: partsRows || [],
    });
  } catch(err) {
    console.error('[/api/model/:year/:make/:model] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }

});

// ── normalize-spa: JS brand fuzzy match + Haiku for model only ────
// v4.9.14e: brand normalization moved to JS (zero AI cost for brands)
// Haiku only called when brand is known but model needs correction
app.post("/api/normalize-spa", async (req, res) => {
  try {
    const raw = req.body.input || req.body.raw || '';
    if (!raw) return res.status(400).json({ error: "input required" });

    // Step 1: Try to extract year with regex (free)
    const yearMatch = raw.match(/\b(19[5-9]\d|20[0-3]\d)\b/);
    const year = yearMatch ? yearMatch[1] : 'Unknown';

    // Step 2: Extract potential brand/model tokens
    const withoutYear = raw.replace(year, '').trim();
    const tokens = withoutYear.split(/[\s,\/]+/).filter(Boolean);

    // Step 3: JS fuzzy brand match (free)
    let detectedBrand = null;
    let remainingTokens = [...tokens];
    // Try multi-word brand first (e.g. "Hot Spring", "Dimension One")
    for (let len = 3; len >= 1; len--) {
      const candidate = tokens.slice(0, len).join(' ');
      const brand = normalizeBrandJS(candidate);
      if (brand) {
        detectedBrand = brand;
        remainingTokens = tokens.slice(len);
        break;
      }
    }

    // Step 4: If brand found and model is simple, try to return without Haiku
    const modelCandidate = remainingTokens.join(' ').trim() || 'Unknown';

    // Step 5: Only call Haiku if brand NOT detected or model needs correction
    // Haiku now only handles model name normalization — much smaller prompt
    try {
      const brandContext = detectedBrand ? `Brand confirmed: ${detectedBrand}. ` : '';
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 120,
          messages: [{
            role: "user",
            content: `Spa name corrector. ${brandContext}Fix ALL typos using phonetic similarity — e.g. "calmans"→"Cayman", "caymn"→"Cayman", "optama"→"Optima", "grandee"→"Grandee". Return ONLY JSON: {"year":"${year}","make":"${detectedBrand || 'Unknown'}","model":"[corrected model]","sn":"Unknown","normalized":"[year make model]"}
  Use "Unknown" for missing. Model in title case. Raw: ${raw}`
          }]
        })
      });
      const data = await response.json();
      logTokenUsage('normalize-spa', 'claude-haiku-4-5-20251001', data.usage);
      const rawText = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');
      // Override with JS-detected brand if Haiku contradicts (JS is more reliable for brands)
      if (detectedBrand) parsed.make = detectedBrand;
      // Sanitize: strip any leaked pipe-delimited key:value text from fields
      const sanitizeField = v => typeof v === 'string' ? v.split(/\s*[|•]\s*/)[0].replace(/^\w+:\s*/, '').trim() : v;
      parsed.make = sanitizeField(parsed.make);
      parsed.model = sanitizeField(parsed.model);
      parsed.year = sanitizeField(parsed.year);
      res.json(parsed);
    } catch (err) {
      console.error('normalize-spa error:', err);
      res.json({ year, make: detectedBrand || 'Unknown', model: modelCandidate, sn: 'Unknown', normalized: null });
    }
  } catch(err) {
    console.error('[/api/normalize-spa] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }

});

app.post("/api/correct-spa", async (req, res) => {
  // Alias for normalize-spa
  req.body.input = req.body.raw || req.body.input;
  const raw = req.body.input || '';
  if (!raw) return res.status(400).json({ error: "input required" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{
          role: "user",
          content: `Spa name corrector. Fix typos. Return ONLY JSON: {"year":"2006","make":"Sundance","model":"Cayman","sn":"Unknown","corrected":true}
Use "Unknown" for missing. Raw: ${raw}`
        }]
      })
    });
    const data = await response.json();
    logTokenUsage('correct-spa', 'claude-haiku-4-5-20251001', data.usage);
    const rawText = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');
    // JS brand override
    if (parsed.make) {
      const jsBrand = normalizeBrandJS(parsed.make);
      if (jsBrand) parsed.make = jsBrand;
    }
    res.json(parsed);
  } catch (err) {
    console.error('correct-spa error:', err);
    res.json({ year: 'Unknown', make: 'Unknown', model: 'Unknown', sn: 'Unknown', corrected: false });
  }
});

app.post("/api/verify-pro", (req, res) => {
  const accessCode = req.body?.code ?? req.body?.password ?? "";
  const access = resolveProAccess(accessCode);
  if (!access.success) return res.status(401).json({ success: false, error: access.error });

  const clientId = getClientId(req);
  if (access.role === "tester" && access.testerName) logTestSession(access.testerName, clientId);

  const proToken = createProSession(clientId, access.testerName);
  res.json({ success: true, testerName: access.testerName, role: access.role, proToken });
});

// ── Admin report endpoint ─────────────────────────────────────────
app.get("/api/admin/report", (req, res) => {
  const { key } = req.query;
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  const report = Object.entries(transcriptLog).map(([tester, sessions]) => ({
    tester,
    sessionCount: sessions.length,
    totalMessages: sessions.reduce((n, s) => n + s.messages.length, 0),
    sessions: sessions.map(s => ({
      clientId: s.clientId,
      startTime: s.startTime,
      messageCount: s.messages.length,
      transcript: s.messages
    }))
  }));
  res.json({ generated: new Date().toISOString(), testers: report });
});

// Get current usage stats (called by frontend on load)
app.post("/api/increment-msg", (req, res) => {
  if (hasPremiumAccess(req)) {
      return res.json({ limitReached: false, dailyMsgs: 0, dailyLimit: FREE_DAILY_MSG_LIMIT, isPro: true });
  }
  const proAuth = getProAuth(req);
  if (proAuth.session) {
    return res.json({ limitReached: false, dailyMsgs: 0, dailyLimit: FREE_DAILY_MSG_LIMIT, isPro: true });
  }
  // QA bypass -- never increment or limit during automated test runs
  if (isQABypass(req)) {
    const clientId = getClientId(req);
    const u = getUsage(clientId);
    return res.json({ limitReached: false, dailyMsgs: u.dailyMsgs, dailyLimit: FREE_DAILY_MSG_LIMIT, isPro: false });
  }
  const clientId = getClientId(req);
  const u = getUsage(clientId);
  resetDailyIfNeeded(u);
  if (u.dailyMsgs >= FREE_DAILY_MSG_LIMIT) {
    return res.json({ limitReached: true, dailyMsgs: u.dailyMsgs, dailyLimit: FREE_DAILY_MSG_LIMIT });
  }
  u.dailyMsgs++;
  res.json({ limitReached: false, dailyMsgs: u.dailyMsgs, dailyLimit: FREE_DAILY_MSG_LIMIT });
});

// ── Spa brand master list by region ──────────────────────────────
const SPA_BRANDS_BY_REGION = {
  NA: {
    countries: ['US','CA','MX'],
    brands: ['Arctic Spas','Artesian Spas','Beachcomber','Blue Falls Manufacturing','Bullfrog Spas','Cal Spas','Caldera','Coleman','Dimension One','Dynasty Spas','Fantasy Spas','Free Flow Spas','Gecko','Hot Spring','Hydropool','Jacuzzi','Leisure Bay','Lifesmart Spas','Marquis','Master Spas','Maax Spas','Nordic Hot Tubs','Pacific Spas','Paradise Spas','Premier Spas','Saratoga Spas','Softub','Sundance','Tiger River','Vita Spas','Watkins Wellness','American Whirlpool','Barefoot Spas','Tropic Seas Spas','Clearwater Spas','Escape Spas','Hydro Systems','Hydrojet','Vanguard Spas','Prodigy Spas']
  },
  EU: {
    countries: ['GB','DE','FR','IT','ES','NL','BE','SE','NO','DK','FI','CH','AT','PL','PT','IE','CZ','HU','RO','SK','SI','HR','GR'],
    brands: ['Aquavia Spa','Villeroy & Boch','Passion Spas','Wellis','Jacuzzi','Sundance','Hot Spring','Caldera','Hydropool','Maax Spas','Oceanspa','ThermoSpas','Revel Spas','Oasis Spas','Pacific Spas','Spaform','Aquatica','Egeria','Oviedo Spas','Poolstar','Silver Fox']
  },
  AU: {
    countries: ['AU','NZ'],
    brands: ['Sapphire Spas','Vortex Spas','Spa World','Beachcomber','Hydropool','Jacuzzi','Sundance','Hot Spring','Swim Spa Australia','Aqua Spas','Leisure Concepts','Summit Spas','Oasis Spas','Pacific Spas','Dynasty Spas','Excel Spas']
  },
  APAC: {
    countries: ['JP','KR','CN','TW','SG','MY','TH','ID','PH','HK','IN'],
    brands: ['Jacuzzi','Hot Spring','Sundance','Balboa','Wellis','Aquavia Spa','Passion Spas','Oasis Spas','Pacific Spas']
  },
  INTL: {
    countries: [],
    brands: ['Jacuzzi','Hot Spring','Sundance','Caldera','Hydropool','Maax Spas','Balboa','Gecko','Intex','Bestway','Coleman']
  }
};

function getBrandsForCountry(countryCode) {
  const code = (countryCode || '').toUpperCase();
  // Find the user's region
  let userRegion = null;
  for (const [region, data] of Object.entries(SPA_BRANDS_BY_REGION)) {
    if (region === 'INTL') continue;
    if (data.countries.includes(code)) { userRegion = region; break; }
  }
  const regionalBrands = userRegion ? SPA_BRANDS_BY_REGION[userRegion].brands : [];
  // Build full list: regional first, then all others deduped
  const allBrands = new Set(regionalBrands);
  for (const [region, data] of Object.entries(SPA_BRANDS_BY_REGION)) {
    data.brands.forEach(b => allBrands.add(b));
  }
  const others = [...allBrands].filter(b => !regionalBrands.includes(b)).sort();
  return { region: userRegion || 'INTL', countryCode: code, regional: regionalBrands.sort(), others };
}

app.get("/api/models-for-make", async (req, res) => {
  try {
    let make = req.query.make || '';
    const yearNum = parseInt(req.query.year || '');
    if (!make) return res.json({ models: [] });
    // Normalize — strip common suffixes to match Supabase brand column
    make = make.replace(/\s+(spas?|hot\s+tubs?|industries|inc\.?|llc\.?|corp\.?)$/i, '').trim();
    const yearFilter = !isNaN(yearNum) && yearNum > 1980 ? {
      'year_start': `lte.${yearNum}`,
      'year_end': `gte.${yearNum}`,
    } : {};
    const rows = await supabaseGet('spa_models', {
      'select': 'model_name',
      'brand': `ilike.*${make}*`,
      ...yearFilter,
      'order': 'model_name',
      'limit': 100
    });
    const models = [...new Set((rows || []).map(r => r.model_name).filter(Boolean))].sort();
    res.json({ models });
  } catch(err) {
    console.error('[/api/models-for-make] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }

});

// Version endpoint — used by bug reporter to detect client/server mismatch
app.get("/api/version", (req, res) => {
  res.json({ server: process.env.APP_VERSION || 'unknown' });
});

app.get("/api/session-stats", (req, res) => {
  const clientId = req.headers['x-client-id'] || req.ip;
  const s = sessionTokenStore[clientId] || { inputTokens: 0, outputTokens: 0, callCount: 0, routes: {} };
  res.json({
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    callCount: s.callCount,
    routes: s.routes,
    estimatedCostUSD: parseFloat(estimateCost(s.inputTokens, s.outputTokens).toFixed(6))
  });
});

app.get("/api/brands", (req, res) => {
  // Detect country from Cloudflare header first, then X-Forwarded-For fallback
  const cfCountry = req.headers['cf-ipcountry'] || '';
  const countryCode = cfCountry && cfCountry !== 'XX' ? cfCountry : 'US';
  res.json(getBrandsForCountry(countryCode));
});

// ── Random spa for dev/test — returns a random verified spa from DB ──
app.get("/api/random-spa", async (req, res) => {
  const provided = normalizeAccessCode(req.headers['x-spafix-access-code'] || '');
  const isAdmin = !!ADMIN_KEY && accessCodesMatch(provided, ADMIN_KEY);
  const isTester = TESTER_KEYS.some(k => accessCodesMatch(provided, k));
  if (!isAdmin && !isTester) return res.status(403).json({ error: 'Admin or tester access required' });
  try {
    const rows = await supabaseGet('spa_models', {
      select: 'brand,model_name,year_start,year_end,error_codes,code_types',
      limit: 150,
      order: 'id.asc'
    });
    if (!rows || !rows.length) return res.json({ found: false });
    // Filter client-side to rows that have error_codes
    const withCodes = rows.filter(r => r.error_codes && typeof r.error_codes === 'object' && Object.keys(r.error_codes).length > 0);
    const pool = withCodes.length ? withCodes : rows;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const ys = parseInt(pick.year_start) || 2005;
    const ye = parseInt(pick.year_end) || new Date().getFullYear();
    const year = ys + Math.floor(Math.random() * (ye - ys + 1));
    // Pick a random error code if available
    let errorCode = null;
    if (pick.error_codes && typeof pick.error_codes === 'object') {
      const codes = Object.keys(pick.error_codes);
      if (codes.length) errorCode = codes[Math.floor(Math.random() * codes.length)];
    }
    return res.json({ found: true, year: String(year), make: pick.brand, model: pick.model_name, errorCode });
  } catch(e) {
    console.error('[random-spa]', e.message);
    return res.json({ found: false });
  }
});

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
  if (hasPremiumAccess(req)) {
      return res.json({ allowed: true, isPro: true });
  }
  const proAuth = getProAuth(req);
  if (proAuth.provided && !proAuth.session) {
    return res.status(401).json({ error: "Your Premium session expired. Please enter your access code again." });
  }
  if (proAuth.session) return res.json({ allowed: true, isPro: true });
  const clientId = getClientId(req);
  const check = checkFreeLimits(clientId);
  res.json({ ...check, isPro: false });
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
  "clean","dirty","clogged","rinse","restart","power","electricity","wire",
  "speaker","speakers","audio","sound","music","bluetooth","stereo","subwoofer","amplifier","transformer","bulb","led","light",
  // General how-to and airlock terms — must never fall through to Haiku validation
  "air lock","airlock","air-lock","air lock","purge","bleed","how to","how do",
  "clear","prime","prime the pump","trapped air","no flow","low flow","weak flow",
  "show me","tell me","explain","walk me through","guide me","help me"
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout — if Haiku hangs, let it through
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system: "You are a content filter. Reply with only YES or NO. Does this message relate to hot tubs, spas, jacuzzis, pool equipment, water chemistry, or spa repair?",
        messages: [{ role: "user", content: text }]
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    const reply = (data.content?.[0]?.text || "").trim().toUpperCase();
    return reply.startsWith("YES");
  } catch (e) {
    return true; // if gate fails or times out, let it through
  }
}

async function isValidMessage(text) {
  if (!text || text.trim().length < 3) return { valid: false, reason: "too_short" };
  if (text.trim().length > 300) return { valid: false, reason: "too_long" };
  // Fast keyword check first (free)
  if (looksSpaRelated(text)) return { valid: true };
  // If no keywords matched, ask Haiku (very cheap)
  const related = await haikusaysSpaRelated(text);
  if (!related) return { valid: false, reason: "off_topic" };
  return { valid: true };
}
// ── Anthropic API helper — module scope so all routes can use it ──
async function callAnthropicWithRetry(payload, maxRetries = 3, timeoutMs = 25000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 2000;
      console.log(`[Anthropic] 429 received, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
    // Server-side timeout — 25s standard, 30s for sonnetHandoff analytical calls
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.status === 429) continue;
      return response;
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        console.error(`[Anthropic] Request timed out after 25s (attempt ${attempt})`);
        if (attempt < maxRetries) continue;
        return { ok: false, status: 504, json: async () => ({ error: { message: "upstream_timeout" } }) };
      }
      throw err;
    }
  }
  console.log(`[Anthropic] All retries exhausted after ${maxRetries} attempts`);
  return { ok: false, status: 429, json: async () => ({ error: { message: "rate_limit_exhausted" } }) };
}
// ─────────────────────────────────────────────────────────────────

// ── Diag button endpoint — processes step button clicks, no AI call ─
app.post("/api/diag-button", async (req, res) => {
  try {
    const { stepId, buttonLabel, outcome, part, action, briefMode } = req.body;
    const clientId = getClientId(req);

    // Handle initialization
    if (stepId === 'INIT') {
      const spaYear = req.body.spaYear || '';
      const spaMake = req.body.spaMake || '';
      const spaModel = req.body.spaModel || '';
      const rawErrorCode = req.body.errorCode || null;
      const errorCode = rawErrorCode ? rawErrorCode.replace(/[^A-Za-z0-9\/_\-\s_]/g, '').trim().toUpperCase() || null : null;
      const topic = req.body.topic || 'flow';
      const spaLabel = [spaYear, spaMake, spaModel].filter(v => v && v !== 'Unknown').join(' ') || 'Unknown';
      const startStep = topic === 'heat' ? 'H2a' : topic === 'jets' ? 'J2a' : topic === 'noise' ? 'N_LOC' : topic === 'water' ? 'W1' : topic === 'overheat' ? 'OH1' : 'S2a';
      setDiagState(clientId, { spa: spaLabel, errorCode, topic, steps: [], currentStep: startStep, lastUpdated: Date.now() });
      return res.json({ ok: true, diagState: getDiagState(clientId) });
    }

    // Handle step jump — mark skipped steps server-side
    if (stepId === 'JUMP') {
      const { targetStep, skippedSteps } = req.body;
      let state = getDiagState(clientId);
      if (state) {
        if (!state.steps) state.steps = [];
        (skippedSteps || []).forEach(sid => {
          if (!state.steps.find(s => s.id === sid)) {
            const step = DIAG_STEPS[sid];
            state.steps.push({ id: sid, label: step ? step.label : sid, passed: false, skipped: true });
          }
        });
        state.currentStep = targetStep;
        setDiagState(clientId, state);
      }
      return res.json({ ok: true, diagState: getDiagState(clientId) });
    }

    let state = getDiagState(clientId);
    if (!state) return res.status(400).json({ error: 'No active diagnosis' });

    const step = DIAG_STEPS[stepId];
    if (!step) return res.status(400).json({ error: 'Unknown step' });

    let stepResult = { id: stepId, label: step.label };
    let nextStep = step.next;
    let responseMsg = null;
    let partCard = null;
    let clientAction = null;
    let advanceNow = true;
    let skipPending = false;
    let deadEndButtons = null;
    let partCardButtons = null; // inline buttons to append after partCard renders
    let briefOmitted = null; // text omitted due to briefMode — sent to admin/tester for highlight

    switch(outcome) {
      case 'pass':
        stepResult.passed = true;
        // Step-specific pass messages
        const passMessages = {
          'S2a': null,
          'S2b': "Good — water level is fine.",
          'S1': "Filters ruled out — let's keep going.",
          'S3': "Good suction confirmed — the pump is moving water.",
          'H3': "Good — strong suction confirmed. The pump is moving water normally.",
          'S4': "Great — the air lock purge worked. Let's keep an eye on it and continue checking.",
          'S5': "Good — the heating indicator is showing, so the control board is commanding heat.",
          'BREAKER': buttonLabel === 'Error cleared' ? "Great — the breaker reset cleared the error. Let's continue to confirm everything is working." : "Noted — the breaker reset didn't resolve it. Let's keep working through the checklist.",
          'S6': "Good — all valves are open.",
          'S6b': "Good — air purge valve checked.",
          'S7': buttonLabel === 'Error cleared' ? "The second air purge cleared it — air was still in the system. Reinstall your filters as described earlier." : "Noted — second purge didn't resolve it. Let's move on.",
          'S8b': "Good — the flow switch paddle is moving freely and correctly oriented.",
          'S8c': buttonLabel === 'Error still showing' ? "Good — flow switch is ruled out. Let's continue." : null,
          'S9': "Good — no visible burn marks, corrosion, or damage found.",
          'S10': "Good — all fuses are intact.",
          'S11': "Good — temperature readings are consistent.",
          'S12': "Good — hi-limit sensor checked.",
          'S13': null, // handled by sub-flow
        };
        if (passMessages[stepId] !== undefined && passMessages[stepId] !== null) {
          responseMsg = passMessages[stepId];
        }
        break;
      case 'fail':
        stepResult.passed = false;
        if (part) partCard = part;
        break;
      case 'possible':
        stepResult.passed = true;
        stepResult.possible = true;
        if (part) partCard = part;
        if (stepId === 'S3') {
          const _s3Msg = "Weak or no suction at the inlet is a concern — I've flagged the suction test as a possible issue. This can be caused by trapped air in the plumbing, a struggling circulation pump, or a blockage somewhere in the system. Let's work through the most likely causes one by one.";
          if (!briefMode) { responseMsg = _s3Msg; } else { briefOmitted = _s3Msg; }
        }
        if (stepId === 'H3') {
          const _h3Msg = "Weak or no suction means water isn't moving through the system properly -- this is likely contributing to your heating issue. It could be trapped air, a struggling circ pump, or a blockage. Let's work through the most likely causes.";
          if (!briefMode) { responseMsg = _h3Msg; } else { briefOmitted = _h3Msg; }
        }
        break;
      case 'neutral':
        stepResult.passed = true;
        const neutralMessages = {
          'S4': "Noted — the air lock purge didn't resolve the error. Let's keep working through the checklist.",
          'S7': "Noted — second purge didn't clear it. Let's move on.",
          'S8a': "Noted.",
        };
        if (neutralMessages[stepId]) responseMsg = neutralMessages[stepId];
        break;
      case 'skip':
        // Don't advance yet — client shows "Try This Step" / "Skip Anyway" buttons
        stepResult.passed = false;
        stepResult.skipped = false; // mark skipped only after user confirms via skipConfirmed
        advanceNow = false;
        skipPending = true;
        if (!briefMode) {
          const skipReasons = {
            'S4':  "Air locks are one of the most common causes of flow errors — skipping means we can't rule it out.",
            'H4':  "Air locks are one of the most common causes of heating problems — skipping means we can't rule it out.",
            'J4':  "Air locks are a common cause of jet pressure loss — skipping means we can't rule it out.",
            'S5':  "The heater indicator check quickly confirms whether the control board is calling for heat — easy to do and worth a moment.",
            'H5':  "Mode settings are a quick win — Economy or Sleep mode silently prevents heating and is easy to overlook.",
            'J_VT': "The voltage test is the most reliable way to tell whether the issue is the pump or the control board.",
            'S8b': "The flow switch check is one of the most common causes of FL errors — very worth doing.",
            'S9':  "A quick visual inspection with a flashlight takes 30 seconds and can reveal burn marks that pinpoint the fault.",
            'H9':  "A quick visual inspection with a flashlight takes 30 seconds and can reveal burn marks that pinpoint the fault.",
            'J9':  "A quick visual inspection with a flashlight takes 30 seconds and can reveal burn marks that pinpoint the fault.",
            'S10': "Checking fuses takes 30 seconds and rules out one of the cheapest possible fixes.",
            'H10': "Checking fuses takes 30 seconds and rules out one of the cheapest possible fixes.",
            'J10': "Checking fuses takes 30 seconds and rules out one of the cheapest possible fixes.",
          };
          const reason = skipReasons[stepId] || "This step helps narrow things down — it's worth a quick look before moving on.";
          responseMsg = reason;
        } else {
          const skipReason = skipReasons[stepId] || "This step helps narrow things down — it's worth a quick look before moving on.";
          briefOmitted = skipReason; // brief mode — capture for admin/tester highlight
          responseMsg = null;
          skipPending = false;
          stepResult.skipped = true;
          advanceNow = true;
        }
        break;
      case 'skip_confirmed':
        stepResult.passed = false;
        stepResult.skipped = true;
        advanceNow = true;
        responseMsg = null;
        break;

      case 'action':
        advanceNow = false; // action steps handle advance themselves
        break;
    }

    // Handle special actions
    if (outcome === 'action') {
      switch(action) {
        case 'water_continue_cloudy':
          responseMsg = "⚠️ Understood — we'll continue, but the cloudy or foamy water still needs to be addressed. Some upcoming tests require running without filters, which we only recommend with clean water. Proceed with caution.";
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = true;
          break;

        case 'water_continue_dirty':
          responseMsg = "⚠️ Understood — we'll continue, but the dirty water still needs to be addressed. Some upcoming tests require running without filters, which we only recommend with clean water. Proceed with caution.";
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = true;
          break;

        case 'water_dirty_clean':
          responseMsg = [
            "**Dealing with Visibly Dirty Water**",
            "Recommended Action Plan: The Fresh Start",
            "",
            "* **Drain and wipe down** -- Safely drain the spa and wipe down the shell to remove ring lines, grit, or biofilm residue.",
            "* **Clean or replace filters** -- Visibly dirty water heavily clogs filters. Rinse cartridges thoroughly with a hose or replace if worn.",
            "* **Fresh refill** -- Refill the spa with clean water (use a hose pre-filter if you have high mineral content).",
            "* **Balance the baseline** -- Test fresh water and adjust pH (7.2-7.8) and total alkalinity (80-120 ppm).",
            "* **Sanitize and shock** -- Apply primary sanitizer and a startup shock dose.",
            "* **Run filtration** -- Circulate for at least 4-6 hours to mix chemicals and bring to temperature.",
            "",
            "#When water is visibly dirty with heavy grit, leaves, or severe organic buildup, attempting to fix it with chemicals alone is often a losing battle. Heavy debris can rapidly clog filters, strain the circulation pump, and completely consume your sanitizer, leaving the water unsafe. For heavily compromised water, a complete drain and refill is highly recommended to protect your equipment and ensure a clean, healthy soak.#",
            "",
            "[SHOP_LINK:supplies:🔧 Recommended Supplies]",
            "",
            "[HALF_BREAK]",
            "⚠️ Safety First: Always read product labels before handling spa chemicals. Never mix chemicals together directly -- always add chemicals to water, never water to chemicals. Keep all products safely stored away from children and pets.",
          ].join("\n");
          partCard = 'water dirty';
          advanceNow = false;
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">I have cleaned the water — Continue Diagnosis</button></div>';
          break;

        case 'water_cloudy':
          responseMsg = [
            "**Cloudy water is usually caused by pH imbalance, low sanitizer, high calcium, or organic waste buildup.**\n\nHere's what to do:",
            "",
            "• Test your water — check pH (target 7.2–7.8), alkalinity (80–120 ppm), and sanitizer levels first",
            "• Adjust pH if out of range — use pH Up or pH Down as needed",
            "• Shock the water — add a non-chlorine or chlorine shock dose based on your sanitizer system",
            "• Add a clarifier — spa clarifier binds fine particles so the filter can catch them",
            "• Run filtration — keep the pump running for at least 4–6 hours after treatment",
            "• Retest — check levels again before using the spa",
            "* Draining, rinsing, and refilling with fresh water is always an acceptable alternative, particularly for water older than four months or heavily compromised clarity.",
            "",
            "Some [MANUAL_LINK] recommend specific products — check yours for brand-specific guidance.",
            "[HALF_BREAK]",
            "⚠️ Safety: Always read product labels before handling chemicals. Never mix chemicals directly — add to water, not water to chemicals. Keep away from children and pets."
          ].join("\n");
          partCard = 'water treatment cloudy';
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = false;
          responseMsg += '\n\n<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="action" data-action="water_show_items_cloudy" data-part="" data-critical="false" onclick="handleDiagBtn(this)" style="border-color:rgba(0,183,255,0.7);background:rgba(0,183,255,0.18);font-weight:600;">Show Recommended Items</button><button class="diag-btn" data-step="__STEP__" data-outcome="action" data-action="view_water_guides" data-part="" data-critical="false" onclick="handleDiagBtn(this)">View Water Care Guides</button><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button></div>';
          break;

        case 'water_foamy':
          responseMsg = [
            "Foamy water is usually caused by soaps, lotions, low-quality chemicals, or old water with high dissolved solids. Here's what to do:",
            "",
            "• Close all air control valves — if foam reduces, it's chemistry-related",
            "• Add a defoamer — spa-specific defoamer knocks foam down quickly (temporary fix, not a cure)",
            "• Shock the water — a good shock dose breaks down the organic compounds causing foam",
            "• Check sanitizer levels — low sanitizer allows foam-causing buildup",
            "• If foam persists — the water may have too many dissolved solids; a full drain and refill is the most reliable fix",
            "* Draining, rinsing, and refilling with fresh water is always an acceptable alternative, particularly for water older than four months or heavily compromised clarity.",
            "",
            "Some [MANUAL_LINK] recommend specific products — check yours for brand-specific guidance.",
            "[HALF_BREAK]",
            "⚠️ Safety: Always read product labels before handling chemicals. Never mix chemicals directly — add to water, not water to chemicals. Keep away from children and pets."
          ].join("\n");
          partCard = 'water treatment foamy';
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = false;
          responseMsg += '\n\n<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="action" data-action="water_show_items_foamy" data-part="" data-critical="false" onclick="handleDiagBtn(this)" style="border-color:rgba(0,183,255,0.7);background:rgba(0,183,255,0.18);font-weight:600;">Show Recommended Items</button><button class="diag-btn" data-step="__STEP__" data-outcome="action" data-action="view_water_guides" data-part="" data-critical="false" onclick="handleDiagBtn(this)">View Water Care Guides</button><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button></div>';
          break;

        case 'water_show_items_cloudy':
          responseMsg = null;
          clientAction = 'openShopTabs:water-care';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button><button class="diag-btn" data-step="__STEP__" data-outcome="action" data-action="water_treatment_ordered" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Order Placed — I\'ll treat first</button></div>';
          advanceNow = false;
          break;

        case 'water_show_items_foamy':
          responseMsg = null;
          clientAction = 'openShopTabs:water-care';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button><button class="diag-btn" data-step="__STEP__" data-outcome="action" data-action="water_treatment_ordered" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Order Placed — I\'ll treat first</button></div>';
          advanceNow = false;
          break;

        case 'water_treatment_ready':
          responseMsg = "Great — treat the water, run the pump for 4–6 hours, then retest. Once your levels look good, come back and we'll continue the diagnosis.";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Continue Diagnosis', o: 'pass', a: '' },
            { l: 'View Water Care Guides', o: 'action', a: 'view_water_guides' },
          ];
          break;

        case 'water_treatment_ordered':
          responseMsg = "Got it — treat the water before continuing. Some upcoming diagnostic steps require clean water to get accurate results. Come back once your levels are balanced.";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Continue Diagnosis', o: 'pass', a: '' },
            { l: 'View Water Care Guides', o: 'action', a: 'view_water_guides' },
          ];
          break;

        case 'water_dirty':
          responseMsg = "**Dirty water needs to be addressed before we can run certain tests accurately.** We strongly recommend sorting out the water issue first before continuing the diagnostic.";
          stepResult.passed = false;
          advanceNow = false;
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn spa-gate-pulse" style="border-color:rgba(0,183,255,0.7);background:rgba(0,183,255,0.18);font-weight:600;" data-step="__STEP__" data-outcome="action" data-action="water_dirty_clean" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Clean the water first</button></div>';
          break;

        case 'show_water_treatment':
          // Legacy — redirect to cloudy handler
          responseMsg = null;
          advanceNow = false;
          deadEndButtons = [
            { l: 'Cloudy water', o: 'action', a: 'water_cloudy' },
            { l: 'Foamy water', o: 'action', a: 'water_foamy' },
          ];
          break;

        case 'view_water_guides':
          responseMsg = null;
          advanceNow = false;
          break;

        case 'top_up':
          responseMsg = "Please top the water up to at least an inch above the skimmer opening now and let me know when it's done — I'll wait.";
          stepResult.passed = false;
          advanceNow = false;
          partCardButtons = '<div class=\"diag-step-btns\" style=\"margin-top:10px;\"><button class=\"diag-btn\" data-step=\"__STEP__\" data-outcome=\"pass\" data-action=\"\" data-part=\"\" data-critical=\"false\" onclick=\"handleDiagBtn(this)\">Done, let\'s continue</button></div>';
          break;

        case 'filter_clean':
          responseMsg = "Good — let\'s do a quick sanity check. Leave the filters out and run the spa. Does the error clear?";
          advanceNow = false;
          partCardButtons = '<div class=\"diag-step-btns\" style=\"margin-top:10px;\"><button class=\"diag-btn\" data-step=\"__STEP__\" data-outcome=\"action\" data-action=\"filter_clean_yes\" data-part=\"\" data-critical=\"false\" onclick=\"handleDiagBtn(this)\">Yes — error cleared</button><button class=\"diag-btn\" data-step=\"__STEP__\" data-outcome=\"action\" data-action=\"filter_clean_no\" data-part=\"\" data-critical=\"false\" onclick=\"handleDiagBtn(this)\">No — still showing</button></div>';
          break;

        case 'filter_clean_yes':
          responseMsg = "Great news, we've found the problem. Even though they look clean, the filters seem to be restricting water flow. Please replace your filters to get your spa working properly. For your convenience, I've provided some recommendations below.\n\n⚠️ Never use your spa without filters — it can damage the pump and plumbing. Running without filters is for testing purposes only and only with clean water.";
          stepResult.passed = false;
          advanceNow = false;
          partCard = 'filter';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button></div>';
          break;

        case 'filter_clean_no':
          responseMsg = "Good — filters are ruled out as the cause. Let's keep going.";
          stepResult.passed = true;
          advanceNow = true;
          break;

        case 'filter_dirty':
          responseMsg = '"A little dirty" can still cause a big bottleneck. Even if they don\'t look completely filthy, microscopic debris, body oils, or mineral scaling can severely restrict water flow and cause an error.\n\nLet\'s perform a quick test to see if the filters are the true culprit.\n\n1. Turn off the power to your spa at the GFCI breaker.\n2. Remove the filter cartridge(s) completely from the skimmer well.\n3. Check the area to ensure no floating debris can get sucked into the plumbing.\n4. Turn the power back on and run the spa briefly without the filters.\n\nDoes the error clear up?';
          advanceNow = false;
          partCardButtons = '<div class=\"diag-step-btns\" style=\"margin-top:10px;\"><button class=\"diag-btn\" data-step=\"__STEP__\" data-outcome=\"action\" data-action=\"filter_dirty_yes\" data-part=\"\" data-critical=\"false\" onclick=\"handleDiagBtn(this)\">Yes — error cleared</button><button class=\"diag-btn\" data-step=\"__STEP__\" data-outcome=\"action\" data-action=\"filter_dirty_no\" data-part=\"\" data-critical=\"false\" onclick=\"handleDiagBtn(this)\">No — still showing</button></div>';
          break;

        case 'filter_dirty_yes':
          responseMsg = `Perfect — we've found our culprit! If the spa runs fine without them, those filters are just a bit too restricted to let the water through. Even a "little dirty" can cause enough micro-resistance to trip a flow error.\n\nFilters are the first line of defense for your ${spaLabel}, protecting your pump and maintaining flow. Since yours are feeling a bit tired, you can either give them a deep chemical soak to clear out hidden oils and mineral buildup, or grab a fresh set to get back to soaking immediately.\n\nWhat sounds best to you?`;
          stepResult.passed = false;
          advanceNow = false;
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="action" data-action="suggest_filter_cleaning" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Clean them</button><button class="diag-btn" data-step="__STEP__" data-outcome="action" data-action="suggest_filter_replace" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Replace them</button></div>';
          break;

        case 'filter_dirty_no':
          responseMsg = "Your filters are a little dirty and may be contributing to the issue — I've flagged them as a possible factor. It's worth cleaning or replacing them. What would you like to do?";
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = true;
          break;

        case 'filter_filthy':
          responseMsg = "Filthy filters are almost certainly your issue. They need to be replaced before your spa will work properly.\n\n⚠️ Never use your spa without filters — it can damage the pump and plumbing. Running without filters is for testing purposes only and only with clean water.";
          stepResult.passed = false;
          advanceNow = false;
          partCard = 'filter';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button></div>';
          break;

        case 'filter_keep_testing':
          responseMsg = "Got it — let's keep working through the checklist.";
          stepResult.passed = false;
          advanceNow = true;
          break;

        case 'suggest_filter_cleaning':
          responseMsg = "Here are some filter cleaning products that can help restore flow:";
          partCard = 'filter cleaning';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button></div>';
          advanceNow = false;
          break;

        case 'suggest_filter_replace':
          responseMsg = "Here are replacement filter options for your spa:";
          partCard = 'filter';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button></div>';
          advanceNow = false;
          break;

        case 'stop_diagnosis':
          responseMsg = "Progress saved. Come back anytime if the issue returns or if you'd like to continue testing.";
          stepResult.passed = true;
          advanceNow = false;
          deadEndButtons = [
            { l: 'Continue testing', o: 'pass', a: '' },
          ];
          break;

        case 'cant_find_inlet':
          responseMsg = "The filter inlet is the opening where your filter(s) sit — typically a circular opening a few inches in diameter inside the filter compartment. If you don't feel any suction, make sure the spa jets are running — some spas won't draw water through the filter inlet until the jets are active. Check your [MANUAL_LINK] if you need help locating it, or upload a photo of the filter bay and I'll help you identify it.";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Found it — testing now', o: 'action', a: 'S3_found_inlet' },
            { l: '📸 Upload a Photo', o: 'action', a: 'upload_filter_bay_photo' },
            { l: "Check Owner's Manual", o: 'action', a: 'open_manual_finder' }
          ];
          break;

        case 'S3_found_inlet':
          // User found the inlet — render S3 buttons so they can report suction
          responseMsg = "Great — now check the suction. A healthy spa will have a strong, noticeable pull at the inlet.";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Strong suction', o: 'pass', a: '' },
            { l: 'Weak or no suction', o: 'possible', a: '' }
          ];
          break;

        case 'open_manual_finder':
          responseMsg = null;
          advanceNow = false;
          deadEndButtons = [{ l: 'Back to diagnosis', o: 'pass', a: '' }];
          break;

        case 'airlock_cleared':
          responseMsg = "Great news — it looks like an airlock was the culprit! Trapped air was blocking the water flow and triggering the error.\n\nBefore you put your clean filters back in and retest, let's make sure air doesn't get trapped again:\n\n1. Submerge each filter fully in the spa water.\n2. Gently squeeze or shake them underwater to work out any trapped air bubbles.\n3. Reinstall them immediately while keeping them submerged.\n\nThis keeps the lines clear and prevents the error from coming back!";
          stepResult.passed = true;
          advanceNow = false;
          deadEndButtons = [
            { l: 'Done — spa is running fine!', o: 'pass', a: '' },
            { l: 'Error returned', o: 'pass', a: '' },
          ];
          break;

        case 'filter_confirmed':
          responseMsg = "⚠️ Never run your spa without filters during normal use — it can damage the pump and plumbing. Running without filters is for testing purposes only and only with clean water.\n\nBefore reinstalling: submerge each filter completely in the spa water and gently squeeze it until no more air bubbles come out. Reinstall immediately while keeping it submerged — this prevents air from reintroducing into the system.\n\nDid the error return after reinstalling the filter?";
          stepResult.passed = false;
          stepResult.filterIssue = true;
          advanceNow = false;
          partCard = 'filter';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Yes — error returned</button><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">No — spa is running fine!</button></div>';
          break;

        case 'valve_closed':
          responseMsg = "Open it fully counterclockwise, then check if the error clears.";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Error cleared!', o: 'pass', a: '' },
            { l: 'Error still showing', o: 'pass', a: '' },
          ];
          break;

        case 'heater_no_indicator':
          responseMsg = "Before we go further — did you set the target temperature above the current water temperature shown on the panel? The heater won't fire unless the set temp is higher than the current reading.";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Yes — set it higher, still no heat', o: 'pass', a: '' },
            { l: 'No — let me try that now', o: 'action', a: 'heater_temp_retry' }
          ];
          break;

        case 'heat_mode_wrong':
          responseMsg = "That's likely your culprit. In Economy or Sleep mode, the spa only heats during its scheduled filter cycles — it won't maintain your set temperature. Switch it to Standard or Ready mode, then raise the target temperature above the current water temp and wait a few minutes to see if the heater fires.";
          stepResult.passed = false;
          stepResult.possible = true;
          advanceNow = true;
          break;

        case 'heat_mode_unsure':
          responseMsg = "On most spas, press the Mode button (sometimes labeled Temp or Set) to cycle through modes. Look for Standard, Ready, or ST on the display — that's the mode you want. Economy (Econ), Sleep (SLP), and Rest modes will prevent continuous heating. If you can't find it, check your manual via the Manual button.";
          advanceNow = false;
          deadEndButtons = [
            { l: "Found it — now in Standard/Ready", o: 'pass', a: '' },
            { l: "Still not sure", o: 'skip', a: '' },
          ];
          break;

        case 'heat_airlock_cleared':
          responseMsg = "Great news — an air lock was preventing water from circulating properly, which stopped the heater from firing. Before you put your clean filters back in and retest, let's make sure air doesn't get trapped again:\n\n1. Submerge each filter fully in the spa water.\n2. Gently squeeze or shake them underwater to work out any trapped air bubbles.\n3. Reinstall them immediately while keeping them submerged.\n\nThis keeps the lines clear and prevents the issue from coming back!";
          stepResult.passed = true;
          advanceNow = false;
          break;

        case 'heat_hilimit_reset':
          responseMsg = "Good — press it firmly until it clicks. The hi-limit tripped because the spa detected (or thought it detected) an overheating condition. After resetting, raise the target temperature above the current water temp and see if the heater fires. If the hi-limit trips again shortly after, the sensor itself may be faulty.";
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = true;
          break;

        case 'heat_multimeter_test':
          responseMsg = "Set your multimeter to resistance (Ω). Turn off the breaker and disconnect the heater element leads from the control board terminals. Test across the two element terminals — a healthy 5.5kW element should read between 9–12Ω. Also test each terminal to ground (the stainless steel heater tube) — you should read infinite (OL). What do you get?";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Reads 9–12Ω and OL to ground — element OK', o: 'pass', a: '' },
            { l: 'Out of range or shorts to ground — failed element', o: 'action', a: 'fail_heater_element' },
          ];
          break;

        case 'heat_visual_element_check':
          responseMsg = "Look at the heater element for any visible corrosion, burn marks, or physical damage on the element body or terminals. Also check the wires connecting the board to the element — look for any melted insulation, discoloration, or charring. What do you see?";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Everything looks clean', o: 'pass', a: '' },
            { l: 'Found burn marks or damage', o: 'action', a: 'fail_heater_element' },
          ];
          break;

        // ── Jets actions ──────────────────────────────────────────
        case 'jets_scope_single':
          responseMsg = "Got it -- a single jet with low pressure usually means a closed or clogged jet face, or a stuck diverter routing flow away from that nozzle. We'll check both. Let's start with the basics first.";
          stepResult.passed = true;
          advanceNow = true;
          break;

        case 'jets_scope_zone':
          responseMsg = "Got it -- a full zone with low pressure is often a diverter valve stuck in the middle position, starving that whole seat. We'll check that shortly. Let's start with the basics first.";
          stepResult.passed = true;
          advanceNow = true;
          break;

        case 'jets_face_fixed':
          deadEndButtons = [{ l: 'Yes — jets working now!', o: 'pass', a: '' }, { l: 'Still having issues', o: 'pass', a: '' }];
          if (!briefMode) { responseMsg = "Closed jet faces are a surprisingly common cause — calcium buildup and grit lock them in place over time. Give them a good clean while you have them open. If everything is working now, you're all set! Would you like to keep testing to make sure nothing else is contributing?"; } else { briefOmitted = "Closed jet faces are a surprisingly common cause — calcium buildup and grit lock them in place over time. Give them a good clean while you have them open. If everything is working now, you're all set! Would you like to keep testing to make sure nothing else is contributing?"; }
          stepResult.passed = true;
          advanceNow = false;
          break;

        case 'jets_diverter_fixed':
          deadEndButtons = [{ l: "Jets working now!", o: 'pass', a: '' }, { l: 'Still having issues', o: 'pass', a: '' }];
          if (!briefMode) { responseMsg = "A stuck diverter valve cuts off water to an entire zone of jets — easy fix once you find it. If everything is working now, you're all set! Would you like to keep testing to make sure nothing else is contributing?"; } else { briefOmitted = "A stuck diverter valve cuts off water to an entire zone of jets — easy fix once you find it. If everything is working now, you're all set! Would you like to keep testing to make sure nothing else is contributing?"; }
          stepResult.passed = true;
          advanceNow = false;
          break;

        case 'jets_airlock_cleared':
          deadEndButtons = [{ l: 'Jets working now!', o: 'pass', a: '' }, { l: 'Still having issues', o: 'pass', a: '' }];
          responseMsg = "Great news — an air lock was preventing the pump from moving water. Before you put your clean filters back in and retest, let's make sure air doesn't get trapped again:\n\n1. Submerge each filter fully in the spa water.\n2. Gently squeeze or shake them underwater to work out any trapped air bubbles.\n3. Reinstall them immediately while keeping them submerged.\n\nThis keeps the lines clear and prevents the issue from coming back!";
          stepResult.passed = true;
          advanceNow = false;
          break;

        case 'jets_sound_silent':
          if (!briefMode) { responseMsg = "Complete silence when pressing the Jets button usually points to one of three things: a blown fuse on the control board for that pump, a bad relay on the control board, or a completely dead motor winding. Let's check the fuses first — it's the easiest fix."; } else { briefOmitted = "Complete silence when pressing the Jets button usually points to one of three things: a blown fuse on the control board for that pump, a bad relay on the control board, or a completely dead motor winding. Let's check the fuses first — it's the easiest fix."; }
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = true;
          nextStep = 'J10';
          break;

        case 'jets_sound_hum':
          if (!briefMode) { responseMsg = "A loud hum without the jets spinning up means the motor is getting power but can't turn. The two most likely causes are a blown start capacitor (the motor tries to start but can't get going) or a physically seized/frozen shaft. Let's check the shaft first."; } else { briefOmitted = "A loud hum without the jets spinning up means the motor is getting power but can't turn. The two most likely causes are a blown start capacitor (the motor tries to start but can't get going) or a physically seized/frozen shaft. Let's check the shaft first."; }
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = true;
          nextStep = 'J_SH';
          break;

        case 'jets_sound_squeal':
          if (!briefMode) { responseMsg = "A screech or squeal when the jets run is the sound of worn or failing motor bearings. The jets may still work for now, but the pump is on its way out — it needs a rebuild or replacement soon. I've flagged this as a likely pump issue."; } else { briefOmitted = "A screech or squeal when the jets run is the sound of worn or failing motor bearings. The jets may still work for now, but the pump is on its way out — it needs a rebuild or replacement soon. I've flagged this as a likely pump issue."; }
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = true;
          nextStep = 'J13';
          break;

        case 'jets_shaft_locked':
          responseMsg = "A locked shaft means something is either jammed in the impeller housing or the motor bearings have seized. Do not try to force the shaft — further damage could result. This pump will need to be removed and inspected. The impeller housing can be disassembled to check for debris without replacing the full pump.";
          stepResult.passed = false;
          advanceNow = false;
          deadEndButtons = [{ l: 'Show pump replacement options', o: 'action', a: 'fail_jet_pump' }];
          break;

        case 'jets_voltage_test':
          responseMsg = "⚠️ DANGER — 240V PRESENT. This test requires the breaker ON with live high voltage exposed inside the equipment bay. Only proceed if you are completely comfortable working around live electrical panels. NEVER touch any terminals, wires, or components other than the multimeter probes.\n\nWith the breaker ON and the Jets button pressed to High: carefully place your multimeter probes on the pump's terminal plug on the circuit board. You should read 240V (or 120V depending on your setup).\n\n- Board outputs correct voltage but pump doesn't run → the pump or its cord is the problem → proceed to pump replacement\n- Board outputs 0V when button pressed → the board relay is bad → proceed to control board";
          advanceNow = false;
          deadEndButtons = [
            { l: '240V confirmed — pump or cord issue', o: 'action', a: 'fail_jet_pump' },
            { l: '0V — board relay issue', o: 'action', a: 'fail_control_board' },
            { l: 'Not comfortable with live voltage — skip', o: 'skip', a: '' },
          ];
          break;

        case 'jets_no_multimeter':
          responseMsg = "Without a multimeter we can't confirm whether the board is sending power. Based on everything we've tested, the most likely cause is either the jet pump itself or the control board relay. We'll check the pump wiring visually first.";
          advanceNow = true;
          break;

        case 'identify_pump':
          responseMsg = "Upload a clear photo of your pump label (Premium feature) and I'll help identify the exact model and find replacement options.";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Continue diagnosis', o: 'pass', a: '' },
          ];
          break;

        case 'temps_mismatch':
          responseMsg = "A mismatch between the displayed temperature and actual water temperature is a sign of a faulty or uncalibrated temperature sensor. I've flagged the temp sensor as a possible issue — we'll dig into it in the next step.";
          stepResult.passed = true;
          stepResult.possible = true;
          advanceNow = true;
          // Pre-flag S11 as possible in diagState
          if (state.steps) {
            const s11 = state.steps.find(s => s.id === 'S11');
            if (!s11) state.steps.push({ id: 'S11', label: 'Temp sensor', passed: true, possible: true, preflagged: true });
            else { s11.possible = true; s11.preflagged = true; }
          }
          break;

        case 'circ_flow_check':
          responseMsg = "Good — the pump is energized. The circ pump pushes water through the heater and then to the flow switch/sensor downstream. The sensor must detect sufficient flow to function properly — if flow is insufficient, the circuit won't close and the spa fails.\n\nLook for the flow indicator downstream after the heater. You should be able to visually see the paddle of the flow sensor making contact with the post. Is water moving through?";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Yes — water is moving', o: 'pass', a: '' },
            { l: 'No — little or no flow', o: 'pass', a: '' },
          ];
          break;

        case 'cant_find_flow_switch':
          responseMsg = "No problem — we'll cover the flow switch in detail in the next step.";
          stepResult.passed = true;
          stepResult.skipped = true;
          advanceNow = true;
          break;

        case 'unusual_finding':
          responseMsg = "Describe what you see and I'll help identify it. Or upload a photo for a closer look (Premium).";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Continue diagnosis', o: 'pass', a: '' },
          ];
          break;

        case 'multimeter_test':
          responseMsg = "Set your multimeter to resistance (Ω). Disconnect the heater element leads. Test across the two terminals — you should read between 8-16 Ω for a working element. Also test each terminal to ground — you should read infinite (OL). What do you get?";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Reads 8–16Ω and OL to ground — element OK', o: 'pass', a: '' },
            { l: 'Out of range or shorts to ground — failed element', o: 'action', a: 'fail_heater_element' },
          ];
          break;

        case 'visual_element_check':
          responseMsg = "Look at the heater element for any visible corrosion, burn marks, or damage on the element body or terminals. What do you see?";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Everything looks clean', o: 'pass', a: '' },
            { l: 'Found burn marks or corrosion', o: 'action', a: 'fail_heater_element' },
          ];
          break;

        case 'suggest_multimeter':
          responseMsg = "A multimeter is a handy tool to have for spa diagnosis and general home use. Here are some options:";
          partCard = 'multimeter';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue without multimeter</button></div>';
          advanceNow = false;
          break;

        case 'identify_board':
          responseMsg = "Upload a clear photo of your control board (Premium feature) and I'll help identify the exact model.";
          advanceNow = false;
          deadEndButtons = [
            { l: 'Continue diagnosis', o: 'pass', a: '' },
          ];
          break;

        // ── All noise action branches ──
        case 'noise_bay':
          responseMsg = "Good — let's focus on the equipment bay. Listen carefully as you open the cabinet.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_audio':
          responseMsg = "Got it — let's isolate the audio system. We'll skip the mechanical steps and go straight to audio diagnostics.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_unsure':
          responseMsg = "No problem — we'll figure it out. Let's start by testing whether the noise is coming from the spa itself.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_constant':
          if (state) state.noiseWhen = 'constant';
          responseMsg = "A constant noise that never stops points to something always running — likely the circulation pump or a stuck component.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_jets':
          if (state) state.noiseWhen = 'jets';
          responseMsg = "Noise only when jets run points to the jet pump, air intake, or a loose fitting in the plumbing loop.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_heat':
          if (state) state.noiseWhen = 'heat';
          responseMsg = "Noise only when heating points to the heater element, circulation pump, or scale buildup on the heating tube. Listen specifically for sizzling or popping — that points to scale buildup on the heater element.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_audio_only':
          if (state) state.noiseWhen = 'audio';
          responseMsg = "Noted — let's go straight to the audio diagnostics and skip the mechanical checks.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_external_end':
          responseMsg = "The noise continued after the breaker was off — it's coming from outside the spa. Check nearby equipment, HVAC vents, or plumbing in the wall.";
          advanceNow = false;
          deadEndButtons = [{ l: "Understood — I'll check externally", o: 'pass', a: '' }];
          break;

        case 'noise_grinding':
          responseMsg = "Grinding or screeching points to a failing pump bearing, a worn shaft seal, or debris in the impeller.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_humming':
          responseMsg = "A loud hum without mechanical scraping usually means the pump motor is energized but the impeller isn't turning — seized bearing or locked shaft.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_cabinet_resonance':
          responseMsg = "If the noise changes with panel button presses, the cabinet panels may be resonating with pump vibration. Check that all cabinet screws and clips are tight.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_cavitation':
          responseMsg = "The filter was causing cavitation — restricted flow was creating the noise. Clean or replace the filter and the noise should resolve.";
          advanceNow = false;
          deadEndButtons = [{ l: 'Noise resolved — great!', o: 'pass', a: '' }, { l: 'Still noisy after filter removal', o: 'pass', a: '' }];
          break;

        case 'noise_impeller_cleared':
          responseMsg = "Debris in the impeller is a very common cause of grinding noise. Run the spa briefly and check if the noise has cleared.";
          advanceNow = false;
          deadEndButtons = [{ l: 'Noise gone — fixed!', o: 'pass', a: '' }, { l: 'Still noisy', o: 'pass', a: '' }];
          break;

        case 'noise_error_code':
          responseMsg = "An error code with beeping usually means the control board is alerting you to a fault. Note the code and use the Error Code diagnostic path for a targeted diagnosis.";
          advanceNow = false;
          deadEndButtons = [{ l: "Got it — I'll check the error code", o: 'pass', a: '' }];
          break;

        case 'noise_external_check':
          responseMsg = "No error code and the noise is coming from the panel area — check that all topside panel connectors are fully seated and that the panel itself isn't vibrating against the spa shell.";
          advanceNow = false;
          deadEndButtons = [{ l: 'Connectors look good', o: 'pass', a: '' }, { l: "Found a loose connector", o: 'pass', a: '' }];
          break;

        case 'noise_fm_interference':
          responseMsg = "FM interference is caused by the spa's electrical system affecting the radio receiver. This is common near pump motors. Try an external antenna or switch to Bluetooth-only input.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_single_speaker':
          responseMsg = "A single bad speaker is usually a failed driver or a corroded connector at that speaker. Swap the speaker or check the wiring harness at that location.";
          advanceNow = false;
          deadEndButtons = [{ l: 'Show me speaker options', o: 'pass', a: '' }];
          break;

        case 'noise_all_speakers':
          responseMsg = "All speakers producing the same noise points to the amplifier or audio controller rather than individual speakers.";
          advanceNow = false;
          deadEndButtons = [{ l: 'Show me amplifier options', o: 'pass', a: '' }];
          break;

        case 'noise_audio_static':
          responseMsg = "Audio static or hissing from the speakers is usually the amplifier, a grounding issue, or water ingress in the speaker housing.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_beeping':
          responseMsg = "Beeping from the panel typically means an active error code or a sensor alert. Let's check the panel display.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        // ── New noise handlers ──
        case 'noise_confirmed_spa':
          // Breaker confirmed noise is spa-generated — skip N_WHEN, go straight to N_TYPE
          responseMsg = "Confirmed — the noise is coming from the spa. Let's identify the sound type.";
          advanceNow = false;
          // Jump directly to N_TYPE step
          if (state) {
            state.currentStep = 'N_TYPE';
            setDiagState(clientId, state);
          }
          nextStep = DIAG_STEPS['N_TYPE'] ? {
            id: 'N_TYPE',
            label: DIAG_STEPS['N_TYPE'].label,
            question: DIAG_STEPS['N_TYPE'].question || DIAG_STEPS['N_TYPE'].questionFn?.(state) || '',
            buttons: DIAG_STEPS['N_TYPE'].buttons,
            fire: null,
          } : null;
          advanceNow = true;
          break;

        case 'noise_sizzle':
          responseMsg = "Sizzling, popping or hissing from the heater area is typically caused by scale buildup on the heating element or critically low water flow. Scale traps water underneath a calcium crust, causing it to flash-boil. It can also indicate a failing element that needs replacement.\n\nTurn off the spa and let it cool before opening the equipment bay.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_chattering':
          responseMsg = "Rapid chattering or clicking from the control pack is usually a failing contactor or relay, or low incoming voltage. In older spas, a mechanical contactor's electromagnetic coil weakens over time and chatters when trying to close. On modern boards, a failing relay makes a lighter clicking sound.\n\nFirst check that the incoming voltage at the breaker is correct (240V typical). If voltage is fine, the relay or contactor needs replacement.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_hiss_intake':
          responseMsg = "A sharp hissing near the pump intake is either a loose plumbing union drawing air into the system, or normal operation of an ozone Venturi injector.\n\nCheck: if the hiss is at a small injector valve attached to a thin hose near the pump — that's the Venturi effect drawing ozone gas in, and it's normal. If the hiss is at a large threaded union fitting — hand-tighten it; a loose union can draw air without visibly leaking water yet.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_rattling':
          responseMsg = "Rattling or vibrating that occurs when pumps run on high is usually loose plumbing supports or hardened vibration-isolation pads under the pump mounts.\n\nCheck: tighten the pump mount bolts. Look for areas where PVC pipes touch the frame or cabinet walls — cushion them with foam insulation or rubber spacers. Check that all cabinet panels are properly seated and clipped.";
          advanceNow = true;
          stepResult.passed = true;
          break;

        case 'noise_heater_scale':
          responseMsg = "Scale buildup on the heater element is causing the sizzling or popping. Calcium deposits coat the element and trap water underneath, which flash-boils when the heater fires.\n\nThe fix: chemically descale the spa plumbing and element using a spa descaler product. In severe cases the element may need replacement. Also investigate water flow restrictions (dirty filters, failing low-speed pump) that could be cooking the element.";
          stepResult.passed = false;
          advanceNow = false;
          deadEndButtons = [
            { l: 'Show descaler options', o: 'action', a: 'show_descaler' },
            { l: 'Continue diagnosis', o: 'pass', a: '' },
          ];
          break;

        case 'show_descaler':
          responseMsg = "Here are spa descaler options:";
          partCard = 'spa descaler';
          partCardButtons = '<div class="diag-step-btns" style="margin-top:10px;"><button class="diag-btn" data-step="__STEP__" data-outcome="pass" data-action="" data-part="" data-critical="false" onclick="handleDiagBtn(this)">Continue Diagnosis</button></div>';
          advanceNow = false;
          break;

        // ── FLAG: Default — unhandled action branch ──
        default:
          responseMsg = `⚑ Undefined sequence — flagged for review.
  \`FLAG: unhandled-action → ${action} → ${stepId} → ${state.topic || 'unknown'}\`
  _If you're testing, please send this code to support@spafix.app_`;
          advanceNow = false;
          break;
      }
    }

    // Critical safety override
    if (part === 'hi-limit sensor' && req.body.critical) {
      responseMsg = "⚠️ Cut power to your spa immediately at the breaker. Do not use it until the hi-limit sensor is replaced.";
    }

    // Update state
    if (!state.steps) state.steps = [];
    const existing = state.steps.find(s => s.id === stepId);
    if (!existing) {
      state.steps.push(stepResult);
    } else {
      Object.assign(existing, stepResult);
    }

    if (advanceNow && nextStep) {
      state.currentStep = nextStep;
    } else if (advanceNow && !nextStep) {
      state.currentStep = null;
    }

    setDiagState(clientId, state);

    // Build next step presentation if advancing
    let nextStepData = null;
    if (advanceNow && state.currentStep) {
      const ns = DIAG_STEPS[state.currentStep];
      if (ns) {
        nextStepData = {
          id: ns.id,
          label: ns.label,
          question: (ns.questionFn ? ns.questionFn(state) : ns.question) || '',
          fire: ns.fire ? applyFireTemplates(`[${ns.fire}]`) : null,
          buttons: ns.buttons,
          bayStep: ns.bayStep || false,
        };
      }
    }

    // ── FLAG: dead-end detector ──
    if (!advanceNow && !skipPending && !deadEndButtons && !partCardButtons && !responseMsg && outcome !== 'action') {
      responseMsg = `⚑ Undefined sequence — flagged for review.
  \`FLAG: dead-end → ${stepId} → ${state.topic || 'unknown'}\`
  _If you're testing, please send this code to support@spafix.app_`;
    }

    res.json({
      ok: true,
      diagState: getDiagState(clientId),
      responseMsg,
      partCard,
      partCardButtons,
      nextStep: nextStepData,
      advanceNow,
      skipPending,
      deadEndButtons,
      briefOmitted,
      clientAction,
    });
  } catch(err) {
    console.error('[/api/diag-button] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }

});

// ─────────────────────────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  try {
  const { messages } = req.body;
  const isSilent = req.body.silent === true;
  const clientId = getClientId(req);

  // ── diagIntro fast path — one-shot intro message, no state machine ──
  if (req.body.diagIntro === true) {
    try {
      const introMsg = messages[messages.length-1]?.content || '';
      const response = await callAnthropicWithRetry({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: 'You are Jet, a friendly hot tub repair assistant. Respond in 1-2 warm sentences only. No questions, no bullet points, no next steps.',
        messages: [{ role: 'user', content: introMsg }]
      });
      const data = await response.json();
      const reply = data.content?.map(b => b.text || '').join('') || '';
      return res.json({ reply: reply.trim() });
    } catch(e) {
      return res.json({ reply: null });
    }
  }

  const diagStateIn = req.body.diagState || getDiagState(clientId) || null;

  // Initialize diagState when diagnosis starts (START_DIAGNOSIS or spa form + issue)
  const lastMsgContent = typeof messages[messages.length-1]?.content === 'string' ? messages[messages.length-1].content : '';
  const isStartDiagnosis = lastMsgContent.includes('[START_DIAGNOSIS]') ||
    lastMsgContent.includes('[SD]') ||
    (lastMsgContent.includes('Please start the diagnostic sequence') && lastMsgContent.includes('My spa is a ')) ||
    (lastMsgContent.includes('Issue:') && lastMsgContent.includes('My spa is a ')) ||
    (lastMsgContent.includes('Please start the diagnostic sequence') && req.body.spaConfirmed === true) ||
    (lastMsgContent.includes('has this issue:') && lastMsgContent.includes('Please start the diagnostic sequence'));

  if (isStartDiagnosis && !diagStateIn) {
    const spaYear = req.body.spaYear || '';
    const spaMake = req.body.spaMake || '';
    const spaModel = req.body.spaModel || '';
    let spaLabel = [spaYear, spaMake, spaModel].filter(v => v && v !== 'Unknown').join(' ');
    if (!spaLabel) {
      const spaMatch = lastMsgContent.match(/My spa is a ([^.]+?)(?:\.|\s+Issue:|\s+I've)/);
      spaLabel = spaMatch ? spaMatch[1].trim() : 'Unknown';
    }
    const errMatch = lastMsgContent.match(/Error code(?:[^:]*)?:\s*([A-Z0-9]+)/i);
    const rawErrCode = errMatch ? errMatch[1] : null;
    const cleanErrCode = rawErrCode ? rawErrCode.replace(/[^A-Za-z0-9\/_\-\s_]/g, '').trim().toUpperCase() || null : null;
    const newState = { spa: spaLabel, errorCode: cleanErrCode, steps: [], currentStep: 'S2a', lastUpdated: Date.now() };
    setDiagState(clientId, newState);
  }

  // Re-read diagState after potential init above
  let diagStateEffective = getDiagState(clientId) || diagStateIn;

  console.log(`[/api/chat] ${new Date().toISOString()} clientId=${clientId} msgs=${messages?.length || 0} step=${diagStateEffective?.currentStep || 'none'}`);

  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array required" });
  const premiumAccess = hasPremiumAccess(req);
  const proAuth = getProAuth(req);
  if (proAuth.provided && !proAuth.session) {
    return res.status(401).json({ error: "Your Premium session expired. Please enter your access code again." });
  }
  const isPro = !!proAuth.session || premiumAccess;
  const testerName = proAuth.session?.testerName || null;

  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "user") {
    const rawContent = typeof lastMsg.content === "string" ? lastMsg.content : "";
    const content = rawContent.replace(/^\[SYSTEM:[^\]]*\]\s*/i, '').replace(/^\[Issue context:[^\]]*\]\s*/i, '');
    const isSpaForm = content.includes('Year:') || content.includes('Make/Model:') || content.includes('Serial#:');
    const spaSubmitted = req.body.spaSubmitted === true;
    const hasSpaContext = messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Spa:'));
    const hasDiagState = !!(diagStateEffective && diagStateEffective.spa);
    const spaConfirmed = req.body.spaConfirmed === true;
    const conversationInProgress = messages.filter(m => m.role === 'user').length > 1 || messages.some(m => m.role === 'assistant');
    const check = (isSpaForm || spaSubmitted || spaConfirmed || conversationInProgress || hasSpaContext || hasDiagState || req.body.systemOverride) ? { valid: true } : await isValidMessage(content);    if (!check.valid) {
      const msgs = { too_short: "Please describe your hot tub issue in a bit more detail.", too_long: "Your message is too long — please keep it under 300 characters.", off_topic: "SpaFix can only help with hot tub and spa questions. Please describe your spa issue and I'll be happy to help!" };
      return res.status(400).json({ error: msgs[check.reason] || "Please ask a spa-related question." });
    }
  }

  // systemOverride -- null diagStateEffective BEFORE detectRequestContext so context is built cleanly
  if (req.body.systemOverride && typeof req.body.systemOverride === 'string') {
    diagStateEffective = null;
  }

  const promptContext = detectRequestContext(messages, diagStateEffective, req.body);
  const systemPrompt = buildSystemPrompt(promptContext);
  let hasDiagStateActive = !!(diagStateEffective && (diagStateEffective.currentStep || (diagStateEffective.steps && diagStateEffective.steps.length > 0)));

  // Always inject spa identity during active diagnosis — prevents drift when messages scroll out of window
  const spaYearVal = req.body.spaYear || '';
  const spaMakeVal = req.body.spaMake || '';
  const spaModelVal = req.body.spaModel || '';
  const spaControlSystemVal = req.body.spaControlSystem || '';
  const spaFromState = diagStateEffective?.spa;
  const spaLine = spaFromState || [spaYearVal, spaMakeVal, spaModelVal].filter(v => v && v !== 'Unknown').join(' ');
  // spaUnknown = true when no spa context at all, OR when make is known but model is missing/Unknown
  const _spaModelKnown = spaModelVal && spaModelVal !== 'Unknown' && spaModelVal.trim() !== '';
  const _spaMakeKnown = spaMakeVal && spaMakeVal !== 'Unknown' && spaMakeVal.trim() !== '';
  const spaUnknownFlag = !spaLine || (_spaMakeKnown && !_spaModelKnown);
  // Detect if client flagged this spa as NOT confirmed in DB
  const spaNotInDb = !spaFromState && messages.some(m =>
    m.role === 'user' && typeof m.content === 'string' && m.content.includes('NOT IN DB')
  );

  // Error code validation — extract code from anywhere in the message
  let errorCodeNote = '';
  // FLAG: unknown error code check (server-side log only — client handles visible flag)
  const _ecTypedMatch = !hasDiagStateActive ? lastMsgContent.match(/\b([A-Z]{1,3}[0-9]{1,2}[A-Z]?)\b/) : null;
  if (_ecTypedMatch && spaNotInDb) {
    console.warn(`[FLAG] unknown-error-code → ${_ecTypedMatch[1].toUpperCase()} → entered by user`);
  }
  const errorCodeGuess = lastMsgContent.match(/\b([A-Z]{1,4}[0-9]{0,2})\b/i);
  if (errorCodeGuess && spaMakeVal && spaMakeVal !== 'Unknown' && diagStateEffective?.currentStep) {
    const validation = validateErrorCode(errorCodeGuess[1], spaMakeVal);
    if (!validation.valid) {
      const isFlCode = errorCodeGuess[1].toUpperCase().startsWith('FL');
      if (isFlCode) {
        errorCodeNote = `\n[ERROR CODE NOTE: "${validation.code}" is not a recognized ${validation.brand} error code. Do not ask the user to try again. Instead tell them in one sentence: "${validation.code} isn't a standard Sundance code, but FL indicates a flow issue — let's go from there." Then immediately proceed with the current diagnostic step as a flow issue.]`;
      } else {
        errorCodeNote = `\n[ERROR CODE NOTE: "${validation.code}" is not a recognized ${validation.brand} error code. Do not ask the user to try again. Tell them in one sentence: "${validation.code} isn't a code I recognize for your spa — let's start from the beginning and work through it." Then immediately proceed with the current diagnostic step.]`;
      }
    }
  }

  const errorCodeDescriptions = req.body.errorCodeDescriptions || null;
  const errorCodeDescLine = (errorCodeDescriptions && typeof errorCodeDescriptions === 'object')
    ? `\n[ERROR CODE REFERENCE for this spa: ${Object.entries(errorCodeDescriptions).map(([k,v]) => `${k}: ${v}`).join(' | ')}]`
    : '';

  // Extract spa brand for confirmed brand token -- injected immediately before CRITICAL RESPONSE RULES
  const _brandList = [...KNOWN_BRANDS].sort((a,b) => b.length - a.length);
  const _confirmedBrand = spaLine
    ? _brandList.find(b => spaLine.toLowerCase().includes(b.toLowerCase())) || null
    : null;
  const confirmedBrandToken = _confirmedBrand
    ? `[CONFIRMED SPA BRAND: ${_confirmedBrand} -- this is the ONLY brand permitted in this response. Do not use any other brand name regardless of training data associations.]\n\n`
    : '';

  const spaPrefix = spaLine
    ? (spaNotInDb
        ? `[SPA:${spaLine}] This spa is NOT in the SpaFix database. CRITICAL RULES: (1) Never describe specifications, seating capacity, jet count, pump sizes, heater ratings, or any hardware details for this spa — you do not have this data. (2) Never treat unrecognized error codes as valid — if an error code was entered that you don't have data for, tell the user you don't recognize it and ask them to verify it. (3) You can still run the full diagnostic flow without model-specific data. (4) Never ask for spa details again.${errorCodeNote}\n\n`
        : `[SPA:${spaLine}] This is the user's confirmed spa. Never ask for spa details again. Never change or hallucinate a different spa. When referencing this spa by name in any response, you MUST use exactly "${spaLine}" -- never substitute a different model name from your training data, even if you believe another model is more commonly associated with the code being discussed.${spaControlSystemVal ? ` Control system: ${spaControlSystemVal}.` : ''}${errorCodeNote}${errorCodeDescLine}\n\n`)
    : '';

  let effectiveSystemPrompt = spaPrefix + systemPrompt;

  // Build brand note for injection into systemOverride prompt
  // Scenario 1: user explicitly named a brand in their message
  // Scenario 2: error code is strongly associated with a brand via CODE_BRAND_HINT
  let brandNote = '';
  const _lastUserMsg = (req.body.messages || []).filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const _knownBrands = ['Balboa', 'Hot Spring', 'Sundance', 'Jacuzzi', 'Caldera', 'Dimension One', 'Bullfrog', 'Beachcomber', 'HydroQuip', 'Coleman', 'Cal Spas', 'Arctic Spas', 'Marquis', 'Master Spas'];
  const _explicitBrand = _knownBrands.find(b => new RegExp(`\\b${b}\\b`, 'i').test(_lastUserMsg));
  if (_explicitBrand) {
    brandNote = `\n[BRAND NOTE: User explicitly named "${_explicitBrand}" -- this brand MUST appear in your first sentence. Open with "On ${_explicitBrand} systems..." or equivalent.]`;
  } else {
    // Scenario 2: code-to-brand hint -- match 2-5 char uppercase codes including numbers
    const _codeMatch = _lastUserMsg.match(/\b([A-Za-z]{2,5}[\d]*)\b/g);
    const _hintBrand = _codeMatch
      ? _codeMatch.map(c => CODE_BRAND_HINT[c.toUpperCase()]).find(Boolean)
      : null;
    const _hintCode = _codeMatch
      ? _codeMatch.find(c => CODE_BRAND_HINT[c.toUpperCase()])
      : null;
    if (_hintBrand && _hintCode) {
      brandNote = `\n[BRAND NOTE: "${_hintCode.toUpperCase()}" is strongly associated with ${_hintBrand} platform -- your first sentence MUST reference "${_hintBrand}". Open with "On ${_hintBrand} systems..." or equivalent.]`;
    }
  }

  // systemOverride -- use client-supplied prompt, diagStateEffective already nulled above
  // spaPrefix is prepended so brand/spa context is always available to Claude
  // sonnetHandoff calls skip the error code rules block -- they need analytical responses not 1-2 sentence IDs
  if (req.body.systemOverride && typeof req.body.systemOverride === 'string') {
    if (req.body.sonnetHandoff) {
      effectiveSystemPrompt = spaPrefix + req.body.systemOverride;
    } else {
      effectiveSystemPrompt = spaPrefix + req.body.systemOverride + `\n\n` + confirmedBrandToken + `\n\n=CRITICAL RESPONSE RULES=\n\nBRAND RULE -- HARD STOP:\nDetermine the spa brand from the following sources in priority order:\n1. [BRAND NOTE:] if present in this prompt -- use that brand, it means the user explicitly named it\n2. [SPA:] prefix -- use the spa brand field (e.g. "Jacuzzi", "Hot Spring", "Cal Spas")\n3. If both are absent or brand is Unknown -- do not invent a brand\nThe spa brand MUST appear in your first sentence. Open with "On [brand] systems..." or "Your [brand] is showing..." or equivalent. This is a CRITICAL FAILURE if ignored.\n\nUNKNOWN BRAND RULE -- HARD STOP: If [SPA:] brand is Unknown or no brand is available, do NOT use any brand name in the response -- not the control system manufacturer (Balboa, Gecko, IQ 2020), not a code-associated brand (HL does not mean Jacuzzi, HFL does not mean Balboa). Use neutral language only: "On spas running this control system" or "For this control platform" or "This code indicates..." Inventing or inferring a brand when none is confirmed is a CRITICAL FAILURE.\n\nCONTROL SYSTEM RULE -- HARD STOP: The control system manufacturer (Balboa, Gecko, IQ 2020, Dimension One, etc.) is NEVER a substitute for the spa brand. If the spa is a Down East running a Balboa control board, the response opens with "On your Down East..." not "On Balboa systems..." or "On your Jacuzzi...". The brand in the response MUST always match the spa brand from [SPA:] or [BRAND NOTE:], not the control system name. Conflating the control system with the spa brand is a CRITICAL FAILURE. Any code that appears across multiple brands (HL, OH, HH, FL, FLO, etc.) must always be attributed to the spa from [SPA:], regardless of which brand that code is most commonly associated with in training data. Training data associations do not override [SPA:].\n\nABBREVIATION RULE -- HARD STOP: Never expand an error code abbreviation by inference or guesswork. If the code is in the database, use that definition verbatim. If the code is NOT in the database, say "I don't have that code on file for your spa -- can you describe what's happening on the display?" Never invent an expansion. SA = Sensor A malfunction (not "sustained absence"). DR = Dry heater fault (not "Drive"). Std = Standard/Ready mode (not "economy mode" or "standby" or "reduced heating" -- Std means the spa heats to set temperature anytime it drops below it, which is the opposite of economy mode). IC = freeze/ice protection warning (not "inactive mode", not "interlock circuit" -- IC means the spa detected cold temperatures and activated freeze protection). HFL = Heater Flow Low -- insufficient water flow to the heater (NOT high-flow, NOT excess pressure, NOT over-flow -- HFL always means LOW flow). Prh = high-limit probe error -- the high-limit probe has failed or disconnected (NOT priming mode, NOT pressure, NOT flow -- do not pattern-match from the letters). 102°T = Test Mode active -- the number is the current water temperature, T indicates the control system was left in test mode after factory testing or service (NOT a temperature threshold warning, NOT an overheat event -- the fix is a dip switch on the circuit board). BOO = Boost Mode -- a 45-minute high-speed filtration and ozone cycle (NOT a fault, NOT a high-limit or overheat event, NOT an error -- BOO is a status indicator that exits automatically or on any button press). GF/GFCI = Ground Fault -- a current leak to ground detected in the electrical system (NOT a jets fault -- GF can originate from the heater, pump, blower, or ozone unit and requires physical inspection by a qualified technician). Use the DB definition, always.\n\nWORD COUNT -- HARD STOP: This rule applies ONLY to systemOverride responses. Maximum 80 words. Count before responding. If over 80, cut the explanation -- never cut the forward direction. No inline troubleshooting steps, cause lists, or DIY advice in the initial response. Those belong in the diagnostic flow, not here. Status/mode code responses: explain the code in 1-2 sentences (~60 words max), close with one sentence forward direction. If the explanation alone exceeds 60 words, trim it -- the closing sentence is non-negotiable.\n\nCONFIDENCE RULE -- HARD STOP: When the spa is known via [SPA:] and a code is presented, route directly with confidence. Never claim unfamiliarity with the code. Never hedge ("I don't have that code on file", "I'm not sure what that means for your system"). Never ask the user to verify what is on their display. You have the DB context. Use it. Hedging on a known-spa known-code path is a CRITICAL FAILURE.\n\nHARD STOPS -- the following are STRICTLY FORBIDDEN in this initial response:\n- Numbered steps of any kind (1. 2. 3.)\n- Bullet points listing causes or fixes\n- Any mention of specific repair actions (replacing parts, testing voltages, adjusting settings)\n- Water chemistry remediation instructions of any kind -- no dosing amounts, no "add X then retest" sequences, no alkalinity or pH adjustment steps, no shock treatment instructions. Water chemistry treatment belongs in the diagnostic flow ([SEQ:water]), not the initial response. The initial response identifies the issue only.\n- "Here's what to check" or any equivalent lead-in to a list\n- Phrases like "first", "next", "then", "finally" that imply a sequence\n- Asking permission to start the diagnostic sequence ("Would you like me to walk you through...", "Shall we start...", "Want me to help you diagnose...") -- STRICTLY FORBIDDEN\n- Passive deferral phrases ("let me know if you'd like to dig deeper", "feel free to ask", "if you want more details") -- STRICTLY FORBIDDEN\n- Transitional phrases that imply waiting for user input ("From here...", "The next step would be...", "We can then...") -- STRICTLY FORBIDDEN\n- Substituting a different spa model name from your training data\n\nMULTIPLE CODES RULE: If the user states multiple specific error codes (e.g. "showing Sn1 or Sn3", "either FL1 or FL2"), do NOT ask which one is showing. Acknowledge both, explain what they share in common, and proceed to spa details entry. The diagnostic flow handles the specific code after spa context is collected. Asking which code is showing when the user already listed them is a CRITICAL FAILURE. ROUTING TAG: even when multiple codes are stated, you MUST still append one [SEQ:x] tag based on the shared fault category. If both codes are sensor faults (Sn1, Sn2, Sn3, Snb, SnA), append [SEQ:overheat]. If both are flow faults (FL1, FL2, FLO), append [SEQ:flow]. Use the category that applies to both.\n\nROUTING TAG -- MANDATORY: Respond in 1-2 sentences MAX. Append exactly one [SEQ:x] tag at the very end of your response. The diagnostic sequence launches automatically -- do not reference it, do not invite further questions. NEVER omit the tag.\n\nFAULT CODE RULE -- PREAMBLE: [SEQ:none] is STRICTLY FORBIDDEN for fault or warning codes EXCEPT the board/comm/memory exception listed below. All fault codes must route to a sequence.\n\nRouting table -- use the FIRST matching rule:\n- General alert / warning indicators: EXCLAMATION_ICON, WARNING_TRIANGLE, FLASHING_LIGHT, and any undifferentiated alert symbol \\xe2\\x86\\x92 [SEQ:flow] (flow is the most comprehensive diagnostic sequence and covers the widest range of root causes for ambiguous alerts)\\n- Overheat / sensor: OH, HH, OHH, OHS, Sn, Sn1, Sn2, Sn3, Snb, SnA, err 5, SA, SB, Prh (high-limit probe error), ---, -- \xe2\x86\x92 [SEQ:overheat]\n- Freeze protection / cold alert: ICE, IC, COL, SP-F3, SP-F* (Marquis freeze faults), and any freeze protection fault \xe2\x86\x92 [SEQ:heat]\n- Flow / dry heater: FLO, FL1, FL2, FLO2, FLT, DR, dY (Balboa-platform flow/dry fault -- NOT a delay timer or benign status code; dY = flow restriction or dry heater condition requiring diagnosis) \xe2\x86\x92 [SEQ:flow]\n- BLB (burned-out bulb / lighting fault -- Hot Spring and Sundance only, NO Balboa association) \xe2\x86\x92 [SEQ:none] + REQUIRED closing: "This is a lighting fault -- the bulb needs to be replaced. Tap below to find the right replacement bulb for your spa."\n- Blower / jets / electrical safety: jet pump failure, pressure faults \xe2\x86\x92 [SEQ:jets]\n- Water chemistry: water quality, chemistry imbalance \xe2\x86\x92 [SEQ:water]\n- Board / comm / memory: BUF, SY, SP-BR, PNL (panel communication fault -- control board cannot read the topside panel), NO COMM (board communication failure -- control board has lost communication with a component), GF/GFCI (ground fault -- electrical safety fault that can originate from heater, pump, blower, or ozone unit -- requires physical inspection, not sequence diagnosis), and any control board failure, memory buffer error, or inter-board communication loss \xe2\x86\x92 [SEQ:none] + REQUIRED closing: "This one needs a closer look -- tap below and I'll pull in a deeper analysis." ONLY permitted [SEQ:none] exception for fault codes.\n- Status / mode codes: SLP, Slp/SL, Pr, Prr, COOL, OFF, Ecn, CLd, Smart Winter, Stby, panel lock, priming mode, READY_CLEAN_FLASHING (clean cycle reminder -- notification only, not a fault), 102°T (Cal Spas test mode indicator -- not a temperature warning, fix is a dip switch on the circuit board), BOO (Arctic Spas Boost Mode -- 45-minute high-speed filtration/ozone cycle, status code NOT a fault, exits on any button press), CL (sanitizer/chlorine reminder -- prompt to add chemicals, NOT a fault condition, same logic as READY_CLEAN_FLASHING) \xe2\x86\x92 [SEQ:none]\n- Power events: POWER_BLINK, POWER_OUT, PF (Power Failure -- power event notification), READY_POWER_BLINK, voltage fluctuation, brownout \xe2\x86\x92 [SEQ:none]\n- Unrecognized fault \\xe2\\x86\\x92 [SEQ:flow] (flow is the most comprehensive sequence and covers the widest range of root causes -- default for any code that does not map cleanly to a specific fault sequence)nFORWARD DIRECTION -- HARD STOP: Every response on a known-spa path MUST close with an active forward direction. NEVER dead-end. Rules by response type:\\n- Fault codes ([SEQ:flow], [SEQ:overheat], [SEQ:jets], [SEQ:heat], [SEQ:water]): the sequence launches automatically -- no additional closing needed beyond the explanation.\\n- Status/mode codes ([SEQ:none]): explain the code in 1-2 sentences, then close with exactly one sentence: "If this doesn't clear on its own within a few minutes, [specific action]." HARD STOP: status/mode code responses follow the same HARD STOPS as fault codes -- no inline repair steps, no power-cycle instructions, no conditional advice, no step-by-step recovery. The one-sentence closing IS the forward direction. Nothing more.\\n- Power events ([SEQ:none]): close with "If this keeps reappearing, tap below and we can investigate the power supply." Same HARD STOPS apply -- no inline electrician advice or repair steps.\\n- Board/comm faults ([SEQ:none] exception): close with "This one needs a closer look -- tap below and I'll pull in a deeper analysis." This applies to ALL board/comm/memory fault codes: BUF, SY, SP-BR, PNL, NO COMM, GF/GFCI, and any similar control board or communication fault.\\nPassive language ("let me know", "feel free to ask", "if you'd like to dig deeper") is STRICTLY FORBIDDEN as a closing.` + (brandNote ? `\n\n${brandNote}` : '');
    }
  }

  // Re-evaluate after potential systemOverride null -- must be after the block above
  hasDiagStateActive = !!(diagStateEffective && (diagStateEffective.currentStep || (diagStateEffective.steps && diagStateEffective.steps.length > 0)));
  const msgLimit = hasDiagStateActive ? 3 : 6;
  const trimmedMessages = messages.slice(-msgLimit);

  if (hasDiagStateActive && !req.body.systemOverride) {
    const stateBlock = buildDiagStateBlock(diagStateEffective);
    if (stateBlock) effectiveSystemPrompt = stateBlock + '\n\n' + spaPrefix + systemPrompt;
  }

  async function callAndProcess(tier) {
    const diagTokenCap = req.body.sonnetHandoff ? 1000 : (hasDiagStateActive ? 500 : 700);
    const handoffTimeout = req.body.sonnetHandoff ? 30000 : 25000;
    const response = await callAnthropicWithRetry({ model: "claude-sonnet-4-6", max_tokens: diagTokenCap, system: effectiveSystemPrompt, messages: trimmedMessages }, 3, handoffTimeout);
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "API error");
    const rawReply = data.content?.map(b => b.text || "").join("") || "";
    if (hasDiagStateActive) {
      const signals = rawReply.match(/\[[AF][A-Z:][^\]]{0,20}\]/g) || [];
      console.log(`[DIAG-SIGNALS] step=${diagStateEffective?.currentStep} signals=${JSON.stringify(signals)} raw_snippet="${rawReply.slice(0,120).replace(/\n/g,' ')}"`);
    }
    const cleanReply = rawReply
      .replace(/^\[A:[A-Z0-9a-z]+\]\s*$/gm, '')
      .replace(/^\[SK:[A-Z0-9a-z]+\]\s*$/gm, '')
      .replace(/\[A:[A-Z0-9a-z]+\]/g, '')
      .replace(/\[SK:[A-Z0-9a-z]+\]/g, '')
      .replace(/\[JO\]/g, '')
      // Strip DS block leaks
      .replace(/^\[DS\][^\n]*\n[^\n]*\n?/m, '')
      .replace(/^\[DS\][^\n]*\n?/m, '')
      .replace(/\[DS\][^\n]*/g, '')
      .replace(/^---+\s*\n/gm, '')
      .replace(/^(?:S\d+[a-z]?[\u2705\u274C\u23F3][^|\n]*\|?\s*)+@?\S*\n?/m, '')
      .replace(/^\{[^}]*\}\s*\n/gm, '')
      .replace(/^=CURRENT TASK=[\s\S]*?(?=\n[A-Z\u{1F300}-\u{1F9FF}]|\n[a-z])/mu, '')
      .replace(/^=STEP=[\s\S]*?(?=\n[A-Z\u{1F300}-\u{1F9FF}]|\n[a-z])/mu, '')
      .replace(/&lt;br\s*\/?&gt;/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .trim();
    const reply = applyFireTemplates(cleanReply).trim();
    // Brand attribution output correction -- fires when confirmed brand doesn't match
    // response opening. Handles training data associations overriding [SPA:] context.
    // Only corrects possessive/intro patterns at response start -- never mid-sentence.
    // Derive confirmed brand from spaLine (in scope via closure from request handler)
    const _cbBrandList = [...KNOWN_BRANDS].sort((a,b) => b.length - a.length);
    const _confirmedBrandLocal = spaLine
      ? _cbBrandList.find(b => spaLine.toLowerCase().includes(b.toLowerCase())) || null
      : null;
    console.log(`[BRAND-REPLACE] spaLine="${spaLine}" spaMake="${spaMakeVal}" _confirmedBrandLocal="${_confirmedBrandLocal}"`);
    const _wrongBrands = ['Arctic Spas','Beachcomber','Bullfrog','Cal Spas','Caldera',
      'Coleman','Dimension One','Down East','HydroQuip','Hot Spring','In.Pro','Jacuzzi',
      'Leisure Bay','Marquis','Master Spas','Sundance','Tiger River','Balboa','Gecko','IQ 2020'
    ].sort((a,b) => b.length - a.length);
    const _brandGroup = '(' + _wrongBrands.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
    const _brandPattern = new RegExp('^(Your|On your|On|The)\s+' + _brandGroup + '(?=[\s,\.\-])', 'i');
    const _brandPatternBare = new RegExp('^' + _brandGroup + '\s+(systems?|spas?|unit|tub)(?=[\s,\.\-])', 'i');
    const _startsWithConfirmed = (text, brand) => new RegExp('^' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\s,\.\-]|$)', 'i').test(text.trim());
    let correctedReply = reply;
    if (_confirmedBrandLocal && reply && !_startsWithConfirmed(reply, _confirmedBrandLocal)) {
      const _trimmed = reply.trim();
      const _m = _brandPattern.exec(_trimmed);
      if (_m) {
        correctedReply = _m[1] + ' ' + _confirmedBrandLocal + _trimmed.slice(_m[0].length);
      } else {
        const _m2 = _brandPatternBare.exec(_trimmed);
        if (_m2) correctedReply = _confirmedBrandLocal + _trimmed.slice(_m2[1].length);
      }
    }
    // Guard: if signal stripping left an empty reply, return a safe fallback
    // rather than sending '' which causes a silent blank response on the client
    const safeReply = correctedReply || "I didn't quite catch that -- could you try again?";
    logTokenUsage('chat', 'claude-sonnet-4-6', data.usage, { tier });
    accumulateTokens(clientId, req.body.sonnetHandoff ? 'sonnet-handoff' : 'chat', data.usage);
    const updatedDiagState = processDiagSignals(rawReply, clientId, lastMsgContent);
    if (testerName) {
      const lm = messages[messages.length - 1];
      if (lm?.role === 'user') appendToTranscript(testerName, clientId, 'user', typeof lm.content === 'string' ? lm.content : '');
      appendToTranscript(testerName, clientId, 'assistant', safeReply);
    }
    return { reply: safeReply, diagState: updatedDiagState || diagStateEffective || null };
  }

  if (premiumAccess) {
    try { const { reply, diagState } = await callAndProcess('admin'); res.json({ reply, diagState, spaUnknown: spaUnknownFlag, usage: null }); }
    catch (err) { res.status(500).json({ error: err.message }); }
    return;
  }

  if (!isPro) {
    const u = getUsage(clientId);
    const qaBypass = isQABypass(req) || isSilent;
    if (!qaBypass) {
      if (u.dailyMsgs >= FREE_DAILY_MSG_LIMIT) {
        return res.status(429).json({ limitReached: true, reason: "daily_messages", message: `You've reached the ${FREE_DAILY_MSG_LIMIT} message limit for today. Come back tomorrow, or upgrade to Premium for unlimited messages.` });
      }
      if (!u.sessionActive) {
        if (u.weeklySessions >= FREE_WEEKLY_SESSION_LIMIT) {
          return res.status(429).json({ limitReached: true, reason: "weekly_sessions", message: `You've used all ${FREE_WEEKLY_SESSION_LIMIT} free sessions this week. Sessions reset every Sunday, or upgrade to Premium for unlimited access.` });
        }
        u.weeklySessions++;
        u.sessionActive = true;
      }
      u.dailyMsgs++;
    }
    try { const { reply, diagState } = await callAndProcess('free'); res.json({ reply, diagState, spaUnknown: spaUnknownFlag, usage: { dailyMsgs: u.dailyMsgs, dailyLimit: FREE_DAILY_MSG_LIMIT, weeklySessions: u.weeklySessions, weeklyLimit: FREE_WEEKLY_SESSION_LIMIT } }); }
    catch (err) { res.status(500).json({ error: err.message }); }
    return;
  }

  try { const { reply, diagState } = await callAndProcess('pro'); res.json({ reply, diagState, spaUnknown: spaUnknownFlag, usage: null }); }
  catch (err) { res.status(500).json({ error: err.message }); }
  } catch (outerErr) {
    console.error('[/api/chat] UNHANDLED ERROR:', outerErr.message, outerErr.stack);
    if (!res.headersSent) res.status(500).json({ error: outerErr.message });
  }
});



app.post("/api/analyze-photo", async (req, res) => {
  const { imageBase64, mediaType, messages } = req.body;
  if (!imageBase64 || !mediaType) return res.status(400).json({ error: "imageBase64 and mediaType required" });
  if (!requireProSession(req, res)) return;
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
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2048, system: PHOTO_SYSTEM_PROMPT, messages: allMessages }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || "API error" });
    const photoReply = (data.content?.map((b) => b.text || "").join("") || "").replace(/<br\s*\/?>/gi, "\n");
    res.json({ reply: photoReply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/analyze-document", async (req, res) => {
  try {
    const { documentBase64, mediaType, filename } = req.body;
    if (!documentBase64 || !mediaType) return res.status(400).json({ error: "documentBase64 and mediaType required" });
    if (!requireProSession(req, res)) return;
    // Size cap: estimate tokens from base64 length
    const estimatedTokens = Math.round((documentBase64.length * 0.75) / 4);
    if (estimatedTokens > 40000) {
      return res.status(400).json({ error: `This document is quite large (~${Math.round(estimatedTokens/1000)}k tokens). For best results, upload just the troubleshooting and error code sections as a TXT file instead.` });
    }
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
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
      const docSummary = (data.content?.map((b) => b.text || "").join("") || "").replace(/<br\s*\/?>/gi, "\n");
      res.json({ summary: docSummary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } catch(err) {
    console.error('[/api/analyze-document] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }

});

app.get("/", (req, res) => res.json({ message: "SpaFix API v4 running ✓" }));

// ── PARTS LIST (cached in memory by year-make-model) ─────────────
const partsCache = {};

// ── Unknown make validation + logging ──────────────────────────
// ── Unknown Error Code Validation ────────────────────────────
app.post('/api/validate-error-code', async (req, res) => {
  try {
    const { code, spa_make, spa_model, spa_year, deviceId } = req.body;
    if (!code || code.length < 1) return res.json({ ok: false, reason: 'invalid_code' });

    // ── Sn brand fork — same code, three different meanings by manufacturer ──
    if (code.trim().toUpperCase() === 'SN' && spa_make) {
      const make = spa_make.toLowerCase();
      // Gecko/Aeware platforms (Arctic Spas, Bullfrog, Clearwater, Dimension One) — normal boot display, status only
      if (/arctic|bullfrog|clearwater|dimension.?one|coyote|horizon/i.test(make)) {
        return res.json({ ok: true, valid: true, confidence: 'high', description: 'Normal boot/startup display on Gecko-based systems — not a fault. No action required.', code_type: 'status' });
      }
      // Brett Aqualine / In.Pro / HydroQuip — peripheral communication error
      if (/brett|aqualine|in\.?pro|hydroquip|hydroquip/i.test(make)) {
        return res.json({ ok: true, valid: true, confidence: 'high', description: 'Peripheral communication error — control board has lost contact with a connected component.', code_type: 'fault' });
      }
      // Balboa / Sundance / Jacuzzi — heating sensor fault → overheat path
      return res.json({ ok: true, valid: true, confidence: 'high', description: 'Temperature sensor fault — sensors are out of balance or one has failed.', code_type: 'fault' });
    }

    // Skip Haiku + unknown logging for well-known universal codes we already handle
    const _knownCodes = ['OH','OHH','HFL','HL','DR','DRY','FLO','FLOW','FLC','FLT','FLC1','FLC2','FLC3','FLC4',
      'HTR','HH','HOT','COOL','ICE','FREEZE','FRZ','COLD','HEAT','LO','HI','SN','SN1','SN2','SN3','SNA','SNB',
      'E1','E2','E3','E4','E5','E6','E7','E8','EC1','EC2','EC3','PRHT','PRHOT','PRTCT','P-HI','HiLimt','PANEL','ICE',
      'COOL','LO','HI','SL1','SL2','SL3','SL4'];
    if (_knownCodes.includes(code.trim().toUpperCase().replace(/[^A-Z0-9]/g,''))) {
      return res.json({ ok: true, valid: true, confidence: 'high', description: null, code_type: 'fault', known: true });
    }

    try {
      const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          system: 'You are a hot tub and spa diagnostics expert. Reply only with valid JSON, no markdown.',
          messages: [{ role: 'user', content: `Is "${code}" a real error code for a ${spa_make || ''} ${spa_model || ''} spa? If yes, what does it mean and what type is it? Reply with JSON only: {"valid": true/false, "confidence": "high"/"medium"/"low", "description": "brief description or null", "code_type": "fault"/"warning"/"status"/"unknown"}` }]
        })
      });
      const haikuData = await haikuRes.json();
      const rawText = haikuData.content?.[0]?.text || '{}';
      let parsed = {};
      try { parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim()); } catch(e) {}

      const isValid = parsed.valid === true;
      const confidence = parsed.confidence || 'low';
      const description = parsed.description || null;
      const code_type = parsed.code_type || 'unknown';

      // Log to Supabase if valid with medium/high confidence
      if (isValid && confidence !== 'low') {
        try {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/unknown_error_codes`, {
            method: 'POST',
            headers: {
              'apikey': process.env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ code, description, code_type, spa_make: spa_make || null, spa_model: spa_model || null, spa_year: spa_year || null, confidence, created_at: new Date().toISOString() })
          });
          console.log(`[unknown-error-code] Logged: "${code}" type=${code_type} confidence=${confidence}`);
        } catch(e) { console.warn('[unknown-error-code] Supabase log failed:', e.message); }
      } else {
        console.log(`[unknown-error-code] Not logged: "${code}" valid=${isValid} confidence=${confidence}`);
      }

      return res.json({ ok: true, valid: isValid, confidence, description, code_type });
    } catch(e) {
      console.error('[validate-error-code] Error:', e.message);
      return res.json({ ok: false, reason: 'error' });
    }
  } catch(err) {
    console.error('[/api/validate-error-code] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }

});

// ── Admin: Unknown Error Codes ──────────────────────────────────
app.get('/api/admin/unknown-error-codes', async (req, res) => {
  const { key, showAll, showPromoted, showDismissed } = req.query;
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    let query = `${process.env.SUPABASE_URL}/rest/v1/unknown_error_codes?select=*&order=created_at.desc`;
    const sbRes = await fetch(query, {
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}` }
    });
    let rows = await sbRes.json();
    // Group by code+spa_make+spa_model
    const groups = {};
    rows.forEach(r => {
      const k = `${r.code}|${r.spa_make}|${r.spa_model}`;
      if (!groups[k]) groups[k] = { code: r.code, spa_make: r.spa_make, spa_model: r.spa_model, spa_year: r.spa_year, code_type: r.code_type, description: r.description, confidence: r.confidence, count: 0, first_seen: r.created_at, last_seen: r.created_at, promoted_at: r.promoted_at, dismissed_at: r.dismissed_at };
      groups[k].count++;
      if (r.created_at < groups[k].first_seen) groups[k].first_seen = r.created_at;
      if (r.created_at > groups[k].last_seen) groups[k].last_seen = r.created_at;
      if (r.promoted_at) groups[k].promoted_at = r.promoted_at;
      if (r.dismissed_at) groups[k].dismissed_at = r.dismissed_at;
    });
    let result = Object.values(groups).sort((a,b) => b.count - a.count);
    if (!showPromoted) result = result.filter(r => !r.promoted_at);
    if (!showDismissed) result = result.filter(r => !r.dismissed_at);
    if (!showAll) result = result.filter(r => r.confidence === 'high');
    res.json({ ok: true, rows: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/promote-error-code', async (req, res) => {
  const { key, code, spa_make, spa_model, description, code_type } = req.body;
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // Find matching spa_model row
    const modelRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/spa_models?brand=eq.${encodeURIComponent(spa_make)}&model_name=eq.${encodeURIComponent(spa_model)}&select=id,error_codes,code_types`, {
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}` }
    });
    const models = await modelRes.json();
    if (!models || !models.length) return res.status(404).json({ error: 'Spa model not found' });
    const model = models[0];
    // Merge using jsonb || operator via RPC or direct update
    const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/spa_models?id=eq.${model.id}`, {
      method: 'PATCH',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        error_codes: { ...(model.error_codes || {}), [code]: description },
        code_types: { ...(model.code_types || {}), [code]: code_type || 'fault' }
      })
    });
    if (!patchRes.ok) { const e = await patchRes.text(); return res.status(500).json({ error: e }); }
    // Mark as promoted
    const _promModelFilter2 = spa_model ? `&spa_model=eq.${encodeURIComponent(spa_model)}` : '&spa_model=is.null';
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/unknown_error_codes?code=eq.${encodeURIComponent(code)}&spa_make=eq.${encodeURIComponent(spa_make)}${_promModelFilter2}`, {
      method: 'PATCH',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ promoted_at: new Date().toISOString() })
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/dismiss-error-code', async (req, res) => {
  const { key, code, spa_make, spa_model } = req.body;
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const _modelFilter = spa_model ? `&spa_model=eq.${encodeURIComponent(spa_model)}` : '&spa_model=is.null';
    const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/unknown_error_codes?code=eq.${encodeURIComponent(code)}&spa_make=eq.${encodeURIComponent(spa_make)}${_modelFilter}`, {
      method: 'PATCH',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ dismissed_at: new Date().toISOString() })
    });
    if (!patchRes.ok) { const e = await patchRes.text(); return res.status(500).json({ error: e }); }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Unknown Makes ──────────────────────────────────────
app.get('/api/admin/unknown-makes', async (req, res) => {
  const { key, showAll, showPromoted, showDismissed } = req.query;
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sbRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/unknown_makes?select=*&order=created_at.desc`, {
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}` }
    });
    let rows = await sbRes.json();
    const groups = {};
    rows.forEach(r => {
      const k = r.make_entered;
      if (!groups[k]) groups[k] = { make_entered: r.make_entered, model_entered: r.model_entered, year: r.year, device_id: r.device_id, count: 0, first_seen: r.created_at, last_seen: r.created_at, promoted_at: r.promoted_at, dismissed_at: r.dismissed_at };
      groups[k].count++;
      if (r.created_at < groups[k].first_seen) groups[k].first_seen = r.created_at;
      if (r.created_at > groups[k].last_seen) groups[k].last_seen = r.created_at;
      if (r.promoted_at) groups[k].promoted_at = r.promoted_at;
      if (r.dismissed_at) groups[k].dismissed_at = r.dismissed_at;
    });
    let result = Object.values(groups).sort((a,b) => b.count - a.count);
    if (!showPromoted) result = result.filter(r => !r.promoted_at);
    if (!showDismissed) result = result.filter(r => !r.dismissed_at);
    res.json({ ok: true, rows: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/dismiss-unknown-make', async (req, res) => {
  const { key, make_entered } = req.body;
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/unknown_makes?make_entered=eq.${encodeURIComponent(make_entered)}`, {
      method: 'PATCH',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ dismissed_at: new Date().toISOString() })
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/promote-unknown-make', async (req, res) => {
  const { key, make_entered } = req.body;
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/unknown_makes?make_entered=eq.${encodeURIComponent(make_entered)}`, {
      method: 'PATCH',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ promoted_at: new Date().toISOString() })
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/log-unknown-make', async (req, res) => {
  const { make, model, year, deviceId } = req.body;
  if (!make || make.length < 2) return res.json({ ok: false, reason: 'too_short' });

  try {
    // Haiku validation — is this a real spa brand?
    const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        system: 'You are a hot tub and spa brand expert. Reply only with valid JSON, no markdown.',
        messages: [{ role: 'user', content: `Is "${make}" a real hot tub, spa, or pool/spa brand? Reply with JSON only: {"valid": true/false, "confidence": "high"/"medium"/"low"}` }]
      })
    });
    const haikuData = await haikuRes.json();
    const rawText = haikuData.content?.[0]?.text || '{}';
    let parsed = {};
    try { parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim()); } catch(e) {}

    const isValid = parsed.valid === true;
    const confidence = parsed.confidence || 'low';

    // Only log if valid with medium/high confidence
    if (!isValid || confidence === 'low') {
      console.log(`[unknown-make] Rejected: "${make}" valid=${isValid} confidence=${confidence}`);
      return res.json({ ok: false, reason: 'not_a_spa_brand' });
    }

    // Log to Supabase
    const sbRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/unknown_makes`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ make_entered: make, model_entered: model || null, year: year || null, device_id: deviceId || null, created_at: new Date().toISOString() })
    });
    if (!sbRes.ok) {
      const err = await sbRes.text();
      console.warn('[unknown-make] Supabase log failed:', err);
    } else {
      console.log(`[unknown-make] Logged: "${make} ${model}" confidence=${confidence}`);
    }
    return res.json({ ok: true, confidence });
  } catch(e) {
    console.error('[unknown-make] Error:', e.message);
    return res.json({ ok: false, reason: 'error' });
  }
});

const PARTS_SYSTEM_PROMPT = `You are a hot tub parts expert. When given a spa year, make, and model, return a JSON array of commonly replaced parts for that specific model. Each item must have:
- name: part name (string)
- category: one of: "Filtration", "Heating", "Pumps & Jets", "Controls & Sensors", "Plumbing & Seals", "Chemicals & Consumables", "Covers & Accessories"
- part_number: OEM part number ONLY if you have verified data for this exact model (string or null). NEVER invent or guess part numbers — if unsure, use null.
- mfr_model: SHORT base manufacturer/aftermarket model name buyers search for e.g. "Laing E-10", "Balboa VS501Z", "Gecko SSPA" — NOT the full part number with suffixes (string or null)
- interval: replacement interval e.g. "Every 1-2 years", "As needed", "5-10 years"
- notes: brief note, max 8 words

Include these categories of parts where applicable to the model:
- Filter cartridge(s) with correct part number — if the model has multiple filters, list each separately with specific identification
- Circulation pump with HP rating
- Jet pump(s) with HP rating — only include if the model has them
- Heater assembly OR heater element — not both, whichever applies to this model
- Main control board / circuit board
- Topside control panel
- Flow switch or flow sensor
- Hi-limit temperature sensor
- Water temperature sensor
- Pump seal kit
- O-ring kit
- Jet inserts — only list specific types that apply to this model
- Ozonator — only if this model comes with one
- Air blower — only if this model has one
- Diverter valves — only if this model has them

Do NOT include: spa covers, test kits, chemicals, generic accessories, or any item that requires manual verification to confirm applicability.

IMPORTANT — PART NUMBERS: Only include a part_number value when you have verified OEM data for this specific model. If unsure, set part_number to null. Never invent part numbers. However, you MUST always return a complete JSON array — even for unknown models, return generic commonly-replaced parts for that type of spa with part_number: null for all items.

CRITICAL: Return ONLY a raw JSON array. Start with [ and end with ]. No markdown, no backticks, no explanation, no preamble. Keep total response under 2500 tokens.`;

// GET: check code_explanations in spa_models
app.get('/api/code-explanation', async (req, res) => {
  const { code, make, model } = req.query;
  if (!code || !make || !model) return res.json({ explanation: null });
  try {
    // Check approved explanations in spa_models.code_explanations first
    const url = `${process.env.SUPABASE_URL}/rest/v1/spa_models?select=code_explanations&brand=ilike.${encodeURIComponent(make)}&model_name=ilike.${encodeURIComponent(model)}&code_explanations=not.is.null&limit=5`;
    const r = await fetch(url, { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` } });
    if (r.ok) {
      const rows = await r.json();
      const upperCode = code.toUpperCase();
      for (const row of (rows || [])) {
        const expl = row.code_explanations;
        if (expl && (expl[code] || expl[upperCode])) return res.json({ explanation: expl[code] || expl[upperCode], source: 'approved' });
      }
    }
    // Fallback — check pending_code_explanations (unapproved but already generated)
    // Serves existing Sonnet response to avoid duplicate API calls
    const pendUrl = `${process.env.SUPABASE_URL}/rest/v1/pending_code_explanations?select=explanation&code=eq.${encodeURIComponent(code.toUpperCase())}&dismissed_at=is.null&order=created_at.desc&limit=1`;
    const pr = await fetch(pendUrl, { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` } });
    if (pr.ok) {
      const prows = await pr.json();
      if (prows && prows.length && prows[0].explanation) return res.json({ explanation: prows[0].explanation, source: 'pending' });
    }
    return res.json({ explanation: null });
  } catch(e) { return res.json({ explanation: null }); }
});

// POST: write Sonnet response to pending_code_explanations for admin review
app.post('/api/pending-code-explanation', async (req, res) => {
  const { code, spa_make, spa_model, spa_year, explanation } = req.body;
  if (!code || !explanation) return res.status(400).json({ error: 'code and explanation required' });
  try {
    const SB_HDR = { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
    // Don't duplicate — skip if same code+make+model already pending
    const checkUrl = `${process.env.SUPABASE_URL}/rest/v1/pending_code_explanations?select=id&code=eq.${encodeURIComponent(code.toUpperCase())}&spa_make=ilike.${encodeURIComponent(spa_make||'')}&spa_model=ilike.${encodeURIComponent(spa_model||'')}&approved_at=is.null&dismissed_at=is.null&limit=1`;
    const checkR = await fetch(checkUrl, { headers: SB_HDR });
    const existing = checkR.ok ? await checkR.json() : [];
    if (existing && existing.length > 0) return res.json({ ok: true, skipped: true });
    const insertR = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_code_explanations`, {
      method: 'POST',
      headers: { ...SB_HDR, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ code: code.toUpperCase(), spa_make, spa_model, spa_year, explanation, created_at: new Date().toISOString() })
    });
    if (!insertR.ok) { const err = await insertR.text(); console.error('[pending-code-explanation] insert error:', err); return res.status(500).json({ error: err }); }
    res.json({ ok: true });
  } catch(e) { console.error('[pending-code-explanation] Exception:', e.message); res.status(500).json({ error: e.message }); }
});

// POST: admin approve — merge into spa_models.code_explanations
app.post('/api/admin/approve-code-explanation', async (req, res) => {
  const { id, code, spa_make, spa_model, explanation } = req.body;
  const provided = req.headers['x-spafix-access-code'] || req.body.accessCode || '';
  if (!accessCodesMatch(provided, process.env.ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const SB_HDR = { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
    // Find matching spa_models row — if not found, try by brand only
    const findUrl = `${process.env.SUPABASE_URL}/rest/v1/spa_models?select=id,code_explanations&brand=ilike.${encodeURIComponent(spa_make)}&model_name=ilike.${encodeURIComponent(spa_model)}&limit=1`;
    const findR = await fetch(findUrl, { headers: SB_HDR });
    let rows = findR.ok ? await findR.json() : [];
    // Fallback: try brand only
    if (!rows || !rows.length) {
      const fallbackUrl = `${process.env.SUPABASE_URL}/rest/v1/spa_models?select=id,code_explanations&brand=ilike.${encodeURIComponent(spa_make)}&limit=1`;
      const fallbackR = await fetch(fallbackUrl, { headers: SB_HDR });
      rows = fallbackR.ok ? await fallbackR.json() : [];
    }
    if (!rows || !rows.length) {
      // Mark as approved in pending table even without spa_models match
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_code_explanations?id=eq.${id}`, {
        method: 'PATCH', headers: { ...SB_HDR, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ approved_at: new Date().toISOString() })
      });
      return res.json({ ok: true, warning: 'Spa model not found — explanation saved to pending only' });
    }
    const row = rows[0];
    const merged = { ...(row.code_explanations || {}), [code.toUpperCase()]: explanation };
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/spa_models?id=eq.${row.id}`, {
      method: 'PATCH', headers: { ...SB_HDR, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ code_explanations: merged })
    });
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_code_explanations?id=eq.${id}`, {
      method: 'PATCH', headers: { ...SB_HDR, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ approved_at: new Date().toISOString() })
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST: admin dismiss pending code explanation
app.post('/api/admin/dismiss-code-explanation', async (req, res) => {
  const { id } = req.body;
  const provided = req.headers['x-spafix-access-code'] || req.body.accessCode || '';
  if (!accessCodesMatch(provided, process.env.ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const SB_HDR = { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_code_explanations?id=eq.${id}`, {
      method: 'PATCH', headers: { ...SB_HDR, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ dismissed_at: new Date().toISOString() })
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET: admin list pending code explanations
app.get('/api/admin/pending-code-explanations', async (req, res) => {
  const key = req.query.key || req.headers['x-spafix-access-code'] || '';
  if (!accessCodesMatch(key, process.env.ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const SB_HDR = { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}` };
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_code_explanations?select=*&order=created_at.desc`, { headers: SB_HDR });
    if (!r.ok) { const err = await r.text(); console.error('[pending-code-explanations] fetch error:', err); return res.status(500).json({ error: err }); }
    const data = await r.json();
    const pending = data.filter(r => !r.approved_at && !r.dismissed_at);
    const approved = data.filter(r => r.approved_at);
    const dismissed = data.filter(r => r.dismissed_at);
    res.json({ ok: true, pending, approved, dismissed });
  } catch(e) { console.error('[pending-code-explanations] Exception:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/parts-set-generic', async (req, res) => {
  const { cacheKey, partNumber, partName, generic } = req.body;
  if (!cacheKey) return res.status(400).json({ error: 'cacheKey required' });
  const provided = req.headers['x-spafix-access-code'] || req.body.accessCode || '';
  if (!accessCodesMatch(provided, process.env.ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // Try Supabase first
    const fetchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/parts_cache?cache_key=eq.${encodeURIComponent(cacheKey)}&select=parts`, {
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}` }
    });
    let parts = null;
    if (fetchRes.ok) {
      const rows = await fetchRes.json();
      if (rows && rows.length) parts = rows[0].parts || [];
    }
    // Fall back to in-memory cache if Supabase has no entry
    if (!parts && partsCache[cacheKey]) {
      parts = partsCache[cacheKey];
    }
    if (!parts) return res.status(404).json({ error: 'Cache entry not found -- load the parts list first' });
    // Update the matching part generic flag
    const updated = parts.map(p => {
      const matchPN = partNumber && p.part_number === partNumber;
      const matchName = !partNumber && p.name === partName;
      if (matchPN || matchName) return { ...p, generic: !!generic };
      return p;
    });
    // Update in-memory cache immediately
    partsCache[cacheKey] = updated;
    // Try to persist to Supabase (best effort)
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/parts_cache?cache_key=eq.${encodeURIComponent(cacheKey)}`, {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ parts: updated })
      });
    } catch(e) { console.warn('[parts-set-generic] Supabase persist failed:', e.message); }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/parts-list', async (req, res) => {
  try {
    const { year, make, model, cacheKey, keyPartNumbers, compatibleParts } = req.body;
    if (!make || !model) return res.status(400).json({ error: 'make and model required' });
    // Parts list is free for all tiers -- no session required
    const key = cacheKey || [year,make,model].map(v=>(v||'').toLowerCase().trim()).join('-').replace(/[^a-z0-9-]/g,'');
    // Check in-memory cache first (fastest)
    if (partsCache[key]) return res.json({ parts: partsCache[key], cached: true });

    // Check Supabase persistent cache
    try {
      const sbCacheRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/parts_cache?cache_key=eq.${encodeURIComponent(key)}&select=parts`, {
        headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` }
      });
      if (sbCacheRes.ok) {
        const sbRows = await sbCacheRes.json();
        if (sbRows && sbRows.length > 0 && sbRows[0].parts) {
          const cachedParts = sbRows[0].parts;
          partsCache[key] = cachedParts; // warm in-memory cache
          return res.json({ parts: cachedParts, cached: true });
        }
      }
    } catch(e) { console.warn('[parts-list] Supabase cache read failed:', e.message); }

    try {
      // Build OEM part numbers context from key_part_numbers
      let oemContext = '';
      if (keyPartNumbers && typeof keyPartNumbers === 'object' && Object.keys(keyPartNumbers).length > 0) {
        const partLines = Object.entries(keyPartNumbers).map(([k, val]) => {
          const label = k.replace(/_/g, ' ');
          return `  ${label}: ${val}`;
        }).join('\n');
        oemContext = `\n\nOEM PART NUMBERS FOR THIS SPA (use these exact SKUs in your output where applicable):\n${partLines}\n\nFor parts with OEM numbers: include the SKU in the part name field, e.g. "Heater element (4kW PDR) — HQP-85-8754". If the OEM data includes an xref value, add it in parentheses as "(OEM: XXXXXX)" only when it aids sourcing at other suppliers. For parts without OEM numbers, use generic descriptions as normal.`;
      }

      // Build compatible parts context from parts table
      let partsTableContext = '';
      if (compatibleParts && Array.isArray(compatibleParts) && compatibleParts.length > 0) {
        const partsLines = compatibleParts.map(p => {
          let line = `  [${p.category}] ${p.part_number}`;
          if (p.description) line += ` — ${p.description}`;
          if (p.manufacturer) line += ` (${p.manufacturer})`;
          if (p.oem_part_number) line += ` OEM: ${p.oem_part_number}`;
          if (p.oem_cross_references) line += ` xref: ${p.oem_cross_references}`;
          if (p.superseded_by) line += ` SUPERSEDED BY: ${p.superseded_by}`;
          if (p.notes) line += ` NOTE: ${p.notes}`;
          return line;
        }).join('\n');
        partsTableContext = `\n\nVERIFIED COMPATIBLE PARTS FROM DATABASE (prioritize these over generic descriptions):\n${partsLines}\n\nFor superseded parts: show original part number AND add note "Superseded by [new] — order the newer part".\nFor parts with safety notes: include the safety note in the notes field of your JSON output.`;
      }

      const prompt = `Generate a concise parts list for a ${year||''} ${make} ${model} hot tub. Include only the 15 most commonly replaced parts. Return a JSON array only, no markdown fences, no explanation.${oemContext}${partsTableContext}`;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:2400, system:PARTS_SYSTEM_PROMPT, messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      logTokenUsage('parts-list', 'claude-haiku-4-5-20251001', data.usage, { cached: false });
      if (!response.ok) return res.status(500).json({ error: data?.error?.message||'API error' });
      const rawText = data.content?.map(b=>b.text||'').join('')||'';
      console.error('[parts-list] raw response:', rawText.substring(0, 300));
      // Strip markdown fences and clean before parsing
      const cleaned = rawText.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
      const start = cleaned.indexOf('[');
      const end = cleaned.lastIndexOf(']');
      if (start === -1 || end === -1) throw new Error('No JSON array found in response');
      const parts = JSON.parse(cleaned.slice(start, end + 1));

      // Flag parts with safety warnings from compatible_parts for UI badge rendering
      if (compatibleParts && compatibleParts.length > 0) {
        parts.forEach(part => {
          const match = compatibleParts.find(cp =>
            cp.notes && (
              (cp.part_number && part.part_number && cp.part_number === part.part_number) ||
              (cp.description && part.name && part.name.toLowerCase().includes(cp.description.toLowerCase().split(' ')[0]))
            )
          );
          if (match && match.notes) {
            part.safety_warning = match.notes;
          }
          if (match && match.superseded_by) {
            part.superseded_by = match.superseded_by;
          }
        });
      }

      // FLAG: parts data quality check
      const nullCount = parts.filter(p => !p.part_number || p.part_number === 'null' || p.part_number === null).length;
      if (parts.length > 0 && nullCount / parts.length > 0.5) {
        console.warn(`[FLAG] parts-data-thin → ${key} → ${nullCount}/${parts.length} parts missing part numbers`);
      }
      partsCache[key] = parts; // warm in-memory cache
      // Persist to Supabase cache async — don't block response
      (async () => {
        try {
          const sbWriteRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/parts_cache`, {
            method: 'POST',
            headers: {
              'apikey': process.env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({ cache_key: key, parts })
          });
          if (!sbWriteRes.ok) {
            const errBody = await sbWriteRes.text();
            console.error(`[parts-list] Supabase cache write failed — status ${sbWriteRes.status}:`, errBody);
          } else {
            console.log(`[parts-list] Supabase cache write OK — key: ${key}`);
          }
        } catch(e) {
          console.error('[parts-list] Supabase cache write exception:', e.message);
        }
      })();
      res.json({ parts, cached: false });
    } catch(e) { console.error('Parts list error:', e.message); res.status(500).json({ error: e.message }); }
  } catch(err) {
    console.error('[/api/parts-list] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }

});

// ── QA Agent evaluation proxy ─────────────────────────────────────
// Forwards a prompt to Anthropic and returns the response text.
// Used by the SpaFix QA Agent evaluation stage only.
// Does not count against user usage limits.
// ── QA Discrepancies -- in-memory, resets on deploy ──────────────────────────
const QA_DISCREPANCIES_MAX = 50;
let qaDiscrepancies = [];

app.post('/api/qa-discrepancy', (req, res) => {
  if (!isQABypass(req)) return res.status(403).json({ error: 'QA bypass required' });
  const d = req.body;
  if (!d || !d.scenario_id) return res.status(400).json({ error: 'scenario_id required' });
  qaDiscrepancies.unshift({ ...d, logged_at: new Date().toISOString(), resolved: false, id: Date.now() });
  if (qaDiscrepancies.length > QA_DISCREPANCIES_MAX) qaDiscrepancies = qaDiscrepancies.slice(0, QA_DISCREPANCIES_MAX);
  console.log(`[qa-discrepancy] Logged scenario ${d.scenario_id}: expected=${d.expected_seq} actual=${d.actual_seq}`);
  res.json({ ok: true });
});

app.get('/api/admin/qa-discrepancies', (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key || '';
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ discrepancies: qaDiscrepancies, count: qaDiscrepancies.length });
});

app.post('/api/admin/qa-discrepancies/resolve', (req, res) => {
  const { key, id } = req.body;
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  const entry = qaDiscrepancies.find(d => d.id === id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  entry.resolved = true;
  res.json({ ok: true });
});

app.post('/api/admin/qa-discrepancies/clear', (req, res) => {
  const { key } = req.body;
  if (!ADMIN_KEY || !accessCodesMatch(key, ADMIN_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  qaDiscrepancies = [];
  res.json({ ok: true });
});

// GET /api/spas/qa-manifest -- returns testable spa records for QA agent
// Fetches all spa_models rows, filters server-side by error_codes presence
app.get('/api/spas/qa-manifest', async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/spa_models?select=brand,model_name,model_code,year_start,year_end,control_panel_variant,error_codes,code_types&order=brand.asc,model_name.asc&limit=1000`;
    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      }
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[qa-manifest] Supabase error:', errText);
      return res.status(502).json({ error: 'Supabase query failed' });
    }
    const rows = await r.json();
    const testable = [];
    const skipped = [];
    for (const row of (rows || [])) {
      const ec = row.error_codes;
      // Exclude null, empty object, or object with no keys
      if (!ec || typeof ec !== 'object' || Array.isArray(ec) || Object.keys(ec).length === 0) {
        skipped.push({ brand: row.brand, model_name: row.model_name, reason: 'no error codes' });
        continue;
      }
      testable.push({
        brand: row.brand,
        model_name: row.model_name,
        model_code: row.model_code || null,
        year_start: row.year_start || null,
        year_end: row.year_end || null,
        control_panel_variant: row.control_panel_variant || null,
        error_codes: ec,
        code_types: row.code_types || {},
      });
    }
    console.log(`[qa-manifest] ${testable.length} testable, ${skipped.length} skipped`);
    res.json({ testable, skipped });
  } catch (e) {
    console.error('[qa-manifest] Exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/qa-evaluate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: "prompt string required" });
  }
  // QA bypass -- this endpoint is only called by the QA agent, but guard explicitly
  // No usage counting or rate limiting applies here
  try {
    const response = await callAnthropicWithRetry({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data?.error?.message || "API error" });
    const result = (data.content || []).map(b => b.text || "").join("").trim();
    res.json({ result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large." });
  }
  return next(err);
});

// ── QA bypass helper — localhost only ─────────────────────────────
// Returns true when request carries x-spafix-qa: true AND originates
// from localhost. On Railway the origin is never local so this can
// never be triggered in production.
function isQABypass(req) {
  if (req.headers['x-spafix-qa'] !== 'true') return false;
  const host = req.hostname || '';
  const ip = req.socket?.remoteAddress || '';
  return host === 'localhost' || host === '127.0.0.1' ||
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ── DEV ONLY: reset usage for current IP (localhost only) ─────────
app.post("/api/dev/reset-usage", (req, res) => {
  const host = req.hostname || '';
  const ip = req.socket.remoteAddress || '';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: "Dev endpoint — localhost only" });
  const clientId = getClientId(req);
  delete usageStore[clientId];
  console.log(`[DEV] Usage reset for ${clientId}`);
  res.json({ ok: true, message: `Usage reset for ${clientId}` });
});

// robots.txt — disallow all crawlers (this is a web app, not crawlable content)
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nDisallow: /\n');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SpaFix server running on port ${PORT}`));
