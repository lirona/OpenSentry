// Integration tests for the public relay and local POST /api/analyze handlers.
//
// Run:  node --test tests/analyze.test.mjs
//
// These tests import onRequestPost directly and call it with a mock
// Cloudflare Pages context object. Both fetchSource and model calls are stubbed
// via globalThis.fetch, so no network access is needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost as onRelayRequest } from '../functions/api/analyze.js';
import { onRequestGet as onRelayStatusRequest } from '../functions/api/analyze/[jobId].js';
import { runLocalAnalysis } from '../functions/api/lib/local-analyze.js';

// ---- helpers ---------------------------------------------------------------

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const JOB_ID = '2dd20c93-e528-4e75-bd70-cf3e6f1699b9';

const ENV = {
  AI_API_KEY: 'test-ai-key',
  AI_MODEL: 'test-model',
  ETHERSCAN_API_KEY: 'test-etherscan-key',
};

function jobRequest(overrides = {}) {
  return {
    jobId: JOB_ID,
    address: ADDR,
    chain: 'ethereum',
    ...overrides,
  };
}

function makeRequest(body, options = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [key, value] of Object.entries(options.headers || {})) {
    headers.set(key, value);
  }

  return new Request('https://opensentry.tech/api/analyze', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function makeContext(body, envOverrides = {}, requestOptions = {}) {
  return {
    request: makeRequest(body, requestOptions),
    env: { ...ENV, ...envOverrides },
  };
}

function makeStatusContext(jobId = JOB_ID, envOverrides = {}, requestOptions = {}) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(requestOptions.headers || {})) {
    headers.set(key, value);
  }

  return {
    request: new Request(`https://opensentry.tech/api/analyze/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers,
    }),
    env: { ...ENV, ...envOverrides },
    params: { jobId },
  };
}

function upstreamResponse(status, body, contentType = 'application/json; charset=utf-8') {
  return {
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(url, init);
  return () => { globalThis.fetch = original; };
}

// A minimal verified single-file Etherscan V2 response.
function etherscanOk() {
  return {
    status: '1',
    message: 'OK',
    result: [{
      SourceCode: 'pragma solidity 0.8.20;\ncontract USDC { uint256 public x; }',
      ABI: '[{"inputs":[],"name":"x","outputs":[{"type":"uint256"}],"type":"function"}]',
      ContractName: 'USDC',
      CompilerVersion: 'v0.8.20+commit.a1b79de6',
      OptimizationUsed: '1',
      Runs: '200',
      ConstructorArguments: '',
      EVMVersion: 'paris',
      Library: '',
      LicenseType: 'MIT',
      Proxy: '0',
      Implementation: '',
      SwarmSource: '',
    }],
  };
}

function etherscanProxyOk() {
  return {
    status: '1',
    message: 'OK',
    result: [{
      SourceCode: 'pragma solidity 0.8.20;\ncontract Proxy { fallback() external payable {} }',
      ABI: '[]',
      ContractName: 'Proxy',
      CompilerVersion: 'v0.8.20+commit.a1b79de6',
      OptimizationUsed: '1',
      Runs: '200',
      ConstructorArguments: '',
      EVMVersion: 'paris',
      Library: '',
      LicenseType: 'MIT',
      Proxy: '1',
      Implementation: '0x1111111111111111111111111111111111111111',
      SwarmSource: '',
    }],
  };
}

function etherscanImplementationOk() {
  return {
    status: '1',
    message: 'OK',
    result: [{
      SourceCode: 'pragma solidity 0.8.20;\ncontract Impl { function x() external pure returns (uint256) { return 1; } }',
      ABI: '[]',
      ContractName: 'Impl',
      CompilerVersion: 'v0.8.20+commit.a1b79de6',
      OptimizationUsed: '1',
      Runs: '200',
      ConstructorArguments: '',
      EVMVersion: 'paris',
      Library: '',
      LicenseType: 'MIT',
      Proxy: '0',
      Implementation: '',
      SwarmSource: '',
    }],
  };
}

// A valid model output — all agents return SAFE for simplicity.
function modelSafe(agentName) {
  return JSON.stringify({
    agent: agentName,
    severity: 'SAFE',
    summary: `No issues found by ${agentName}.`,
    findings: [],
  });
}

// Agent names in the expected iteration order (from AGENTS in embedded-skills).
const AGENT_NAMES = [
  'Access Control', 'Token Mechanics', 'Economic & Fees', 'Oracle & Dependencies',
  'MEV & Tx Safety', 'Code Quality', 'Transparency', 'Governance',
];

// Build a combined stub that handles both Etherscan V2 and model calls.
function stubAll(options = {}) {
  const {
    etherscanResponse = etherscanOk(),
    modelHandler = null, // if null, default to SAFE for all agents
  } = options;
  let modelCallIndex = 0;

  return stubFetch(async (url) => {
    // Etherscan V2 calls go to api.etherscan.io/v2
    if (url.includes('etherscan.io')) {
      return {
        ok: true,
        status: 200,
        json: async () => etherscanResponse,
      };
    }
    // Model calls
    if (url.includes('generativelanguage.googleapis.com')) {
      if (modelHandler) return modelHandler(url, modelCallIndex++);
      const name = AGENT_NAMES[modelCallIndex++ % AGENT_NAMES.length];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: modelSafe(name) }] },
            finishReason: 'STOP',
          }],
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

// ---- desktop relay mode ----------------------------------------------------

test('relays valid job creation requests and preserves the 202 response', async () => {
  let seenUrl;
  let seenInit;
  const restore = stubFetch(async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return upstreamResponse(202, {
      success: true,
      jobId: JOB_ID,
      status: 'queued',
    });
  });

  try {
    const res = await onRelayRequest(makeContext(
      jobRequest({ chain: 'base' }),
      {
        ANALYZE_RELAY_URL: 'https://runner.example.com',
        ANALYZE_RELAY_TOKEN: 'runner-secret',
      },
      { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
    ));

    assert.equal(res.status, 202);
    assert.equal(seenUrl, 'https://runner.example.com/api/analyze');
    assert.equal(seenInit.method, 'POST');
    assert.equal(seenInit.redirect, 'manual');
    assert.equal(seenInit.headers.get('x-opensentry-runner-token'), 'runner-secret');
    assert.equal(seenInit.headers.get('x-forwarded-for'), '203.0.113.7');
    assert.deepEqual(JSON.parse(seenInit.body), {
      jobId: JOB_ID,
      address: ADDR,
      chain: 'base',
    });

    const body = await res.json();
    assert.deepEqual(body, {
      success: true,
      jobId: JOB_ID,
      status: 'queued',
    });
  } finally {
    restore();
  }
});

test('relays job status requests to the job-specific runner URL', async () => {
  let seenUrl;
  let seenInit;
  const expected = {
    success: true,
    jobId: JOB_ID,
    status: 'running',
  };
  const restore = stubFetch(async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return upstreamResponse(200, expected);
  });

  try {
    const res = await onRelayStatusRequest(makeStatusContext(
      JOB_ID,
      {
        ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze/',
        ANALYZE_RELAY_TOKEN: 'runner-secret',
      },
      { headers: { 'X-Forwarded-For': '198.51.100.4' } },
    ));

    assert.equal(res.status, 200);
    assert.equal(seenUrl, `https://runner.example.com/api/analyze/${JOB_ID}`);
    assert.equal(seenInit.method, 'GET');
    assert.equal(seenInit.redirect, 'manual');
    assert.equal(seenInit.body, undefined);
    assert.equal(seenInit.headers.get('x-opensentry-runner-token'), 'runner-secret');
    assert.equal(seenInit.headers.get('x-forwarded-for'), '198.51.100.4');
    assert.deepEqual(await res.json(), expected);
  } finally {
    restore();
  }
});

