import { selectBundledSolc } from './solc-version-selector.js';

export function compileSourceWithBundledSolc(sourceResult) {
  if (!sourceResult || typeof sourceResult !== 'object') {
    throw new TypeError('compileSourceWithBundledSolc: sourceResult must be an object');
  }
  if (!Array.isArray(sourceResult.files) || sourceResult.files.length === 0) {
    throw new TypeError('compileSourceWithBundledSolc: sourceResult.files must be a non-empty array');
  }

  const selection = selectBundledSolc({
    compilerHint: sourceResult.compiler,
    files: sourceResult.files,
  });

  const base = {
    strategy: selection.strategy,
    requestedCompilerHint: selection.requestedCompilerHint,
    selectedVersion: selection.selectedVersion,
    diagnostics: [],
  };

  if (selection.status !== 'ok') {
    return {
      ...base,
      status: 'unavailable',
      reason: selection.reason,
      compilerOutput: null,
    };
  }

  const input = buildStandardJsonInput(sourceResult.files);

  let compilerOutput;
  try {
    compilerOutput = compileStandardJson(selection.compiler, input);
  } catch (error) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'compile_exception',
      diagnostics: [normalizeThrownDiagnostic(error)],
      compilerOutput: null,
    };
  }

  return {
    ...base,
    status: 'ok',
    reason: null,
    diagnostics: normalizeDiagnostics(compilerOutput.errors || [], input.sources),
    compilerOutput,
  };
}

function buildStandardJsonInput(files) {
  return {
    language: 'Solidity',
    sources: Object.fromEntries(files.map((file) => [file.name, { content: file.content }])),
    settings: {
      outputSelection: {
        '*': {
          '': ['ast'],
        },
      },
    },
  };
}

function compileStandardJson(compiler, input) {
  const compile = compiler.compileStandardWrapper || compiler.compileStandard || compiler.compile;
  if (typeof compile !== 'function') {
    throw new TypeError('Selected compiler does not expose a supported compile function');
  }

  const raw = compile(JSON.stringify(input));
  return JSON.parse(raw);
}

function normalizeDiagnostics(errors, sources) {
  return errors.map((error) => ({
    severity: error.severity || 'error',
    type: error.type || null,
    component: error.component || null,
    code: error.errorCode || null,
    message: error.message || error.formattedMessage || 'Unknown compiler diagnostic',
    file: error.sourceLocation?.file || null,
    line: toLineNumber(error.sourceLocation, sources),
    column: toColumnNumber(error.sourceLocation, sources),
  }));
}

function normalizeThrownDiagnostic(error) {
  return {
    severity: 'error',
    type: 'exception',
    component: 'opensentry',
    code: null,
    message: error?.message || String(error),
    file: null,
    line: null,
    column: null,
  };
}

function toLineNumber(sourceLocation, sources) {
  return offsetToLineColumn(sourceLocation, sources)?.line ?? null;
}

function toColumnNumber(sourceLocation, sources) {
  return offsetToLineColumn(sourceLocation, sources)?.column ?? null;
}

function offsetToLineColumn(sourceLocation, sources) {
  if (!sourceLocation || !Number.isInteger(sourceLocation.start) || typeof sourceLocation.file !== 'string') {
    return null;
  }

  const source = sources?.[sourceLocation.file]?.content;
  if (typeof source !== 'string') return null;

  const offset = Math.max(0, Math.min(sourceLocation.start, source.length));
  const prefix = source.slice(0, offset);
  const lines = prefix.split('\n');

  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

export const __internal = Object.freeze({
  buildStandardJsonInput,
  compileStandardJson,
  normalizeDiagnostics,
  offsetToLineColumn,
});
