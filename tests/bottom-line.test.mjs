import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBottomLine,
  deriveBottomLine,
  __internal,
} from '../functions/api/lib/bottom-line.js';

const {
  MAX_SENTENCE_LENGTH,
  selectBottomLineFindings,
  validateBottomLineResult,
  validateGeneratedSentence,
} = __internal;

function agentSummaries({ completed = 8, total = 8 } = {}) {
  return Array.from({ length: total }, (_, index) => ({
    agent: `Agent ${index + 1}`,
    status: index < completed ? 'completed' : 'failed',
  }));
}

function finding(overrides = {}) {
  return {
    id: 'OS-001',
    severity: 'WARNING',
    check: 'Owner can change fees',
    summary: 'The owner can set fees without a clear maximum.',
    user_impact: 'Users could lose most or all of a transfer to fees.',
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    overallSeverity: 'SAFE',
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
    findings: [],
    agentSummaries: agentSummaries(),
    ...overrides,
  };
}

function successfulSummary({
  severity = 'WARNING',
  summary = 'We found a few things worth understanding: the contract owner can change fees without a clear limit.',
  agent = 'Bottom Line',
  findings = [],
} = {}) {
  return {
    ok: true,
    result: { agent, severity, summary, findings },
  };
}

test('SAFE and INFO both map to No concern without claiming the contract is safe', () => {
  const safe = deriveBottomLine(report());
  const info = deriveBottomLine(report({
    overallSeverity: 'INFO',
    infoCount: 1,
    findings: [finding({ severity: 'INFO' })],
  }));

  for (const result of [safe, info]) {
    assert.equal(result.level, 'NO_CONCERN');
    assert.equal(result.label, 'No concern');
    assert.equal(result.sentence, 'We didn\'t find any major security concerns with this contract.');
    assert.equal(result.generated, false);
  }
});

test('WARNING maps to Some concerns', () => {
  const result = deriveBottomLine(report({
    overallSeverity: 'WARNING',
    warningCount: 1,
    findings: [finding()],
  }));

  assert.equal(result.level, 'SOME_CONCERNS');
  assert.equal(result.label, 'Some concerns');
  assert.match(result.sentence, /worth understanding/);
});

test('CRITICAL maps to High risk', () => {
  const result = deriveBottomLine(report({
    overallSeverity: 'CRITICAL',
    criticalCount: 1,
    findings: [finding({ severity: 'CRITICAL' })],
  }));

  assert.equal(result.level, 'HIGH_RISK');
  assert.equal(result.label, 'High risk');
  assert.match(result.sentence, /serious risks/);
});

test('partial SAFE and INFO reports become incomplete instead of No concern', () => {
  const safe = deriveBottomLine(report({ agentSummaries: agentSummaries({ completed: 7 }) }));
  const info = deriveBottomLine(report({
    overallSeverity: 'INFO',
    infoCount: 1,
    findings: [finding({ severity: 'INFO' })],
    agentSummaries: agentSummaries({ completed: 7 }),
  }));

  for (const result of [safe, info]) {
    assert.equal(result.level, null);
    assert.equal(result.label, 'Result incomplete');
    assert.equal(result.coverage.status, 'partial');
    assert.match(result.sentence, /analysis was incomplete/);
  }
});

test('partial WARNING and CRITICAL reports keep their known risk levels', () => {
  const warning = deriveBottomLine(report({
    overallSeverity: 'WARNING',
    warningCount: 1,
    findings: [finding()],
    agentSummaries: agentSummaries({ completed: 3 }),
  }));
  const critical = deriveBottomLine(report({
    overallSeverity: 'CRITICAL',
    criticalCount: 1,
    findings: [finding({ severity: 'CRITICAL' })],
    agentSummaries: agentSummaries({ completed: 3 }),
  }));

  assert.equal(warning.level, 'SOME_CONCERNS');
  assert.equal(critical.level, 'HIGH_RISK');
  assert.equal(warning.coverage.status, 'partial');
  assert.equal(critical.coverage.status, 'partial');
});

test('all failed with no findings produces an unavailable result', () => {
  const result = deriveBottomLine(report({
    overallSeverity: 'unknown',
    agentSummaries: agentSummaries({ completed: 0 }),
  }));

  assert.equal(result.level, null);
  assert.equal(result.label, 'Result incomplete');
  assert.equal(result.coverage.status, 'unavailable');
  assert.match(result.sentence, /no reliable security conclusion/);
});

test('deterministic elevated findings remain visible when all AI agents fail', () => {
  const result = deriveBottomLine(report({
    overallSeverity: 'CRITICAL',
    criticalCount: 1,
    findings: [finding({ severity: 'CRITICAL' })],
    agentSummaries: agentSummaries({ completed: 0 }),
  }));

  assert.equal(result.level, 'HIGH_RISK');
  assert.equal(result.coverage.status, 'unavailable');
});

test('missing, malformed, and unsupported reports fail closed', () => {
  for (const value of [
    null,
    undefined,
    {},
    report({ overallSeverity: 'BOGUS' }),
    report({ overallSeverity: 'SAFE', criticalCount: 1 }),
  ]) {
    const result = deriveBottomLine(value);
    assert.equal(result.level, null);
    assert.equal(result.label, 'Result incomplete');
  }
});

test('top-finding selection keeps only the first two findings at the overall severity', () => {
  const selected = selectBottomLineFindings(report({
    findings: [
      finding({ id: 'OS-001', severity: 'CRITICAL', check: 'First' }),
      finding({ id: 'OS-002', severity: 'WARNING', check: 'Ignore' }),
      finding({ id: 'OS-003', severity: 'CRITICAL', check: 'Second' }),
      finding({ id: 'OS-004', severity: 'CRITICAL', check: 'Third' }),
    ],
  }), 'CRITICAL');

  assert.deepEqual(selected.map((item) => item.id), ['OS-001', 'OS-003']);
  assert.equal(selected[0].check, 'First');
  assert.equal('detail' in selected[0], false);
});

