// Middleware for all /api/* routes.
//
// Responsibilities:
//   1. CORS — opensentry.tech + localhost origins, preflight support
//   2. Abuse protection — configurable per-IP cooldown and optional daily cap
//   3. Request validation — POST + application/json for /api/analyze
//   4. Error handling — unhandled exceptions → clean 500
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

// ---- Abuse protection ------------------------------------------------------

// Per-IP: timestamp of last accepted analysis request.
const ipLastRequest = new Map();

// Global daily counter. Resets when the UTC day changes.
let dailyCount = 0;
let dailyResetDate = todayUTC();

// Defaults are intentionally conservative and provider-agnostic. They protect
// the endpoint from rapid abuse out of the box without baking any specific
// vendor quota assumptions into the code.
const DEFAULT_IP_COOLDOWN_MS = 15_000;
const DEFAULT_DAILY_CAP = 0;

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function secondsUntilMidnightUTC() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((midnight - now) / 1000);
}

function parsePositiveInt(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function getRateLimitConfig(env) {
  // Env values are optional and parsed leniently so bad config falls back to
  // safe defaults instead of accidentally disabling protection or crashing.
  return {
    ipCooldownMs: parsePositiveInt(env?.ANALYZE_IP_COOLDOWN_MS, DEFAULT_IP_COOLDOWN_MS),
    dailyCap: parsePositiveInt(env?.ANALYZE_DAILY_CAP, DEFAULT_DAILY_CAP),
  };
}

function checkRateLimit(ip, config) {
  // Roll the daily counter at midnight UTC.
  const today = todayUTC();
  if (today !== dailyResetDate) {
    dailyCount = 0;
    dailyResetDate = today;
    ipLastRequest.clear(); // also purge stale IP entries
  }

  // Optional global daily cap.
  if (config.dailyCap > 0 && dailyCount >= config.dailyCap) {
    return {
      blocked: true,
      status: 429,
      error: 'daily_limit',
      message: `Daily analysis limit reached (${config.dailyCap}). Resets at midnight UTC.`,
      retryAfterSec: secondsUntilMidnightUTC(),
    };
  }

  // Optional per-IP cooldown.
  if (config.ipCooldownMs > 0) {
    const now = Date.now();
    const last = ipLastRequest.get(ip);
    if (last && now - last < config.ipCooldownMs) {
      const waitSec = Math.ceil((config.ipCooldownMs - (now - last)) / 1000);
      return {
        blocked: true,
        status: 429,
        error: 'ip_cooldown',
        message: `Please wait ${waitSec}s before submitting another analysis.`,
        retryAfterSec: waitSec,
      };
    }
  }

  return { blocked: false };
}

function recordRequest(ip, config) {
  // Record BEFORE the handler runs so that even a slow/failed analysis still
  // counts toward the configured window, preventing rapid retries of broken
  // requests from bypassing the app-level protection.
  if (config.ipCooldownMs > 0) {
    ipLastRequest.set(ip, Date.now());
  }
  if (config.dailyCap > 0) {
    dailyCount++;
  }
}

// ---- Middleware entry point -------------------------------------------------

export async function onRequest(context) {
  const { request, env } = context;
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

    // Abuse protection (checked before forwarding to the handler).
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const config = getRateLimitConfig(env);
    const limit = checkRateLimit(ip, config);
    if (limit.blocked) {
      return jsonResponse(limit.status, {
        error: limit.error,
        message: limit.message,
      }, allowed ? origin : null, { 'Retry-After': String(limit.retryAfterSec) });
    }

    // Record BEFORE the handler runs so that even a slow/failed analysis
    // still counts toward the rate window (preventing rapid retries of
    // broken requests from burning through quota).
    recordRequest(ip,config);
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

export {
  DEFAULT_DAILY_CAP as __DEFAULT_DAILY_CAP,
  DEFAULT_IP_COOLDOWN_MS as __DEFAULT_IP_COOLDOWN_MS,
  getRateLimitConfig as __getRateLimitConfig,
};
