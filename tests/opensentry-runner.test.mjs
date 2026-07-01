import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import {
  assertRunnerEnvironment,
  createRunnerServer,
} from '../bin/opensentry-runner.js';

const TOKEN = 'runner-secret';
const BASE_ENV = {
  ANALYZE_RELAY_TOKEN: TOKEN,
  ANALYZE_IP_COOLDOWN_MS: '0',
};

test('runner refuses to start without ANALYZE_RELAY_TOKEN', () => {
  assert.throws(
    () => assertRunnerEnvironment({}),
    /ANALYZE_RELAY_TOKEN is required/,
  );
});

test('runner refuses to start with ANALYZE_RELAY_URL', () => {
  assert.throws(
    () => assertRunnerEnvironment({
      ANALYZE_RELAY_TOKEN: TOKEN,
      ANALYZE_RELAY_URL: 'https://relay.example/api/analyze',
    }),
    /ANALYZE_RELAY_URL must not be set/,
  );
});

test('runner health endpoint reports runner mode', async () => {
  await withRunner({}, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      success: true,
      mode: 'runner',
    });
  });
});

test('runner returns 404 for unknown routes', async () => {
  await withRunner({}, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  });
});

test('runner rejects analyze requests without the shared token', async () => {
  await withRunner({}, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'invalid', chain: 'ethereum' }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized_runner_request');
  });
});

test('runner accepts the token and reaches analyze validation', async () => {
  await withRunner({}, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensentry-runner-token': TOKEN,
      },
      body: JSON.stringify({ address: 'invalid', chain: 'ethereum' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_address');
  });
});

test('runner rejects non-POST analyze requests', async () => {
  await withRunner({}, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      headers: {
        'x-opensentry-runner-token': TOKEN,
      },
    });
    assert.equal(res.status, 405);
    assert.equal((await res.json()).error, 'method_not_allowed');
  });
});

test('runner rejects oversized request bodies', async () => {
  await withRunner({ maxRequestBytes: 16 }, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensentry-runner-token': TOKEN,
      },
      body: JSON.stringify({ address: 'this body is too large' }),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, 'request_too_large');
  });
});

test('runner converts unexpected handler failures into JSON errors', async () => {
  await withRunner({
    analyzeHandler: async () => {
      throw new Error('kaboom');
    },
  }, async baseUrl => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opensentry-runner-token': TOKEN,
        },
        body: JSON.stringify({
          address: '0x1111111111111111111111111111111111111111',
          chain: 'ethereum',
        }),
      });
      assert.equal(res.status, 500);
      assert.equal((await res.json()).error, 'internal_error');
    } finally {
      console.error = originalError;
    }
  });
});

async function withRunner(options, run) {
  const server = createRunnerServer({
    env: { ...BASE_ENV, ...(options.env || {}) },
    analyzeHandler: options.analyzeHandler,
    maxRequestBytes: options.maxRequestBytes,
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}
