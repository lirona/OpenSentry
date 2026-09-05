// Middleware for all /api/* routes.
//
// Responsibilities:
//   1. CORS — opensentry.tech + localhost origins, preflight support
//   2. Request validation — POST create and GET status requests for /api/analyze
//   3. Error handling — unhandled exceptions → clean 500

import { checkRunnerToken } from './lib/analyze-relay.js';
import { isAnalysisJobStatusPath } from './lib/analysis-job-contract.js';

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // 24 h
  };
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
  const isAnalyzeCreate = url.pathname === '/api/analyze';
  const isAnalyzeStatus = isAnalysisJobStatusPath(url.pathname);

  if (isAnalyzeCreate) {
    if (request.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' }, allowed ? origin : null);
    }

    // Content-Type check.
    const ct = (request.headers.get('Content-Type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      return jsonResponse(415, { error: 'unsupported_media_type', message: 'Content-Type must be application/json.' }, allowed ? origin : null);
    }
  } else if (isAnalyzeStatus && request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use GET.' }, allowed ? origin : null);
  }

  if (isAnalyzeCreate || isAnalyzeStatus) {
    const runnerTokenError = checkRunnerToken(request, env);
    if (runnerTokenError) {
      return withCors(runnerTokenError, allowed ? origin : null);
    }
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
    return withCors(response, origin);
  }

  return response;
}

// ---- Helpers ----------------------------------------------------------------

function jsonResponse(status, body, origin, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (origin) {
    Object.assign(headers, corsHeaders(origin));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function withCors(response, origin) {
  if (!origin) return response;
  const patched = new Response(response.body, response);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    patched.headers.set(k, v);
  }
  return patched;
}
