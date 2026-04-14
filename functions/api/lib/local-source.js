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

    return buildSuccessResult(absolutePath, bundle, inferContractNameFromFileName(path.basename(absolutePath)));
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

  return buildSuccessResult(absolutePath, bundle, contractName);
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

function buildSuccessResult(absolutePath, bundle, contractName) {
  return {
    success: true,
    contractName,
    compiler: '',
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
