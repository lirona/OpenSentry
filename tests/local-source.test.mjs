import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadLocalSource } from '../functions/api/lib/local-source.js';

test('loads a single local Solidity file', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-local-source-'));
  const filePath = path.join(tmpDir, 'Vault.sol');

  await writeFile(filePath, 'pragma solidity 0.8.20;\ncontract Vault {}', 'utf8');

  const result = await loadLocalSource(filePath);
  assert.equal(result.success, true);
  assert.equal(result.contractName, 'Vault');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'Vault.sol');
  assert.equal(result.source, 'pragma solidity 0.8.20;\ncontract Vault {}');
  assert.equal(result.localPath, filePath);
  assert.equal(result.compiler, 'pragma:0.8.20');
});

test('loads a directory of Solidity files recursively with stable relative names', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-local-source-'));
  const srcDir = path.join(tmpDir, 'contracts');
  const nestedDir = path.join(srcDir, 'interfaces');

  await mkdir(nestedDir, { recursive: true });
  await writeFile(path.join(srcDir, 'Vault.sol'), 'pragma solidity 0.8.20;\ncontract Vault {}', 'utf8');
  await writeFile(path.join(nestedDir, 'IVault.sol'), 'pragma solidity 0.8.20;\ninterface IVault {}', 'utf8');

  const result = await loadLocalSource(srcDir);
  assert.equal(result.success, true);
  assert.equal(result.contractName, 'contracts');
  assert.deepEqual(result.files.map((file) => file.name), [
    'interfaces/IVault.sol',
    'Vault.sol',
  ]);
  assert.match(result.source, /\/\/ === File: Vault\.sol ===/);
  assert.match(result.source, /\/\/ === File: interfaces\/IVault\.sol ===/);
  assert.equal(result.compiler, 'pragma:0.8.20');
});

test('marks local compiler as pragma:mixed when Solidity pragmas differ', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-local-source-'));
  const srcDir = path.join(tmpDir, 'contracts');

  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'Vault.sol'), 'pragma solidity ^0.8.20;\ncontract Vault {}', 'utf8');
  await writeFile(path.join(srcDir, 'Legacy.sol'), 'pragma solidity 0.7.6;\ncontract Legacy {}', 'utf8');

  const result = await loadLocalSource(srcDir);
  assert.equal(result.success, true);
  assert.equal(result.compiler, 'pragma:mixed');
});

test('leaves local compiler empty when no Solidity pragma exists', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-local-source-'));
  const filePath = path.join(tmpDir, 'Vault.sol');

  await writeFile(filePath, 'contract Vault {}', 'utf8');

  const result = await loadLocalSource(filePath);
  assert.equal(result.success, true);
  assert.equal(result.compiler, '');
});

test('returns a structured error when no Solidity files exist in a directory', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-local-source-'));
  const emptyDir = path.join(tmpDir, 'empty');

  await mkdir(emptyDir, { recursive: true });
  await writeFile(path.join(emptyDir, 'README.md'), '# nothing here\n', 'utf8');

  const result = await loadLocalSource(emptyDir);
  assert.equal(result.success, false);
  assert.equal(result.error, 'no_solidity_files');
});

test('returns a structured error for non-Solidity files', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-local-source-'));
  const filePath = path.join(tmpDir, 'notes.txt');

  await writeFile(filePath, 'hello', 'utf8');

  const result = await loadLocalSource(filePath);
  assert.equal(result.success, false);
  assert.equal(result.error, 'unsupported_file');
});
