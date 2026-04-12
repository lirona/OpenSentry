// Merge-results turns an array of agent runs
// (each a Promise.allSettled result wrapping the agent-runner's uniform
// output) into the `report` object that analyze.js wraps and ships to the
// frontend.
//
// Pipeline:
//   7a. Classify each run as completed | failed
//   7b. Quality-gate each completed agent's findings
//   7c/d. Dedup + conflict resolution across agents
//   7e. Sort and assign OS-### IDs
//   7f. Aggregate counts + overall severity
//   7g. Build agentSummaries in the skill's canonical order
//
// NOTE: Cross-agent consistency reasoning is explicitly out of
// scope for v1 — it belongs to a future LLM-powered post-merge pass.

// ---- Constants --------------------------------------------------------------

// Numeric rank lets us "max severity" with a simple > comparison.
// `unknown` is deliberately the lowest so failed agents never drive the
// overall severity upward.
const SEVERITY_RANK = Object.freeze({
  unknown:  0,
  SAFE:     1,
  INFO:     2,
  WARNING:  3,
  CRITICAL: 4,
});

const VALID_SEVERITIES = new Set(['SAFE', 'INFO', 'WARNING', 'CRITICAL']);

// Canonical emission order for agentSummaries. Matches the Risk Summary
// table order in skill/output/report-template.md and the AGENT_ORDER list
// in scripts/embed-skills.js.
const CANONICAL_AGENTS = Object.freeze([
  { key: 'access-control',      name: 'Access Control' },
  { key: 'token-mechanics',     name: 'Token Mechanics' },
  { key: 'economic-fees',       name: 'Economic & Fees' },
  { key: 'oracle-dependencies', name: 'Oracle & Dependencies' },
  { key: 'mev-safety',          name: 'MEV & Tx Safety' },
  { key: 'code-quality',        name: 'Code Quality' },
  { key: 'transparency',        name: 'Transparency' },
  { key: 'governance',          name: 'Governance' },
]);

const REQUIRED_FINDING_FIELDS = Object.freeze([
  'check', 'severity', 'location', 'summary', 'detail', 'user_impact',
]);

// Maximum findings we emit per agent (Step 7b "Finding Cap").
const FINDING_CAP = 5;

// Line-citation requirement for WARNING/CRITICAL: location must contain
// `:<number>` somewhere (e.g. "Vault.sol:42" or "Vault.sol:42-47"). Lower
// severities are exempt because design-level INFO/SAFE notes often cite a
// whole file.
const LINE_CITATION_RE = /:\s*\d+/;

// Narrow set of phrases that indicate a WARNING/CRITICAL finding
// contradicts itself by simultaneously claiming "vulnerable" and
// "mitigated". Kept intentionally conservative to avoid false positives;
// legitimate findings that mention mitigations in passing (e.g. "mitigated
// by a timelock") will NOT match.
const CONTRADICTION_PATTERNS = Object.freeze([
  /\bno\s+(?:actual\s+)?vulnerability\b/i,
  /\bnot\s+(?:actually\s+)?exploitable\b/i,
  /\bnot\s+(?:actually\s+)?vulnerable\b/i,
  /\bfully\s+mitigated\b/i,
  /\balready\s+(?:mitigated|protected)\b/i,
  /\bsafe\s+as\s+(?:written|implemented)\b/i,
]);

// Jaccard token-overlap threshold for deciding two check names are "highly
// similar" per PLAN.md Step 7c.
const CHECK_SIMILARITY_THRESHOLD = 0.6;

// ---- Public API -------------------------------------------------------------

/**
 * @param {Array<{key: string, name: string, settled: {status: string, value?: any, reason?: any}}>} agentRuns
 * @returns {{overallSeverity: string, criticalCount: number, warningCount: number, infoCount: number, findings: Array, agentSummaries: Array}}
 */
