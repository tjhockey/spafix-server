// 4.9.15f
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
  AIRLOCK_PURGE: `Step 4 — Air Lock Purge:

⚠️ Plain garden hose end only — no sprayer, nozzle, or attachment.

• With filter(s) out, perform the following steps...
• Wrap a towel around the plain hose end to seal it against the filter inlet.
• Turn the water on fully and wait until only water (no air) comes out the hose end.
• Press the hose and towel firmly over the filter inlet and force water through for 30–60 seconds.
• Air bubbling up from the jets is normal — keep going until only water flows.
• Stop and check if the error has cleared. Repeat once more if needed.`,

  BREAKER_RESET: `Before we go further — try a full breaker reset. Find the dedicated circuit breaker for your spa (not the topside panel) and flip it OFF. Wait 15 seconds, then flip it back ON.`,

  BAY_ENTRY: `Before we open the equipment bay — turn off the dedicated circuit breaker. Not the topside panel button — the breaker in your electrical panel. The topside button does not fully cut power to the components inside.`,

  CIRC_PUMP_POWER: `⚠️ Power stays ON for this step — touch the pump housing only. Keep hands completely away from all wires, terminals, and connectors.`,

  FS_JUMPER_GATE: `⚠️ Power MUST be OFF at the breaker before this step — not just the topside panel.`,
};

// ── Diagnostic step definitions — state machine ───────────────────
const DIAG_STEPS = {
  S1:      { id:'S1',      next:'S2a',    label:'Filter condition',     prompt:'Ask user to pull all filters and check for dirt, slime, or damage. Multi-filter spas: check ALL. Also check temp sensor near filter area. $25-100 to replace.' },
  S2a:     { id:'S2a',    next:'S2b',    label:'Water condition',       prompt:'Ask ONLY this one question: "Is the water foamy, cloudy, or visibly dirty?" Nothing else. Wait for answer.' },
  S2b:     { id:'S2b',    next:'S3',     label:'Water level',           prompt:'Ask ONLY this one question: "Does the water cover the skimmer opening by 1-2 inches?" If user says low → tell them to raise it and signal [ADVANCE:S2b]. Nothing else. No water chemistry questions.' },
  S3:      { id:'S3',     next:'S4',     label:'Suction test',          prompt:'Ask ONLY: "With the filters still out, run the spa. Do you feel strong suction at the filter inlet?" ONE question only. No follow-up. No additional checks. Wait for answer. If flow error clears without filter: submerge filter fully until zero bubbles, reinstall immediately — if error returns → filter is cause → >>PT. Otherwise [ADVANCE:S3].' },
  S4:      { id:'S4',     next:'S5',     label:'Air lock purge',        prompt:'Tell user to perform the air lock purge. Emit [FIRE:AIRLOCK_PURGE]. Then ask: "Tell me the results — did the error clear?"' },
  S5:      { id:'S5',     next:'BREAKER',label:'Heater indicator',      prompt:'Ask user to set temp above current water temp and watch for any heating indicator (light, flame symbol, or "Heat"). Confirms control board is commanding the heater.' },
  BREAKER: { id:'BREAKER',next:'S6',     label:'Breaker reset',         prompt:'Emit [FIRE:BREAKER_RESET] then ask if the error clears after reset.' },
  S6:      { id:'S6',     next:'S6b',    label:'Gate valves',           prompt:'Emit [FIRE:BAY_ENTRY]. Then ask: are all gate or isolation valves (if equipped) fully open?' },
  S6b:     { id:'S6b',   next:'S7',     label:'Air purge valve',       prompt:'If equipped, ask user to briefly open the air purge valve to release any trapped air.' },
  S7:      { id:'S7',     next:'S8a',    label:'Air lock phase 2',      prompt:'Repeat the hose purge with the bay open. Watch for air bubbles in the lines.' },
  S8a:     { id:'S8a',   next:'S8b',    label:'Circ pump',             prompt:'Emit [FIRE:CIRC_PUMP_POWER]. Ask user to feel the circ pump housing — hum/vibration/warm=working; silent/grinding/hot/leaking=failed ($150-300). Not all spas have a dedicated circ pump.' },
  S8b:     { id:'S8b',   next:'S8c',    label:'Flow switch visual',    prompt:'Ask user to check the flow switch paddle — does it move freely with active flow? Check the direction arrow on the body (backwards = will not work).' },
  S8c:     { id:'S8c',   next:'S9',     label:'Flow switch jumper',    prompt:'Emit [FIRE:FS_JUMPER_GATE] then confirm user is comfortable: >>BTN\nYes, I\'m ready | Skip this step\n<<BTN. If ready: power OFF → photograph wire connections → disconnect FS wires → bridge terminals → restore power → error clear? Yes=replace FS ($20-60)→>>PT. No=continue.' },
  S9:      { id:'S9',     next:'S10',    label:'Visual inspection',     prompt:'Ask user to use a flashlight throughout the bay. Look for burn marks, scorched wires, corrosion, blown fuses, rodent damage. Specifically call out board: "Using a flashlight, examine the control board closely — look for any black or brown spots or char marks around connectors."' },
  S10:     { id:'S10',   next:'S11',    label:'Fuses',                 prompt:'Ask user to inspect all fuses — housing and filament. Blown fuse = symptom, find the cause.' },
  S11:     { id:'S11',   next:'S12',    label:'Temp sensor',           prompt:'Ask user to compare actual water temp against topside display. Significant difference = replace ($15-50).' },
  S12:     { id:'S12',   next:'S13',    label:'Hi-limit sensor',       prompt:'Ask user to check for a reset button on the hi-limit and press it if present. If spa is overheating: ⚠️ cut power immediately, do not use until replaced.' },
  S13:     { id:'S13',   next:'S14',    label:'Heater element',        prompt:'Multimeter test: resistance and ground fault. Element $30-150, assembly $120-400. Ask if user has a multimeter first — if not, skip to visual check for corrosion/burn marks.' },
  S14:     { id:'S14',   next:null,     label:'Control board',         prompt:'LAST RESORT — only after ALL previous steps completed/skipped. Present control board diagnosis and >>PT.' },
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
    }
  }

  const advanceMatch = reply.match(/\[ADVANCE:([A-Z0-9a-z]+)\]/);
  const skipMatch = reply.match(/\[SKIP:([A-Z0-9a-z]+)\]/);
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
  return reply.replace(/\[FIRE:([A-Z0-9_]+)\]/g, (match, key) => FIRE_TEMPLATES[key] || match);
}

