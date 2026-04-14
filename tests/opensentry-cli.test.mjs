import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../bin/opensentry.js';

function makeBuffer() {
  let text = '';
  return {
    stream: {
      write(chunk) {
        text += chunk;
      },
    },
    read() {
      return text;
    },
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(url, init);
  return () => {
    globalThis.fetch = original;
  };
}

test('CLI analyze --json prints final result for a local Solidity file', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-cli-'));
  const filePath = path.join(tmpDir, 'Vault.sol');
  await writeFile(filePath, 'pragma solidity 0.8.20;\ncontract Vault {}', 'utf8');

  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({
            agent: 'Access Control',
            severity: 'SAFE',
            summary: 'No issues found.',
            findings: [],
          }) }] },
          finishReason: 'STOP',
        }],
      }),
    };
  });

  const stdout = makeBuffer();
  const stderr = makeBuffer();
  try {
    const exitCode = await runCli(
      ['analyze', '--file', filePath, '--json'],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: { AI_API_KEY: 'test-key', AI_MODEL: 'test-model' },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), '');
    assert.equal(calls, 8);

    const body = JSON.parse(stdout.read());
    assert.equal(body.success, true);
    assert.equal(body.source.path, filePath);
    assert.equal(body.analysis.contractName, 'Vault');
    assert.equal(body.analysis.report.agentSummaries.length, 8);
  } finally {
    restore();
  }
});

test('CLI can save final JSON and trace artifacts', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-cli-'));
  const contractsDir = path.join(tmpDir, 'contracts');
  const outPath = path.join(tmpDir, 'report.json');
  const traceDir = path.join(tmpDir, 'trace');

  await mkdir(contractsDir, { recursive: true });
  await writeFile(path.join(contractsDir, 'Vault.sol'), 'pragma solidity 0.8.20;\ncontract Vault {}', 'utf8');
  await writeFile(path.join(contractsDir, 'IERC20.sol'), 'pragma solidity 0.8.20;\ninterface IERC20 {}', 'utf8');

  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        agent: 'Access Control',
        severity: 'SAFE',
        summary: 'No issues found.',
        findings: [],
      }) }],
    }),
  }));

  const stdout = makeBuffer();
  const stderr = makeBuffer();
  try {
    const exitCode = await runCli(
      ['analyze', '--path', contractsDir, '--out', outPath, '--trace-dir', traceDir],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AI_PROVIDER: 'claude',
          AI_API_KEY: 'test-key',
          AI_MODEL: 'claude-test-model',
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), '');
    assert.match(stdout.read(), /Saved final JSON:/);
    assert.match(stdout.read(), /Saved trace files:/);

    const savedReport = JSON.parse(await readFile(outPath, 'utf8'));
    assert.equal(savedReport.success, true);
    assert.equal(savedReport.analysis.report.agentSummaries.length, 8);

    const merged = JSON.parse(await readFile(path.join(traceDir, 'merged-report.json'), 'utf8'));
    assert.equal(merged.overallSeverity, 'SAFE');

    const sourceText = await readFile(path.join(traceDir, 'source.txt'), 'utf8');
    assert.match(sourceText, /\/\/ === File: IERC20\.sol ===/);
    assert.match(sourceText, /\/\/ === File: Vault\.sol ===/);
  } finally {
    restore();
  }
});
