// Unit tests for functions/api/_middleware.js
//
// Run:  node --test tests/middleware.test.mjs
//
// Tests call `onRequest` directly with a fake Cloudflare Pages context. No
// network access needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from '../functions/api/_middleware.js';

// ---- helpers ---------------------------------------------------------------

function makeContext({
  method = 'POST',
  url = 'https://opensentry.tech/api/analyze',
  origin,
  contentType,
  ip,
  env,
  headers: extraHeaders,
  nextResponse,
  nextThrows,
} = {}) {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  if (contentType) headers.set('Content-Type', contentType);
  if (ip) headers.set('CF-Connecting-IP', ip);
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    headers.set(key, value);
  }

  const request = new Request(url, { method, headers });

  return {
    request,
    env: env || {},
    next: nextThrows
      ? async () => { throw nextThrows; }
      : async () => nextResponse || new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
  };
}

async function json(res) {
  return res.json();
}

// ---- CORS ------------------------------------------------------------------

test('OPTIONS preflight from allowed origin → 204 with CORS headers', async () => {
  const res = await onRequest(makeContext({
    method: 'OPTIONS',
    origin: 'https://opensentry.tech',
  }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
});

test('OPTIONS preflight for a job status route allows GET', async () => {
  const res = await onRequest(makeContext({
    method: 'OPTIONS',
    url: 'https://opensentry.tech/api/analyze/2dd20c93-e528-4e75-bd70-cf3e6f1699b9',
    origin: 'https://opensentry.tech',
  }));

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
});

test('OPTIONS preflight from localhost → 204', async () => {
  const res = await onRequest(makeContext({
    method: 'OPTIONS',
    origin: 'http://localhost:8788',
  }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8788');
});

test('OPTIONS preflight from disallowed origin → 403', async () => {
  const res = await onRequest(makeContext({
    method: 'OPTIONS',
    origin: 'https://evil.com',
  }));
  assert.equal(res.status, 403);
});

test('response from allowed origin gets CORS headers attached', async () => {
  const res = await onRequest(makeContext({
    origin: 'https://opensentry.tech',
    contentType: 'application/json',
    ip: '1.2.3.4',
  }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
});

test('response from disallowed origin has no CORS headers', async () => {
  const res = await onRequest(makeContext({
    origin: 'https://evil.com',
    contentType: 'application/json',
    ip: '1.2.3.4',
  }));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

// ---- request validation (POST + JSON) for /api/analyze --------------------

test('GET /api/analyze → 405', async () => {
  const res = await onRequest(makeContext({
    method: 'GET',
    origin: 'https://opensentry.tech',
  }));
  assert.equal(res.status, 405);
  const body = await json(res);
  assert.equal(body.error, 'method_not_allowed');
});

test('POST /api/analyze without application/json → 415', async () => {
  const res = await onRequest(makeContext({
    contentType: 'text/plain',
    origin: 'https://opensentry.tech',
    ip: '1.2.3.4',
  }));
  assert.equal(res.status, 415);
  const body = await json(res);
  assert.equal(body.error, 'unsupported_media_type');
});

test('POST /api/analyze with application/json; charset=utf-8 → passes', async () => {
  const res = await onRequest(makeContext({
    contentType: 'application/json; charset=utf-8',
    origin: 'https://opensentry.tech',
    ip: '1.2.3.4',
  }));
  assert.equal(res.status, 200);
});

test('GET /api/analyze/:jobId passes without a Content-Type header', async () => {
  const res = await onRequest(makeContext({
    method: 'GET',
    url: 'https://opensentry.tech/api/analyze/2dd20c93-e528-4e75-bd70-cf3e6f1699b9',
    origin: 'https://opensentry.tech',
  }));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
});

test('POST /api/analyze/:jobId returns 405 before content-type validation', async () => {
  let nextCalled = false;
  const context = makeContext({
    method: 'POST',
    url: 'https://opensentry.tech/api/analyze/2dd20c93-e528-4e75-bd70-cf3e6f1699b9',
    contentType: 'text/plain',
    origin: 'https://opensentry.tech',
  });
  context.next = async () => {
    nextCalled = true;
    return new Response();
  };

  const res = await onRequest(context);

  assert.equal(res.status, 405);
  assert.equal(nextCalled, false);
  assert.equal((await json(res)).error, 'method_not_allowed');
});

test('POST /api/analyze without required local-runner token → 401', async () => {
  let nextCalled = false;
  const context = makeContext({
    contentType: 'application/json',
    origin: 'https://opensentry.tech',
    ip: '1.2.3.4',
    env: { ANALYZE_RELAY_TOKEN: 'runner-secret' },
  });
  context.next = async () => {
    nextCalled = true;
    return new Response(JSON.stringify({ ok: true }));
  };

  const res = await onRequest(context);

  assert.equal(res.status, 401);
  assert.equal(nextCalled, false);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
  const body = await json(res);
  assert.equal(body.error, 'unauthorized_runner_request');
});

test('POST /api/analyze with required local-runner token → passes', async () => {
  const res = await onRequest(makeContext({
    contentType: 'application/json',
    origin: 'https://opensentry.tech',
    ip: '1.2.3.4',
    env: { ANALYZE_RELAY_TOKEN: 'runner-secret' },
    headers: { 'x-opensentry-runner-token': 'runner-secret' },
  }));

  assert.equal(res.status, 200);
});

test('POST /api/analyze relay mode does not require browser token', async () => {
  const res = await onRequest(makeContext({
    contentType: 'application/json',
    origin: 'https://opensentry.tech',
    ip: '1.2.3.4',
    env: {
      ANALYZE_RELAY_TOKEN: 'runner-secret',
      ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
    },
  }));

  assert.equal(res.status, 200);
});

test('GET /api/analyze/:jobId without required local-runner token returns 401', async () => {
  let nextCalled = false;
  const context = makeContext({
    method: 'GET',
    url: 'https://opensentry.tech/api/analyze/2dd20c93-e528-4e75-bd70-cf3e6f1699b9',
    origin: 'https://opensentry.tech',
    env: { ANALYZE_RELAY_TOKEN: 'runner-secret' },
  });
  context.next = async () => {
    nextCalled = true;
    return new Response(JSON.stringify({ ok: true }));
  };

  const res = await onRequest(context);

  assert.equal(res.status, 401);
  assert.equal(nextCalled, false);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
  assert.equal((await json(res)).error, 'unauthorized_runner_request');
});

test('GET /api/analyze/:jobId with required local-runner token passes', async () => {
  const res = await onRequest(makeContext({
    method: 'GET',
    url: 'https://opensentry.tech/api/analyze/2dd20c93-e528-4e75-bd70-cf3e6f1699b9',
    origin: 'https://opensentry.tech',
    env: { ANALYZE_RELAY_TOKEN: 'runner-secret' },
    headers: { 'x-opensentry-runner-token': 'runner-secret' },
  }));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
});

test('GET /api/analyze/:jobId in relay mode does not require a browser token', async () => {
  const res = await onRequest(makeContext({
    method: 'GET',
    url: 'https://opensentry.tech/api/analyze/2dd20c93-e528-4e75-bd70-cf3e6f1699b9',
    origin: 'https://opensentry.tech',
    env: {
      ANALYZE_RELAY_TOKEN: 'runner-secret',
      ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
    },
  }));

  assert.equal(res.status, 200);
});

// ---- non-analyze routes pass through without method/content checks ---------

test('GET /api/other → passes through (no method guard)', async () => {
  const res = await onRequest(makeContext({
    method: 'GET',
    url: 'https://opensentry.tech/api/other',
    origin: 'https://opensentry.tech',
  }));
  assert.equal(res.status, 200);
});

test('analyze-like routes do not receive job-route guards', async () => {
  const res = await onRequest(makeContext({
    method: 'GET',
    url: 'https://opensentry.tech/api/analyze-extra',
    origin: 'https://opensentry.tech',
    env: { ANALYZE_RELAY_TOKEN: 'runner-secret' },
  }));

  assert.equal(res.status, 200);
});

// ---- repeated analyses -----------------------------------------------------

test('repeated requests from the same IP are accepted immediately', async () => {
  const opts = { contentType: 'application/json', origin: 'https://opensentry.tech', ip: '10.0.0.1' };

  const first = await onRequest(makeContext(opts));
  const second = await onRequest(makeContext(opts));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('Retry-After'), null);
});

test('legacy limit environment variables do not restrict analyses', async () => {
  const base = {
    contentType: 'application/json',
    origin: 'https://opensentry.tech',
    env: { ANALYZE_DAILY_CAP: '1', ANALYZE_IP_COOLDOWN_MS: '60000' },
  };

  for (let i = 0; i < 4; i++) {
    const res = await onRequest(makeContext({ ...base, ip: '192.168.0.1' }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Retry-After'), null);
  }
});

test('a failed analysis does not prevent an immediate retry', async () => {
  const opts = {
    contentType: 'application/json',
    origin: 'https://opensentry.tech',
    ip: '10.0.0.1',
    nextThrows: new Error('temporary failure'),
  };

  const failed = await onRequest(makeContext(opts));
  const retry = await onRequest(makeContext({ ...opts, nextThrows: undefined }));

  assert.equal(failed.status, 500);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('Retry-After'), null);
});

// ---- error handling --------------------------------------------------------

test('unhandled exception in next() → clean 500', async () => {
  const res = await onRequest(makeContext({
    contentType: 'application/json',
    origin: 'https://opensentry.tech',
    ip: '99.99.99.99',
    nextThrows: new Error('kaboom'),
  }));
  assert.equal(res.status, 500);
  const body = await json(res);
  assert.equal(body.error, 'internal_error');
  assert.ok(!body.message.includes('kaboom'));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
});
