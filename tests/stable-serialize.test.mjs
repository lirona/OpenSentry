import test from 'node:test';
import assert from 'node:assert/strict';

import { stableSerialize } from '../functions/api/lib/stable-serialize.js';

test('stableSerialize is deterministic across object key order', () => {
  const first = stableSerialize({
    location: 'Vault.sol:10',
    ruleId: 'privileged-mint',
    check: 'Privileged mint path',
  });
  const second = stableSerialize({
    check: 'Privileged mint path',
    ruleId: 'privileged-mint',
    location: 'Vault.sol:10',
  });

  assert.equal(first, second);
});

test('stableSerialize distinguishes different deterministic finding key shapes', () => {
  const first = stableSerialize({
    ruleId: 'a|b',
    location: 'c',
    check: 'd',
  });
  const second = stableSerialize({
    ruleId: 'a',
    location: 'b|c',
    check: 'd',
  });

  assert.notEqual(first, second);
});

test('stableSerialize handles nested arrays and objects recursively', () => {
  const first = stableSerialize({
    ruleId: 'upgrade-without-timelock',
    metadata: {
      contracts: ['Vault', 'Proxy'],
      details: { line: 42, file: 'Vault.sol' },
    },
  });
  const second = stableSerialize({
    metadata: {
      details: { file: 'Vault.sol', line: 42 },
      contracts: ['Vault', 'Proxy'],
    },
    ruleId: 'upgrade-without-timelock',
  });

  assert.equal(first, second);
});

test('stableSerialize handles BigInt values without throwing', () => {
  assert.equal(stableSerialize(42n), '42n');
  assert.equal(stableSerialize({ scale: 10000n }), '{"scale":10000n}');
  assert.notEqual(stableSerialize(10000n), stableSerialize(10000));
  assert.equal(stableSerialize([1n, { scale: 2n }]), '[1n,{"scale":2n}]');
});