test('top-finding selection handles missing arrays and non-string fields', () => {
  assert.deepEqual(selectBottomLineFindings({}, 'WARNING'), []);
  assert.deepEqual(selectBottomLineFindings({ findings: [{ severity: 'WARNING' }] }, 'WARNING'), [{
    id: '',
    check: '',
    summary: '',
    userImpact: '',
  }]);
});

test('generated sentence validation accepts one grounded plain-language sentence', () => {
  const result = validateGeneratedSentence(
    '  We found serious risks: the contract owner can change how your funds are handled.  ',
    { severity: 'CRITICAL', requiredOpening: 'We found serious risks' },
  );

  assert.equal(result, 'We found serious risks: the contract owner can change how your funds are handled.');
});

test('generated sentence validation rejects every unsafe output path', () => {
  const options = { severity: 'WARNING', requiredOpening: 'We found a few things worth understanding' };
  const cases = [
    null,
    '',
    'Different verdict: the owner can change fees.',
    'We found a few things worth understanding: the owner can change fees',
    'We found a few things worth understanding: one issue. Another issue.',
    'We found a few things worth understanding:\nfees can change.',
    'We found a few things worth understanding: **fees can change**.',
    'We found a few things worth understanding: the contract is otherwise safe.',
    'We found a few things worth understanding: this is a critical issue.',
    'We found a few things worth understanding: the proxy admin retains upgradeability privileges.',
    'We found a few things worth understanding: an unrestricted mint function exists.',
    `We found a few things worth understanding: ${'x'.repeat(MAX_SENTENCE_LENGTH)}.`,
  ];

  for (const sentence of cases) {
    assert.equal(validateGeneratedSentence(sentence, options), null, String(sentence));
  }
});

test('bottom-line result validation enforces the fixed agent shape and severity', () => {
  const options = { severity: 'WARNING', requiredOpening: 'We found a few things worth understanding' };

  assert.equal(
    validateBottomLineResult(successfulSummary(), options),
    'We found a few things worth understanding: the contract owner can change fees without a clear limit.',
  );

  const invalid = [
    null,
    { ok: false },
    successfulSummary({ agent: 'Governance' }),
    successfulSummary({ severity: 'CRITICAL' }),
    successfulSummary({ findings: [finding()] }),
    successfulSummary({ summary: 'Invalid.' }),
  ];
  for (const value of invalid) {
    assert.equal(validateBottomLineResult(value, options), null);
  }
});

test('No concern and incomplete states never call the model', async () => {
  let calls = 0;
  const runAgentFn = async () => {
    calls++;
    return successfulSummary();
  };

  const safe = await buildBottomLine({ report: report(), env: {}, runAgentFn });
  const incomplete = await buildBottomLine({
    report: report({ agentSummaries: agentSummaries({ completed: 7 }) }),
    env: {},
    runAgentFn,
  });

  assert.equal(calls, 0);
  assert.equal(safe.level, 'NO_CONCERN');
  assert.equal(incomplete.level, null);
});

test('valid generated wording replaces the Some concerns fallback', async () => {
  let suppliedSource;
  const result = await buildBottomLine({
    report: report({
      overallSeverity: 'WARNING',
      warningCount: 1,
      findings: [finding()],
    }),
    env: { AI_MODEL: 'test' },
    metadata: { contractName: 'Vault' },
    runAgentFn: async (_key, _prompt, source) => {
      suppliedSource = JSON.parse(source);
      return successfulSummary();
    },
  });

  assert.equal(result.generated, true);
  assert.deepEqual(result.sourceFindingIds, ['OS-001']);
  assert.equal(suppliedSource.fixedVerdict.level, 'SOME_CONCERNS');
  assert.equal(suppliedSource.findings.length, 1);
});

test('valid generated wording replaces the High risk fallback', async () => {
  const result = await buildBottomLine({
    report: report({
      overallSeverity: 'CRITICAL',
      criticalCount: 1,
      findings: [finding({ severity: 'CRITICAL' })],
    }),
    env: {},
    runAgentFn: async () => successfulSummary({
      severity: 'CRITICAL',
      summary: 'We found serious risks: anyone can withdraw funds without permission.',
    }),
  });

  assert.equal(result.level, 'HIGH_RISK');
  assert.equal(result.generated, true);
  assert.match(result.sentence, /withdraw funds/);
});

test('model failure, thrown errors, invalid output, and missing matching findings all use the deterministic fallback', async () => {
  const warningReport = report({
    overallSeverity: 'WARNING',
    warningCount: 1,
    findings: [finding()],
  });
  const expected = 'We found a few things worth understanding before you interact with this contract.';
  const runners = [
    async () => ({ ok: false, error: { code: 'TIMEOUT' } }),
    async () => { throw new Error('boom'); },
    async () => successfulSummary({ summary: 'Invalid.' }),
  ];

  for (const runAgentFn of runners) {
    const result = await buildBottomLine({ report: warningReport, env: {}, runAgentFn });
    assert.equal(result.generated, false);
    assert.equal(result.sentence, expected);
    assert.deepEqual(result.sourceFindingIds, []);
  }

  const missingFindings = await buildBottomLine({
    report: { ...warningReport, findings: [] },
    env: {},
    runAgentFn: async () => { throw new Error('must not run'); },
  });
  assert.equal(missingFindings.sentence, expected);
});
