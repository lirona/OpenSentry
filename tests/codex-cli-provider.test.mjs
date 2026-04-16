import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { __internal } from '../functions/api/lib/model-providers/codex-cli.js';

test('extractCodexCliText reads the final agent_message text from Codex JSONL output', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"abc"}',
    '2026-04-14T14:41:01.491428Z  WARN something noisy',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"ok\\":true}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ].join('\n');

  assert.equal(__internal.extractCodexCliText(stdout), '{"ok":true}');
});

test('extractCodexCliText falls back to a bare JSON object line', () => {
  const stdout = [
    'noise',
    '{"ok":true}',
  ].join('\n');

  assert.equal(__internal.extractCodexCliText(stdout), '{"ok":true}');
});

test('extractCodexCliText returns empty string when no parseable JSON payload exists', () => {
  const stdout = [
    'warning 1',
    'warning 2',
  ].join('\n');

  assert.equal(__internal.extractCodexCliText(stdout), '');
});

test('runCodexCli captures the final item.completed payload from a live stdout stream', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = { end() {} };
  child.kill = () => {};

  const spawn = () => {
    queueMicrotask(() => {
      child.stdout.emit('data', '{"type":"thread.started","thread_id":"abc"}\n');
      child.stdout.emit('data', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"ok\\":true}"}}\n');
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await __internal.runCodexCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 1000,
    schemaPath: '/tmp/schema.json',
    model: 'gpt-5.3-codex',
    prompt: 'Return JSON',
  });

  assert.deepEqual(result, { ok: true, text: '{"ok":true}' });
});

test('runCodexCli escalates to SIGKILL when the child ignores SIGTERM', async () => {
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = { end() {} };
  child.kill = (signal) => {
    signals.push(signal);
  };

  const spawn = () => child;

  const result = await __internal.runCodexCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 5,
    schemaPath: '/tmp/schema.json',
    model: 'gpt-5.3-codex',
    prompt: 'Return JSON',
  });

  await new Promise((resolve) => setTimeout(resolve, 2_050));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