test('job creation rejects missing and invalid client job IDs before relay fetch', async () => {
  let fetchCalls = 0;
  const restore = stubFetch(async () => {
    fetchCalls += 1;
    throw new Error('should not fetch');
  });

  try {
    const cases = [
      { address: ADDR, chain: 'ethereum' },
      jobRequest({ jobId: null }),
      jobRequest({ jobId: '' }),
      jobRequest({ jobId: 'not-a-uuid' }),
      jobRequest({ jobId: '00000000-0000-1000-8000-000000000001' }),
    ];

    for (const body of cases) {
      const response = await onRelayRequest(makeContext(body, {
        ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
        ANALYZE_RELAY_TOKEN: 'runner-secret',
      }));

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        success: false,
        error: 'invalid_job_id',
        message: 'The analysis job ID is invalid.',
      });
    }
    assert.equal(fetchCalls, 0);
  } finally {
    restore();
  }
});

test('job status relay preserves structured runner 404 responses', async () => {
  const expected = {
    success: false,
    error: 'job_not_found',
    message: 'Analysis job not found.',
  };
  const restore = stubFetch(async () => upstreamResponse(404, expected));

  try {
    const res = await onRelayStatusRequest(makeStatusContext(
      JOB_ID,
      {
        ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
        ANALYZE_RELAY_TOKEN: 'runner-secret',
      },
    ));

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), expected);
  } finally {
    restore();
  }
});

