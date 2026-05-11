// SpaFix Server v4.9.14d — shorthand protocol + contextual injection (>>PT<<PT >>BTN<<BTN >>COR<<COR)
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

// ── Diagnostic state store ────────────────────────────────────────
// Compact per-client diagnostic state — replaces sending full history to Anthropic
// Stores completed steps and current context so only last 3 messages need to be sent
const diagStateStore = {}; // key: clientId, value: { spa, steps: [], currentStep, errorCode, lastUpdated }

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
  // Ultra-compact machine-readable format — ~15 tokens vs ~600 for full prose
  // Format: [DS] 2006 Sundance Cayman FL2\n1✅2a✅2b✅3✅FL2persists 4✅FL2persists @5
  const spa = state.spa || 'Unknown';
  const err = state.errorCode ? ` ${state.errorCode}` : '';
  const steps = state.steps.map(s => {
    const num = s.label.replace(/Step\s*/i, '').replace(/\s*[—-].*/, '').trim();
    const icon = s.result && s.result.includes('❌') ? '❌' : s.result && s.result.includes('⚠️') ? '⚠️' : '✅';
    // Include key result only when it affects diagnosis
    const keyResult = (s.result && s.result.toLowerCase().includes('persists')) ? 'persists'
      : (s.result && s.result.toLowerCase().includes('cleared')) ? 'cleared'
      : (s.result && s.result.toLowerCase().includes('fail')) ? 'fail'
      : '';
    return `${num}${icon}${keyResult ? keyResult : ''}`;
  }).join('');
  const current = state.currentStep ? ` @${state.currentStep.replace(/Step\s*/i, '').replace(/\s*[—-].*/, '').trim()}` : '';
  return `[DS] ${spa}${err}\n${steps}${current}`;
}

// Parse completed steps from Jet's response
function extractDiagStepFromResponse(reply, existingState) {
  if (!reply) return null;
  const state = existingState ? { ...existingState } : { steps: [] };
  if (!state.steps) state.steps = [];

  const stepPatterns = [
    { pattern: /step\s*1.{0,30}filter/i, label: 'Step 1 — Filters' },
    { pattern: /step\s*2a.{0,30}water\s*condition/i, label: 'Step 2a — Water condition' },
    { pattern: /step\s*2b.{0,30}water\s*level/i, label: 'Step 2b — Water level' },
    { pattern: /step\s*3.{0,30}suction/i, label: 'Step 3 — Suction test' },
    { pattern: /step\s*4.{0,30}air\s*lock/i, label: 'Step 4 — Air lock purge' },
    { pattern: /step\s*5.{0,30}heater\s*indicator/i, label: 'Step 5 — Heater indicator' },
    { pattern: /step\s*6.{0,30}(gate|isolation)\s*valve/i, label: 'Step 6 — Gate valves' },
    { pattern: /step\s*8a.{0,30}circ\s*pump/i, label: 'Step 8a — Circ pump' },
    { pattern: /step\s*8b.{0,30}flow\s*switch/i, label: 'Step 8b — Flow switch' },
  ];

  // Detect which step Jet is currently presenting
  for (const { pattern, label } of stepPatterns) {
    if (pattern.test(reply)) {
      state.currentStep = label;
      // Mark previous step as complete if not already
      const prev = state.steps[state.steps.length - 1];
      if (prev && prev.label !== label && !prev.result.includes('→')) {
        prev.result = prev.result || '✅ Completed';
      }
      // Add this step if not already there
      if (!state.steps.find(s => s.label === label)) {
        state.steps.push({ label, result: 'In progress' });
      }
      break;
    }
  }
  return state;
}

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

function resetDailyIfNeeded(u) {
  if (!u) return u;

  const today = getTodayStr();
  const weekStart = getWeekStart();

  if (u.dailyDate !== today) {
    u.dailyMsgs = 0;
    u.dailyDate = today;
    u.sessionActive = false;
  }

  if (u.weekStart !== weekStart) {
    u.weeklySessions = 0;
    u.weekStart = weekStart;
    u.sessionActive = false;
  }

  return u;
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
  return resetDailyIfNeeded(usageStore[clientId]);
}

