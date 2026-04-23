import { errorResult } from '../error-result.js';
import { buildOutputSchema } from '../output-schema.js';
import { tryParseJson } from '../try-parse-json.js';

const CLAUDE_CLI_BINARY = 'claude';

const SEVERITY_SET = new Set(['SAFE', 'INFO', 'WARNING', 'CRITICAL']);
const FINDING_STRING_FIELDS = Object.freeze([
  'check',
  'severity',
  'location',
  'summary',
  'detail',
  'user_impact',
]);

export function createClaudeCliProvider() {
  return Object.freeze({
    name: 'claude-cli',
    requiresApiKey: false,
    defaultTotalBudgetMs: 8 * 60_000,
    defaultPerAttemptTimeoutMs: 8 * 60_000,
    async execute({ systemPrompt, userMessage, env, timeoutMs }) {
      if (typeof env?.__CLAUDE_CLI_RUNNER === 'function') {
        return env.__CLAUDE_CLI_RUNNER({ systemPrompt, userMessage, env, timeoutMs });
      }

      const { spawn } = await import('node:child_process');
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');

      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-claude-cli-'));
      const systemPromptPath = path.join(tempDir, 'system-prompt.txt');

      try {
        await writeFile(systemPromptPath, `${buildClaudeCliSystemPrompt(systemPrompt)}\n`, 'utf8');

        const result = await runClaudeCli({
          spawn,
          // Run inside the temp directory so Claude Code does not discover
          // project-local CLAUDE.md context or cwd-keyed project memory.
          cwd: tempDir,
          timeoutMs,
          jsonSchema: JSON.stringify(buildOutputSchema()),
          model: env.AI_MODEL,
          systemPromptPath,
          prompt: userMessage,
        });

        if (!result.ok) {
          return result;
        }

        return { ok: true, text: result.text };
      } catch (error) {
        return errorResult('PROVIDER_ERROR', `Claude Code execution failed: ${error?.message || String(error)}`);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  });
}

function buildClaudeCliSystemPrompt(systemPrompt) {
  return (
    'You are acting as a deterministic security-analysis engine. ' +
    'Do not request tools, do not ask to inspect the filesystem, and do not browse the web. ' +
    'Use only the instructions and source code included below. ' +
    'Return exactly one JSON object that matches the provided schema.\n\n' +
    `${systemPrompt}`
  );
}


async function runClaudeCli({ spawn, cwd, timeoutMs, jsonSchema, model, systemPromptPath, prompt }) {
  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE_CLI_BINARY,
      [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        jsonSchema,
        '--model',
        model,
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
        systemPromptPath,
      ],
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let killTimer = null;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {
          // Ignore cases where the child has already exited.
        }
      }, 2_000);
      killTimer.unref?.();
      finish(errorResult('TIMEOUT', `Model call exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.stdin.on('error', () => {});

    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish(errorResult('PROVIDER_ERROR', `Claude Code execution failed: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);

      if (resolved) return;

      finish(classifyClaudeCliExit({ code, signal, stdout, stderr, timeoutMs }));
    });

    child.stdin.end(prompt);

    function finish(result) {
      if (resolved) return;
      resolved = true;
      resolve(result);
    }
  });
}

function extractClaudeCliText(stdout) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return '';

  const payload = tryParseJson(stdout.trim());
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';

  const structuredOutput = normalizeStructuredOutput(payload.structured_output);
  if (structuredOutput) {
    return JSON.stringify(structuredOutput);
  }

  if (typeof payload.result !== 'string' || payload.result.trim().length === 0) {
    return '';
  }

  const fallbackOutput = normalizeStructuredOutput(payload.result.trim());
  if (!fallbackOutput) return '';

  return JSON.stringify(fallbackOutput);
}

function classifyClaudeCliExit({ code, signal, stdout, stderr, timeoutMs }) {
  if (signal === 'SIGTERM') {
    return errorResult('TIMEOUT', `Model call exceeded ${timeoutMs}ms`);
  }

  const combined = `${stderr}\n${stdout}`.trim();

  if (code !== 0) {
    if (looksLikeAuthError(combined)) {
      return errorResult('PROVIDER_ERROR', `Claude Code is not authenticated: ${combined}`);
    }

    return errorResult(
      'PROVIDER_ERROR',
      `Claude Code execution failed: ${combined || `Claude Code exited with code ${code}`}`,
    );
  }

  const finalText = extractClaudeCliText(stdout);
  if (finalText) {
    return { ok: true, text: finalText };
  }

  return errorResult(
    'PROVIDER_ERROR',
    `Claude Code returned no structured output: ${combined || 'empty stdout'}`,
  );
}

function normalizeStructuredOutput(candidate) {
  const parsed = typeof candidate === 'string' ? tryParseJson(candidate) : candidate;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!isValidAgentOutputShape(parsed)) return null;
  return parsed;
}

function isValidAgentOutputShape(candidate) {
  if (typeof candidate.agent !== 'string' || candidate.agent.length === 0) return false;
  if (typeof candidate.summary !== 'string') return false;
  if (!SEVERITY_SET.has(candidate.severity)) return false;
  if (!Array.isArray(candidate.findings)) return false;

  return candidate.findings.every((finding) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false;
    if (!SEVERITY_SET.has(finding.severity)) return false;
    return FINDING_STRING_FIELDS.every((field) => typeof finding[field] === 'string');
  });
}

function looksLikeAuthError(message) {
  return /\blog(?:\s+|-)in\b|\bsign(?:\s+|-)in\b|\bauth(?:entication|enticate)?\b|\bnot logged in\b/i.test(message);
}


export { CLAUDE_CLI_BINARY };
export const __internal = Object.freeze({
  buildClaudeCliSystemPrompt,
  classifyClaudeCliExit,
  extractClaudeCliText,
  runClaudeCli,
});
