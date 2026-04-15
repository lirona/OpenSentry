// Unit tests for functions/api/lib/merge-results.js
//
// Run:  node --test tests/merge-results.test.mjs
//
// The merger is pure — no fetch stubs needed. Every test constructs a
// hand-crafted agentRuns array, calls mergeResults, and asserts on the
// returned report shape.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeResults, __internal } from '../functions/api/lib/merge-results.js';

const {
  classifyRun,
  normalizeLocation,
  locationsMatch,
  checksSimilar,
  isContradictory,
  CANONICAL_AGENTS,
  FINDING_CAP,
} = __internal;

// ---- helpers ---------------------------------------------------------------

// Make a runAgent-shaped settled result wrapping a valid agent output.
function ok(key, name, agentOutput) {
  return {
    key,
    name,
    settled: {
      status: 'fulfilled',
      value: { ok: true, key, result: agentOutput, attempts: 1 },
    },
  };
}

// Make a run where runAgent returned ok:false (handled failure).
function runnerError(key, name, code = 'HTTP_5XX') {
  return {
    key,
    name,
    settled: {
      status: 'fulfilled',
      value: { ok: false, key, error: { code, message: 'simulated' }, attempts: 2 },
    },
  };
}

// Make a run where the outer promise rejected (shouldn't happen with the
// current runner but the merger must tolerate it).
function rejected(key, name) {
  return {
    key,
    name,
    settled: { status: 'rejected', reason: new Error('boom') },
  };
}

function finding(overrides = {}) {
  return {
    check: 'Unprotected initializer',
    severity: 'WARNING',
    location: 'Vault.sol:42',
    summary: 'initialize() has no guard.',
    detail: 'The initialize function is missing the initializer modifier.',
    user_impact: 'Anyone could seize ownership.',
    ...overrides,
  };
}

function agentOutput(overrides = {}) {
  return {
    agent: 'Access Control',
    severity: 'WARNING',
    summary: 'One warning-level issue.',
    findings: [finding()],
    ...overrides,
  };
}

function compilerFinding(overrides = {}) {
  return {
    ruleId: 'fee-uncapped-100',
    source: 'Compiler Facts',
    check: 'Configurable fee can reach 100%',
    severity: 'CRITICAL',
    location: 'Vault.sol:77',
    summary: 'feeBps is configurable without a visible cap and can reach 100% of the fee scale.',
    detail: 'setFeeBps updates feeBps without a visible maximum.',
    user_impact: 'Users could lose all of the transferred value to fees.',
    ...overrides,
  };
}

// Build a complete 8-agent input, defaulting every agent to SAFE-empty.
function allSafe() {
  return CANONICAL_AGENTS.map(({ key, name }) =>
    ok(key, name, { agent: name, severity: 'SAFE', summary: 'Nothing found.', findings: [] }),
  );
}

// ---- input guards ----------------------------------------------------------

test('mergeResults throws when agentRuns is not an array', () => {
  assert.throws(() => mergeResults(null), /must be an array/);
  assert.throws(() => mergeResults({}),   /must be an array/);
  assert.throws(() => mergeResults(),     /must be an array/);
});

// ---- classification --------------------------------------------------------

test('classifyRun: rejected promise → failed with placeholder summary', () => {
  const p = classifyRun(rejected('access-control', 'Access Control'));
  assert.equal(p.status, 'failed');
  assert.equal(p.agentName, 'Access Control');
  assert.equal(p.severity, 'unknown');
  assert.equal(p.summary, 'Analysis incomplete for Access Control');
  assert.deepEqual(p.findings, []);
});

test('classifyRun: runner ok:false → failed', () => {
  const p = classifyRun(runnerError('governance', 'Governance', 'RATE_LIMIT'));
  assert.equal(p.status, 'failed');
  assert.equal(p.failReason, 'RATE_LIMIT');
  assert.equal(p.summary, 'Analysis incomplete for Governance');
});

test('classifyRun: missing settled → failed', () => {
  const p = classifyRun({ key: 'x', name: 'X' });
  assert.equal(p.status, 'failed');
});

test('classifyRun: valid run → completed with findings preserved', () => {
  const p = classifyRun(ok('access-control', 'Access Control', agentOutput()));
  assert.equal(p.status, 'completed');
  assert.equal(p.severity, 'WARNING');
  assert.equal(p.findings.length, 1);
});

// ---- location / check similarity helpers -----------------------------------

