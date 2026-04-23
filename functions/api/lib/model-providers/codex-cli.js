import { errorResult } from '../error-result.js';
import { buildOutputSchema } from '../output-schema.js';
import { tryParseJson } from '../try-parse-json.js';

const CODEX_CLI_BINARY = 'codex';

export function createCodexCliProvider() {
  return Object.freeze({
    name: 'codex-cli',
    requiresApiKey: false,
    defaultTotalBudgetMs: 8 * 60_000,
    defaultPerAttemptTimeoutMs: 8 * 60_000,
    async execute({ systemPrompt, userMessage, env, timeoutMs }) {
      if (typeof env?.__CODEX_CLI_RUNNER === 'function') {
        return env.__CODEX_CLI_RUNNER({ systemPrompt, userMessage, env, timeoutMs });
      }

      const { spawn } = await import('node:child_process');
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');

      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opensentry-codex-cli-'));
      const schemaPath = path.join(tempDir, 'agent-output.schema.json');

      try {
        await writeFile(schemaPath, `${JSON.stringify(buildOutputSchema(), null, 2)}\n`, 'utf8');

        const result = await runCodexCli({
          spawn,
          cwd: process.cwd(),
          timeoutMs,
          schemaPath,
          model: env.AI_MODEL,
          prompt: buildCodexCliPrompt(systemPrompt, userMessage),
        });

        if (!result.ok) {
          return result;
        }

        return { ok: true, text: result.text };
      } catch (error) {
        return errorResult('PROVIDER_ERROR', `Codex CLI execution failed: ${error?.message || String(error)}`);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  });
}

function buildCodexCliPrompt(systemPrompt, userMessage) {
  return (
    'You are acting as a deterministic security-analysis engine. ' +
    'Do not run shell commands, do not inspect the filesystem, and do not browse the web. ' +
    'Use only the instructions and source code included below. ' +
    'Return exactly one JSON object that matches the provided schema.\n\n' +
    '<system_instructions>\n' +
    `${systemPrompt}\n` +
    '</system_instructions>\n\n' +
    '<user_message>\n' +
    `${userMessage}\n` +
    '</user_message>\n'
  );
}


async function runCodexCli({ spawn, cwd, timeoutMs, schemaPath, model, prompt, killGraceMs = 2_000 }) {
  return new Promise((resolve) => {
    const child = spawn(
      CODEX_CLI_BINARY,
      [
        'exec',
        '--ephemeral',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--color',
        'never',
        '--output-schema',
        schemaPath,
        '-m',
        model,
        '-',
      ],
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let finalText = '';
    let killTimer = null;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {
          // Ignore cases where the child has already exited.
        }
      }, killGraceMs);
      killTimer.unref?.();
      finish(errorResult('TIMEOUT', `Model call exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const parsed = extractCodexCliText(stdout);
      if (parsed) finalText = parsed;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish(errorResult('PROVIDER_ERROR', `Codex CLI execution failed: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);

      if (resolved) return;

      if (finalText) {
        finish({ ok: true, text: finalText });
        return;
      }

      if (signal === 'SIGTERM') {
        finish(errorResult('TIMEOUT', `Model call exceeded ${timeoutMs}ms`));
        return;
      }

      const combined = `${stderr}\n${stdout}`.trim() || `Codex CLI exited with code ${code}`;
      if (/login|authenticate|sign in/i.test(combined)) {
        finish(errorResult('PROVIDER_ERROR', `Codex CLI is not authenticated: ${combined}`));
        return;
      }

      finish(errorResult('PROVIDER_ERROR', `Codex CLI execution failed: ${combined}`));
    });

    child.stdin.end(prompt);

    function finish(result) {
      if (resolved) return;
      resolved = true;
      resolve(result);
    }
  });
}

function extractCodexCliText(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return '';

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const event = tryParseJson(lines[i]);
    if (!event) continue;

    const eventText = extractTextFromEvent(event);
    if (eventText) return eventText;

    const candidate = normalizeJsonLine(lines[i]);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          !Object.prototype.hasOwnProperty.call(parsed, 'type')) {
        return candidate;
      }
    } catch (_) {
      // Ignore non-JSON lines and keep scanning backward.
    }
  }

  return '';
}


function extractTextFromEvent(event) {
  if (!event || typeof event !== 'object') return '';

  if (event.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item?.text === 'string' &&
      event.item.text.length > 0) {
    return event.item.text;
  }

  if (event.type === 'item.completed' &&
      event.item?.type === 'message' &&
      typeof event.item?.text === 'string' &&
      event.item.text.length > 0) {
    return event.item.text;
  }

  return '';
}

function normalizeJsonLine(line) {
  if (line.startsWith('{') && line.endsWith('}')) return line;

  const braceIndex = line.indexOf('{');
  if (braceIndex === -1) return '';

  const candidate = line.slice(braceIndex).trim();
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  return '';
}

export { CODEX_CLI_BINARY };
export const __internal = Object.freeze({
  extractCodexCliText,
  runCodexCli,
});