function buildStepContext(state) {
  if (!state || !state.currentStep) return null;
  const step = DIAG_STEPS[state.currentStep];
  if (!step) return null;
  const nextStep = step.next ? DIAG_STEPS[step.next] : null;
  return `=CURRENT STEP=
Step: ${step.id} — ${step.label}
Task: ${step.prompt}
Signal [ADVANCE:${step.id}] when user's answer clears this step.
Signal [SKIP:${step.id}] if user skips or cannot perform this step.
${nextStep ? `Next: ${step.next} — ${nextStep.label}` : 'This is the final step.'}
NEVER move forward without emitting [ADVANCE:${step.id}] or [SKIP:${step.id}].`;
}

// ── Token telemetry ───────────────────────────────────────────────
function logTokenUsage(route, model, usage, meta = {}) {
  if (!usage) return;
  const entry = { ts: Date.now(), route, model: model.replace('claude-','').replace('-20251001','').replace('-4-6',''), in: usage.input_tokens || 0, out: usage.output_tokens || 0, ...meta };
  console.log('[TOKENS]', JSON.stringify(entry));
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
[DS] prefix = compact session state: {spa} {err}\n{steps}{@current}
Steps: id+✅/❌/⚠️+optional(persists/cleared). Never re-ask completed steps.

=SPA GATE=
Ask for details before diagnosing but never block. Skip gate when: [CONFIRM_PART:] [SHOW_LINKS:] [START_DIAGNOSIS] or spa in history.
Request phrase (exact): "To troubleshoot your spa accurately, it would be really helpful to have your spa details and what you've already tried. Please enter that information below." Never output template fields.

=HOWTO=
General how-to Q → answer directly, no gate.

=SPA CONFIRM=
"My spa is a [Y M Mo]": vary opener (Got it/Perfect/Understood/Thanks/Good to know).
[MODEL_DATA_FOUND] → 1 sentence only: "Perfect — you have a **[Y M Mo]** and I have detailed specs on file."
[MODEL_DATA_NOT_FOUND] → "Got it — you have a **[Y M Mo]**." Proceed. No re-ask.
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
Never: raw URLs, markdown links, <br>, 240V/GFCI/gas/structural instructions.`;

const SP_PERSONALITY = `=STYLE=
Never dismiss answers. No resets. One Q, wait, move on. Don't restate what user said. No "usually/typically/often/probably/might." Never suggest calling tech for standard repairs.`;

const SP_DIAG_FLOW = `=DIAG FLOW=
Flow/heat errors (FL1/FL2/FLO/FLOW/no heat/low heat): follow step sequence exactly.
App tracks current step and injects =CURRENT STEP= block. Execute that step only.
Signal [ADVANCE:Sx] when user's answer clears the step. Signal [SKIP:Sx] if user skips.
Never jump ahead. Never revisit completed steps (they're in DS block).
NEVER: suggest control board before all prior steps done | loosen unions | lower water level | suggest board after breaker reset fail (next step is S6).`;

const SP_BAY_RULES = `=BAY POWER=
Power warning FIRST before any bay instruction. If prev step had power ON → explicitly say OFF before entering.
CIRC PUMP ONLY: power stays ON to observe/touch pump housing. Never near wires/terminals.
ALL OTHER BAY STEPS: "Turn off dedicated circuit breaker — not topside panel."
Use flashlight always.
BURNS: dark spot=burn until proven otherwise. Wipe test (power OFF): black=burn→check wires→>>PT. Confirmed burn: inspect board back. Discolored wires near burn = harness damaged — new board + damaged harness = dead new board.`;

const SP_PART_FLOW = `=PART FLOW=
Part before diagnosis confirmed → 1 sentence (part+symptom) + 2 buttons. No bullets, no links yet.
Heater element NOT most common — filter/airlock/flow switch/circ pump are. Never say "most common" unless true.
[CONFIRM_PART:heater assembly/element]: never ask element vs assembly again.
"pump" unspecified → ask which (circ vs jets, which zone).
Suspected part → "Confirming is wise before ordering." >>BTN\nStart Diagnosis | Show Purchase Links\n<<BTN
[SHOW_LINKS:part] → >>PT immediately.
[START_DIAGNOSIS] → S1, spa confirmed, don't re-confirm spa.
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
AIRLOCK HOW-TO: any general question about clearing/purging an airlock → emit [FIRE:AIRLOCK_PURGE] then ask "Did that clear it up?"
DIAG PROGRESS: user asks to "show all steps", "show diagnostic list", "what steps are left", or "go back to step X" →
  Show numbered list of all 14 steps with status: ✅ passed, ❌ failed (but diagnosis continues), ⏳ not yet tested.
  Format: "S1 ✅ Filter condition", "S2a ⏳ Water condition", etc.
  User can say "go back to step 3" → re-execute that step, signal [SKIP] for current and set state back.`;

function buildSystemPrompt(context = {}) {
  const { hasDiagState, isGuideEntry, hasSpaConfirmed, hasPartRequest, isEquipmentBayStep, hasInstallRequest, isFirstMessage, stepContext } = context;
  const modules = [SP_CORE];
  if (isFirstMessage || !hasSpaConfirmed) modules.push(SP_PERSONALITY);
  if (hasDiagState || hasSpaConfirmed) modules.push(SP_DIAG_FLOW);
  if (isEquipmentBayStep) modules.push(SP_BAY_RULES);
  if (hasPartRequest || hasDiagState) modules.push(SP_PART_FLOW);
  modules.push(SP_SAFETY);
  if (hasInstallRequest) modules.push(SP_INSTALL);
  if (isGuideEntry) modules.push(SP_GUIDE_CONTEXT);
  if (hasSpaConfirmed || hasDiagState) modules.push(SP_BRAND_CONTEXT);
  if (!hasDiagState) modules.push(SP_MISC);
  // SP_MISC excluded during active diagnosis — saves ~271 tokens, Jet stays on-script
  if (stepContext) modules.push(stepContext);
  return modules.join('\n\n');
}

function detectRequestContext(messages, diagStateIn, body) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
  const assistantExists = messages.some(m => m.role === 'assistant');
  const isGuideEntry = content.startsWith('[From guide:');
  const hasPartRequest = /\[(CONFIRM_PART|SHOW_LINKS|START_DIAGNOSIS)/i.test(content);
  const hasDiagState = !!(diagStateIn && diagStateIn.steps && diagStateIn.steps.length > 0);
  const hasSpaConfirmed = body.spaConfirmed === true || messages.some(m => m.role === 'user' && typeof m.content === 'string' && (m.content.startsWith('[Spa:') || m.content.startsWith('My spa is a ')));
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
  return { hasDiagState, isGuideEntry, hasSpaConfirmed, hasPartRequest, isEquipmentBayStep, hasInstallRequest, isFirstMessage, stepContext };
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
  const [rows, partsRows] = await Promise.all([
    supabaseGet('spa_models', {
      'select': 'brand,model_name,year_start,year_end,control_system,common_failures,error_codes,pump_configs,verified,key_part_numbers',
      'brand': `ilike.*${make}*`,
      'model_name': `ilike.*${model}*`,
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
    control_system: profile.control_system || null,
    common_failures: Array.isArray(profile.common_failures)
      ? profile.common_failures.slice(0, 5).join('; ')
      : (profile.common_failures || null),
    error_codes: Array.isArray(profile.error_codes)
      ? profile.error_codes.map(e => e.code).join(', ')
      : (profile.error_codes || null),
    pump_configs: Array.isArray(profile.pump_configs)
      ? profile.pump_configs.map(p => `Pump ${p.pump_num}: ${p.hp}hp ${p.speeds}-speed`).join(', ')
      : (profile.pump_configs || null),
    key_part_numbers: profile.key_part_numbers || null,
    compatible_parts: partsRows || [],
  });
});

// Primary spa normalization endpoint — used by client for typo correction
// ── Model lookup endpoint ─────────────────────────────────────────
app.get("/api/model/:year/:make/:model", async (req, res) => {
  const { year, make, model } = req.params;
  if (!year || !make || !model) return res.status(400).json({ error: "year, make, model required" });

  // Query spa_models and parts table in parallel — single round trip
  const [rows, partsRows] = await Promise.all([
    supabaseGet('spa_models', {
      'select': 'brand,model_name,year_start,year_end,control_system,common_failures,error_codes,pump_configs,verified,key_part_numbers',
      'brand': `ilike.*${make}*`,
      'model_name': `ilike.*${model}*`,
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
    control_system: profile.control_system || null,
    common_failures: Array.isArray(profile.common_failures)
      ? profile.common_failures.slice(0, 5).join('; ')
      : (profile.common_failures || null),
    error_codes: Array.isArray(profile.error_codes)
      ? profile.error_codes.map(e => e.code).join(', ')
      : (profile.error_codes || null),
    pump_configs: Array.isArray(profile.pump_configs)
      ? profile.pump_configs.map(p => `Pump ${p.pump_num}: ${p.hp}hp ${p.speeds}-speed`).join(', ')
      : (profile.pump_configs || null),
    key_part_numbers: profile.key_part_numbers || null,
    compatible_parts: partsRows || [],
  });
});

// Primary spa normalization endpoint — used by client for typo correction
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
  if (text.trim().length > 2000) return { valid: false, reason: "too_long" };
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

// ─────────────────────────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  const isSilent = req.body.silent === true;
  const clientId = getClientId(req);
  const diagStateIn = req.body.diagState || getDiagState(clientId) || null;

  // Initialize diagState when diagnosis starts (START_DIAGNOSIS or spa form + issue)
  const lastMsgContent = typeof messages[messages.length-1]?.content === 'string' ? messages[messages.length-1].content : '';
  const isStartDiagnosis = lastMsgContent.includes('[START_DIAGNOSIS]') ||
    (lastMsgContent.includes('Please start the diagnostic sequence') && lastMsgContent.includes('My spa is a ')) ||
    (lastMsgContent.includes('Issue:') && lastMsgContent.includes('My spa is a '));

  if (isStartDiagnosis && !diagStateIn) {
    // Build spa label — prefer explicit fields sent by client, fall back to message parsing
    const spaYear = req.body.spaYear || '';
    const spaMake = req.body.spaMake || '';
    const spaModel = req.body.spaModel || '';
    let spaLabel = [spaYear, spaMake, spaModel].filter(v => v && v !== 'Unknown').join(' ');
    if (!spaLabel) {
      const spaMatch = lastMsgContent.match(/My spa is a ([^.]+?)(?:\.|\s+Issue:|\s+I've)/);
      spaLabel = spaMatch ? spaMatch[1].trim() : 'Unknown';
    }
    const errMatch = lastMsgContent.match(/Error code(?:[^:]*)?:\s*([A-Z0-9]+)/i);
    const newState = { spa: spaLabel, errorCode: errMatch ? errMatch[1] : null, steps: [], currentStep: 'S1', lastUpdated: Date.now() };
    setDiagState(clientId, newState);
  }

  console.log(`[/api/chat] ${new Date().toISOString()} clientId=${clientId} msgs=${messages?.length || 0} step=${diagStateIn?.currentStep || 'none'}`);

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
    const hasDiagState = !!(diagStateIn && diagStateIn.spa);
    const spaConfirmed = req.body.spaConfirmed === true;
    const conversationInProgress = messages.filter(m => m.role === 'user').length > 1 || messages.some(m => m.role === 'assistant');
    const check = (isSpaForm || spaSubmitted || spaConfirmed || conversationInProgress || hasSpaContext || hasDiagState) ? { valid: true } : await isValidMessage(content);
    if (!check.valid) {
      const msgs = { too_short: "Please describe your hot tub issue in a bit more detail.", too_long: "Your message is too long — please keep it under 2,000 characters.", off_topic: "SpaFix can only help with hot tub and spa questions. Please describe your spa issue and I'll be happy to help!" };
      return res.status(400).json({ error: msgs[check.reason] || "Please ask a spa-related question." });
    }
  }

  const promptContext = detectRequestContext(messages, diagStateIn, req.body);
  const systemPrompt = buildSystemPrompt(promptContext);
  const hasDiagStateActive = diagStateIn && diagStateIn.steps && diagStateIn.steps.length > 0;
  const msgLimit = hasDiagStateActive ? 3 : 6;
  const trimmedMessages = messages.slice(-msgLimit);
  let effectiveSystemPrompt = systemPrompt;

  // Inject confirmed spa details so Jet never re-asks for info already on file
  const spaYearVal = req.body.spaYear || '';
  const spaMakeVal = req.body.spaMake || '';
  const spaModelVal = req.body.spaModel || '';
  const hasConfirmedSpaDetails = (spaYearVal || spaMakeVal) && spaMakeVal !== 'Unknown';
  if (hasConfirmedSpaDetails) {
    const spaLine = [spaYearVal, spaMakeVal, spaModelVal].filter(v => v && v !== 'Unknown').join(' ');
    effectiveSystemPrompt = `=SPA ON FILE= User's spa is confirmed: ${spaLine}. DO NOT ask for spa year, make, or model — already known.\n\n` + effectiveSystemPrompt;
  }

  if (hasDiagStateActive) {
    const stateBlock = buildDiagStateBlock(diagStateIn);
    if (stateBlock) effectiveSystemPrompt = `${stateBlock}\n\n${systemPrompt}`;
  }

  async function callAndProcess(tier) {
    const response = await callAnthropicWithRetry({ model: "claude-sonnet-4-6", max_tokens: 700, system: effectiveSystemPrompt, messages: trimmedMessages });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "API error");
    const rawReply = data.content?.map(b => b.text || "").join("") || "";
    const cleanReply = rawReply
      .replace(/\[ADVANCE:[A-Z0-9a-z]+\]/g, '')
      .replace(/\[SKIP:[A-Z0-9a-z]+\]/g, '')
      // Strip all DS/step leak formats
      .replace(/^\[DS\][^\n]*\n[^\n]*\n?/m, '')
      .replace(/^\[DS\][^\n]*\n?/m, '')
      .replace(/^(?:S\d+[a-z]?[\u2705\u274C\u23F3][^|\n]*\|?\s*)+@?\S*\n?/m, '')
      .replace(/^\{[^}]*\}\s*\n/gm, '')
      .replace(/^=CURRENT STEP=[\s\S]*?(?=\n[A-Z\u{1F300}-\u{1F9FF}]|\n[a-z])/mu, '')
      .replace(/\[DS\][^\n]*/g, '')
      .replace(/&lt;br\s*\/?&gt;/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n");
    const reply = applyFireTemplates(cleanReply).trim();
    logTokenUsage('chat', 'claude-sonnet-4-6', data.usage, { tier });
    const updatedDiagState = processDiagSignals(rawReply, clientId, lastMsgContent);
    if (testerName) {
      const lm = messages[messages.length - 1];
      if (lm?.role === 'user') appendToTranscript(testerName, clientId, 'user', typeof lm.content === 'string' ? lm.content : '');
      appendToTranscript(testerName, clientId, 'assistant', reply);
    }
    return { reply, diagState: updatedDiagState || diagStateIn || null };
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
- part_number: OEM part number if known for that specific model (string or null)
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

CRITICAL: Return ONLY a raw JSON array. Start with [ and end with ]. No markdown, no backticks, no explanation. Keep total response under 2500 tokens.`;

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
    const start = rawText.indexOf('[');
    const end = rawText.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array found in response');
    const parts = JSON.parse(rawText.slice(start, end + 1));

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
