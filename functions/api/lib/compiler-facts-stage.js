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

  if (compiled.diagnostics.some((entry) => entry.severity === 'error')) {
    return {
      factsStage: {
        ...base,
        status: 'compile_error',
        reason: 'compiler_errors',
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
