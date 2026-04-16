import { compileSourceWithBundledSolc } from './solc-compile.js';
import { extractSolidityFacts } from './solidity-facts.js';
import { deriveDeterministicFindings } from './deterministic-findings.js';

export function runCompilerFactsStage(sourceResult) {
  if (!sourceResult || typeof sourceResult !== 'object') {
    throw new TypeError('runCompilerFactsStage: sourceResult must be an object');
  }

  let compiled;
  try {
    compiled = compileSourceWithBundledSolc(sourceResult);
  } catch (error) {
    return {
      factsStage: {
        status: 'error',
        requestedCompilerHint: sourceResult.compiler || '',
        selectedCompilerVersion: null,
        diagnostics: [],
        reason: 'compile_stage_exception',
        errorMessage: error?.message || String(error),
        facts: null,
      },
      deterministicFindings: [],
    };
  }

  const base = {
    requestedCompilerHint: compiled.requestedCompilerHint,
    selectedCompilerVersion: compiled.selectedVersion,
    diagnostics: compiled.diagnostics,
    reason: compiled.reason || null,
    facts: null,
  };

  if (compiled.status !== 'ok') {
    return {
      factsStage: {
        ...base,
        status: 'unavailable',
      },
      deterministicFindings: [],
    };
  }

  const requestedFiles = sourceResult.files || [];
  const partition = partitionRequestedFilesByAst(compiled.compilerOutput, requestedFiles);
  if (partition.analyzableFiles.length === 0) {
    return {
      factsStage: {
        ...base,
        status: 'no_analyzable_files',
        reason: 'missing_requested_asts',
        coverage: 'none',
        analyzedFiles: [],
        missingAstFiles: partition.missingAstFiles,
      },
      deterministicFindings: [],
    };
  }

  try {
    const facts = extractSolidityFacts({
      compilerOutput: filterCompilerOutputToFiles(compiled.compilerOutput, partition.analyzableFiles),
      files: partition.analyzableFiles,
    });

    return {
      factsStage: {
        ...base,
        status: 'ok',
        reason: null,
        coverage: partition.missingAstFiles.length === 0 ? 'full' : 'partial',
        analyzedFiles: partition.analyzableFiles.map((file) => file.name),
        missingAstFiles: partition.missingAstFiles,
        facts,
      },
      deterministicFindings: deriveDeterministicFindings(facts),
    };
  } catch (error) {
    return {
      factsStage: {
        ...base,
        status: 'error',
        reason: 'facts_extraction_exception',
        errorMessage: error?.message || String(error),
        facts: null,
      },
      deterministicFindings: [],
    };
  }
}

function partitionRequestedFilesByAst(compilerOutput, files) {
  const analyzableFiles = [];
  const missingAstFiles = [];

  for (const file of files || []) {
    const fileName = file?.name;
    if (typeof fileName !== 'string' || fileName.length === 0) continue;
    if (compilerOutput?.sources?.[fileName]?.ast) {
      analyzableFiles.push(file);
      continue;
    }
    missingAstFiles.push(fileName);
  }

  return {
    analyzableFiles,
    missingAstFiles,
  };
}

function filterCompilerOutputToFiles(compilerOutput, files) {
  return {
    ...compilerOutput,
    sources: Object.fromEntries(
      (files || [])
        .map((file) => [file.name, compilerOutput.sources?.[file.name]])
        .filter(([, source]) => source?.ast),
    ),
  };
}

export const __internal = Object.freeze({
  partitionRequestedFilesByAst,
  filterCompilerOutputToFiles,
});
