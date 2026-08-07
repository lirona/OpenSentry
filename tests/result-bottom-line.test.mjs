import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDisplayBottomLine,
  getBottomLinePresentation,
  __internal,
} from '../website/result-bottom-line.js';

function summaries(completed = 8, total = 8) {
  return Array.from({ length: total }, (_, index) => ({
    status: index < completed ? 'completed' : 'failed',
  }));
}

function report(overrides = {}) {
  return {
    overallSeverity: 'SAFE',
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
    findings: [],
    agentSummaries: summaries(),
    ...overrides,
  };
}

test('frontend fallback maps SAFE and INFO to No concern', () => {
  for (const overallSeverity of ['SAFE', 'INFO']) {
    const result = getDisplayBottomLine(report({
      overallSeverity,
      infoCount: overallSeverity === 'INFO' ? 1 : 0,
    }));
    assert.equal(result.level, 'NO_CONCERN');
    assert.equal(result.label, 'No concern');
    assert.equal(result.sentence, 'We didn\'t find any major security concerns with this contract.');
  }
});

test('frontend fallback maps WARNING and CRITICAL to the remaining two levels', () => {
  const warning = getDisplayBottomLine(report({ overallSeverity: 'WARNING', warningCount: 1 }));
  const critical = getDisplayBottomLine(report({ overallSeverity: 'CRITICAL', criticalCount: 1 }));

  assert.equal(warning.level, 'SOME_CONCERNS');
  assert.equal(warning.label, 'Some concerns');
  assert.equal(critical.level, 'HIGH_RISK');
  assert.equal(critical.label, 'High risk');
});

test('frontend fallback refuses a reassuring result for partial low-severity analysis', () => {
  const result = getDisplayBottomLine(report({ agentSummaries: summaries(6) }));

  assert.equal(result.level, null);
  assert.equal(result.label, 'Result incomplete');
  assert.match(result.sentence, /analysis was incomplete/);
  assert.equal(result.coverage.status, 'partial');
});

test('frontend fallback preserves known WARNING and CRITICAL risk during partial analysis', () => {
  const warning = getDisplayBottomLine(report({
    overallSeverity: 'WARNING',
    warningCount: 1,
    agentSummaries: summaries(6),
  }));
  const critical = getDisplayBottomLine(report({
    overallSeverity: 'CRITICAL',
    criticalCount: 1,
    agentSummaries: summaries(0),
  }));

  assert.equal(warning.level, 'SOME_CONCERNS');
  assert.equal(warning.coverage.status, 'partial');
  assert.equal(critical.level, 'HIGH_RISK');
  assert.equal(critical.coverage.status, 'unavailable');
});

test('valid backend bottom line is used and normalized', () => {
  const result = getDisplayBottomLine(report({
    overallSeverity: 'WARNING',
    warningCount: 1,
    bottomLine: {
      level: 'SOME_CONCERNS',
      label: '  Some concerns  ',
      sentence: '  We found a few things worth understanding: fees can change without a limit.  ',
      generated: true,
      sourceFindingIds: ['OS-001', 'bad', 'OS-1000'],
      coverage: { status: 'complete', completedCount: 8, totalCount: 8 },
    },
  }));

  assert.equal(result.label, 'Some concerns');
  assert.equal(result.generated, true);
  assert.deepEqual(result.sourceFindingIds, ['OS-001', 'OS-1000']);
  assert.equal(result.sentence, 'We found a few things worth understanding: fees can change without a limit.');
});

test('missing and malformed backend bottom lines fall back safely', () => {
  const cases = [
    undefined,
    null,
    {},
    { level: 'UNKNOWN', label: 'Unknown', sentence: 'Bad.' },
    { level: 'HIGH_RISK', label: 'High risk', sentence: 'Bad.' },
    { level: 'NO_CONCERN', label: '', sentence: 'Bad.' },
    { level: 'NO_CONCERN', label: 'No concern', sentence: '' },
  ];

  for (const bottomLine of cases) {
    const result = getDisplayBottomLine(report({ bottomLine }));
    assert.equal(result.level, 'NO_CONCERN');
    assert.equal(result.generated, false);
  }
});

test('missing and unsupported reports fail closed in the frontend', () => {
  for (const value of [
    null,
    undefined,
    {},
    report({ overallSeverity: 'BOGUS' }),
    report({ overallSeverity: 'SAFE', criticalCount: 1 }),
  ]) {
    const result = getDisplayBottomLine(value);
    assert.equal(result.level, null);
    assert.equal(result.label, 'Result incomplete');
  }
});

test('presentation maps all levels to colors, actions, and targets', () => {
  assert.deepEqual(
    getBottomLinePresentation({ level: 'NO_CONCERN', sourceFindingIds: [], coverage: { status: 'complete' } }),
    {
      severityClass: 'sev-safe',
      actionLabel: 'View analysis details ↓',
      actionTarget: '#analysis-details',
      coverageNote: '',
    },
  );

  assert.deepEqual(
    getBottomLinePresentation({
      level: 'SOME_CONCERNS',
      sourceFindingIds: ['OS-002'],
      coverage: { status: 'partial', completedCount: 7, totalCount: 8 },
    }),
    {
      severityClass: 'sev-warning',
      actionLabel: 'See why ↓',
      actionTarget: '#finding-OS-002',
      coverageNote: 'Partial analysis: 7 of 8 analysis areas completed.',
    },
  );

  assert.deepEqual(
    getBottomLinePresentation({
      level: 'HIGH_RISK',
      sourceFindingIds: [],
      coverage: { status: 'complete' },
    }),
    {
      severityClass: 'sev-critical',
      actionLabel: 'See why ↓',
      actionTarget: '#findings-list',
      coverageNote: '',
    },
  );

  assert.deepEqual(
    getBottomLinePresentation({
      level: null,
      sourceFindingIds: [],
      coverage: { status: 'unavailable', completedCount: 0, totalCount: 8 },
    }),
    {
      severityClass: 'sev-unknown',
      actionLabel: 'View analysis details ↓',
      actionTarget: '#analysis-details',
      coverageNote: 'Analysis incomplete: none of the 8 analysis areas completed.',
    },
  );
});

test('coverage normalization clamps invalid values and covers unknown notes', () => {
  assert.deepEqual(
    __internal.normalizeCoverage(
      { status: 'bad', completedCount: 12, totalCount: 8 },
      { status: 'partial', completedCount: 4, totalCount: 8 },
    ),
    { status: 'partial', completedCount: 8, totalCount: 8 },
  );
  assert.equal(__internal.buildCoverageNote({ status: 'unknown' }), '');
  assert.equal(__internal.buildCoverageNote({ status: 'unavailable', totalCount: 0 }), 'Analysis incomplete.');
});