export function mergeResults(agentRuns) {
  if (!Array.isArray(agentRuns)) {
    throw new TypeError('mergeResults: agentRuns must be an array');
  }

  // 7a. Classify each run.
  const processed = agentRuns.map(classifyRun);

  // 7b. Quality-gate findings for each completed agent (mutates `processed`).
  for (const p of processed) {
    if (p.status === 'completed') applyQualityGate(p);
  }

  // Flatten all non-SAFE findings across completed agents for dedup.
  // Each carries an internal `_sourceAgents` list that the dedup step
  // unions into the final `agents` array on the output.
  const allFindings = [];
  for (const p of processed) {
    if (p.status !== 'completed') continue;
    for (const f of p.findings) {
      if (f.severity === 'SAFE') continue; // SAFE is never listed
      allFindings.push({
        check: f.check,
        severity: f.severity,
        location: f.location,
        summary: f.summary,
        detail: f.detail,
        user_impact: f.user_impact,
        _sourceAgents: [p.agentName],
      });
    }
  }

  // 7c / 7d. Dedup by root cause + conflict resolution.
  const deduped = dedupFindings(allFindings);

  // 7e. Sort (CRITICAL → WARNING → INFO; then first contributing agent
  // alphabetically) and assign sequential IDs.
  deduped.sort((a, b) => {
    const sevDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sevDelta !== 0) return sevDelta;
    return (a._sourceAgents[0] || '').localeCompare(b._sourceAgents[0] || '');
  });

  const findings = deduped.map((f, i) => ({
    id: `OS-${String(i + 1).padStart(3, '0')}`,
    agents: f._sourceAgents,
    severity: f.severity,
    check: f.check,
    location: f.location,
    summary: f.summary,
    detail: f.detail,
    user_impact: f.user_impact,
  }));

  // 7f. Aggregate counts + overall severity.
  let criticalCount = 0, warningCount = 0, infoCount = 0;
  for (const f of findings) {
    if (f.severity === 'CRITICAL') criticalCount++;
    else if (f.severity === 'WARNING') warningCount++;
    else if (f.severity === 'INFO') infoCount++;
  }

  const overallSeverity = computeOverallSeverity(processed);

  // 7g. Emit agentSummaries in canonical order (always 8 entries).
  const agentSummaries = buildAgentSummaries(processed);

  return {
    overallSeverity,
    criticalCount,
    warningCount,
    infoCount,
    findings,
    agentSummaries,
  };
}

// ---- 7a. Classify -----------------------------------------------------------

function classifyRun(run) {
  // The display name falls back through several levels of "we have no idea
  // which agent this was" because the orchestrator might pass a malformed
  // run during a failure storm and we'd rather emit a named failure than
  // throw and kill the whole report.
  const displayName = run?.name || run?.key || 'Unknown Agent';
  const agentKey    = run?.key  || 'unknown';

  const fail = (reason) => ({
    status: 'failed',
    agentKey,
    agentName: displayName,
    severity: 'unknown',
    summary: `Analysis incomplete for ${displayName}`,
    findings: [],
    droppedCount: 0,
    failReason: reason,
  });

  if (!run || typeof run !== 'object') return fail('invalid run');
  const settled = run.settled;
  if (!settled || typeof settled !== 'object') return fail('missing settled');

  if (settled.status === 'rejected') return fail('rejected');
  if (settled.status !== 'fulfilled') return fail('unknown settled status');

  const value = settled.value;
  if (!value || typeof value !== 'object') return fail('no value');
  if (value.ok !== true) {
    const code = value.error?.code || 'error';
    return fail(code);
  }

  const result = value.result;
  // Structural re-check. The runner has already validated, but the merger
  // is a trust boundary and defense in depth is cheap here.
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('bad result');
  if (typeof result.agent !== 'string' || !result.agent) return fail('missing agent field');
  if (!VALID_SEVERITIES.has(result.severity)) return fail('invalid severity');
  if (!Array.isArray(result.findings)) return fail('findings not array');
  if (typeof result.summary !== 'string') return fail('summary not string');

  return {
    status: 'completed',
    agentKey,
    agentName: displayName,
    severity: result.severity,
    summary: result.summary,
    findings: result.findings.slice(), // defensive copy — we'll mutate
    droppedCount: 0,
  };
}

