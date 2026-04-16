import { compileSourceWithBundledSolc } from './solc-compile.js';
import { extractSolidityFacts } from './solidity-facts.js';
import { deriveDeterministicFindings } from './deterministic-findings.js';

export function runCompilerFactsStage(sourceResult) {
  return runCompilerFactsStageWithDependencies(sourceResult);
}

function runCompilerFactsStageWithDependencies(sourceResult, dependencies = {}) {
  if (!sourceResult || typeof sourceResult !== 'object') {
    throw new TypeError('runCompilerFactsStage: sourceResult must be an object');
  }

  const compileSource = dependencies.compileSource || compileSourceWithBundledSolc;
  const extractFacts = dependencies.extractFacts || extractSolidityFacts;
  const deriveFindings = dependencies.deriveFindings || deriveDeterministicFindings;

  let compiled;
  try {
    compiled = compileSource(sourceResult);
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
    const facts = extractFacts({
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
      deterministicFindings: deriveFindings(facts),
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
  runCompilerFactsStageWithDependencies,
  partitionRequestedFilesByAst,
  filterCompilerOutputToFiles,
});
