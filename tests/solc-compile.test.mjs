import test from 'node:test';
import assert from 'node:assert/strict';

import { compileSourceWithBundledSolc, __internal } from '../functions/api/lib/solc-compile.js';

test('compiles a single-file Solidity source with a compatible bundled compiler', () => {
  const result = compileSourceWithBundledSolc({
    compiler: 'pragma:0.8.20',
    files: [
      {
        name: 'Vault.sol',
        content: 'pragma solidity 0.8.20;\ncontract Vault {}',
      },
    ],
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.selectedVersion, '0.8.20');
  assert.ok(result.compilerOutput.sources['Vault.sol'].ast);
  assert.equal(result.diagnostics.some((item) => item.severity === 'error'), false);
});

test('compiles a multi-file Solidity source bundle', () => {
  const result = compileSourceWithBundledSolc({
    compiler: 'pragma:^0.8.24',
    files: [
      {
        name: 'Vault.sol',
        content: 'pragma solidity ^0.8.24;\nimport "./IERC20.sol";\ncontract Vault is IERC20 { function totalSupply() external pure returns (uint256) { return 0; } }',
      },
      {
        name: 'IERC20.sol',
        content: 'pragma solidity ^0.8.24;\ninterface IERC20 { function totalSupply() external view returns (uint256); }',
      },
    ],
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.selectedVersion, '0.8.28');
  assert.ok(result.compilerOutput.sources['Vault.sol'].ast);
  assert.ok(result.compilerOutput.sources['IERC20.sol'].ast);
});

test('normalizes compiler diagnostics for invalid Solidity source', () => {
  const result = compileSourceWithBundledSolc({
    compiler: 'pragma:0.8.20',
    files: [
      {
        name: 'Broken.sol',
        content: 'pragma solidity 0.8.20;\ncontract Broken { function x( external {} }',
      },
    ],
  });

  assert.equal(result.status, 'ok');
  assert.ok(result.diagnostics.some((item) => item.severity === 'error'));
  assert.ok(result.diagnostics.some((item) => item.file === 'Broken.sol'));
  assert.ok(result.diagnostics.some((item) => item.line !== null));
  assert.ok(result.diagnostics.some((item) => item.column !== null));
});

test('returns unavailable when no compatible bundled compiler exists', () => {
  const result = compileSourceWithBundledSolc({
    compiler: '',
    files: [
      {
        name: 'Future.sol',
        content: 'pragma solidity ^0.8.29;\ncontract Future {}',
      },
    ],
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no_compatible_bundled_compiler');
  assert.equal(result.compilerOutput, null);
});

test('buildStandardJsonInput produces standard-json compiler input', () => {
  const input = __internal.buildStandardJsonInput([
    { name: 'Vault.sol', content: 'pragma solidity 0.8.20;\ncontract Vault {}' },
  ]);

  assert.equal(input.language, 'Solidity');
  assert.equal(input.sources['Vault.sol'].content, 'pragma solidity 0.8.20;\ncontract Vault {}');
  assert.deepEqual(input.settings.outputSelection, {
    '*': {
      '': ['ast'],
    },
  });
});