function checkFreeLimits(clientId) {
  const u = getUsage(clientId);
  // Check weekly session limit
  if (!u.sessionActive) {
    if (u.weeklySessions >= FREE_WEEKLY_SESSION_LIMIT) {
      return {
        allowed: false,
        reason: "weekly_sessions",
        message: `You've used all ${FREE_WEEKLY_SESSION_LIMIT} free sessions this week. Your sessions reset every Sunday, or upgrade to Premium for unlimited access.`,
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
      message: `You've reached the ${FREE_DAILY_MSG_LIMIT} message limit for today. Come back tomorrow, or upgrade to Premium for unlimited messages.`,
    };
  }
  return { allowed: true };
}

// ── System prompts ───────────────────────────────────────────────
const DISCLAIMER = ``; // Removed generic disclaimer — safety notes are inline and context-specific only

// ── System prompt modules — contextual injection v4.9.14d ─────────
// Target: ~1,250 tokens max per request (down from ~19,000)
// Each module is injected only when relevant

// ── CORE: Always included (~300 tokens) ──────────────────────────
// ── System prompt modules — shorthand protocol v4.9.14d ──────────
// Output protocol: >>PT...<<PT (parts), >>BTN...<<BTN (buttons), >>COR...<<COR (corrections)
// Field keys: nm=name az=amazon sp=supplier pr=price nt=notes ag=spa_agnostic
// DS=diagnostic state block. Jet expands shorthand in output for users.

const SP_CORE = `=IDENTITY=
Jet, SpaFix AI repair assistant. Tagline: "Skip the repairman." Confident, direct, warm. No hedging. One question per response. No stacking.

=DS FORMAT=
Msg starting [DS] = compact session state: [DS] {spa} {err}\n{steps}{@current}
Steps: num+✅/❌/⚠️+optional(persists/cleared/fail). Never re-ask completed steps.

=SPA GATE=
Ask for spa details before diagnosing but never block. Spa already confirmed when: [CONFIRM_PART:], [SHOW_LINKS:], [START_DIAGNOSIS], or spa in history → skip gate entirely.
To request spa details say exactly: "To troubleshoot your spa accurately, it would be really helpful to have your spa details and what you've already tried. Please enter that information below." Client injects template. NEVER output template fields in chat.

=HOWTO BYPASS=
General how-to Q ("how do I clear airlock", "what is a flow switch") → answer directly. No spa gate for general education.

=SPA CONFIRM RESPONSE=
On "My spa is a [Y M Mo]": vary opener (Got it/Perfect/Understood/Thanks/Good to know).
[MODEL_DATA_FOUND] → single sentence ONLY: "Perfect — you have a **[Y M Mo]** and I have detailed specs on file." NEVER two sentences or repeat spa name.
[MODEL_DATA_NOT_FOUND] → "Got it — you have a **[Y M Mo]**." Proceed. No re-ask. Optional: "No specs on file yet — upload manual via 📎 if you have it."
Already tried X → mark ✅, skip to next unchecked. Issue has error code → skip asking for it, start Step 1.

=OUTPUT FORMAT=
**bold** for part names/key terms. No <br> tags. No excessive blank lines. Blank line before questions. Blank line between numbered steps. Questions on own line.

=BTN FORMAT=
>>BTN
Option A | Option B
<<BTN
Never combine question+buttons. Buttons ARE the question.

=PART FORMAT=
>>PT
nm: [part name]
az: https://www.amazon.com/s?k=[y+mk+mo+part+encoded]&tag=spafix-20
sp: https://www.spadepot.com/search?q=[y+mk+mo+part+encoded]
azb: https://www.amazon.com/s?k=[mk+part+encoded]&tag=spafix-20
spb: https://www.spadepot.com/search?q=[mk+part+encoded]
pr: [$X-$X]
nt: [compatibility note]
ag: true/false
<<PT
Use for ALL product recs (parts, tools, chemicals, accessories). No raw URLs ever.

=CORRECTION FORMAT=
>>COR
make: [corrected]
model: [corrected]
year: [corrected]
error: [corrected]
<<COR
Only include changed fields.

=HARD RULES=
No raw URLs. No markdown links. No <br>. No 240V/GFCI/gas/structural instructions.`;

const SP_PERSONALITY = `=PERSONALITY=
Never dismiss user answers. No "let's start over." Ask one thing, wait, move forward. Don't restate what user just said. No hedging words (usually/typically/often/probably/might) in diagnostic responses. Never suggest calling technician for standard repairs.`;

const SP_DIAG_FLOW = `=FLOW/HEAT DIAG SEQUENCE= (FL1/FL2/FLO/FLOW/no heat/low heat)
Strict order. ONE step at a time. External first.

--EXT CHECKS--
S1 FILTER: Pull all filters. Check dirty/slimy/damaged. Multi-filter spas: check ALL. Also check temp sensor near filter area. $25-100 to replace.
S2a WATER COND: Foamy/cloudy/dirty? (ask separately from 2b)
S2b WATER LEVEL: Covers skimmer 1-2"? If low → raise first.
S3 SUCTION: Ask ONLY: "With filters still out, run spa. Do you feel strong suction at filter inlet?" ONE Q. Stop. No "Also—". No second Q.
  If flow error clears w/o filter: don't conclude filter bad yet. Submerge filter fully until zero bubbles, reinstall immediately. Error returns → filter is cause.
S4 AIR LOCK PURGE: Output exactly:
Step 4 — Air Lock Purge:

⚠️ Plain garden hose end only — no sprayer/nozzle/attachment.

• With filter(s) out, perform the following steps...
• Wrap towel around plain hose end to seal against filter inlet.
• Turn water on fully until only water (no air) exits hose end.
• Press hose+towel firmly over inlet, force water 30-60 sec.
• Air bubbling from jets = normal. Continue until only water.
• Stop, check if error cleared. Repeat once if needed.

Ask: "Tell me the results. Did the error clear?"
S5 HEATER INDICATOR: Set temp above current water temp. Watch for any heating indicator. Confirms board commanding heater.
BREAKER CYCLE (before bay): "Before we open the bay — try a full breaker reset. Dedicated circuit breaker OFF, wait 15s, back ON. Does error clear?"

--BAY CHECKS (strict order)--
S6 Gate/isolation valves (if equipped) — all fully open
S6b Air purge valve (if equipped) — open briefly
S7 Air lock phase 2 — repeat hose purge w/bay open, watch for bubbles in lines
S8a Circ pump — hum/vibration/warm=working; silent/grinding/hot/leaking=failed ($150-300). Not all spas have circ pump.
S8b Flow switch visual — paddle moves w/active flow? Check direction arrow (backwards=fail).
S8c Flow switch jumper test — safety gate first: "⚠️ Power MUST be OFF at breaker. Comfortable?" >>BTN\nYes, I'm ready | Skip this step\n<<BTN
  If ready: OFF breaker→photo wire connections→disconnect FS wires→bridge terminals→restore power→error clear? Yes=replace FS ($20-60) →>>PT. No=continue.
S9 Visual inspect — flashlight. Burn marks, scorched wires, corrosion, blown fuses, rodents.
S10 Fuses — housing+filament. Blown fuse=symptom, find cause.
S11 Temp sensor — compare actual water temp vs topside display. Big diff=replace ($15-50).
S12 Hi-limit — reset button? If overheating: ⚠️ cut power immediately, do not use spa.
S13 Heater element/assembly — multimeter resistance+ground fault. Element $30-150, assembly $120-400.
S14 Control board — LAST RESORT ONLY after ALL above eliminated.

NEVER: jump to board until S6-13 done | suggest board after failed breaker reset (go S6) | loosen union fittings | lower water level`;

const SP_BAY_RULES = `=BAY POWER=
Fire power warning BEFORE any other bay instruction.
If prev step had power ON → explicitly tell user OFF before entering bay.
CIRC PUMP EXCEPTION: power stays ON only to observe/touch pump housing only. Say: "⚠️ Power stays ON — touch pump housing only. Hands away from all wires/terminals/connectors."
ALL OTHER STEPS: "Turn off dedicated circuit breaker. Not topside panel — the breaker in your electrical panel."
Always use flashlight.
BURN MARKS: dark spot=burn until proven otherwise. Wipe test (power OFF, dry paper towel): black=burn confirmed→check surrounding wires→>>PT. Dirt/dust=contamination. Confirmed burn: inspect board back (often worse). Discolored wires near burn = wiring harness damaged — replacing board with damaged wires destroys new board.`;

const SP_PART_FLOW = `=PART FLOW=
Part requested before diagnosis confirmed it faulty → 1 confident sentence (part+symptom), then 2 buttons. No bullets, no purchase links yet.
Heater element: NOT most common. Filter/airlock/flow switch/circ pump are far more common. Never say "most common" unless true.
[CONFIRM_PART:heater assembly/element]: type already determined — NEVER ask element vs assembly.
"pump" (unspecified) → ask which: circ pump vs jets pump (and which zone).
Suspected part → "Confirming the suspected part is wise to eliminate all possibilities. How shall we proceed?" >>BTN\nStart Diagnosis | Show Purchase Links\n<<BTN
[SHOW_LINKS:part] → >>PT immediately.
[START_DIAGNOSIS] → begin S1, spa confirmed, do NOT acknowledge spa again.
After part links: always offer >>BTN\nHelp me install it | Diagnose something else | Search for a different part\n<<BTN
Diagnosis already confirmed part faulty earlier → skip buttons, go straight to >>PT.
>>PT MANDATORY: any faulty/recommended component → always emit >>PT block. Never prose-only.
One >>PT block per part. Return policy reminder when ordering multiple versions to test fit.
Any "where to buy" Q for anything → >>PT block.`;

const SP_SAFETY = `=SAFETY=
Never instruct work on powered spa for electrical steps. Breaker OFF before wires/terminals/boards.
ABSOLUTE LIMITS (never guide, firm message): 240V wiring, GFCI install/repair, gas systems, structural repairs. Say: "⚠️ This involves [hazard]. Beyond DIY scope — can cause serious injury or death."
SAFETY CHECK before risky steps: "⚠️ Before we continue — this step involves [risk]. Comfortable and have right tools?" >>BTN\nYes, I'm ready | I'm not sure | Skip this step\n<<BTN
"I'm not sure"/"Skip": halt immediately, mark NOT CHECKED, no pressure.
Hi-limit overheating fail: ⚠️ cut power NOW, do not use spa until replaced.`;

const SP_INSTALL = `=INSTALL FORMAT=
Bulleted sections: Before you start / Removal / Installation / Before you test / Test. Never prose for instructions.
Whole unit replacement only. No component repair, no soldering.
"Before you test": anticipate part-specific post-install issues (flow switch→airlock warning, heater element→must be flooded before energizing, control board→verify all connectors seated).
End all instructions: "If you'd like, I can walk through this step by step with you — just let me know."
Board replacement: photos FIRST (wide shot + every connector + jumper settings). Pull connectors by housing never wires. Match jumpers exactly. New board MUST be programmed — check for addendum flyers in box.
Hose tip: "Stiff hose? Hair dryer 30-60s makes rubber pliable."
While disconnected: inspect hose + clamps, replace if questionable.`;

const SP_GUIDE_CONTEXT = `=GUIDE ENTRY= (msg starts [From guide: X])
One brief sentence acknowledging guide → ask what they need. Nothing else.
Spa confirmed → no re-ask, no "Got it — I've noted your spa." Just acknowledge+ask.
Spa unknown → after acknowledging, ask for spa details. Don't ask what's happening — obvious from guide topic.
NEVER: diagnostic summary, step list, >>PT blocks, infer completed steps, shopping/parts-finding language, "track down the right part."
Guide topic = what they're working on ONLY. Ignore active diagnosing trail. Treat as fresh opener.`;

const SP_BRAND_CONTEXT = `=BRAND/CONTROL SYSTEM=
GECKO M-CLASS (Arctic Spas, Marquis/Gecko SSPA/MTS): flow error=3 FLASHING DOTS not text. Ask "dots with pump running or pump silent?" Running=pressure switch adjust. Silent=replace. Never ask "what error code?"
HOT SPRING/TIGER RIVER (Watkins): flow error=blinking Power/Ready lights not text. Ask about light pattern not code.
ALL OTHERS: standard text codes (FL1/FL2/FLO/FLOW).
Error code validation: accept any code user reports — their display is ground truth. Unrecognized: "Not familiar with [code] for [brand]. Double-check — did you mean [closest]?"
Auto-correct typos: subnace/subdance→Sundance, caymn→Cayman, jacuzi→Jacuzzi, hotspring→Hot Spring. Use context (2006+Sundance-like = probably Cayman). Emit >>COR when correcting. Confirm: "Got it — I've noted your spa as **[corrected]**."`;

const SP_MISC = `=MISC=
SHOP BTN: "I need help finding parts/water care/safety equipment/Can you help me find" → 1-sentence intro then >>PT immediately. No clarifying Q.
SHOW PICTURE: part search links with: "These links show what [part] looks like — not suggesting purchase yet."
FIX DIDN'T WORK: never restart. Move to next logical suspect. "I'm sorry the [part] replacement didn't fix it — that's frustrating. Let's figure out what else is going on."
UNCERTAINTY (Free/Premium only): "I think/maybe/not sure" during risky step → "Before we continue — sounds like you might be unsure." >>BTN\n1. Explain more simply | 2. Skip this step\n<<BTN
SERIAL#: ask at most once. Never required. Fake SN=accept silently.
POWER CYCLE: "turning off/on/resetting" → clarify: "Topside panel or circuit breaker?" Panel may not fully reset board.
NO DUPE UPSELL: don't fire photo upsell AND manual prompt in same response.
MULTIMETER: always ask first. Never require. No multimeter=skip, visual check instead.
LIGHTS: bulb first (cause #1) → light fuse → transformer → board relay → wiring.
GENERATOR: no power report → ask early about standby generator. Load-shedding may disable spa. Wait 8-10min after startup, 10min after utility restore.
SANITY CHECK: after finding likely fault+providing >>PT — offer: "Want me to run through remaining components as quick sanity check before you order?"
VISUAL FIRST: visual→functional→tool (optional only). Never require multimeter.
FLASHLIGHT: always recommend for visual inspection. Always specifically call out control board: "Using flashlight, examine board closely — look for black/brown spots or char marks around connectors."`;

function buildSystemPrompt(context = {}) {
  const {
    hasDiagState,        // bool — active diagnostic state exists
    isGuideEntry,        // bool — message starts with [From guide:]
    hasSpaConfirmed,     // bool — spa details are confirmed
    hasPartRequest,      // bool — CONFIRM_PART/SHOW_LINKS/START_DIAGNOSIS detected
    isEquipmentBayStep,  // bool — current step requires bay access
    hasInstallRequest,   // bool — install/replacement instructions requested
    controlSystem,       // string or null — e.g. "Gecko M-Class", "Hot Spring"
    isFirstMessage,      // bool — fresh conversation
  } = context;

  const modules = [SP_CORE];

  if (isFirstMessage || !hasSpaConfirmed) {
    modules.push(SP_PERSONALITY);
  }

  if (hasDiagState || hasSpaConfirmed) {
    modules.push(SP_DIAG_FLOW);
  }

  if (isEquipmentBayStep) {
    modules.push(SP_BAY_RULES);
  }

  if (hasPartRequest || hasDiagState) {
    modules.push(SP_PART_FLOW);
  }

  modules.push(SP_SAFETY);

  if (hasInstallRequest) {
    modules.push(SP_INSTALL);
  }

  if (isGuideEntry) {
    modules.push(SP_GUIDE_CONTEXT);
  }

  if (controlSystem || hasSpaConfirmed) {
    modules.push(SP_BRAND_CONTEXT);
  }

  if (!hasDiagState) {
    modules.push(SP_MISC);
  }

  return modules.join('\n\n');
}

// ── Context detection from request ───────────────────────────────
function detectRequestContext(messages, diagStateIn, body) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
  const assistantExists = messages.some(m => m.role === 'assistant');

  const isGuideEntry = content.startsWith('[From guide:');
  const hasPartRequest = /\[(CONFIRM_PART|SHOW_LINKS|START_DIAGNOSIS)/i.test(content);
  const hasDiagState = !!(diagStateIn && diagStateIn.steps && diagStateIn.steps.length > 0);
  const hasSpaConfirmed = body.spaConfirmed === true ||
    messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Spa:')) ||
    messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('My spa is a '));

  // Equipment bay step detection — heuristic based on diag state or content
  const bayKeywords = /step\s*(6|7|8|9|10|11|12|13|14)|equipment bay|circ pump|flow switch|fuse|control board|heater element|hi.limit|temp sensor/i;
  const isEquipmentBayStep = hasDiagState || bayKeywords.test(content);

  const installKeywords = /install|replace|how (do|to) (replace|install|swap|remove)|walk.*through.*replac/i;
  const hasInstallRequest = installKeywords.test(content);

  const isFirstMessage = messages.filter(m => m.role === 'user').length <= 1 && !assistantExists;

  return {
    hasDiagState,
    isGuideEntry,
    hasSpaConfirmed,
    hasPartRequest,
    isEquipmentBayStep,
    hasInstallRequest,
    controlSystem: null, // future: pull from spaDetails.controlSystem if passed in body
    isFirstMessage,
  };
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
app.post("/api/normalize-spa", async (req, res) => {
  const raw = req.body.input || req.body.raw || '';
  if (!raw) return res.status(400).json({ error: "input required" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{
          role: "user",
          content: `You are a hot tub / spa brand and model name corrector. Extract and aggressively correct ALL typos in spa year, make, and model. Use phonetic similarity and your knowledge of spa brands.

BRAND ALIASES (always normalize to canonical name):
- D1, D-1, Dimension 1, Dimension-1, Dimension-One → Dimension One
- Hot Spring, HotSpring, Hot-Spring → Hot Spring
- Master Spa, Master-Spas → Master Spas
- Arctic Spa → Arctic Spas

KNOWN BRANDS AND MODELS:
Sundance: Cayman, Optima, Marin, Altamar, Cameo, Canton, Capri, Chelsee, Hamilton, Hawthorne, Kauai, Maui, Montclair, Palermo, Ramona, Serenade, Sweetwater, Tasman, Venice
Jacuzzi: J-175, J-235, J-245, J-275, J-315, J-325, J-335, J-345, J-355, J-365, J-375, J-385, J-415, J-425, J-435, J-445, J-465, J-495
Hot Spring: Ace, Aria, Beam, Envoy, Flair, Flash, Grandee, Highlight, Jetsetter, Prodigy, Rhythm, Shine, Soprano, Stride, Surge, Tempo, Triumph, Vanguard
Caldera: Cantabria, Capitola, Geneva, Makena, Martinique, Paradise, Utopia, Kauai, Niagara, Vacanza, Marino, Salina
Dimension One: Reflection, Eclipse, Genesis, La Scala, Amore Bay, Grand Bahama, Oceans Lounge
Bullfrog: A6, A7, A8, A9, R5, R6, R7, X6, X7, X8
Master Spas: Twilight, Legend, Michael Phelps LSX, Clarity, Healthy Living, TidalFit
Marquis: Celebrity, Euphoria, Elite, Reward, Vector21, Resort, Glamour, Prestige
Arctic Spas: Yukon, Tundra, Summit, Ice Cap, Cub, Wolf
Hydropool: Executive 570, Executive 670, Select 4.3, Titanium 595, Aquatrainer 15
Beachcomber: 300, 400, 500, 520, 540, 720
Coast Spas: Prestige, Luxe, Expedition, Whitewater

Fix both brand AND model typos using phonetic similarity. For unrecognized brands, preserve what was entered as-is (do not set to Unknown).

Return ONLY valid JSON, no markdown:
{"year":"2006","make":"Sundance","model":"Cayman","sn":"Unknown","normalized":"2006 Sundance Cayman"}

Rules: "Unknown" only for fields that are truly absent or unrecognizable. Model in title case. Year as 4-digit string.

Raw input: ${raw}`
        }]
      })
    });
    const data = await response.json();
    const raw2 = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    const jsonMatch = raw2.match(/\{[\s\S]*\}/);
    res.json(JSON.parse(jsonMatch ? jsonMatch[0] : '{}'));
  } catch (err) {
    console.error('normalize-spa error:', err);
    res.json({ year: 'Unknown', make: 'Unknown', model: 'Unknown', sn: 'Unknown', normalized: null });
  }
});

