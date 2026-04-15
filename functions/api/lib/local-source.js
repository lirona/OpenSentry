import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { buildSourceBundle, inferContractNameFromFileName } from './source-bundle.js';

export async function loadLocalSource(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return {
      success: false,
      error: 'invalid_path',
      message: 'Local source path must be a non-empty string.',
    };
  }

  const absolutePath = path.resolve(inputPath);

  let stats;
  try {
    stats = await stat(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        success: false,
        error: 'not_found',
        message: `Local source path not found: ${absolutePath}`,
      };
    }
    throw error;
  }

  if (stats.isFile()) {
    if (!absolutePath.endsWith('.sol')) {
      return {
        success: false,
        error: 'unsupported_file',
        message: `Expected a .sol file, got: ${absolutePath}`,
      };
    }

    const content = await readFile(absolutePath, 'utf8');
    const bundle = buildSourceBundle([{
      name: path.basename(absolutePath),
      content,
    }]);

    return buildSuccessResult(
      absolutePath,
      bundle,
      inferContractNameFromFileName(path.basename(absolutePath)),
      inferCompilerHint(bundle.files),
    );
  }

  if (!stats.isDirectory()) {
    return {
      success: false,
      error: 'unsupported_path',
      message: `Expected a Solidity file or directory, got: ${absolutePath}`,
    };
  }

  const files = await readSolidityFiles(absolutePath, absolutePath);
  if (files.length === 0) {
    return {
      success: false,
      error: 'no_solidity_files',
      message: `No .sol files found under ${absolutePath}`,
    };
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  const bundle = buildSourceBundle(files);
  const contractName = inferDirectoryContractName(absolutePath, files);
  const compiler = inferCompilerHint(bundle.files);

  return buildSuccessResult(absolutePath, bundle, contractName, compiler);
}

async function readSolidityFiles(rootDir, currentDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readSolidityFiles(rootDir, fullPath));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.sol')) continue;

    const content = await readFile(fullPath, 'utf8');
    files.push({
      name: path.relative(rootDir, fullPath),
      content,
    });
  }

  return files;
}

function inferDirectoryContractName(absolutePath, files) {
  const rootName = path.basename(absolutePath);
  if (rootName) return rootName;
  return inferContractNameFromFileName(files[0]?.name);
}

function inferCompilerHint(files) {
  const pragmas = new Set();

  for (const file of files) {
    for (const pragma of extractSolidityPragmas(file.content)) {
      pragmas.add(pragma);
    }
  }

  if (pragmas.size === 0) return '';
  if (pragmas.size === 1) return `pragma:${[...pragmas][0]}`;
  return 'pragma:mixed';
}

function extractSolidityPragmas(source) {
  if (typeof source !== 'string' || source.length === 0) return [];

  const matches = source.matchAll(/\bpragma\s+solidity\s+([^;]+);/g);
  const pragmas = [];

  for (const match of matches) {
    const normalized = match[1].replace(/\s+/g, ' ').trim();
    if (normalized) pragmas.push(normalized);
  }

  return pragmas;
}

function buildSuccessResult(absolutePath, bundle, contractName, compiler) {
  return {
    success: true,
    contractName,
    compiler,
    optimization: {
      enabled: false,
      runs: 0,
    },
    evmVersion: '',
    licenseType: '',
    source: bundle.combinedSource,
    files: bundle.files,
    isProxy: false,
    implementationAddress: null,
    abi: [],
    localPath: absolutePath,
  };
}

export const __internal = Object.freeze({
  extractSolidityPragmas,
  inferCompilerHint,
});