test('normalizeLocation: file:line forms', () => {
  assert.deepEqual(normalizeLocation('Vault.sol:42'),       { file: 'vault.sol', line: '42',    hasLine: true });
  assert.deepEqual(normalizeLocation('Vault.sol : 42'),     { file: 'vault.sol', line: '42',    hasLine: true });
  assert.deepEqual(normalizeLocation('Vault.sol:42-47'),    { file: 'vault.sol', line: '42-47', hasLine: true });
  assert.deepEqual(normalizeLocation('Vault.sol'),          { file: 'vault.sol', line: null,    hasLine: false });
});

test('locationsMatch: both with line → must be equal', () => {
  assert.equal(locationsMatch({ location: 'Vault.sol:42' }, { location: 'vault.sol:42' }), true);
  assert.equal(locationsMatch({ location: 'Vault.sol:42' }, { location: 'Vault.sol:43' }), false);
  assert.equal(locationsMatch({ location: 'Vault.sol:42' }, { location: 'Token.sol:42' }), false);
});

test('locationsMatch: one without line → file-level match', () => {
  assert.equal(locationsMatch({ location: 'Vault.sol:42' }, { location: 'Vault.sol' }), true);
});

test('checksSimilar: exact after normalization', () => {
  assert.equal(checksSimilar('Unprotected initializer', 'UNPROTECTED INITIALIZER!'), true);
});

test('checksSimilar: Jaccard ≥ 0.6', () => {
  // "Unprotected initializer function" vs "Unprotected initializer"
  // Tokens A = {unprotected, initializer, function}, B = {unprotected, initializer}
  // |A∩B|=2, |A∪B|=3, ratio = 0.66 → similar.
  assert.equal(checksSimilar('Unprotected initializer function', 'Unprotected initializer'), true);
});

test('checksSimilar: unrelated checks fail', () => {
  assert.equal(checksSimilar('Reentrancy in withdraw', 'Unprotected initializer'), false);
});

// ---- quality gate ----------------------------------------------------------

test('quality gate: WARNING without line citation is dropped', () => {
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({
      findings: [finding({ location: 'Vault.sol' })], // no line
    })),
    ...allSafe().slice(1),
  ]);
  assert.equal(report.findings.length, 0);
  assert.match(report.agentSummaries[0].summary, /\(1 findings dropped: no code citation\)/);
});

test('quality gate: INFO without line citation is kept', () => {
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({
      severity: 'INFO',
      findings: [finding({ severity: 'INFO', location: 'Vault.sol' })],
    })),
    ...allSafe().slice(1),
  ]);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].severity, 'INFO');
});

test('quality gate: contradictory CRITICAL is dropped', () => {
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({
      severity: 'CRITICAL',
      findings: [finding({
        severity: 'CRITICAL',
        detail: 'This call is not exploitable because the caller must be the admin.',
      })],
    })),
    ...allSafe().slice(1),
  ]);
  assert.equal(report.findings.length, 0);
});

test('quality gate: finding cap truncates to FINDING_CAP, keeping worst', () => {
  const findings = [
    finding({ check: 'Issue A', severity: 'INFO',     location: 'A.sol:1' }),
    finding({ check: 'Issue B', severity: 'WARNING',  location: 'B.sol:2' }),
    finding({ check: 'Issue C', severity: 'CRITICAL', location: 'C.sol:3' }),
    finding({ check: 'Issue D', severity: 'WARNING',  location: 'D.sol:4' }),
    finding({ check: 'Issue E', severity: 'INFO',     location: 'E.sol:5' }),
    finding({ check: 'Issue F', severity: 'INFO',     location: 'F.sol:6' }),
    finding({ check: 'Issue G', severity: 'INFO',     location: 'G.sol:7' }),
  ];
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({ severity: 'CRITICAL', findings })),
    ...allSafe().slice(1),
  ]);
  assert.equal(report.findings.length, FINDING_CAP);
  // After cap: 1 CRITICAL + 2 WARNING + 2 INFO (sorted by severity).
  const kinds = report.findings.map(f => f.severity);
  assert.deepEqual(kinds, ['CRITICAL', 'WARNING', 'WARNING', 'INFO', 'INFO']);
});

test('quality gate: agent-level severity corrected to max of kept findings', () => {
  // Agent declared SAFE but has a WARNING finding → must be corrected.
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({
      severity: 'SAFE',
      findings: [finding({ severity: 'WARNING', location: 'X.sol:1' })],
    })),
    ...allSafe().slice(1),
  ]);
  assert.equal(report.agentSummaries[0].severity, 'WARNING');
});

