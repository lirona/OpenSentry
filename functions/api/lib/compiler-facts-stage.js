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

  if (!hasAstForAllRequestedFiles(compiled.compilerOutput, sourceResult.files || [])) {
    return {
      factsStage: {
        ...base,
        status: 'compile_error',
        reason: 'missing_requested_asts',
      },
      deterministicFindings: [],
    };
  }

  try {
    const facts = extractSolidityFacts({
      compilerOutput: compiled.compilerOutput,
      files: sourceResult.files || [],
    });

    return {
      factsStage: {
        ...base,
        status: 'ok',
        reason: null,
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

function hasAstForAllRequestedFiles(compilerOutput, files) {
  if (!compilerOutput || typeof compilerOutput !== 'object') return false;
  if (!Array.isArray(files) || files.length === 0) return false;

  for (const file of files) {
    const fileName = file?.name;
    if (typeof fileName !== 'string' || fileName.length === 0) return false;
    if (!compilerOutput.sources?.[fileName]?.ast) return false;
  }

  return true;
}

export const __internal = Object.freeze({
  hasAstForAllRequestedFiles,
});
