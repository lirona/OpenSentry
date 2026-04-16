import test from 'node:test';
import assert from 'node:assert/strict';

import { runCompilerFactsStage, __internal } from '../functions/api/lib/compiler-facts-stage.js';

test('compiler facts stage proceeds when requested files have ASTs despite placeholder-related diagnostics', () => {
  const sourceResult = {
    compiler: 'pragma:^0.8.24',
    files: [
      {
        name: 'Vault.sol',
        content: [
          'pragma solidity ^0.8.24;',
          'import "./interfaces/IRegistry.sol";',
          'contract Vault {',
          '  IRegistry public registry;',
          '  function setRegistry(address value) external {',
          '    registry = IRegistry(value);',
          '  }',
          '  function registryAddress() external view returns (address) {',
          '    return address(registry);',
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

test('compiler facts stage helpers keep the analyzable subset when AST coverage is partial', () => {
  const files = [
    { name: 'Good.sol', content: 'pragma solidity 0.8.20; contract Good {}' },
    { name: 'Bad.sol', content: 'pragma solidity 0.8.20; contract Bad {}' },
  ];
  const compilerOutput = {
    sources: {
      'Good.sol': { ast: { nodeType: 'SourceUnit' } },
    },
  };

  const partition = __internal.partitionRequestedFilesByAst(compilerOutput, files);
  assert.deepEqual(partition.analyzableFiles.map((file) => file.name), ['Good.sol']);
  assert.deepEqual(partition.missingAstFiles, ['Bad.sol']);

  const filtered = __internal.filterCompilerOutputToFiles(compilerOutput, partition.analyzableFiles);
  assert.deepEqual(Object.keys(filtered.sources), ['Good.sol']);
});

test('compiler facts stage reports no analyzable files when requested file names cannot map to AST output', () => {
  const result = runCompilerFactsStage({
    compiler: 'pragma:0.8.20',
    files: [
      {
        name: '',
        content: 'pragma solidity 0.8.20; contract T {}',
      },
    ],
  });

  assert.equal(result.factsStage.status, 'no_analyzable_files');
  assert.equal(result.factsStage.reason, 'missing_requested_asts');
});