// ---- 7b. Quality gate -------------------------------------------------------

function applyQualityGate(p) {
  const kept = [];
  let droppedForCitation = 0;

  for (const f of p.findings) {
    // Drop findings missing any required field (defense in depth — the
    // runner's validator would have failed the whole agent already).
    if (!hasRequiredFields(f)) continue;

    // Citation rule: WARNING/CRITICAL must cite a line. Uncited lower-
    // severity findings are allowed because design-level notes reasonably
    // cite a whole file.
    if ((f.severity === 'WARNING' || f.severity === 'CRITICAL') &&
        !LINE_CITATION_RE.test(f.location)) {
      droppedForCitation++;
      continue;
    }

    // Drop contradictory findings (WARNING/CRITICAL that also claim the
    // code is safe). See CONTRADICTION_PATTERNS for why this is kept narrow.
    if (isContradictory(f)) continue;

    kept.push(f);
  }

  // Finding cap: keep top 5 by severity (ties broken by original order).
  kept.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  p.findings = kept.slice(0, FINDING_CAP);
  p.droppedCount = droppedForCitation;

  // Correct agent-level severity to the actual max of what survived.
  p.severity = maxSeverityOf(p.findings);

  if (droppedForCitation > 0) {
    p.summary = `${p.summary} (${droppedForCitation} findings dropped: no code citation)`;
  }
}

function hasRequiredFields(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  for (const field of REQUIRED_FINDING_FIELDS) {
    if (typeof f[field] !== 'string' || f[field].length === 0) return false;
  }
  return VALID_SEVERITIES.has(f.severity);
}

function isContradictory(f) {
  if (f.severity !== 'WARNING' && f.severity !== 'CRITICAL') return false;
  const combined = `${f.summary} ${f.detail}`;
  return CONTRADICTION_PATTERNS.some(p => p.test(combined));
}

function maxSeverityOf(findings) {
  if (findings.length === 0) return 'SAFE';
  let max = 'SAFE';
  let maxRank = SEVERITY_RANK.SAFE;
  for (const f of findings) {
    const r = SEVERITY_RANK[f.severity] ?? 0;
    if (r > maxRank) { maxRank = r; max = f.severity; }
  }
  return max;
}

// ---- 7c / 7d. Dedup + conflict resolution -----------------------------------

function dedupFindings(findings) {
  const kept = [];
  for (const f of findings) {
    let mergedIntoExisting = false;
    for (let i = 0; i < kept.length; i++) {
      if (sameRootCause(kept[i], f)) {
        kept[i] = combineFindings(kept[i], f);
        mergedIntoExisting = true;
        break;
      }
    }
    if (!mergedIntoExisting) kept.push(f);
  }
  return kept;
}

function sameRootCause(a, b) {
  return locationsMatch(a, b) && checksSimilar(a.check, b.check);
}

/**
 * Normalize a location string into `{ file, line, hasLine }`. Whitespace is
 * stripped and the file part is lowercased so comparisons are stable. A
 * trailing `:NN` or `:NN-MM` is peeled off as the line component.
 */
function normalizeLocation(loc) {
  const s = String(loc || '').replace(/\s+/g, '').toLowerCase();
  const m = s.match(/^(.+?):(\d+(?:-\d+)?)$/);
  if (m) return { file: m[1], line: m[2], hasLine: true };
  return { file: s, line: null, hasLine: false };
}

/**
 * Locations match when:
 *   - Both have line numbers → exact file:line equality
 *   - Otherwise → file-only equality (the check-name similarity step below
 *     supplies the additional specificity the line number would have)
 */