test('job status relay rejects invalid job IDs before contacting the runner', async () => {
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    throw new Error('should not fetch');
  });

  try {
    const res = await onRelayStatusRequest(makeStatusContext(
      'not-a-job-id',
      {
        ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
        ANALYZE_RELAY_TOKEN: 'runner-secret',
      },
    ));

    assert.equal(res.status, 400);
    assert.equal(fetchCalled, false);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'invalid_job_id');
  } finally {
    restore();
  }
});

test('relay mode fails closed when ANALYZE_RELAY_TOKEN is missing', async () => {
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    throw new Error('should not fetch');
  });

  try {
    const res = await onRelayRequest(makeContext(
      jobRequest(),
      { ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze' },
    ));

    assert.equal(res.status, 500);
    assert.equal(fetchCalled, false);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'invalid_relay_config');
    assert.match(body.message, /ANALYZE_RELAY_TOKEN/);
  } finally {
    restore();
  }
});

test('public API fails closed when relay mode is not configured', async () => {
  const res = await onRelayRequest(makeContext(
    jobRequest(),
  ));

  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error, 'relay_not_configured');
});

test('public job status API fails closed when relay mode is not configured', async () => {
  const res = await onRelayStatusRequest(makeStatusContext(JOB_ID));

  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error, 'relay_not_configured');
});

test('job status relay fails closed when ANALYZE_RELAY_TOKEN is missing', async () => {
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    throw new Error('should not fetch');
  });

  try {
    const res = await onRelayStatusRequest(makeStatusContext(
      JOB_ID,
      { ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze' },
    ));

    assert.equal(res.status, 500);
    assert.equal(fetchCalled, false);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'invalid_relay_config');
  } finally {
    restore();
  }
});

test('relay mode rejects invalid ANALYZE_RELAY_URL', async () => {
  const res = await onRelayRequest(makeContext(
    jobRequest(),
    { ANALYZE_RELAY_URL: 'ftp://runner.example.com' },
  ));

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error, 'invalid_relay_url');
});

test('relay mode rejects an endpoint that points back to itself', async () => {
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    throw new Error('should not fetch');
  });

  try {
    const res = await onRelayRequest(makeContext(
      jobRequest(),
      {
        ANALYZE_RELAY_URL: 'https://opensentry.tech/api/analyze',
        ANALYZE_RELAY_TOKEN: 'runner-secret',
      },
    ));

    assert.equal(res.status, 500);
    assert.equal(fetchCalled, false);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'relay_loop');
  } finally {
    restore();
  }
});

test('relay mode returns 502 when the local runner cannot be reached', async () => {
  const restore = stubFetch(async () => {
    throw new Error('connect failed');
  });

  try {
    const res = await onRelayRequest(makeContext(
      jobRequest(),
      {
        ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
        ANALYZE_RELAY_TOKEN: 'runner-secret',
      },
    ));

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'relay_unavailable');
  } finally {
    restore();
  }
});

test('relay maps response-body stream failures to a safe unavailable response', async () => {
  const requests = [
    () => onRelayRequest(makeContext(jobRequest(), {
      ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
      ANALYZE_RELAY_TOKEN: 'runner-secret',
    })),
    () => onRelayStatusRequest(makeStatusContext(JOB_ID, {
      ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
      ANALYZE_RELAY_TOKEN: 'runner-secret',
    })),
  ];

  for (const request of requests) {
    const restore = stubFetch(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => { throw new Error('private stream failure'); },
    }));

    try {
      const response = await request();
      assert.equal(response.status, 502);
      const raw = await response.text();
      assert.match(raw, /"error":"relay_unavailable"/);
      assert.doesNotMatch(raw, /private stream failure/);
    } finally {
      restore();
    }
  }
});

