// Unit tests for functions/api/_middleware.js
//
// Run:  node --test tests/middleware.test.mjs
//
// Tests call `onRequest` directly with a fake Cloudflare Pages context. No
// network access needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  onRequest,
  __resetRateLimits,
  __DAILY_CAP,
  __IP_COOLDOWN_MS,
} from '../functions/api/_middleware.js';

// ---- helpers ---------------------------------------------------------------

function makeContext({ method = 'POST', url = 'https://opensentry.tech/api/analyze', origin, contentType, ip, nextResponse, nextThrows } = {}) {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  if (contentType) headers.set('Content-Type', contentType);
  if (ip) headers.set('CF-Connecting-IP', ip);

  const request = new Request(url, { method, headers });

  return {
    request,
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

// Reset state between tests.
test.beforeEach(() => __resetRateLimits());

// ---- CORS ------------------------------------------------------------------

test('OPTIONS preflight from allowed origin → 204 with CORS headers', async () => {
  const res = await onRequest(makeContext({
    method: 'OPTIONS',
    origin: 'https://opensentry.tech',
  }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
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
  // Should still pass through (CORS is browser-enforced), but no header.
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

// ---- non-analyze routes pass through without method/content checks ---------

test('GET /api/other → passes through (no method guard)', async () => {
  const res = await onRequest(makeContext({
    method: 'GET',
    url: 'https://opensentry.tech/api/other',
    origin: 'https://opensentry.tech',
  }));
  assert.equal(res.status, 200);
});

// ---- IP rate limiting ------------------------------------------------------

test('second request from same IP within 60s → 429 ip_cooldown', async () => {
  const opts = { contentType: 'application/json', origin: 'https://opensentry.tech', ip: '10.0.0.1' };

  const first = await onRequest(makeContext(opts));
  assert.equal(first.status, 200);

  const second = await onRequest(makeContext(opts));
  assert.equal(second.status, 429);
  const body = await json(second);
  assert.equal(body.error, 'ip_cooldown');
  assert.ok(second.headers.get('Retry-After'));
});

test('different IPs are independent', async () => {
  const base = { contentType: 'application/json', origin: 'https://opensentry.tech' };

  const a = await onRequest(makeContext({ ...base, ip: '10.0.0.1' }));
  assert.equal(a.status, 200);

  const b = await onRequest(makeContext({ ...base, ip: '10.0.0.2' }));
  assert.equal(b.status, 200);
});

// ---- global daily cap ------------------------------------------------------

test('requests beyond DAILY_CAP → 429 daily_limit', async () => {
  const base = { contentType: 'application/json', origin: 'https://opensentry.tech' };

  // Fire DAILY_CAP requests from unique IPs.
  for (let i = 0; i < __DAILY_CAP; i++) {
    const res = await onRequest(makeContext({ ...base, ip: `192.168.0.${i}` }));
    assert.equal(res.status, 200, `request ${i} should succeed`);
  }

  // Next request should be blocked regardless of IP.
  const over = await onRequest(makeContext({ ...base, ip: '192.168.1.1' }));
  assert.equal(over.status, 429);
  const body = await json(over);
  assert.equal(body.error, 'daily_limit');
  assert.ok(over.headers.get('Retry-After'));
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
  // Must not leak error internals.
  assert.ok(!body.message.includes('kaboom'));
  // CORS headers still attached for allowed origin.
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://opensentry.tech');
});
