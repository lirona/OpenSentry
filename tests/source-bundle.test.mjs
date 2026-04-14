import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSourceBundle,
  inferContractNameFromFileName,
} from '../functions/api/lib/source-bundle.js';

test('buildSourceBundle returns raw content for a single file by default', () => {
  const bundle = buildSourceBundle([
    { name: 'Vault.sol', content: 'pragma solidity 0.8.20;\ncontract Vault {}' },
  ]);

  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].name, 'Vault.sol');
  assert.equal(bundle.combinedSource, 'pragma solidity 0.8.20;\ncontract Vault {}');
});

test('buildSourceBundle can force file headers for a single file', () => {
  const bundle = buildSourceBundle(
    [{ name: 'Vault.sol', content: 'contract Vault {}' }],
    { forceHeaders: true },
  );

  assert.match(bundle.combinedSource, /\/\/ === File: Vault\.sol ===/);
  assert.match(bundle.combinedSource, /contract Vault \{\}/);
});

test('buildSourceBundle adds headers for multi-file sources', () => {
  const bundle = buildSourceBundle([
    { name: 'A.sol', content: 'contract A {}' },
    { name: 'B.sol', content: 'contract B {}' },
  ]);

  assert.match(bundle.combinedSource, /\/\/ === File: A\.sol ===/);
  assert.match(bundle.combinedSource, /\/\/ === File: B\.sol ===/);
});

test('buildSourceBundle rejects invalid input shapes', () => {
  assert.throws(() => buildSourceBundle([]), /non-empty array/);
  assert.throws(() => buildSourceBundle([null]), /must be an object/);
  assert.throws(() => buildSourceBundle([{ name: '', content: 'x' }]), /name must be a non-empty string/);
  assert.throws(() => buildSourceBundle([{ name: 'A.sol' }]), /content must be a string/);
});

test('inferContractNameFromFileName strips extensions and handles empty input', () => {
  assert.equal(inferContractNameFromFileName('Vault.sol'), 'Vault');
  assert.equal(inferContractNameFromFileName('My.Proxy.v1.sol'), 'My.Proxy.v1');
  assert.equal(inferContractNameFromFileName(''), 'Contract');
  assert.equal(inferContractNameFromFileName(null), 'Contract');
});
