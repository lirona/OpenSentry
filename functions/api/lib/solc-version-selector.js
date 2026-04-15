import semver from 'semver';

import { BUNDLED_SOLC_BY_VERSION, BUNDLED_SOLC_VERSIONS } from './bundled-solc.js';

const SELECTOR_STRATEGY = 'bundled-version-map';
const EXACT_COMPILER_VERSION_RE = /^v?(\d+\.\d+\.\d+)/;
const PRAGMA_SOLIDITY_RE = /\bpragma\s+solidity\s+([^;]+);/g;

export function selectBundledSolc({ compilerHint = '', files = [] } = {}) {
  const requestedCompilerHint = typeof compilerHint === 'string' ? compilerHint : '';
  const exactCompilerVersion = extractExactCompilerVersion(requestedCompilerHint);

  if (exactCompilerVersion && BUNDLED_SOLC_BY_VERSION[exactCompilerVersion]) {
    return {
      status: 'ok',
      strategy: SELECTOR_STRATEGY,
      source: 'compiler_hint',
      requestedCompilerHint,
      pragmaExpressions: extractPragmaExpressions(files),
      selectedVersion: exactCompilerVersion,
      compiler: BUNDLED_SOLC_BY_VERSION[exactCompilerVersion],
    };
  }

  const pragmaExpressions = extractPragmaExpressions(files);
  if (pragmaExpressions.length === 0) {
    return unavailableResult({
      requestedCompilerHint,
      pragmaExpressions,
      reason: exactCompilerVersion ? 'exact_compiler_not_bundled' : 'missing_compiler_info',
    });
  }

  const compatible = BUNDLED_SOLC_VERSIONS.filter((entry) =>
    pragmaExpressions.every((expression) => semver.satisfies(entry.version, expression)),
  );

  if (compatible.length === 0) {
    return unavailableResult({
      requestedCompilerHint,
      pragmaExpressions,
      reason: 'no_compatible_bundled_compiler',
    });
  }

  const selected = compatible[compatible.length - 1];
  return {
    status: 'ok',
    strategy: SELECTOR_STRATEGY,
    source: 'pragma',
    requestedCompilerHint,
    pragmaExpressions,
    selectedVersion: selected.version,
    compiler: selected.compiler,
  };
}

function unavailableResult({ requestedCompilerHint, pragmaExpressions, reason }) {
  return {
    status: 'unavailable',
    strategy: SELECTOR_STRATEGY,
    requestedCompilerHint,
    pragmaExpressions,
    reason,
    selectedVersion: null,
    compiler: null,
  };
}

function extractExactCompilerVersion(compilerHint) {
  if (typeof compilerHint !== 'string' || compilerHint.length === 0) return null;
  const match = compilerHint.match(EXACT_COMPILER_VERSION_RE);
  if (!match) return null;
  return semver.valid(match[1]);
}

function extractPragmaExpressions(files) {
  const expressions = new Set();

  for (const file of files) {
    if (!file || typeof file.content !== 'string') continue;
    for (const expression of extractSolidityPragmas(file.content)) {
      expressions.add(expression);
    }
  }

  return [...expressions];
}

function extractSolidityPragmas(source) {
  const expressions = [];

  for (const match of source.matchAll(PRAGMA_SOLIDITY_RE)) {
    const expression = normalizePragmaExpression(match[1]);
    if (!expression) continue;
    if (!semver.validRange(expression)) continue;
    expressions.push(expression);
  }

  return expressions;
}

function normalizePragmaExpression(expression) {
  if (typeof expression !== 'string' || expression.length === 0) return '';
  return expression.replace(/\s+/g, ' ').trim();
}

export const __internal = Object.freeze({
  extractExactCompilerVersion,
  extractPragmaExpressions,
  extractSolidityPragmas,
  normalizePragmaExpression,
});