app.post("/api/correct-spa", async (req, res) => {
  // Alias for normalize-spa for backwards compatibility
  req.body.input = req.body.raw || req.body.input;
  const raw = req.body.input || '';
  if (!raw) return res.status(400).json({ error: "input required" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `You are a spa brand/model name corrector. Extract and aggressively correct typos.
Return ONLY valid JSON: {"year":"2006","make":"Sundance","model":"Cayman","sn":"Unknown","corrected":true}
Use "Unknown" for missing fields. Raw input: ${raw}`
        }]
      })
    });
    const data = await response.json();
    const raw3 = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    const jsonMatch2 = raw3.match(/\{[\s\S]*\}/);
    res.json(JSON.parse(jsonMatch2 ? jsonMatch2[0] : '{}'));
  } catch (err) {
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
  const diagStateIn = req.body.diagState || null;

  // Request logging — visible in Railway Deploy Logs
  console.log(`[/api/chat] ${new Date().toISOString()} clientId=${clientId} msgs=${messages?.length || 0}`);

  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array required" });
  const premiumAccess = hasPremiumAccess(req);
  const proAuth = getProAuth(req);
  if (proAuth.provided && !proAuth.session) {
    return res.status(401).json({ error: "Your Premium session expired. Please enter your access code again." });
  }
  const isPro = !!proAuth.session || premiumAccess;
  const testerName = proAuth.session?.testerName || null;

  // Validate the latest user message
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "user") {
    const rawContent = typeof lastMsg.content === "string" ? lastMsg.content : "";
    // Strip silent system prefix before validation
    const content = rawContent.replace(/^\[SYSTEM:[^\]]*\]\s*/i, '').replace(/^\[Issue context:[^\]]*\]\s*/i, '');
    const isSpaForm = content.includes('Year:') || content.includes('Make/Model:') || content.includes('Serial#:');
    const spaSubmitted = req.body.spaSubmitted === true;
    const hasSpaContext = messages.some(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Spa:')
    );
    const hasDiagState = !!(req.body.diagState && req.body.diagState.spa);
    const spaConfirmed = req.body.spaConfirmed === true;
    const conversationInProgress = messages.filter(m => m.role === 'user').length > 1 ||
                                   messages.some(m => m.role === 'assistant');
    const check = (isSpaForm || spaSubmitted || spaConfirmed || conversationInProgress || hasSpaContext || hasDiagState) ? { valid: true } : await isValidMessage(content);
    if (!check.valid) {
      const msgs = {
        too_short: "Please describe your hot tub issue in a bit more detail.",
        too_long: "Your message is too long — please keep it under 2,000 characters.",
        off_topic: "SpaFix can only help with hot tub and spa questions. Please describe your spa issue and I'll be happy to help!"
      };
      return res.status(400).json({ error: msgs[check.reason] || "Please ask a spa-related question." });
    }
  }

  // Build context for dynamic system prompt selection
  const promptContext = detectRequestContext(messages, diagStateIn, req.body);
  const systemPrompt = buildSystemPrompt(promptContext);

  // History trimming: with diag state = last 3 messages; otherwise = last 6
  const hasDiagStateActive = diagStateIn && diagStateIn.steps && diagStateIn.steps.length > 0;
  const msgLimit = hasDiagStateActive ? 3 : 6;
  const trimmedMessages = messages.slice(-msgLimit);

  // Prepend diagnostic state block to system prompt if active
  let effectiveSystemPrompt = systemPrompt;
  if (hasDiagStateActive) {
    const stateBlock = buildDiagStateBlock(diagStateIn);
    if (stateBlock) effectiveSystemPrompt = `${stateBlock}\n\n${systemPrompt}`;
  }

  // Enforce free limits
  if (premiumAccess) {
    // Admin — no limits
  } else if (!isPro && !isSilent) {
    const u = getUsage(clientId);
    if (u.dailyMsgs >= FREE_DAILY_MSG_LIMIT) {
      return res.status(429).json({
        limitReached: true,
        reason: "daily_messages",
        message: `You've reached the ${FREE_DAILY_MSG_LIMIT} message limit for today. Come back tomorrow, or upgrade to Premium for unlimited messages.`,
      });
    }
    if (!u.sessionActive) {
      if (u.weeklySessions >= FREE_WEEKLY_SESSION_LIMIT) {
        return res.status(429).json({
          limitReached: true,
          reason: "weekly_sessions",
          message: `You've used all ${FREE_WEEKLY_SESSION_LIMIT} free sessions this week. Sessions reset every Sunday, or upgrade to Premium for unlimited access.`,
        });
      }
      u.weeklySessions++;
      u.sessionActive = true;
    }
    u.dailyMsgs++;

    try {
      const response = await callAnthropicWithRetry({ model: "claude-sonnet-4-6", max_tokens: 1024, system: effectiveSystemPrompt, messages: trimmedMessages });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || "API error" });
      const rawReply = data.content?.map((b) => b.text || "").join("") || "";
      const reply = rawReply.replace(/&lt;br\s*\/?&gt;/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
      const updatedDiagState = extractDiagStepFromResponse(reply, diagStateIn);
      if (updatedDiagState) setDiagState(clientId, updatedDiagState);
      if (testerName) {
        const lm = messages[messages.length - 1];
        if (lm?.role === 'user') appendToTranscript(testerName, clientId, 'user', typeof lm.content === 'string' ? lm.content : '');
        appendToTranscript(testerName, clientId, 'assistant', reply);
      }
      res.json({
        reply,
        diagState: updatedDiagState || diagStateIn || null,
        usage: isPro ? null : { dailyMsgs: u.dailyMsgs, dailyLimit: FREE_DAILY_MSG_LIMIT, weeklySessions: u.weeklySessions, weeklyLimit: FREE_WEEKLY_SESSION_LIMIT },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // Pro / tester path
  try {
    const response = await callAnthropicWithRetry({ model: "claude-sonnet-4-6", max_tokens: 1024, system: effectiveSystemPrompt, messages: trimmedMessages });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || "API error" });
    const rawReply = data.content?.map((b) => b.text || "").join("") || "";
    const reply = rawReply.replace(/&lt;br\s*\/?&gt;/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
    const updatedDiagState = extractDiagStepFromResponse(reply, diagStateIn);
    if (updatedDiagState) setDiagState(clientId, updatedDiagState);
    if (testerName) {
      const lm = messages[messages.length - 1];
      if (lm?.role === 'user') appendToTranscript(testerName, clientId, 'user', typeof lm.content === 'string' ? lm.content : '');
      appendToTranscript(testerName, clientId, 'assistant', reply);
    }
    res.json({ reply, diagState: updatedDiagState || diagStateIn || null, usage: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:3000, system:PARTS_SYSTEM_PROMPT, messages:[{role:'user',content:prompt}] })
    });
    const data = await response.json();
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