// ---- dedup + conflict resolution -------------------------------------------

test('dedup: same file:line + similar check → one finding with both agents', () => {
  const sharedLoc = 'Vault.sol:42';
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({
      findings: [finding({ check: 'Unprotected initializer', location: sharedLoc })],
    })),
    ok('governance', 'Governance', agentOutput({
      agent: 'Governance',
      findings: [finding({ check: 'UNPROTECTED INITIALIZER', location: sharedLoc })],
    })),
    ...allSafe().filter(r => r.key !== 'access-control' && r.key !== 'governance'),
  ]);
  assert.equal(report.findings.length, 1);
  assert.deepEqual(
    [...report.findings[0].agents].sort(),
    ['Access Control', 'Governance'],
  );
});

test('dedup: conflicting severity → higher wins + both justifications preserved', () => {
  const sharedLoc = 'Vault.sol:42';
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({
      severity: 'WARNING',
      findings: [finding({
        check: 'Missing access control',
        severity: 'WARNING',
        location: sharedLoc,
        detail: 'Function lacks access control (low-risk context).',
      })],
    })),
    ok('governance', 'Governance', agentOutput({
      agent: 'Governance',
      severity: 'CRITICAL',
      findings: [finding({
        check: 'Missing access control',
        severity: 'CRITICAL',
        location: sharedLoc,
        detail: 'Function exposes governance powers without access control.',
      })],
    })),
    ...allSafe().filter(r => r.key !== 'access-control' && r.key !== 'governance'),
  ]);

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].severity, 'CRITICAL');
  assert.match(report.findings[0].detail, /\[Access Control\] .* \(low-risk/);
  assert.match(report.findings[0].detail, /\[Governance\] .* governance powers/);
});

test('dedup: different locations → two findings', () => {
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({
      findings: [finding({ location: 'Vault.sol:42' })],
    })),
    ok('governance', 'Governance', agentOutput({
      agent: 'Governance',
      findings: [finding({ location: 'Vault.sol:99' })],
    })),
    ...allSafe().filter(r => r.key !== 'access-control' && r.key !== 'governance'),
  ]);
  assert.equal(report.findings.length, 2);
});

// ---- sort + id assignment --------------------------------------------------

test('sort: CRITICAL > WARNING > INFO; within severity, agents[0] alphabetical', () => {
  const report = mergeResults([
    ok('token-mechanics', 'Token Mechanics', agentOutput({
      agent: 'Token Mechanics',
      severity: 'INFO',
      findings: [finding({ check: 'Minor thing',     severity: 'INFO',     location: 'A.sol:1' })],
    })),
    ok('governance', 'Governance', agentOutput({
      agent: 'Governance',
      severity: 'CRITICAL',
      findings: [finding({ check: 'Giant hole',      severity: 'CRITICAL', location: 'B.sol:1' })],
    })),
    ok('access-control', 'Access Control', agentOutput({
      severity: 'WARNING',
      findings: [finding({ check: 'Medium thing',    severity: 'WARNING',  location: 'C.sol:1' })],
    })),
    ok('code-quality', 'Code Quality', agentOutput({
      agent: 'Code Quality',
      severity: 'WARNING',
      findings: [finding({ check: 'Another medium',  severity: 'WARNING',  location: 'D.sol:1' })],
    })),
    ...allSafe().filter(r => !['token-mechanics','governance','access-control','code-quality'].includes(r.key)),
  ]);

  assert.deepEqual(
    report.findings.map(f => ({ id: f.id, severity: f.severity, agent: f.agents[0] })),
    [
      { id: 'OS-001', severity: 'CRITICAL', agent: 'Governance' },
      { id: 'OS-002', severity: 'WARNING',  agent: 'Access Control' }, // A before C
      { id: 'OS-003', severity: 'WARNING',  agent: 'Code Quality' },
      { id: 'OS-004', severity: 'INFO',     agent: 'Token Mechanics' },
    ],
  );
});

// ---- aggregates ------------------------------------------------------------

