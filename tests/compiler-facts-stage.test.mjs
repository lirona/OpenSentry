import test from 'node:test';
import assert from 'node:assert/strict';

import { runCompilerFactsStage } from '../functions/api/lib/compiler-facts-stage.js';

test('compiler facts stage proceeds when requested files have ASTs despite placeholder-related diagnostics', () => {
  const sourceResult = {
    compiler: 'pragma:^0.8.24',
    files: [
      {
        name: 'Vault.sol',
        content: [
          'pragma solidity ^0.8.24;',
          'import "./interfaces/IAntseedRegistry.sol";',
          'contract Vault {',
          '  IAntseedRegistry public registry;',
          '  function setRegistry(address value) external {',
          '    registry = IAntseedRegistry(value);',
          '  }',
          '  function channels() external view returns (address) {',
          '    return registry.channels();',
          '  }',
          '}',
        ].join('\n'),
      },
    ],
  };

  const result = runCompilerFactsStage(sourceResult);

  assert.equal(result.factsStage.status, 'ok');
  assert.ok(Array.isArray(result.factsStage.diagnostics));
  assert.ok(result.factsStage.facts.contracts.some((entry) => entry.contract === 'Vault'));
});
