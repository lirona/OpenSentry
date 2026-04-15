import { selectBundledSolc } from './solc-version-selector.js';

const KNOWN_IMPORT_STUBS = Object.freeze({
  '@openzeppelin/contracts/access/Ownable.sol': [
    'pragma solidity >=0.4.0 <0.9.0;',
    'contract Ownable {',
    '  address private _owner;',
    '  constructor(address initialOwner) public { _owner = initialOwner; }',
    '  modifier onlyOwner() { _; }',
    '  function owner() public view returns (address) { return _owner; }',
    '}',
  ].join('\n'),
  '@openzeppelin/contracts/utils/Pausable.sol': [
    'pragma solidity >=0.4.0 <0.9.0;',
    'contract Pausable {',
    '  modifier whenNotPaused() { _; }',
    '  modifier whenPaused() { _; }',
    '  function _pause() internal {}',
    '  function _unpause() internal {}',
    '}',
  ].join('\n'),
  '@openzeppelin/contracts/utils/ReentrancyGuard.sol': [
    'pragma solidity >=0.4.0 <0.9.0;',
    'contract ReentrancyGuard {',
    '  modifier nonReentrant() { _; }',
    '}',
  ].join('\n'),
  '@openzeppelin/contracts/utils/cryptography/EIP712.sol': [
    'pragma solidity >=0.4.0 <0.9.0;',
    'contract EIP712 {',
    '  constructor(string memory name, string memory version) public {}',
    '  function _hashTypedDataV4(bytes32 hash) internal view returns (bytes32) { return hash; }',
    '  function _domainSeparatorV4() internal view returns (bytes32) { return bytes32(0); }',
    '}',
  ].join('\n'),
  '@openzeppelin/contracts/utils/cryptography/ECDSA.sol': [
    'pragma solidity >=0.4.0 <0.9.0;',
    'library ECDSA {',
    '  function recover(bytes32 hash, bytes memory signature) internal pure returns (address) {',
    '    return address(0);',
    '  }',
    '}',
  ].join('\n'),
  '@openzeppelin/contracts/token/ERC20/IERC20.sol': [
    'pragma solidity >=0.4.0 <0.9.0;',
    'interface IERC20 {',
    '  function transfer(address to, uint256 value) external returns (bool);',
    '  function transferFrom(address from, address to, uint256 value) external returns (bool);',
    '  function approve(address spender, uint256 value) external returns (bool);',
    '  function balanceOf(address account) external view returns (uint256);',
    '}',
  ].join('\n'),
  '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol': [
    'pragma solidity >=0.4.0 <0.9.0;',
    'import "@openzeppelin/contracts/token/ERC20/IERC20.sol";',
    'library SafeERC20 {',
    '  function safeTransfer(IERC20 token, address to, uint256 value) internal {}',
    '  function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {}',
    '  function safeApprove(IERC20 token, address spender, uint256 value) internal {}',
    '}',
  ].join('\n'),
  '@openzeppelin/contracts/token/ERC20/ERC20.sol': [
    'pragma solidity >=0.8.0 <0.9.0;',
    'contract ERC20 {',
    '  constructor(string memory name, string memory symbol) {}',
    '  function totalSupply() public view virtual returns (uint256) { return 0; }',
    '  function transfer(address to, uint256 value) public virtual returns (bool) { return true; }',
    '  function balanceOf(address account) public view virtual returns (uint256) { return 0; }',
    '  function _transfer(address from, address to, uint256 value) internal virtual {}',
    '  function _update(address from, address to, uint256 value) internal virtual {}',
    '  function _mint(address to, uint256 value) internal virtual {}',
    '}',
  ].join('\n'),
});

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

  let compilerOutput;
  let input = buildStandardJsonInput(sourceResult.files);
  try {
    const compiled = compileWithGeneratedImportStubs(selection.compiler, input);
    compilerOutput = compiled.compilerOutput;
    input = compiled.input;
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
  return buildStandardJsonInputFromSources(
    Object.fromEntries(files.map((file) => [file.name, { content: file.content }])),
  );
}

function buildStandardJsonInputFromSources(sources) {
  return {
    language: 'Solidity',
    sources,
    settings: {
      outputSelection: {
        '*': {
          '': ['ast'],
        },
      },
    },
  };
}

function compileWithGeneratedImportStubs(compiler, initialInput) {
  let input = initialInput;

  for (let attempt = 0; attempt < 3; attempt++) {
    const compilerOutput = compileStandardJson(compiler, input);
    const missingImports = collectMissingImportPaths(compilerOutput.errors || []);
    const nextSources = addGeneratedImportStubs(input.sources, missingImports);

    if (Object.keys(nextSources).length === Object.keys(input.sources).length) {
      return { compilerOutput, input };
    }

    input = buildStandardJsonInputFromSources(nextSources);
  }

  return {
    compilerOutput: compileStandardJson(compiler, input),
    input,
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

function collectMissingImportPaths(errors) {
  const paths = new Set();
  for (const error of errors) {
    const message = error?.message || error?.formattedMessage || '';
    const match = message.match(/Source "([^"]+)" not found/);
    if (match) paths.add(normalizeImportPath(match[1]));
  }
  return [...paths];
}

function addGeneratedImportStubs(existingSources, importPaths) {
  const sources = { ...existingSources };

  for (const rawPath of importPaths) {
    const importPath = normalizeImportPath(rawPath);
    if (sources[importPath]) continue;

    const stub = generateImportStub(importPath);
    if (!stub) continue;

    sources[importPath] = { content: stub };
  }

  return sources;
}

function generateImportStub(importPath) {
  if (KNOWN_IMPORT_STUBS[importPath]) return KNOWN_IMPORT_STUBS[importPath];

  const symbol = inferPrimarySymbol(importPath);
  if (!symbol) return null;

  if (/^I[A-Z]/.test(symbol)) {
    return [
      'pragma solidity >=0.4.0 <0.9.0;',
      `interface ${symbol} {}`,
    ].join('\n');
  }

  return [
    'pragma solidity >=0.4.0 <0.9.0;',
    `contract ${symbol} {}`,
  ].join('\n');
}

function inferPrimarySymbol(importPath) {
  const normalized = normalizeImportPath(importPath);
  const baseName = normalized.split('/').pop()?.replace(/\.sol$/i, '') || '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(baseName)) return null;
  return baseName;
}

function normalizeImportPath(importPath) {
  return String(importPath || '').replace(/^\.\/+/, '');
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
  buildStandardJsonInputFromSources,
  compileWithGeneratedImportStubs,
  compileStandardJson,
  normalizeDiagnostics,
  offsetToLineColumn,
  collectMissingImportPaths,
  addGeneratedImportStubs,
  generateImportStub,
  inferPrimarySymbol,
  normalizeImportPath,
});
