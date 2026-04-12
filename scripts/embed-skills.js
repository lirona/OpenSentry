#!/usr/bin/env node
// Build-time embedder for OpenSentry agent prompts.
//
// Cloudflare Pages Functions cannot read files from disk at runtime, so this
// script reads each markdown file in skill/agents/ and generates
// functions/api/lib/embedded-skills.js — a JS module that exports the agent
// contents as string constants for the agent runner to import.
//
// Usage: `npm run build` (or `node scripts/embed-skills.js`).

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AGENTS_DIR = join(REPO_ROOT, 'skill', 'agents');
const SHARED_RULES_FILE = join(REPO_ROOT, 'skill', 'shared-rules.md');
const OUTPUT_FILE = join(REPO_ROOT, 'functions', 'api', 'lib', 'embedded-skills.js');

// Display names must match the Risk Summary table in
// skill/output/report-template.md so the frontend labels line up with the
// methodology document. Keys are the agent filename without the `.md`.
const DISPLAY_NAMES = {
  'access-control':      'Access Control',
  'token-mechanics':     'Token Mechanics',
  'economic-fees':       'Economic & Fees',
  'oracle-dependencies': 'Oracle & Dependencies',
  'mev-safety':          'MEV & Tx Safety',
  'code-quality':        'Code Quality',
  'transparency':        'Transparency',
  'governance':          'Governance',
};

// Canonical emission order (matches the Risk Summary table order in the
// report template). Preserved in the generated module so downstream code that
// iterates via Object.entries(AGENTS) gets a deterministic order.
const AGENT_ORDER = [
  'access-control',
  'token-mechanics',
  'economic-fees',
  'oracle-dependencies',
  'mev-safety',
  'code-quality',
  'transparency',
  'governance',
];

// Escape a string so it can be safely embedded inside a JS template literal.
// Order matters: backslashes MUST be escaped first, otherwise the backticks
// and `${` escapes we introduce below would be double-escaped.
function escapeForTemplateLiteral(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/**
 * Read skill/shared-rules.md and split it into two parts:
 *   - rules:        methodology rules (Evidence Requirement … Finding Cap)
 *   - outputFormat:  the ## Output Format JSON schema block
 *
 * The file uses a `---` separator between the two sections. If the separator
 * or the Output Format heading is missing the build fails loudly so the
 * author knows the shared file is malformed.
 */
function loadSharedRules() {
  const raw = readFileSync(SHARED_RULES_FILE, 'utf8');

  const outputHeadingIdx = raw.indexOf('\n## Output Format');
  if (outputHeadingIdx === -1) {
    throw new Error('shared-rules.md: missing "## Output Format" heading');
  }

  // Everything before the Output Format heading is the rules block.
  // Trim the trailing `---` separator that sits between the two sections.
  const rules = raw.slice(0, outputHeadingIdx).replace(/\n---\s*$/, '').trimEnd();

  // The Output Format section itself (heading + JSON block).
  const outputFormat = raw.slice(outputHeadingIdx + 1).trimEnd();

  if (rules.length === 0) {
    throw new Error('shared-rules.md: rules section is empty');
  }
  if (outputFormat.length === 0) {
    throw new Error('shared-rules.md: Output Format section is empty');
  }

  return { rules, outputFormat };
}

/**
 * Inject shared content into an agent's markdown:
 *   1. Shared methodology rules are appended at the end of the agent's
 *      `## Rules` section (before the `---` + `## Checks` separator).
 *   2. The shared Output Format block is appended at the very end.
 *
 * If the expected markers are not found the build fails so the author
 * knows the agent file structure has drifted.
 */
function injectSharedRules(agentMarkdown, agentKey, shared) {
  // Find the first `---` that is followed (after optional whitespace) by
  // `## Checks`. This is the boundary between Rules and Checks.
  const checksMarker = /\n---\s*\n+## Checks/;
  const match = checksMarker.exec(agentMarkdown);
  if (!match) {
    throw new Error(
      `embed-skills: agent "${agentKey}" is missing the expected ` +
      `"---\\n## Checks" boundary after its Rules section`,
    );
  }

  const beforeChecks = agentMarkdown.slice(0, match.index);
  const checksOnward = agentMarkdown.slice(match.index);

  return `${beforeChecks}\n\n${shared.rules}${checksOnward}\n\n${shared.outputFormat}\n`;
}

function main() {
  // Discover agent files on disk and sanity-check against the canonical set
  // so a newly-added agent without a display name fails the build loudly.
  const discoveredKeys = readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''))
    .sort();

  const expectedKeys = Object.keys(DISPLAY_NAMES).sort();
  const missing    = expectedKeys.filter(k => !discoveredKeys.includes(k));
  const unexpected = discoveredKeys.filter(k => !expectedKeys.includes(k));
  if (missing.length) {
    throw new Error(`embed-skills: missing agent file(s): ${missing.join(', ')}`);
  }
  if (unexpected.length) {
    throw new Error(
      `embed-skills: unexpected agent file(s) not in DISPLAY_NAMES: ${unexpected.join(', ')}. ` +
      `Add them to DISPLAY_NAMES + AGENT_ORDER in scripts/embed-skills.js or remove the files.`,
    );
  }

  // Load shared rules once, then inject into every agent.
  const shared = loadSharedRules();

  // Read, inject shared rules, escape, and format each agent entry.
  const entries = AGENT_ORDER.map(key => {
    const raw = readFileSync(join(AGENTS_DIR, `${key}.md`), 'utf8');
    const assembled = injectSharedRules(raw, key, shared);
    const escaped = escapeForTemplateLiteral(assembled);
    const name = DISPLAY_NAMES[key];
    return `  ${JSON.stringify(key)}: {\n    name: ${JSON.stringify(name)},\n    content: \`${escaped}\`,\n  },`;
  });

  const output = `// AUTO-GENERATED — do not edit.
// Run \`npm run build\` to regenerate from skill/agents/*.md.
// This file is gitignored; it is rebuilt on every deploy.

export const AGENTS = {
${entries.join('\n')}
};
`;

  // functions/api/lib/ should already exist from Step 2, but mkdir -p is cheap
  // insurance for a fresh clone.
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, output, 'utf8');

  const byteCount = Buffer.byteLength(output, 'utf8');
  console.log(
    `embed-skills: wrote ${AGENT_ORDER.length} agents to ` +
    `${OUTPUT_FILE.replace(REPO_ROOT + '/', '')} (${byteCount} bytes)`,
  );
}

main();
