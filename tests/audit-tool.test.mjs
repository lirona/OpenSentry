import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const auditToolHtml = await readFile(
  new URL('../website/audit-tool.html', import.meta.url),
  'utf8',
);

test('audit tool has no browser-side daily quota', () => {
  assert.doesNotMatch(auditToolHtml, /quota-indicator|QUOTA_KEY|localStorage|analyses remaining today/);
});

test('audit tool has no post-analysis cooldown', () => {
  assert.doesNotMatch(auditToolHtml, /cooldown-bar|COOLDOWN_SEC|startCooldown|Please wait \$\{cooldownSec\}/);
});

test('all analysis outcomes leave the next submission unrestricted', () => {
  const submitFlow = auditToolHtml.slice(auditToolHtml.indexOf("form.addEventListener('submit'"));

  assert.doesNotMatch(submitFlow, /analyzeBtn\.disabled|\.disabled\s*=|setTimeout\([^,]+,\s*60000\)/);
  assert.doesNotMatch(submitFlow, /daily_limit|ip_cooldown|bumpQuota|startCooldown/);
});