test('aggregates: counts and overallSeverity reflect merged findings + agents', () => {
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({
      severity: 'CRITICAL',
      findings: [
        finding({ check: 'A', severity: 'CRITICAL', location: 'A.sol:1' }),
        finding({ check: 'B', severity: 'WARNING',  location: 'B.sol:1' }),
      ],
    })),
    ok('governance', 'Governance', agentOutput({
      agent: 'Governance',
      severity: 'INFO',
      findings: [finding({ check: 'C', severity: 'INFO', location: 'C.sol:1' })],
    })),
    ...allSafe().filter(r => r.key !== 'access-control' && r.key !== 'governance'),
  ]);

  assert.equal(report.overallSeverity, 'CRITICAL');
  assert.equal(report.criticalCount, 1);
  assert.equal(report.warningCount, 1);
  assert.equal(report.infoCount, 1);
});

test('deterministic findings are merged into final findings with Compiler Facts label', () => {
  const report = mergeResults(allSafe(), {
    deterministicFindings: [compilerFinding({ severity: 'WARNING' })],
  });

  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.findings[0].agents, ['Compiler Facts']);
  assert.equal(report.findings[0].severity, 'WARNING');
  assert.equal(report.overallSeverity, 'WARNING');
  assert.equal(report.warningCount, 1);
});

test('aggregates: all SAFE → overall SAFE, zero counts', () => {
  const report = mergeResults(allSafe());
  assert.equal(report.overallSeverity, 'SAFE');
  assert.equal(report.criticalCount, 0);
  assert.equal(report.warningCount, 0);
  assert.equal(report.infoCount, 0);
  assert.equal(report.findings.length, 0);
});

test('aggregates: all failed → overall unknown', () => {
  const runs = CANONICAL_AGENTS.map(({ key, name }) => runnerError(key, name));
  const report = mergeResults(runs);
  assert.equal(report.overallSeverity, 'unknown');
  assert.equal(report.findings.length, 0);
  for (const s of report.agentSummaries) {
    assert.equal(s.status, 'failed');
    assert.equal(s.severity, 'unknown');
    assert.match(s.summary, /^Analysis incomplete for /);
    assert.equal(s.failureReason, 'HTTP_5XX');
  }
});

// ---- agentSummaries canonical order ----------------------------------------

test('agentSummaries: always 8 entries in canonical order, missing → failed', () => {
  // Only provide one agent; the other 7 should appear as failed placeholders.
  const report = mergeResults([
    ok('access-control', 'Access Control', agentOutput({ severity: 'SAFE', findings: [] })),
  ]);
  assert.equal(report.agentSummaries.length, 8);
  assert.deepEqual(
    report.agentSummaries.map(s => s.agent),
    CANONICAL_AGENTS.map(a => a.name),
  );
  assert.equal(report.agentSummaries[0].status, 'completed');
  assert.equal(report.agentSummaries[0].failureReason, null);
  for (let i = 1; i < 8; i++) {
    assert.equal(report.agentSummaries[i].status, 'failed');
    assert.equal(report.agentSummaries[i].failureReason, 'missing agent result');
  }
});

test('agentSummaries stay fixed at 8 entries when deterministic findings are present', () => {
  const report = mergeResults(allSafe(), {
    deterministicFindings: [compilerFinding()],
  });

  assert.equal(report.agentSummaries.length, 8);
  assert.deepEqual(
    report.agentSummaries.map((summary) => summary.agent),
    CANONICAL_AGENTS.map((agent) => agent.name),
  );
});

// ---- SAFE findings are never individually listed ---------------------------

test('SAFE findings are never listed in the findings array', () => {
  const report = mergeResults([
    ok('access-control', 'Access Control', {
      agent: 'Access Control',
      severity: 'SAFE',
      summary: 'Looks fine',
      findings: [finding({ severity: 'SAFE', location: 'Vault.sol' })],
    }),
    ...allSafe().slice(1),
  ]);
  assert.equal(report.findings.length, 0);
});

// ---- contradiction heuristic sanity ----------------------------------------

test('isContradictory: legitimate WARNING with mitigation-in-passing is NOT contradictory', () => {
  const f = finding({
    severity: 'WARNING',
    detail: 'Reentrancy possible in withdraw; partially mitigated by the checks-effects-interactions pattern but still exploitable.',
  });
  assert.equal(isContradictory(f), false);
});

test('isContradictory: WARNING claiming "not exploitable" IS contradictory', () => {
  const f = finding({
    severity: 'WARNING',
    detail: 'This re-entrancy pattern is not exploitable due to the nonReentrant modifier.',
  });
  assert.equal(isContradictory(f), true);
});
