// Integration tests for functions/api/analyze.js (POST /api/analyze)
//
// Run:  node --test tests/analyze.test.mjs
//
// These tests import onRequestPost directly and call it with a mock
// Cloudflare Pages context object. Both fetchSource and GLM are stubbed
// via globalThis.fetch, so no network access is needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/api/analyze.js';

// ---- helpers ---------------------------------------------------------------

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const ENV = {
  ZAI_API_KEY: 'test-zai-key',
  ETHERSCAN_API_KEY: 'test-etherscan-key',
};

function makeRequest(body) {
  return new Request('https://opensentry.tech/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeContext(body, envOverrides = {}) {
  return {
    request: makeRequest(body),
    env: { ...ENV, ...envOverrides },
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

// A valid GLM agent output — all agents return SAFE for simplicity.
function glmSafe(agentName) {
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

// Build a combined stub that handles both Etherscan V2 and GLM calls.
function stubAll(options = {}) {
  const {
    etherscanResponse = etherscanOk(),
    glmHandler = null, // if null, default to SAFE for all agents
  } = options;
  let glmCallIndex = 0;

  return stubFetch(async (url) => {
    // Etherscan V2 calls go to api.etherscan.io/v2
    if (url.includes('etherscan.io')) {
      return {
        ok: true,
        status: 200,
        json: async () => etherscanResponse,
      };
    }
    // GLM calls
    if (url.includes('api.z.ai')) {
      if (glmHandler) return glmHandler(url, glmCallIndex++);
      const name = AGENT_NAMES[glmCallIndex++ % AGENT_NAMES.length];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: { content: glmSafe(name) },
            finish_reason: 'stop',
          }],
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

// ---- input validation ------------------------------------------------------

test('rejects non-JSON body', async () => {
  const context = {
    request: new Request('https://opensentry.tech/api/analyze', {
      method: 'POST',
      body: 'not json',
    }),
    env: ENV,
  };
  const res = await onRequestPost(context);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_json');
});

test('rejects bad address', async () => {
  const res = await onRequestPost(makeContext({ address: '0xBAD', chain: 'ethereum' }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_address');
});

test('rejects unsupported chain', async () => {
  const res = await onRequestPost(makeContext({ address: ADDR, chain: 'solana' }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'unsupported_chain');
});

// ---- source fetch errors ---------------------------------------------------

test('returns 422 for unverified contracts', async () => {
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
    const res = await onRequestPost(makeContext({ address: ADDR, chain: 'ethereum' }));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'unverified');
  } finally {
    restore();
  }
});

// ---- happy path: full pipeline ---------------------------------------------

test('happy path: all agents SAFE → 200 with full report shape', async () => {
  const restore = stubAll();
  try {
    const res = await onRequestPost(makeContext({ address: ADDR, chain: 'ethereum' }));
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
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
    if (url.includes('api.z.ai')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: { content: glmSafe('Access Control') },
            finish_reason: 'stop',
          }],
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  try {
    const res = await onRequestPost(makeContext({ address: ADDR, chain: 'ethereum' }));
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
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
    glmHandler: () => {
      const i = callIdx++;
      // First agent returns a WARNING finding; the rest fail with 500.
      if (i === 0) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
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
              },
              finish_reason: 'stop',
            }],
          }),
        };
      }
      return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) };
    },
  });
  try {
    const res = await onRequestPost(makeContext({ address: ADDR, chain: 'ethereum' }));
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);

    const r = body.report;
    assert.equal(r.overallSeverity, 'WARNING');
    assert.equal(r.warningCount, 1);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].id, 'OS-001');

    // First agent completed; rest failed.
    assert.equal(r.agentSummaries[0].status, 'completed');
    for (let i = 1; i < 8; i++) {
      assert.equal(r.agentSummaries[i].status, 'failed');
    }
  } finally {
    restore();
  }
});