test('relay normalizes JSON gateway timeouts for both creation and status requests', async () => {
  const requests = [
    () => onRelayRequest(makeContext(jobRequest(), {
      ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
      ANALYZE_RELAY_TOKEN: 'runner-secret',
    })),
    () => onRelayStatusRequest(makeStatusContext(JOB_ID, {
      ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
      ANALYZE_RELAY_TOKEN: 'runner-secret',
    })),
  ];

  for (const status of [504, 524]) {
    for (const request of requests) {
      const restore = stubFetch(async () => upstreamResponse(status, {
        success: false,
        error: 'gateway_generated_error',
        message: 'Generated outside the runner.',
      }));

      try {
        const response = await request();
        assert.equal(response.status, 504);
        assert.deepEqual(await response.json(), {
          success: false,
          error: 'relay_timeout',
          message: 'The connection to the local runner timed out. The audit may still be running.',
        });
      } finally {
        restore();
      }
    }
  }
});

test('relay normalizes JSON bad-gateway responses for both creation and status requests', async () => {
  const requests = [
    () => onRelayRequest(makeContext(jobRequest(), {
      ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
      ANALYZE_RELAY_TOKEN: 'runner-secret',
    })),
    () => onRelayStatusRequest(makeStatusContext(JOB_ID, {
      ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
      ANALYZE_RELAY_TOKEN: 'runner-secret',
    })),
  ];

  for (const request of requests) {
    const restore = stubFetch(async () => upstreamResponse(502, {
      success: false,
      message: 'Generated outside the runner.',
    }));

    try {
      const response = await request();
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        success: false,
        error: 'relay_unavailable',
        message: 'Local runner is unavailable. Make sure your desktop server and tunnel are running.',
      });
    } finally {
      restore();
    }
  }
});

for (const invalidResponse of [
  {
    name: 'a non-JSON response',
    contentType: 'text/html',
    body: '<html>upstream error</html>',
  },
  {
    name: 'malformed JSON with a JSON content type',
    contentType: 'application/json',
    body: '{',
  },
]) {
  for (const status of [504, 524]) {
    test(`relay maps ${invalidResponse.name} with status ${status} to relay_timeout`, async () => {
      const restore = stubFetch(async () => upstreamResponse(
        status,
        invalidResponse.body,
        invalidResponse.contentType,
      ));

      try {
        const res = await onRelayRequest(makeContext(
          jobRequest(),
          {
            ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
            ANALYZE_RELAY_TOKEN: 'runner-secret',
          },
        ));

        assert.equal(res.status, 504);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.error, 'relay_timeout');
      } finally {
        restore();
      }
    });
  }

  for (const status of [500, 502, 503, 599]) {
    test(`relay maps ${invalidResponse.name} with status ${status} to relay_unavailable`, async () => {
      const restore = stubFetch(async () => upstreamResponse(
        status,
        invalidResponse.body,
        invalidResponse.contentType,
      ));

      try {
        const res = await onRelayRequest(makeContext(
          jobRequest(),
          {
            ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
            ANALYZE_RELAY_TOKEN: 'runner-secret',
          },
        ));

        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.error, 'relay_unavailable');
      } finally {
        restore();
      }
    });
  }

  for (const status of [200, 202, 299]) {
    test(`relay maps ${invalidResponse.name} with status ${status} to relay_bad_response`, async () => {
      const restore = stubFetch(async () => upstreamResponse(
        status,
        invalidResponse.body,
        invalidResponse.contentType,
      ));

      try {
        const res = await onRelayRequest(makeContext(
          jobRequest(),
          {
            ANALYZE_RELAY_URL: 'https://runner.example.com/api/analyze',
            ANALYZE_RELAY_TOKEN: 'runner-secret',
          },
        ));

        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.error, 'relay_bad_response');
      } finally {
        restore();
      }
    });
  }
}

// ---- source fetch errors ---------------------------------------------------

test('local analysis throws a structured error for unverified contracts', async () => {
  const restore = stubAll({
    etherscanResponse: {
      status: '1',
      message: 'OK',
      result: [{
        SourceCode: '',
        ABI: '',
        ContractName: '',
        CompilerVersion: '',
        OptimizationUsed: '0',
        Runs: '0',
        ConstructorArguments: '',
        EVMVersion: '',
        Library: '',
        LicenseType: '',
        Proxy: '0',
        Implementation: '',
        SwarmSource: '',
      }],
    },
  });
  try {
    await assert.rejects(
      runLocalAnalysis({ address: ADDR, chain: 'ethereum', env: ENV }),
      error => {
        assert.equal(error.code, 'unverified');
        assert.match(error.message, /not verified/i);
        return true;
      },
    );
  } finally {
    restore();
  }
});

