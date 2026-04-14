import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeContractSource,
  analyzeContractSourceWithOptions,
  __internal,
} from '../functions/api/lib/analyze-pipeline.js';

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(url, init);
  return () => {
    globalThis.fetch = original;
  };
}

function geminiSafe(agentName) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { parts: [{ text: JSON.stringify({
          agent: agentName,
          severity: 'SAFE',
          summary: `No issues found by ${agentName}.`,
          findings: [],
        }) }] },
        finishReason: 'STOP',
      }],
    }),
  };
}

const SOURCE_RESULT = {
  success: true,
  contractName: 'Vault',
  compiler: 'v0.8.20+commit.a1b79de6',
  source: 'pragma solidity 0.8.20;\ncontract Vault {}',
  files: [{ name: 'Vault.sol', content: 'pragma solidity 0.8.20;\ncontract Vault {}' }],
  isProxy: false,
  implementationAddress: null,
};

const ENV = { AI_API_KEY: 'test-key', AI_MODEL: 'test-model' };

test('analyzeContractSource returns merged analysis without trace by default', { concurrency: false }, async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return geminiSafe('Access Control');
  });

  try {
    const result = await analyzeContractSource({
      sourceResult: SOURCE_RESULT,
      address: 'local://Vault.sol',
      chain: 'local',
      env: ENV,
    });

    assert.equal(calls, 8);
    assert.equal(result.contractName, 'Vault');
    assert.equal(result.report.overallSeverity, 'SAFE');
    assert.equal('trace' in result, false);
  } finally {
    restore();
  }
});

test('analyzeContractSourceWithOptions includes trace data and serializes failed agent runs', { concurrency: false }, async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    if (calls <= 2) {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: { message: 'temporary' } }),
      };
    }
    return geminiSafe('Access Control');
  });

  try {
    const result = await analyzeContractSourceWithOptions({
      sourceResult: SOURCE_RESULT,
      address: 'local://Vault.sol',
      chain: 'local',
      env: ENV,
      includeTrace: true,
    });

    assert.equal(result.trace.agentConfigs.length, 8);
    assert.equal(result.trace.agentRuns.length, 8);
    assert.equal(result.trace.mergedReport, result.report);
    assert.equal(result.trace.agentRuns[0].settled.status, 'fulfilled');
    assert.equal(result.trace.agentRuns[0].settled.value.ok, false);
  } finally {
    restore();
  }
});

test('analyzeContractSource rejects unsuccessful source results', { concurrency: false }, async () => {
  await assert.rejects(
    () => analyzeContractSource({
      sourceResult: { success: false },
      address: 'local://bad',
      chain: 'local',
      env: ENV,
    }),
    /sourceResult must be a successful fetch result/,
  );
});

test('getAgentConcurrency normalizes empty, invalid, and oversized values', { concurrency: false }, () => {
  assert.equal(__internal.getAgentConcurrency({}), 1);
  assert.equal(__internal.getAgentConcurrency({ AI_AGENT_CONCURRENCY: '' }), 1);
  assert.equal(__internal.getAgentConcurrency({ AI_AGENT_CONCURRENCY: '0' }), 1);
  assert.equal(__internal.getAgentConcurrency({ AI_AGENT_CONCURRENCY: '2' }), 2);
  assert.equal(__internal.getAgentConcurrency({ AI_AGENT_CONCURRENCY: '999' }), 8);
});

test('runAllSettledLimited preserves order across fulfilled and rejected workers', { concurrency: false }, async () => {
  const items = ['a', 'b', 'c'];
  const results = await __internal.runAllSettledLimited(items, 2, async (item, index) => {
    if (item === 'b') throw new Error(`bad-${index}`);
    return `${item}-${index}`;
  });

  assert.deepEqual(results[0], { status: 'fulfilled', value: 'a-0' });
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /bad-1/);
  assert.deepEqual(results[2], { status: 'fulfilled', value: 'c-2' });
});

test('serializeAgentRun converts rejected Error reasons into JSON-safe objects', { concurrency: false }, () => {
  const serialized = __internal.serializeAgentRun({
    key: 'access-control',
    name: 'Access Control',
    settled: {
      status: 'rejected',
      reason: new Error('boom'),
    },
  });

  assert.equal(serialized.key, 'access-control');
  assert.equal(serialized.settled.status, 'rejected');
  assert.equal(serialized.settled.reason.message, 'boom');
  assert.equal(serialized.settled.reason.name, 'Error');
});
