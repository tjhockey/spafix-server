// SpaFix Server v4.9.15bm — hasDiagState fix, hasSpaConfirmed broadened, spaPrefix preserved, char limit 300
require('dotenv').config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

let cachedEnvLoadState = null;

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
  "https://spafix.app",
  "https://www.spafix.app",
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
      {label:'Cloudy / Foamy', outcome:'action', action:'water_cloudy'},
      {label:'Visibly dirty', outcome:'action', action:'water_dirty'},
    ]
  },
  S2b: { id:'S2b', next:'S1', label:'Water level',
    question:'Does the water cover the skimmer opening by at least an inch?',
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
    question:'With the filters still out, run the spa. What do you feel at the filter inlet?',
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
      {label:'Error still showing', outcome:'neutral'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S5: { id:'S5', next:'BREAKER', label:'Heater indicator',
    question:'Set the target temp above the current water temp. Do you see a heating indicator — a light, flame icon, or the word Heat — on the topside panel?',
    buttons:[
      {label:'Yes, I see it', outcome:'pass'},
      {label:'No indicator showing', outcome:'action', action:'heater_no_indicator'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  BREAKER: { id:'BREAKER', next:'S6', label:'Breaker reset',
    fire:'F:BR',
    question:'',
    buttons:[
      {label:'Error cleared', outcome:'pass'},
      {label:'Error still showing', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S6: { id:'S6', next:'S6b', label:'Gate valves',
    bayStep:true,
    question:'Some spa manufacturers use gate valves — also called slice valves or isolation valves — and they\'re sometimes added as aftermarket upgrades. If your spa was working fine and recently developed issues, it\'s unlikely one of these has closed on its own. If you\'re troubleshooting a spa that\'s been sitting idle, it\'s worth checking your manual and taking a peek in the equipment bay.',
    buttons:[
      {label:'All fully open', outcome:'pass'},
      {label:'Found one closed', outcome:'action', action:'valve_closed'},
      {label:"My spa doesn't have these", outcome:'skip'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S6b: { id:'S6b', next:'S7', label:'Air purge valve',
    bayStep:true,
    question:'Some spas have an air purge valve on the pump or plumbing — it looks like a small bleed valve or knurled cap. Not all spas have one. If yours has one and you see air bubbling out when you open it, keep it open until only water flows, then close it.',
    buttons:[
      {label:'Error cleared', outcome:'pass'},
      {label:'Still showing / No valve', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S7: { id:'S7', next:'S8a', label:'Air lock phase 2',
    fire:'F:AP',
    bayStep:true,
    question:'',
    buttons:[
      {label:'Error cleared', outcome:'pass'},
      {label:'Still showing', outcome:'neutral'},
      {label:'Skip Step', outcome:'skip'},
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
      {label:'Leaking', outcome:'fail', part:'circ pump seal'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S8b: { id:'S8b', next:'S8c', label:'Flow switch visual',
    bayStep:true,
    question:"You've already located the flow switch — now let's test it more closely. The circ pump pushes water through the heater and then to the flow switch/sensor downstream. The sensor must detect sufficient flow to function properly — if flow is insufficient, the circuit won't close and the spa fails. You should be able to visually see the paddle of the flow sensor making contact with the post. Sometimes these sensors fail even when making contact.",
    buttons:[
      {label:'Paddle moves freely, making contact', outcome:'pass'},
      {label:'Paddle stuck or not making contact', outcome:'fail', part:'flow switch'},
      {label:'Arrow pointing wrong way', outcome:'fail', part:'flow switch'},
      {label:"Can't find it", outcome:'action', action:'cant_find_flow_switch'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S8c: { id:'S8c', next:'S9', label:'Flow switch jumper',
    fire:'F:FJ',
    bayStep:true,
    question:'We\'re going to temporarily bypass the flow switch to test if it\'s the cause. With power OFF, photograph your wire connections, disconnect the flow switch wires, and bridge the two terminals with a small wire or jumper. Restore power and check if the error clears.',
    buttons:[
      {label:"Error cleared — it's the flow switch", outcome:'fail', part:'flow switch'},
      {label:'Error still showing', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S9: { id:'S9', next:'S10', label:'Visual inspection',
    bayStep:true,
    question:'Using a flashlight, inspect the entire equipment bay. Look for burn marks, scorched wires, corrosion, or anything that looks out of place. Pay close attention to the control board — look for any black or brown spots or char marks around the connectors.',
    buttons:[
      {label:'Everything looks clean', outcome:'pass'},
      {label:'Found burn marks or corrosion', outcome:'fail', part:'control board'},
      {label:'Found something unusual', outcome:'action', action:'unusual_finding'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S10: { id:'S10', next:'S11', label:'Fuses',
    bayStep:true,
    question:'Check all fuses in the equipment bay — look at both the housing and the filament inside. A blown fuse is a symptom, not a root cause — we\'ll need to find what caused it.',
    buttons:[
      {label:'All fuses intact', outcome:'pass'},
      {label:'Found a blown fuse', outcome:'possible', part:'fuse kit'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S11: { id:'S11', next:'S12', label:'Temp sensor',
    question:'Compare the water temperature shown on your topside panel against how the water actually feels. A significant difference can indicate a faulty temp sensor.',
    buttons:[
      {label:'Readings match', outcome:'pass'},
      {label:'Big difference between display and actual', outcome:'fail', part:'temp sensor'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S12: { id:'S12', next:'S13', label:'Hi-limit sensor',
    question:"Find the hi-limit sensor and check for a small reset button — press it if present. The hi-limit cuts power to the heater if water gets too hot. Check if your water feels dangerously hot.",
    buttons:[
      {label:'Reset button found and pressed / No button', outcome:'pass'},
      {label:'Water feels dangerously hot', outcome:'fail', part:'hi-limit sensor', critical:true},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  S13: { id:'S13', next:'S14', label:'Heater element',
    question:'Do you have a multimeter?',
    buttons:[
      {label:'Yes, I have one', outcome:'action', action:'multimeter_test'},
      {label:"No, I don't", outcome:'action', action:'visual_element_check'},
      {label:"I'd like one", outcome:'action', action:'suggest_multimeter'},
      {label:'Skip Step', outcome:'skip'},
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
      {label:'Cloudy / Foamy', outcome:'action', action:'water_cloudy'},
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
    question:'Check your topside control panel. Is the spa set to Standard or Ready mode?',
    buttons:[
      {label:'Standard / Ready mode', outcome:'pass'},
      {label:'Economy / Sleep / Rest mode', outcome:'action', action:'heat_mode_wrong'},
      {label:"I'm not sure", outcome:'action', action:'heat_mode_unsure'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H3: { id:'H3', next:'H4', label:'Suction test',
    question:'With the filters still out, run the spa. What do you feel at the filter inlet?',
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
      {label:'Still not heating', outcome:'neutral'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  HBREAKER: { id:'HBREAKER', next:'H6', label:'Breaker reset',
    fire:'F:BR',
    question:'',
    buttons:[
      {label:'Spa is now heating', outcome:'pass'},
      {label:'Still not heating', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H6: { id:'H6', next:'H6b', label:'Gate valves',
    bayStep:true,
    question:'Check the gate valves (also called slice or isolation valves) on either side of the heater pack — they must be fully open. A partially closed valve restricts water flow and prevents the heater from firing. Pull each valve fully out and confirm it locks open.',
    buttons:[
      {label:'All fully open', outcome:'pass'},
      {label:'Found one closed or partially closed', outcome:'action', action:'valve_closed'},
      {label:"My spa doesn't have these", outcome:'skip'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H6b: { id:'H6b', next:'H7', label:'Air purge valve',
    bayStep:true,
    question:'Some spas have an air purge valve on the pump or plumbing — a small bleed valve or knurled cap. If yours has one and you see air bubbling out when you open it, keep it open until only water flows, then close it.',
    buttons:[
      {label:'Spa is now heating', outcome:'pass'},
      {label:'Still not heating / No valve', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H7: { id:'H7', next:'H8a', label:'Air lock phase 2',
    fire:'F:AP',
    bayStep:true,
    question:'',
    buttons:[
      {label:'Spa is now heating', outcome:'pass'},
      {label:'Still not heating', outcome:'neutral'},
      {label:'Skip Step', outcome:'skip'},
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
      {label:'Leaking', outcome:'fail', part:'circ pump seal'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H11: { id:'H11', next:'H12', label:'Temp sensor',
    question:'Compare the water temperature shown on your topside panel against how the water actually feels. A faulty or miscalibrated temp sensor can convince the control board the water is already at target temperature — causing the heater to never fire.',
    buttons:[
      {label:'Readings match', outcome:'pass'},
      {label:'Panel reads higher than actual', outcome:'fail', part:'temp sensor'},
      {label:'Big difference either way', outcome:'fail', part:'temp sensor'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H12: { id:'H12', next:'H13', label:'Hi-limit sensor / reset',
    bayStep:true,
    question:'The hi-limit sensor cuts power to the heater if it detects overheating — even a false reading will prevent heating. Look on the heater assembly or control box for a small reset button (sometimes red or white). Press it firmly if present. Also check if the water feels dangerously hot.',
    buttons:[
      {label:'Reset button found and pressed', outcome:'action', action:'heat_hilimit_reset'},
      {label:'No reset button found', outcome:'pass'},
      {label:'Water feels dangerously hot', outcome:'fail', part:'hi-limit sensor', critical:true},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H13: { id:'H13', next:'H9', label:'Heater element',
    question:'Do you have a multimeter?',
    buttons:[
      {label:'Yes, I have one', outcome:'action', action:'heat_multimeter_test'},
      {label:"No, I don't", outcome:'action', action:'heat_visual_element_check'},
      {label:"I'd like one", outcome:'action', action:'suggest_multimeter'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H9: { id:'H9', next:'H10', label:'Visual inspection',
    bayStep:true,
    question:'Using a flashlight, inspect the heater assembly and the full equipment bay. Look for burn marks, scorched wires, corrosion, or charred solder joints on the control board. Pay close attention to the heater terminal block and the wires connecting the board to the heater element.',
    buttons:[
      {label:'Everything looks clean', outcome:'pass'},
      {label:'Found burn marks on heater', outcome:'fail', part:'heater element'},
      {label:'Found burn marks on control board', outcome:'fail', part:'control board'},
      {label:'Found something unusual', outcome:'action', action:'unusual_finding'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  H10: { id:'H10', next:'H14', label:'Fuses',
    bayStep:true,
    question:'Check all fuses in the equipment bay — look at both the housing and the filament inside. A blown fuse is a symptom, not the root cause — we\'ll need to understand what caused it.',
    buttons:[
      {label:'All fuses intact', outcome:'pass'},
      {label:'Found a blown fuse', outcome:'possible', part:'fuse kit'},
      {label:'Skip Step', outcome:'skip'},
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
      {label:'Cloudy / Foamy', outcome:'action', action:'water_cloudy'},
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
      {label:'Jets are open but still no pressure', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  J_DV: { id:'J_DV', next:'J4', label:'Diverter valves',
    question:'Large topside diverter valves route water between different seats or zones. If a diverter valve is centered or broken internally, it can starve an entire section of jets. Turn each diverter valve fully from one side to the other — make sure none are stuck in a middle position.',
    buttons:[
      {label:'All diverters move freely', outcome:'pass'},
      {label:'Found a stuck valve — now fixed!', outcome:'action', action:'jets_diverter_fixed'},
      {label:'Valves move but still no pressure', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  J4: { id:'J4', next:'J_SS', label:'Air lock purge',
    fire:'F:AP',
    question:'',
    buttons:[
      {label:'Jets are working now!', outcome:'action', action:'jets_airlock_cleared'},
      {label:'Still no jets', outcome:'neutral'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  J_SS: { id:'J_SS', next:'J10', label:'Sound signature',
    question:'Press the Jets button. What do you hear?',
    buttons:[
      {label:'Complete silence — nothing happens', outcome:'action', action:'jets_sound_silent'},
      {label:'Loud hum but jets don\'t spin up', outcome:'action', action:'jets_sound_hum'},
      {label:'Screech or squeal when running', outcome:'action', action:'jets_sound_squeal'},
      {label:'Runs normally but weak pressure', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  J10: { id:'J10', next:'J_SH', label:'Fuses',
    bayStep:true,
    question:'Most control packs have dedicated fuses for each pump. Turn off the breaker, locate the fuse panel inside the equipment bay, and check the fuse for the corresponding jet pump. Look at both the housing and the filament inside — a blown fuse is a symptom, not the root cause.',
    buttons:[
      {label:'All fuses intact', outcome:'pass'},
      {label:'Found a blown fuse', outcome:'possible', part:'fuse kit'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  J_SH: { id:'J_SH', next:'J_VT', label:'Shaft & impeller check',
    bayStep:true,
    question:'Debris like stones, hairbands, or broken filter pieces can physically jam the pump impeller. With power completely OFF, locate the back of the jet pump motor — many have a slot on the rear shaft where you can insert a flathead screwdriver. Try to manually turn the shaft.',
    buttons:[
      {label:'Shaft turns freely', outcome:'pass'},
      {label:'Shaft is locked solid', outcome:'action', action:'jets_shaft_locked'},
      {label:'Can\'t access the shaft', outcome:'skip'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  J_VT: { id:'J_VT', next:'J9', label:'Voltage test',
    bayStep:true,
    question:'Do you have a multimeter?',
    buttons:[
      {label:'Yes, I have one', outcome:'action', action:'jets_voltage_test'},
      {label:"No, I don't", outcome:'action', action:'jets_no_multimeter'},
      {label:"I'd like one", outcome:'action', action:'suggest_multimeter'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  J9: { id:'J9', next:'J13', label:'Visual inspection',
    bayStep:true,
    question:'Using a flashlight, inspect the jet pump and the full equipment bay. Look for burn marks, scorched wires, melted insulation, or corrosion. Check the wiring harness running to the pump — look for any discoloration or damage near the terminals.',
    buttons:[
      {label:'Everything looks clean', outcome:'pass'},
      {label:'Found burn marks on pump wiring', outcome:'fail', part:'jet pump'},
      {label:'Found burn marks on control board', outcome:'fail', part:'control board'},
      {label:'Found something unusual', outcome:'action', action:'unusual_finding'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  J13: { id:'J13', next:'J14', label:'Jet pump',
    bayStep:true,
    question:'Based on everything we\'ve checked, the jet pump itself is the likely cause. Before ordering, confirm the pump model number from the label on the pump housing. Also check the wiring harness for any damage — a new pump with damaged wiring will fail immediately.',
    buttons:[
      {label:'Show me jet pump options', outcome:'fail', part:'jet pump'},
      {label:'I need help identifying my pump', outcome:'action', action:'identify_pump'},
      {label:'Skip Step', outcome:'skip'},
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
      {label:'Noise stopped — spa confirmed', outcome:'pass'},
      {label:'Still noisy — external source', outcome:'action', action:'noise_external_end'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  N_TYPE: { id:'N_TYPE', next:'N_PNL', label:'Sound type',
    question:'What does the noise sound like?',
    buttons:[
      {label:'Grinding or screeching', outcome:'action', action:'noise_grinding'},
      {label:'Loud humming', outcome:'action', action:'noise_humming'},
      {label:'Rattling or vibrating', outcome:'pass'},
      {label:'Gurgling or popping', outcome:'pass'},
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
      {label:'No — still noisy', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  N_BAY: { id:'N_BAY', next:'N_TEMP', label:'Equipment bay visual',
    bayStep:true,
    question:'Open the equipment bay and scan inside without touching anything. Look for dripping water near pump seals, white scale or green corrosion around the pump shaft, and loose hose clamps.',
    buttons:[
      {label:'Dripping or scale around shaft seal', outcome:'fail', part:'circ pump seal'},
      {label:'Everything looks dry and normal', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  N_TEMP: { id:'N_TEMP', next:'N_IMP', label:'Motor temperature',
    bayStep:true,
    question:'Carefully hold your hand near (not touching) the motor casing. Does it feel abnormally hot?',
    buttons:[
      {label:'Abnormally hot — very hot to the touch', outcome:'fail', part:'circulation pump'},
      {label:'Warm but normal', outcome:'pass'},
      {label:'Cool / room temperature', outcome:'pass'},
      {label:'Skip Step', outcome:'skip'},
    ]
  },
  N_IMP: { id:'N_IMP', next:'N_BEEP', label:'Impeller check',
    bayStep:true,
    question:'With power OFF and slice valves closed, carefully open just the face of the pump union — enough to look inside. Do you see any debris in the impeller?',
    buttons:[
      {label:'Found debris — cleared it out', outcome:'action', action:'noise_impeller_cleared'},
      {label:'No debris visible', outcome:'pass'},
      {label:"Can't access safely", outcome:'skip'},
      {label:'Skip Step', outcome:'skip'},
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
      {label:'No — not tested yet', outcome:'action', action:'water_test_guide'},
      {label:'Skip Step', outcome:'skip'},
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

function validateErrorCode(code, spaMake) {
  if (!code || !spaMake) return { valid: true };
  const brand = Object.keys(KNOWN_ERROR_CODES).find(b => spaMake.toLowerCase().includes(b.toLowerCase()));
  if (!brand) return { valid: true };
  const known = KNOWN_ERROR_CODES[brand];
  const upper = code.toUpperCase();
  if (known.map(k => k.toUpperCase()).includes(upper)) return { valid: true, code: upper };
  return { valid: false, code: upper, brand };
}

// ── Brand normalization — pure JS, zero AI cost ───────────────────
const KNOWN_BRANDS = ['Sundance','Jacuzzi','Hot Spring','Caldera','Dimension One','Bullfrog','Master Spas','Marquis','Arctic Spas','Hydropool','Beachcomber','Coast Spas','Cal Spa','Balboa','Tiger River','Watkins'];
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
The system may prepend a [DS] block to your context. It is READ-ONLY session state — never reproduce it, never output it, never reference its format. Treat it as invisible internal data.

=SPA GATE=
Ask for details before diagnosing but never block. Skip gate when: [CP:] [SL:] [SD] or spa in history.
Request phrase (exact): "To troubleshoot your spa accurately, it would be really helpful to have your spa details and what you've already tried. Please enter that information below." Never output template fields.

=HOWTO=
General how-to Q → answer directly, no gate.

=SPA CONFIRM=
"My spa is a [Y M Mo]": vary opener (Got it/Perfect/Understood/Thanks/Good to know).
[MF] → 1 sentence only: "Perfect — you have a **[Y M Mo]** and I have detailed specs on file."
[MNF] → "Got it — you have a **[Y M Mo]**." Proceed. No re-ask.
Already tried X → mark ✅, skip to next. Error code in issue → skip asking, start S1.

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
ABSOLUTE HARD LIMITS — never under any circumstances:
- Never loosen or suggest loosening union fittings
- Never lower or suggest lowering the water level
- Never instruct 240V/GFCI/gas/structural work
- Never output raw URLs or markdown links
- Never output <br> tags`;

const SP_PERSONALITY = `=STYLE=
Never dismiss answers. No resets. One Q, wait, move on. Don't restate what user said. No "usually/typically/often/probably/might." Never suggest calling tech for standard repairs.`;

const SP_DIAG_FLOW = `=DIAG RULES=
DEFAULT: output the step question verbatim — nothing else. No tips, no context, no pricing.
1. =STEP= block is your ONLY task. Execute it exactly as written.
2. ONE question per response. Never stack.
3. Never jump ahead. Never reference future steps.
4. Never revisit completed steps — they are in the DS block.
5. Signal [A:Sx] the moment user's answer clears the step. [SK:Sx] if they skip.
6. Never suggest control board until S14 is current step.
7. Never loosen unions. Never lower water level. Absolute — not situational.
8. Off-topic Q mid-diagnosis: one sentence answer, then redirect to current step question.
Signals: advance=[A:Sx] skip=[SK:Sx] fire=[F:XX]`;

const SP_BAY_RULES = `=BAY POWER=
Power warning FIRST before any bay instruction. If prev step had power ON → explicitly say OFF before entering.
CIRC PUMP ONLY: power stays ON to observe/touch pump housing. Never near wires/terminals.
ALL OTHER BAY STEPS: "Turn off dedicated circuit breaker — not topside panel."
Use flashlight always.
BURNS: dark spot=burn until proven otherwise. Wipe test (power OFF): black=burn→check wires→>>PT. Confirmed burn: inspect board back. Discolored wires near burn = harness damaged — new board + damaged harness = dead new board.`;

const SP_PART_FLOW = `=PART FLOW=
Part before diagnosis confirmed → 1 sentence (part+symptom) + 2 buttons. No bullets, no links yet.
Heater element NOT most common — filter/airlock/flow switch/circ pump are. Never say "most common" unless true.
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
HARD LIMITS (never guide): 240V wiring, GFCI install/repair, gas, structural. Say: "⚠️ [hazard] — beyond DIY scope, can cause serious injury or death."
Before risky steps: "⚠️ Before we continue — [specific risk]. Comfortable and have right tools?" >>BTN\nYes, I'm ready | I'm not sure | Skip this step\n<<BTN
"I'm not sure"/"Skip" → halt, mark NOT CHECKED.
Hi-limit overheating fail → ⚠️ cut power NOW, do not use spa.`;

const SP_INSTALL = `=INSTALL=
Bulleted sections: Before you start / Removal / Installation / Before you test / Test. Never prose.
Whole unit only. No soldering.
"Before you test": part-specific post-install issues (flow switch→airlock, heater→must be flooded, board→all connectors seated).
End: "If you'd like, I can walk through this step by step — just let me know."
Board: photos FIRST (wide + every connector + jumper settings). Pull connectors by housing. Must be programmed — check addendum flyers.
Hose tip: "Stiff? Hair dryer 30-60s." While disconnected: inspect hose+clamps.`;

const SP_GUIDE_CONTEXT = `=GUIDE ENTRY= ([From guide: X])
1 brief sentence ack guide → ask what they need. Nothing else.
Spa confirmed → no re-ask. Spa unknown → ack guide, ask for spa details.
NEVER: diag summary, step list, >>PT, infer steps, shopping language.
Fresh opener — ignore any active diagnosing trail.`;

const SP_BRAND_CONTEXT = `=BRANDS=
GECKO M-CLASS (Arctic Spas, Marquis/SSPA/MTS): flow error=3 FLASHING DOTS. "Dots with pump running or silent?" Running=pressure switch adjust. Silent=replace.
HOT SPRING/TIGER RIVER: flow error=blinking Power/Ready lights. Ask about light pattern, not code.
ALL OTHERS: standard text codes (FL1/FL2/FLO/FLOW).
Accept any code user reports. Unrecognized: "Not familiar with [code] for [brand] — did you mean [closest]?"
Auto-correct typos. Emit >>COR. Confirm: "Got it — **[corrected]**."`;

const SP_MISC = `=MISC=
SHOP BTN ("I need help finding parts/water care/Can you help me find") → 1-sentence intro + >>PT. No Q first.
SHOW PICTURE → part search links + "These show what [part] looks like — not suggesting purchase."
FIX DIDN'T WORK → never restart. Next suspect. "Sorry [part] didn't fix it — let's figure out what else is going on."
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
The user is in free-text "Other" diagnostic mode — their issue doesn't fit the standard flow/heat/jets/noise/water sequences.
Your job: attempt a genuine, specific diagnosis based on what they describe. Use your knowledge of hot tub components for their specific spa model.
Rules:
- Stay grounded in what the spa can actually do — never fabricate component behavior or specs
- If uncertain about a specific behavior for this spa model, say so explicitly before advising
- Work through possibilities systematically: cheapest/easiest causes first, expensive components last
- Never suggest calling a technician
- When you have truly exhausted all remote diagnostic options or find yourself repeating the same advice, append [DIAG_END] on its own line at the very end of your response — not before, not on first response`;

function buildSystemPrompt(context = {}) {
  const { hasDiagState, isGuideEntry, hasSpaConfirmed, hasPartRequest, isEquipmentBayStep, hasInstallRequest, isFirstMessage, stepContext, isOtherFreeText, otherHint } = context;
  const modules = [SP_CORE];
  if (isFirstMessage || !hasSpaConfirmed) modules.push(SP_PERSONALITY);
  if (hasDiagState || hasSpaConfirmed) modules.push(SP_DIAG_FLOW);
  if (isEquipmentBayStep) modules.push(SP_BAY_RULES);
  if (hasPartRequest || hasDiagState) modules.push(SP_PART_FLOW);
  modules.push(SP_SAFETY);
  if (hasInstallRequest) modules.push(SP_INSTALL);
  if (isGuideEntry) modules.push(SP_GUIDE_CONTEXT);
  if (hasSpaConfirmed || hasDiagState) modules.push(SP_BRAND_CONTEXT);
  if (!hasDiagState && !isOtherFreeText) modules.push(SP_MISC);
  if (isOtherFreeText) {
    modules.push(SP_OTHER_FREETEXT);
    if (otherHint) modules.push(`[HINT: User's issue may relate to "${otherHint}" — use this as a starting point but don't assume]`);
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
  return { hasDiagState, isGuideEntry, hasSpaConfirmed, hasPartRequest, isEquipmentBayStep, hasInstallRequest, isFirstMessage, stepContext, isOtherFreeText, otherHint };
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
  const { year, make, model } = req.params;
  if (!year || !make || !model) return res.status(400).json({ error: "year, make, model required" });

  // Query spa_models and parts table in parallel — single round trip
  const yearNum = parseInt(year);
  const yearFilter = !isNaN(yearNum) && yearNum > 1980 ? {
    'year_start': `lte.${yearNum}`,
    'year_end': `gte.${yearNum}`,
  } : {};

  const [rows, partsRows] = await Promise.all([
    supabaseGet('spa_models', {
      'select': 'brand,model_name,year_start,year_end,control_system,common_failures,error_codes,code_types,pump_configs,verified,key_part_numbers,filter_count',
      'brand': `ilike.*${make}*`,
      'model_name': `ilike.*${model}*`,
      ...yearFilter,
      'limit': 1
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

  const profile = rows[0];
  return res.json({
    found: true,
    verified: profile.verified || false,
    make: profile.brand,
    model: profile.model_name,
    filter_count: profile.filter_count || null,
    control_system: profile.control_system || null,
    common_failures: Array.isArray(profile.common_failures)
      ? profile.common_failures.slice(0, 5).join('; ')
      : (profile.common_failures || null),
    error_codes: (() => {
      const ec = profile.error_codes;
      if (!ec) return null;
      // Plain JSON object: {"LF":"description","Pr":"description"} — extract keys as codes
      if (typeof ec === 'object' && !Array.isArray(ec)) {
        const codes = Object.keys(ec).filter(Boolean);
        return codes.length ? codes.join(', ') : null;
      }
      if (Array.isArray(ec)) {
        const mapped = ec.map(e => (typeof e === 'object' && e !== null) ? (e.code || e.name || Object.values(e)[0]) : String(e)).filter(Boolean);
        return mapped.length ? mapped.join(', ') : null;
      }
      if (typeof ec === 'string') {
        const codes = ec.split(',').map(c => c.trim()).filter(Boolean);
        const validCode = c => /^[A-Za-z0-9][A-Za-z0-9\s\-_.\/]{0,11}$/.test(c) && c.length >= 2;
        const cleaned = codes.filter(validCode);
        return cleaned.length ? cleaned.join(', ') : null;
      }
      return null;
    })(),
    error_code_descriptions: (() => {
      const ec = profile.error_codes;
      if (!ec) return null;
      if (typeof ec === 'object' && !Array.isArray(ec)) return ec;
      return null;
    })(),
    code_types: (typeof profile.code_types === 'object' && profile.code_types !== null && !Array.isArray(profile.code_types))
      ? profile.code_types
      : null,
    pump_configs: Array.isArray(profile.pump_configs)
      ? profile.pump_configs.map(p => `Pump ${p.pump_num}: ${p.hp}hp ${p.speeds}-speed`).join(', ')
      : (profile.pump_configs || null),
    key_part_numbers: profile.key_part_numbers || null,
    compatible_parts: partsRows || [],
  });
});

// ── normalize-spa: JS brand fuzzy match + Haiku for model only ────
// v4.9.14e: brand normalization moved to JS (zero AI cost for brands)
// Haiku only called when brand is known but model needs correction
app.post("/api/normalize-spa", async (req, res) => {
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
  const models = (rows || []).map(r => r.model_name).filter(Boolean).sort();
  res.json({ models });
});

app.get("/api/brands", (req, res) => {
  // Detect country from Cloudflare header first, then X-Forwarded-For fallback
  const cfCountry = req.headers['cf-ipcountry'] || '';
  const countryCode = cfCountry && cfCountry !== 'XX' ? cfCountry : 'US';
  res.json(getBrandsForCountry(countryCode));
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
async function callAnthropicWithRetry(payload, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 2000;
      console.log(`[Anthropic] 429 received, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
    // 25s server-side timeout — prevents silent hangs
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
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
  const { stepId, buttonLabel, outcome, part, action, briefMode } = req.body;
  const clientId = getClientId(req);

  // Handle initialization
  if (stepId === 'INIT') {
    const spaYear = req.body.spaYear || '';
    const spaMake = req.body.spaMake || '';
    const spaModel = req.body.spaModel || '';
    const rawErrorCode = req.body.errorCode || null;
    const errorCode = rawErrorCode ? rawErrorCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null : null;
    const topic = req.body.topic || 'flow';
    const spaLabel = [spaYear, spaMake, spaModel].filter(v => v && v !== 'Unknown').join(' ') || 'Unknown';
    const startStep = topic === 'heat' ? 'H2a' : topic === 'jets' ? 'J2a' : topic === 'noise' ? 'N_LOC' : topic === 'water' ? 'W1' : 'S2a';
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
  let advanceNow = true;

  switch(outcome) {
    case 'pass':
      stepResult.passed = true;
      // Step-specific pass messages
      const passMessages = {
        'S2a': "Good — clean water rules out a chemistry or contamination issue.",
        'S2b': "Good — water level is fine.",
        'S1': "Filters ruled out — let's keep going.",
        'S3': "Good suction confirmed — the pump is moving water.",
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
      if (!briefMode && stepId === 'S3') {
        responseMsg = "Weak or no suction at the inlet is a concern — I've flagged the suction test as a possible issue. This can be caused by trapped air in the plumbing, a struggling circulation pump, or a blockage somewhere in the system. Let's work through the most likely causes one by one.";
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
      stepResult.passed = false;
      stepResult.skipped = true;
      if (!briefMode) {
        if (stepId === 'S4' || stepId === 'H4') {
          responseMsg = "Air locks are one of the most common causes of flow and heat errors — skipping this test means we can't rule it out. I've flagged it as a possible issue. You can come back to it anytime by tapping the step in the Diagnostic Steps panel.";
        } else if (stepId === 'J4') {
          responseMsg = "Air locks are one of the most common causes of jet pressure loss — skipping this test means we can't rule it out. I've flagged it as a possible issue. You can come back to it anytime by tapping the step in the Diagnostic Steps panel.";
        } else if (stepId === 'S5') {
          responseMsg = "The heater indicator test is a quick way to confirm whether your spa's thermostat and control board are telling the heater to turn on — skipping it means we can't rule out a control issue. I've flagged it as a possible factor. You can come back to it anytime by tapping the step in the Diagnostic Steps panel.";
        } else if (stepId === 'H5') {
          responseMsg = "The mode settings check is a quick win — Economy or Sleep mode prevents heating and is easy to miss. I've flagged it as possible. You can come back anytime by tapping the step in the Diagnostic Steps panel.";
        } else if (stepId === 'J_VT') {
          responseMsg = "The voltage test is the most reliable way to determine if the issue is the pump or the control board. Without it we're making an educated guess. I've flagged it as a possible factor.";
        }
      }
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

      case 'water_cloudy':
        responseMsg = "Cloudy or foamy water needs to be addressed — running diagnostic steps that require operating without filters should only be done with clean water. We can continue testing up to that point, but we strongly recommend sorting the water first.";
        stepResult.passed = true;
        stepResult.possible = true;
        advanceNow = false;
        break;

      case 'water_dirty':
        responseMsg = "Dirty water needs to be addressed — running diagnostic steps that require operating without filters should only be done with clean water. We can continue testing up to that point, but we strongly recommend sorting the water first.";
        stepResult.passed = true;
        stepResult.possible = true;
        advanceNow = false;
        break;

      case 'show_water_treatment':
        responseMsg = "Here are some water treatment options for your spa:";
        partCard = 'water treatment';
        advanceNow = false;
        break;

      case 'view_water_guides':
        responseMsg = "Opening water care guides for you.";
        stepResult.passed = true;
        stepResult.possible = true;
        advanceNow = true;
        break;

      case 'top_up':
        responseMsg = "Top the water up to at least an inch above the skimmer opening, then continue.";
        stepResult.passed = true;
        advanceNow = true;
        break;

      case 'filter_clean':
        responseMsg = "Good — let's do a quick sanity check. Leave the filters out and run the spa. Does the error clear?";
        advanceNow = false;
        break;

      case 'filter_clean_yes':
        responseMsg = "Great news, we've found the problem. Even though they look clean, the filters seem to be restricting water flow. Please replace your filters to get your spa working properly. For your convenience, I've provided some recommendations below.\n\n⚠️ Never use your spa without filters — it can damage the pump and plumbing. Running without filters is for testing purposes only and only with clean water.";
        stepResult.passed = false;
        advanceNow = false;
        partCard = 'filter';
        break;

      case 'filter_clean_no':
        responseMsg = "Good — filters are ruled out as the cause. Let's keep going.";
        stepResult.passed = true;
        advanceNow = true;
        break;

      case 'filter_dirty':
        responseMsg = "Let's test your filters. With the filters out, run the spa. Does the error clear?";
        advanceNow = false;
        break;

      case 'filter_dirty_yes':
        responseMsg = "Perfect — we've found our culprit! If the spa runs fine without them, those filters are just a bit too restricted to let the water through. Filters are the unsung heroes of your spa, but they do need a refresh every now and then. Since yours are looking a little tired, we can either look at some heavy-duty cleaning supplies to revive them or just grab a new set so you can get back to soaking. What sounds best to you?";
        stepResult.passed = false;
        advanceNow = false;
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
        break;

      case 'filter_keep_testing':
        responseMsg = "Got it — let's keep working through the checklist.";
        stepResult.passed = false;
        advanceNow = true;
        break;

      case 'suggest_filter_cleaning':
        responseMsg = "Here are some filter cleaning products that can help restore flow:";
        partCard = 'filter cleaning';
        advanceNow = false;
        break;

      case 'suggest_filter_replace':
        responseMsg = "Here are replacement filter options for your spa:";
        partCard = 'filter';
        advanceNow = false;
        break;

      case 'stop_diagnosis':
        responseMsg = "Progress saved. Come back anytime if the issue returns or if you'd like to continue testing.";
        stepResult.passed = true;
        advanceNow = false;
        break;

      case 'cant_find_inlet':
        responseMsg = "The filter inlet is the opening where your filter(s) sit — typically a circular opening a few inches in diameter inside the filter compartment. If you don't feel any suction, make sure the spa jets are running — some spas won't draw water through the filter inlet until the jets are active. <a href=\"#\" onclick=\"openManualFinder();return false;\" style=\"color:var(--teal-light);text-decoration:underline;\">Check your manual</a> or upload a photo of the filter bay and I'll help you identify it.";
        advanceNow = false;
        break;

      case 'airlock_cleared':
        responseMsg = "Great news — it looks like an airlock was the culprit! Trapped air was blocking the water flow and triggering the error.\n\nBefore you put your clean filters back in and retest, let's make sure air doesn't get trapped again:\n\n1. Submerge each filter fully in the spa water.\n2. Gently squeeze or shake them underwater to work out any trapped air bubbles.\n3. Reinstall them immediately while keeping them submerged.\n\nThis keeps the lines clear and prevents the error from coming back!";
        stepResult.passed = true;
        advanceNow = false;
        break;

      case 'filter_confirmed':
        responseMsg = "⚠️ Never run your spa without filters during normal use — it can damage the pump and plumbing. Running without filters is for testing purposes only and only with clean water.\n\nSubmerge your filter fully until no air bubbles come out, then reinstall it immediately. Did the error return?";
        stepResult.passed = false;
        stepResult.filterIssue = true;
        advanceNow = false;
        partCard = 'filter';
        break;

      case 'valve_closed':
        responseMsg = "Open it fully counterclockwise, then check if the error clears.";
        advanceNow = false;
        break;

      case 'heater_no_indicator':
        responseMsg = "Did you set the target temp above the current water temp displayed on the panel?";
        advanceNow = false;
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
        break;

      case 'heat_visual_element_check':
        responseMsg = "Look at the heater element for any visible corrosion, burn marks, or physical damage on the element body or terminals. Also check the wires connecting the board to the element — look for any melted insulation, discoloration, or charring. What do you see?";
        advanceNow = false;
        break;

      // ── Jets actions ──────────────────────────────────────────
      case 'jets_face_fixed':
        responseMsg = !briefMode ? "Closed jet faces are a surprisingly common cause — calcium buildup and grit lock them in place over time. Give them a good clean while you have them open. If everything is working now, you're all set! Would you like to keep testing to make sure nothing else is contributing?" : null;
        stepResult.passed = true;
        advanceNow = false;
        break;

      case 'jets_diverter_fixed':
        responseMsg = !briefMode ? "A stuck diverter valve cuts off water to an entire zone of jets — easy fix once you find it. If everything is working now, you're all set! Would you like to keep testing to make sure nothing else is contributing?" : null;
        stepResult.passed = true;
        advanceNow = false;
        break;

      case 'jets_airlock_cleared':
        responseMsg = "Great news — an air lock was preventing the pump from moving water. Before you put your clean filters back in and retest, let's make sure air doesn't get trapped again:\n\n1. Submerge each filter fully in the spa water.\n2. Gently squeeze or shake them underwater to work out any trapped air bubbles.\n3. Reinstall them immediately while keeping them submerged.\n\nThis keeps the lines clear and prevents the issue from coming back!";
        stepResult.passed = true;
        advanceNow = false;
        break;

      case 'jets_sound_silent':
        responseMsg = !briefMode ? "Complete silence when pressing the Jets button usually points to one of three things: a blown fuse on the control board for that pump, a bad relay on the control board, or a completely dead motor winding. Let's check the fuses first — it's the easiest fix." : null;
        stepResult.passed = true;
        stepResult.possible = true;
        advanceNow = true;
        nextStep = 'J10';
        break;

      case 'jets_sound_hum':
        responseMsg = !briefMode ? "A loud hum without the jets spinning up means the motor is getting power but can't turn. The two most likely causes are a blown start capacitor (the motor tries to start but can't get going) or a physically seized/frozen shaft. Let's check the shaft first." : null;
        stepResult.passed = true;
        stepResult.possible = true;
        advanceNow = true;
        nextStep = 'J_SH';
        break;

      case 'jets_sound_squeal':
        responseMsg = !briefMode ? "A screech or squeal when the jets run is the sound of worn or failing motor bearings. The jets may still work for now, but the pump is on its way out — it needs a rebuild or replacement soon. I've flagged this as a likely pump issue." : null;
        stepResult.passed = true;
        stepResult.possible = true;
        advanceNow = true;
        nextStep = 'J13';
        break;

      case 'jets_shaft_locked':
        responseMsg = "A locked shaft means something is either jammed in the impeller housing or the motor bearings have seized. Do not try to force the shaft — further damage could result. This pump will need to be removed and inspected. The impeller housing can be disassembled to check for debris without replacing the full pump.";
        stepResult.passed = false;
        advanceNow = false;
        break;

      case 'jets_voltage_test':
        responseMsg = "⚠️ DANGER — 240V PRESENT. This test requires the breaker ON with live high voltage exposed inside the equipment bay. Only proceed if you are completely comfortable working around live electrical panels. NEVER touch any terminals, wires, or components other than the multimeter probes.\n\nWith the breaker ON and the Jets button pressed to High: carefully place your multimeter probes on the pump's terminal plug on the circuit board. You should read 240V (or 120V depending on your setup).\n\n- Board outputs correct voltage but pump doesn't run → the pump or its cord is the problem → proceed to pump replacement\n- Board outputs 0V when button pressed → the board relay is bad → proceed to control board";
        advanceNow = false;
        break;

      case 'jets_no_multimeter':
        responseMsg = "Without a multimeter we can't confirm whether the board is sending power. Based on everything we've tested, the most likely cause is either the jet pump itself or the control board relay. We'll check the pump wiring visually first.";
        advanceNow = true;
        break;

      case 'identify_pump':
        responseMsg = "Upload a clear photo of your pump label (Premium feature) and I'll help identify the exact model and find replacement options.";
        advanceNow = false;
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
        break;

      case 'multimeter_test':
        responseMsg = "Set your multimeter to resistance (Ω). Disconnect the heater element leads. Test across the two terminals — you should read between 8-16 Ω for a working element. Also test each terminal to ground — you should read infinite (OL). What do you get?";
        advanceNow = false;
        break;

      case 'visual_element_check':
        responseMsg = "Look at the heater element for any visible corrosion, burn marks, or damage on the element body or terminals. What do you see?";
        advanceNow = false;
        break;

      case 'suggest_multimeter':
        responseMsg = "A multimeter is a handy tool to have for spa diagnosis and general home use. Here are some options:";
        partCard = 'multimeter';
        advanceNow = false;
        break;

      case 'identify_board':
        responseMsg = "Upload a clear photo of your control board (Premium feature) and I'll help identify the exact model.";
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
        question: ns.question || '',
        fire: ns.fire ? applyFireTemplates(`[${ns.fire}]`) : null,
        buttons: ns.buttons,
        bayStep: ns.bayStep || false,
      };
    }
  }

  res.json({
    ok: true,
    diagState: getDiagState(clientId),
    responseMsg,
    partCard,
    nextStep: nextStepData,
    advanceNow,
  });
});

// ─────────────────────────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
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
    const cleanErrCode = rawErrCode ? rawErrCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null : null;
    const newState = { spa: spaLabel, errorCode: cleanErrCode, steps: [], currentStep: 'S2a', lastUpdated: Date.now() };
    setDiagState(clientId, newState);
  }

  // Re-read diagState after potential init above
  const diagStateEffective = getDiagState(clientId) || diagStateIn;

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
    const check = (isSpaForm || spaSubmitted || spaConfirmed || conversationInProgress || hasSpaContext || hasDiagState) ? { valid: true } : await isValidMessage(content);    if (!check.valid) {
      const msgs = { too_short: "Please describe your hot tub issue in a bit more detail.", too_long: "Your message is too long — please keep it under 300 characters.", off_topic: "SpaFix can only help with hot tub and spa questions. Please describe your spa issue and I'll be happy to help!" };
      return res.status(400).json({ error: msgs[check.reason] || "Please ask a spa-related question." });
    }
  }

  const promptContext = detectRequestContext(messages, diagStateEffective, req.body);
  const systemPrompt = buildSystemPrompt(promptContext);
  const hasDiagStateActive = !!(diagStateEffective && (diagStateEffective.currentStep || (diagStateEffective.steps && diagStateEffective.steps.length > 0)));
  const msgLimit = hasDiagStateActive ? 3 : 6;
  const trimmedMessages = messages.slice(-msgLimit);

  // Always inject spa identity during active diagnosis — prevents drift when messages scroll out of window
  const spaYearVal = req.body.spaYear || '';
  const spaMakeVal = req.body.spaMake || '';
  const spaModelVal = req.body.spaModel || '';
  const spaFromState = diagStateEffective?.spa;
  const spaLine = spaFromState || [spaYearVal, spaMakeVal, spaModelVal].filter(v => v && v !== 'Unknown').join(' ');

  // Error code validation — extract code from anywhere in the message
  let errorCodeNote = '';
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

  const spaPrefix = spaLine
    ? `[SPA:${spaLine}] This is the user's confirmed spa. Never ask for spa details again. Never change or hallucinate a different spa.${errorCodeNote}${errorCodeDescLine}\n\n`
    : '';

  let effectiveSystemPrompt = spaPrefix + systemPrompt;

  if (hasDiagStateActive) {
    const stateBlock = buildDiagStateBlock(diagStateEffective);
    if (stateBlock) effectiveSystemPrompt = stateBlock + '\n\n' + spaPrefix + systemPrompt;
  }

  async function callAndProcess(tier) {
    const diagTokenCap = hasDiagStateActive ? 500 : 700;
    const response = await callAnthropicWithRetry({ model: "claude-sonnet-4-6", max_tokens: diagTokenCap, system: effectiveSystemPrompt, messages: trimmedMessages });
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
    logTokenUsage('chat', 'claude-sonnet-4-6', data.usage, { tier });
    const updatedDiagState = processDiagSignals(rawReply, clientId, lastMsgContent);
    if (testerName) {
      const lm = messages[messages.length - 1];
      if (lm?.role === 'user') appendToTranscript(testerName, clientId, 'user', typeof lm.content === 'string' ? lm.content : '');
      appendToTranscript(testerName, clientId, 'assistant', reply);
    }
    return { reply, diagState: updatedDiagState || diagStateEffective || null };
  }

  if (premiumAccess) {
    try { const { reply, diagState } = await callAndProcess('admin'); res.json({ reply, diagState, usage: null }); }
    catch (err) { res.status(500).json({ error: err.message }); }
    return;
  }

  if (!isPro && !isSilent) {
    const u = getUsage(clientId);
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
    try { const { reply, diagState } = await callAndProcess('free'); res.json({ reply, diagState, usage: { dailyMsgs: u.dailyMsgs, dailyLimit: FREE_DAILY_MSG_LIMIT, weeklySessions: u.weeklySessions, weeklyLimit: FREE_WEEKLY_SESSION_LIMIT } }); }
    catch (err) { res.status(500).json({ error: err.message }); }
    return;
  }

  try { const { reply, diagState } = await callAndProcess('pro'); res.json({ reply, diagState, usage: null }); }
  catch (err) { res.status(500).json({ error: err.message }); }
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
});

app.get("/", (req, res) => res.json({ message: "SpaFix API v4 running ✓" }));

// ── PARTS LIST (cached in memory by year-make-model) ─────────────
const partsCache = {};

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

app.post('/api/parts-list', async (req, res) => {
  const { year, make, model, cacheKey, keyPartNumbers, compatibleParts } = req.body;
  if (!make || !model) return res.status(400).json({ error: 'make and model required' });
  const session = requireProSession(req, res);
  if (!session) return;
  const key = cacheKey || [year,make,model].join('-').toLowerCase().replace(/[^a-z0-9-]/g,'');
  if (partsCache[key]) return res.json({ parts: partsCache[key], cached: true });
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
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1800, system:PARTS_SYSTEM_PROMPT, messages:[{role:'user',content:prompt}] })
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

    partsCache[key] = parts;
    res.json({ parts, cached: false });
  } catch(e) { console.error('Parts list error:', e.message); res.status(500).json({ error: e.message }); }
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large." });
  }
  return next(err);
});

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
