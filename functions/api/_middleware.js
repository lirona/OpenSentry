// Middleware for all /api/* routes.
//
// Responsibilities:
//   1. CORS — opensentry.tech + localhost origins, preflight support
//   2. IP rate limiting — 1 analysis per IP per 60 s (Gemini 10 RPM)
//   3. Global daily cap — ~30 analyses/day (Gemini 250 RPD / 8 agents)
//   4. Request validation — POST + application/json for /api/analyze
//   5. Error handling — unhandled exceptions → clean 500
//
// Rate-limit state lives in module-scope Maps. Because Cloudflare Workers
// instances are ephemeral and non-shared, this is best-effort — enough for
// the PoC but not production-grade.

// ---- CORS config -----------------------------------------------------------

const ALLOWED_ORIGINS = [
  'https://opensentry.tech',
  'https://www.opensentry.tech',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // localhost on any port for local dev.
  return /^https?:\/\/localhost(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // 24 h
  };
}

// ---- Rate limiting ---------------------------------------------------------

// Per-IP: timestamp of last accepted analysis request.
const ipLastRequest = new Map();

// Global daily counter. Resets when the UTC day changes.
let dailyCount = 0;
let dailyResetDate = todayUTC();

const IP_COOLDOWN_MS = 60_000;       // 1 request per IP per 60 s
const DAILY_CAP = 30;                // ~240 agent calls / 250 RPD

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function checkRateLimit(ip) {
  // Roll the daily counter at midnight UTC.
  const today = todayUTC();
  if (today !== dailyResetDate) {
    dailyCount = 0;
    dailyResetDate = today;
    ipLastRequest.clear(); // also purge stale IP entries
  }

  // Global daily cap.
  if (dailyCount >= DAILY_CAP) {
    return {
      blocked: true,
      status: 429,
      error: 'daily_limit',
      message: `Daily analysis limit reached (${DAILY_CAP}). Resets at midnight UTC.`,
      retryAfterSec: secondsUntilMidnightUTC(),
    };
  }

  // Per-IP cooldown.
  const now = Date.now();
  const last = ipLastRequest.get(ip);
  if (last && now - last < IP_COOLDOWN_MS) {
    const waitSec = Math.ceil((IP_COOLDOWN_MS - (now - last)) / 1000);
    return {
      blocked: true,
      status: 429,
      error: 'ip_cooldown',
      message: `Please wait ${waitSec}s before submitting another analysis.`,
      retryAfterSec: waitSec,
    };
  }

  return { blocked: false };
}

function recordRequest(ip) {
  ipLastRequest.set(ip, Date.now());
  dailyCount++;
}

function secondsUntilMidnightUTC() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((midnight - now) / 1000);
}

// ---- Middleware entry point -------------------------------------------------

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const allowed = isAllowedOrigin(origin);

  // ---- CORS preflight -------------------------------------------------------
  if (request.method === 'OPTIONS') {
    if (!allowed) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  }

  // ---- /api/analyze-specific guards -----------------------------------------
  const isAnalyze = url.pathname === '/api/analyze';

  if (isAnalyze) {
    // Method check — only POST.
    if (request.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' }, allowed ? origin : null);
    }

    // Content-Type check.
    const ct = (request.headers.get('Content-Type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      return jsonResponse(415, { error: 'unsupported_media_type', message: 'Content-Type must be application/json.' }, allowed ? origin : null);
    }

    // Rate limiting (checked before forwarding to the handler).
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const limit = checkRateLimit(ip);
    if (limit.blocked) {
      return jsonResponse(limit.status, {
        error: limit.error,
        message: limit.message,
      }, allowed ? origin : null, { 'Retry-After': String(limit.retryAfterSec) });
    }

    // Record BEFORE the handler runs so that even a slow/failed analysis
    // still counts toward the rate window (preventing rapid retries of
    // broken requests from burning through the Gemini quota).
    recordRequest(ip);
  }

  // ---- Forward to route handler with error boundary -------------------------
  let response;
  try {
    response = await context.next();
  } catch (err) {
    // Unhandled errors → clean 500 that doesn't leak internals.
    console.error('Unhandled error in route handler:', err);
    return jsonResponse(500, {
      error: 'internal_error',
      message: 'An unexpected error occurred. Please try again later.',
    }, allowed ? origin : null);
  }

  // ---- Attach CORS headers to the response ----------------------------------
  if (allowed) {
    const patched = new Response(response.body, response);
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      patched.headers.set(k, v);
    }
    return patched;
  }

  return response;
}

// ---- Helpers ----------------------------------------------------------------

function jsonResponse(status, body, origin, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
  if (origin) {
    Object.assign(headers, corsHeaders(origin));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// Exported for tests only — allows resetting module-level state between runs.
export function __resetRateLimits() {
  ipLastRequest.clear();
  dailyCount = 0;
  dailyResetDate = todayUTC();
}

export { DAILY_CAP as __DAILY_CAP, IP_COOLDOWN_MS as __IP_COOLDOWN_MS };
