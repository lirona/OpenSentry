import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { __internal } from '../functions/api/lib/model-providers/claude-cli.js';

function validAgentOutput(overrides = {}) {
  return {
    agent: 'Access Control',
    severity: 'SAFE',
    summary: 'No issues found.',
    findings: [],
    ...overrides,
  };
}

function makeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = {
    end() {},
    on() {},
  };
  child.kill = () => {};
  return child;
}

test('extractClaudeCliText reads structured_output from Claude Code JSON output', () => {
  const stdout = JSON.stringify({
    session_id: 'session_123',
    result: 'ignored fallback text',
    structured_output: validAgentOutput(),
  });

  assert.equal(__internal.extractClaudeCliText(stdout), JSON.stringify(validAgentOutput()));
});

test('buildClaudeCliSystemPrompt wraps the model instructions with deterministic local-run guards', () => {
  const systemPrompt = 'AGENT PREAMBLE\n\nReview the supplied source.';
  const wrapped = __internal.buildClaudeCliSystemPrompt(systemPrompt);

  assert.match(wrapped, /deterministic security-analysis engine/i);
  assert.match(wrapped, /do not request tools/i);
  assert.match(wrapped, /do not browse the web/i);
  assert.match(wrapped, /exactly one JSON object/i);
  assert.match(wrapped, /AGENT PREAMBLE/);
});

test('extractClaudeCliText falls back to result when it contains valid agent JSON', () => {
  const stdout = JSON.stringify({
    session_id: 'session_123',
    result: JSON.stringify(validAgentOutput({ severity: 'WARNING' })),
  });

  assert.equal(
    __internal.extractClaudeCliText(stdout),
    JSON.stringify(validAgentOutput({ severity: 'WARNING' })),
  );
});

test('extractClaudeCliText returns empty string when Claude Code output is missing valid structured data', () => {
  const stdout = JSON.stringify({
    session_id: 'session_123',
    result: '{"not":"agent-output"}',
  });

  assert.equal(__internal.extractClaudeCliText(stdout), '');
});

test('runClaudeCli captures structured_output from stdout on a zero exit code', async () => {
  let args = null;
  const child = makeChildProcess();

  const spawn = (_cmd, spawnArgs) => {
    args = spawnArgs;
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({
        session_id: 'session_123',
        structured_output: validAgentOutput(),
      }));
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await __internal.runClaudeCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 1000,
    jsonSchema: '{"type":"object"}',
    model: 'sonnet',
    systemPromptPath: '/tmp/system-prompt.txt',
    prompt: 'Analyze this contract',
  });

  assert.deepEqual(result, { ok: true, text: JSON.stringify(validAgentOutput()) });
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    '{"type":"object"}',
    '--model',
    'sonnet',
    '--tools',
    '',
    '--no-session-persistence',
    '--no-chrome',
    '--disable-slash-commands',
    '--setting-sources',
    'user',
    '--permission-mode',
    'dontAsk',
    '--system-prompt-file',
    '/tmp/system-prompt.txt',
  ]);
});

test('runClaudeCli reports malformed stdout when Claude exits cleanly without structured output', async () => {
  const child = makeChildProcess();

  const spawn = () => {
    queueMicrotask(() => {
      child.stdout.emit('data', '{"result":"not valid agent output"}');
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await __internal.runClaudeCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 1000,
    jsonSchema: '{"type":"object"}',
    model: 'sonnet',
    systemPromptPath: '/tmp/system-prompt.txt',
    prompt: 'Analyze this contract',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.match(result.error.message, /returned no structured output/i);
});

test('runClaudeCli surfaces stderr and stdout when Claude exits non-zero', async () => {
  const child = makeChildProcess();

  const spawn = () => {
    queueMicrotask(() => {
      child.stderr.emit('data', 'permission denied');
      child.stdout.emit('data', 'stdout detail');
      child.emit('close', 1, null);
    });
    return child;
  };

  const result = await __internal.runClaudeCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 1000,
    jsonSchema: '{"type":"object"}',
    model: 'sonnet',
    systemPromptPath: '/tmp/system-prompt.txt',
    prompt: 'Analyze this contract',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.match(result.error.message, /permission denied/);
  assert.match(result.error.message, /stdout detail/);
});

test('runClaudeCli maps auth-related failures to a clear provider error', async () => {
  const child = makeChildProcess();

  const spawn = () => {
    queueMicrotask(() => {
      child.stderr.emit('data', 'Please sign in to Claude Code first.');
      child.emit('close', 1, null);
    });
    return child;
  };

  const result = await __internal.runClaudeCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 1000,
    jsonSchema: '{"type":"object"}',
    model: 'sonnet',
    systemPromptPath: '/tmp/system-prompt.txt',
    prompt: 'Analyze this contract',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.match(result.error.message, /not authenticated/i);
});

test('runClaudeCli reports subprocess spawn failures', async () => {
  const child = makeChildProcess();

  const spawn = () => {
    queueMicrotask(() => {
      child.emit('error', new Error('spawn claude ENOENT'));
    });
    return child;
  };

  const result = await __internal.runClaudeCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 1000,
    jsonSchema: '{"type":"object"}',
    model: 'sonnet',
    systemPromptPath: '/tmp/system-prompt.txt',
    prompt: 'Analyze this contract',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.match(result.error.message, /spawn claude ENOENT/);
});

test('runClaudeCli times out when Claude Code exceeds the timeout budget', async () => {
  const signals = [];
  const child = makeChildProcess();
  child.kill = (signal) => {
    signals.push(signal);
  };

  const spawn = () => child;

  const result = await __internal.runClaudeCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 5,
    jsonSchema: '{"type":"object"}',
    model: 'sonnet',
    systemPromptPath: '/tmp/system-prompt.txt',
    prompt: 'Analyze this contract',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.deepEqual(signals, ['SIGTERM']);
});

test('runClaudeCli escalates to SIGKILL when the child ignores SIGTERM', async () => {
  const signals = [];
  const child = makeChildProcess();
  child.kill = (signal) => {
    signals.push(signal);
  };

  const spawn = () => child;

  const result = await __internal.runClaudeCli({
    spawn,
    cwd: process.cwd(),
    timeoutMs: 5,
    jsonSchema: '{"type":"object"}',
    model: 'sonnet',
    systemPromptPath: '/tmp/system-prompt.txt',
    prompt: 'Analyze this contract',
  });

  await new Promise((resolve) => setTimeout(resolve, 2_050));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
