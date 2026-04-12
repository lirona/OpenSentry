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

  // Read, escape, and format each agent entry.
  const entries = AGENT_ORDER.map(key => {
    const raw = readFileSync(join(AGENTS_DIR, `${key}.md`), 'utf8');
    const escaped = escapeForTemplateLiteral(raw);
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
