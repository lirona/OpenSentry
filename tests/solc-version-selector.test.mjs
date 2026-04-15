import test from 'node:test';
import assert from 'node:assert/strict';

import { selectBundledSolc, __internal } from '../functions/api/lib/solc-version-selector.js';

test('selects an exact bundled compiler from the fetched compiler hint', () => {
  const result = selectBundledSolc({
    compilerHint: 'v0.8.20+commit.a1b79de6',
    files: [{ name: 'Vault.sol', content: 'pragma solidity ^0.8.0;\ncontract Vault {}' }],
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'compiler_hint');
  assert.equal(result.selectedVersion, '0.8.20');
  assert.match(result.compiler.version(), /^0\.8\.20\+/);
});

test('selects the newest bundled compiler compatible with ^0.8.24', () => {
  const result = selectBundledSolc({
    files: [{ name: 'Vault.sol', content: 'pragma solidity ^0.8.24;\ncontract Vault {}' }],
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'pragma');
  assert.equal(result.selectedVersion, '0.8.28');
});

test('selects 0.7.6 for a 0.7.x pragma range', () => {
  const result = selectBundledSolc({
    files: [{ name: 'Legacy.sol', content: 'pragma solidity 0.7.x;\ncontract Legacy {}' }],
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.selectedVersion, '0.7.6');
});

test('returns unavailable for incompatible mixed Solidity pragmas', () => {
  const result = selectBundledSolc({
    files: [
      { name: 'A.sol', content: 'pragma solidity ^0.8.24;\ncontract A {}' },
      { name: 'B.sol', content: 'pragma solidity 0.7.6;\ncontract B {}' },
    ],
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no_compatible_bundled_compiler');
});

test('returns unavailable for unsupported pragma ranges', () => {
  const result = selectBundledSolc({
    files: [{ name: 'Future.sol', content: 'pragma solidity ^0.8.29;\ncontract Future {}' }],
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no_compatible_bundled_compiler');
});

test('returns unavailable when no compiler hint or Solidity pragma exists', () => {
  const result = selectBundledSolc({
    files: [{ name: 'Vault.sol', content: 'contract Vault {}' }],
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'missing_compiler_info');
});

test('normalizes pragma expressions and ignores invalid ranges', () => {
  assert.equal(__internal.normalizePragmaExpression('  >=0.8.0   <0.9.0 '), '>=0.8.0 <0.9.0');
  assert.deepEqual(
    __internal.extractSolidityPragmas('pragma solidity >=0.8.0 <0.9.0;\npragma solidity bananas;'),
    ['>=0.8.0 <0.9.0'],
  );
});