function locationsMatch(a, b) {
  const na = normalizeLocation(a.location);
  const nb = normalizeLocation(b.location);
  if (na.hasLine && nb.hasLine) {
    return na.file === nb.file && na.line === nb.line;
  }
  return na.file === nb.file;
}

function normalizeCheck(check) {
  return String(check || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checksSimilar(a, b) {
  const na = normalizeCheck(a);
  const nb = normalizeCheck(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // Jaccard token overlap.
  const setA = new Set(na.split(' '));
  const setB = new Set(nb.split(' '));
  let intersectionSize = 0;
  for (const t of setA) if (setB.has(t)) intersectionSize++;
  const unionSize = new Set([...setA, ...setB]).size;
  if (unionSize === 0) return false;
  return intersectionSize / unionSize >= CHECK_SIMILARITY_THRESHOLD;
}

function combineFindings(a, b) {
  const aRank = SEVERITY_RANK[a.severity];
  const bRank = SEVERITY_RANK[b.severity];
  const higher = bRank > aRank ? b : a;

  // Default: keep the longer detail — "more context wins" (Step 7c).
  let detail = a.detail.length >= b.detail.length ? a.detail : b.detail;

  // 7d. On severity disagreement, preserve both justifications prefixed
  // with contributing agent names. Double-wrapping on a third merge is
  // acceptable for v1 — the output is still readable.
  if (a.severity !== b.severity) {
    const aPrefix = a._sourceAgents.join(', ');
    const bPrefix = b._sourceAgents.join(', ');
    detail = `[${aPrefix}] ${a.detail}\n\n[${bPrefix}] ${b.detail}`;
  }

  // Concatenate user_impact only if the two sides actually disagree.
  let userImpact = higher.user_impact;
  if (a.user_impact !== b.user_impact) {
    userImpact = `${a.user_impact} ${b.user_impact}`.trim();
  }

  // Union contributing agents preserving first-seen order.
  const sourceAgents = [];
  const seen = new Set();
  for (const n of [...a._sourceAgents, ...b._sourceAgents]) {
    if (!seen.has(n)) { seen.add(n); sourceAgents.push(n); }
  }

  return {
    check: higher.check,
    severity: higher.severity,
    location: higher.location,
    summary: higher.summary,
    detail,
    user_impact: userImpact,
    _sourceAgents: sourceAgents,
  };
}

// ---- 7f / 7g. Aggregates + summaries ----------------------------------------

function computeOverallSeverity(processed) {
  if (processed.length === 0) return 'unknown';
  const completed = processed.filter(p => p.status === 'completed');
  if (completed.length === 0) return 'unknown';
  return maxSeverityOf(completed.map(p => ({ severity: p.severity })));
}

function buildAgentSummaries(processed) {
  const byKey = new Map();
  for (const p of processed) byKey.set(p.agentKey, p);

  return CANONICAL_AGENTS.map(({ key, name }) => {
    const p = byKey.get(key);
    if (!p) {
      return {
        agent: name,
        severity: 'unknown',
        summary: `Analysis incomplete for ${name}`,
        status: 'failed',
      };
    }
    // Use the canonical display name rather than the name the caller
    // passed, so the frontend labels always match the report template
    // even if the caller passed slightly different casing.
    return {
      agent: name,
      severity: p.severity,
      summary: p.summary,
      status: p.status,
    };
  });
}

// ---- Internals exposed for unit tests only ---------------------------------

export const __internal = Object.freeze({
  classifyRun,
  applyQualityGate,
  isContradictory,
  normalizeLocation,
  locationsMatch,
  normalizeCheck,
  checksSimilar,
  combineFindings,
  computeOverallSeverity,
  buildAgentSummaries,
  maxSeverityOf,
  SEVERITY_RANK,
  CANONICAL_AGENTS,
  FINDING_CAP,
  CHECK_SIMILARITY_THRESHOLD,
  CONTRADICTION_PATTERNS,
});