// ---- happy path: full pipeline ---------------------------------------------

test('happy path: all agents SAFE produces the full report shape', async () => {
  const restore = stubAll();
  try {
    const body = await runLocalAnalysis({ address: ADDR, chain: 'ethereum', env: ENV });
    assert.equal(body.contractName, 'USDC');
    assert.equal(body.address, ADDR);
    assert.equal(body.chain, 'ethereum');
    assert.equal(body.isProxy, false);
    assert.equal(body.implementationAddress, null);
    assert.equal(body.implementationContractName, null);
    assert.ok(body.timestamp);

    const r = body.report;
    assert.equal(r.overallSeverity, 'SAFE');
    assert.equal(r.criticalCount, 0);
    assert.equal(r.warningCount, 0);
    assert.equal(r.infoCount, 0);
    assert.deepEqual(r.findings, []);
    assert.equal(r.agentSummaries.length, 8);
    assert.equal(r.bottomLine.level, 'NO_CONCERN');
    assert.equal(r.bottomLine.label, 'No concern');
    assert.equal(r.bottomLine.sentence, 'We didn\'t find any major security concerns with this contract.');
    assert.equal(r.bottomLine.generated, false);

    for (const s of r.agentSummaries) {
      assert.equal(s.status, 'completed');
      assert.equal(s.severity, 'SAFE');
    }
  } finally {
    restore();
  }
});

test('proxy metadata is surfaced in the API response', async () => {
  let explorerCallCount = 0;
  const restore = stubFetch(async (url) => {
    if (url.includes('etherscan.io')) {
      explorerCallCount++;
      return {
        ok: true,
        status: 200,
        json: async () => explorerCallCount === 1 ? etherscanProxyOk() : etherscanImplementationOk(),
      };
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: modelSafe('Access Control') }] },
            finishReason: 'STOP',
          }],
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  try {
    const body = await runLocalAnalysis({ address: ADDR, chain: 'ethereum', env: ENV });
    assert.equal(body.contractName, 'Proxy');
    assert.equal(body.isProxy, true);
    assert.equal(body.implementationAddress, '0x1111111111111111111111111111111111111111');
    assert.equal(body.implementationContractName, 'Impl');
  } finally {
    restore();
  }
});

// ---- mixed success + failure -----------------------------------------------

test('some agents fail → report still returns with partial results', async () => {
  let callIdx = 0;
  const restore = stubAll({
    modelHandler: () => {
      const i = callIdx++;
      // First agent returns a WARNING finding; the rest fail with 500.
      if (i === 0) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    agent: 'Access Control',
                    severity: 'WARNING',
                    summary: 'One issue found.',
                    findings: [{
                      check: 'Missing initializer guard',
                      severity: 'WARNING',
                      location: 'USDC.sol:1',
                      summary: 'No guard on init.',
                      detail: 'The init function is missing a guard.',
                      user_impact: 'Anyone can call init.',
                    }],
                  }),
                }],
              },
              finishReason: 'STOP',
            }],
          }),
        };
      }
      return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) };
    },
  });
  try {
    const body = await runLocalAnalysis({ address: ADDR, chain: 'ethereum', env: ENV });

    const r = body.report;
    assert.equal(r.overallSeverity, 'WARNING');
    assert.equal(r.warningCount, 1);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].id, 'OS-001');
    assert.equal(r.bottomLine.level, 'SOME_CONCERNS');
    assert.equal(r.bottomLine.generated, false);
    assert.equal(r.bottomLine.coverage.status, 'partial');

    // First agent completed; rest failed.
    assert.equal(r.agentSummaries[0].status, 'completed');
    for (let i = 1; i < 8; i++) {
      assert.equal(r.agentSummaries[i].status, 'failed');
    }
  } finally {
    restore();
  }
});

test('all agents can fail while the pipeline still returns an incomplete report', async () => {
  const restore = stubAll({
    modelHandler: () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    }),
  });

  try {
    const body = await runLocalAnalysis({ address: ADDR, chain: 'ethereum', env: ENV });
    const report = body.report;

    assert.equal(report.overallSeverity, 'unknown');
    assert.equal(report.findings.length, 0);
    assert.equal(report.agentSummaries.length, 8);
    assert.equal(report.agentSummaries.every(summary => summary.status === 'failed'), true);
    assert.equal(report.bottomLine.level, null);
    assert.equal(report.bottomLine.coverage.status, 'unavailable');
  } finally {
    restore();
  }
});
