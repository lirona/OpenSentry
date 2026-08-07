const DISPLAY_LEVELS = Object.freeze({
  NO_CONCERN: Object.freeze({ label: 'No concern', severityClass: 'sev-safe' }),
  SOME_CONCERNS: Object.freeze({ label: 'Some concerns', severityClass: 'sev-warning' }),
  HIGH_RISK: Object.freeze({ label: 'High risk', severityClass: 'sev-critical' }),
});

const DEFAULT_SENTENCES = Object.freeze({
  NO_CONCERN: 'We didn\'t find any major security concerns with this contract.',
  SOME_CONCERNS: 'We found a few things worth understanding before you interact with this contract.',
  HIGH_RISK: 'We found serious risks that could put your funds at risk.',
});

export function getDisplayBottomLine(report) {
  const derived = deriveDisplayBottomLine(report);
  const supplied = report?.bottomLine;

  if (!supplied || typeof supplied !== 'object') return derived;
  if (supplied.level !== null && !DISPLAY_LEVELS[supplied.level]) return derived;
  if (supplied.level !== derived.level) return derived;
  if (typeof supplied.label !== 'string' || supplied.label.trim().length === 0) return derived;
  if (typeof supplied.sentence !== 'string' || supplied.sentence.trim().length === 0) return derived;

  return {
    level: supplied.level,
    label: supplied.label.trim(),
    sentence: supplied.sentence.trim(),
    generated: supplied.generated === true,
    sourceFindingIds: normalizeFindingIds(supplied.sourceFindingIds),
    coverage: normalizeCoverage(supplied.coverage, derived.coverage),
  };
}

export function getBottomLinePresentation(bottomLine) {
  const display = DISPLAY_LEVELS[bottomLine?.level];
  const isRiskResult = bottomLine?.level === 'SOME_CONCERNS' || bottomLine?.level === 'HIGH_RISK';
  const firstFindingId = normalizeFindingIds(bottomLine?.sourceFindingIds)[0];

  return {
    severityClass: display?.severityClass || 'sev-unknown',
    actionLabel: isRiskResult ? 'See why ↓' : 'View analysis details ↓',
    actionTarget: isRiskResult && firstFindingId
      ? `#finding-${firstFindingId}`
      : isRiskResult
        ? '#findings-list'
        : '#analysis-details',
    coverageNote: buildCoverageNote(bottomLine?.coverage),
  };
}

function deriveDisplayBottomLine(report) {
  const coverage = deriveCoverage(report?.agentSummaries);
  const hasElevatedFinding = Number(report?.warningCount) > 0 || Number(report?.criticalCount) > 0;
  const hasKnownSeverity = ['SAFE', 'INFO', 'WARNING', 'CRITICAL'].includes(report?.overallSeverity);
  const severityIsConsistent = report?.overallSeverity === severityFromCounts(report);

  if (!report || !hasKnownSeverity || !severityIsConsistent || (coverage.status !== 'complete' && !hasElevatedFinding)) {
    return {
      level: null,
      label: 'Result incomplete',
      sentence: coverage.status === 'unavailable'
        ? 'The analysis did not complete, so no reliable security conclusion is available.'
        : !hasKnownSeverity || !severityIsConsistent
          ? 'The analysis result could not be summarized reliably.'
          : 'We didn\'t find major concerns in the completed checks, but the analysis was incomplete.',
      generated: false,
      sourceFindingIds: [],
      coverage,
    };
  }

  const level = report.overallSeverity === 'CRITICAL'
    ? 'HIGH_RISK'
    : report.overallSeverity === 'WARNING'
      ? 'SOME_CONCERNS'
      : 'NO_CONCERN';

  return {
    level,
    label: DISPLAY_LEVELS[level].label,
    sentence: DEFAULT_SENTENCES[level],
    generated: false,
    sourceFindingIds: [],
    coverage,
  };
}

function severityFromCounts(report) {
  if (!report || typeof report !== 'object') return null;
  if (Number(report.criticalCount) > 0) return 'CRITICAL';
  if (Number(report.warningCount) > 0) return 'WARNING';
  if (Number(report.infoCount) > 0) return 'INFO';
  return report.overallSeverity === 'unknown' ? 'unknown' : 'SAFE';
}

function deriveCoverage(agentSummaries) {
  if (!Array.isArray(agentSummaries) || agentSummaries.length === 0) {
    return { status: 'unknown', completedCount: 0, totalCount: 0 };
  }

  const totalCount = agentSummaries.length;
  const completedCount = agentSummaries.filter((summary) => summary?.status === 'completed').length;
  return {
    status: completedCount === totalCount
      ? 'complete'
      : completedCount === 0
        ? 'unavailable'
        : 'partial',
    completedCount,
    totalCount,
  };
}

function normalizeCoverage(coverage, fallback) {
  if (!coverage || typeof coverage !== 'object') return fallback;

  const totalCount = Number.isInteger(coverage.totalCount) && coverage.totalCount >= 0
    ? coverage.totalCount
    : fallback.totalCount;
  const completedCount = Number.isInteger(coverage.completedCount) && coverage.completedCount >= 0
    ? Math.min(coverage.completedCount, totalCount)
    : fallback.completedCount;
  const status = ['complete', 'partial', 'unavailable', 'unknown'].includes(coverage.status)
    ? coverage.status
    : fallback.status;

  return { status, completedCount, totalCount };
}

function normalizeFindingIds(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id) => typeof id === 'string' && /^OS-\d{3,}$/.test(id));
}

function buildCoverageNote(coverage) {
  if (!coverage || coverage.status === 'complete' || coverage.status === 'unknown') return '';

  if (coverage.status === 'unavailable') {
    return coverage.totalCount > 0
      ? `Analysis incomplete: none of the ${coverage.totalCount} analysis areas completed.`
      : 'Analysis incomplete.';
  }

  return `Partial analysis: ${coverage.completedCount} of ${coverage.totalCount} analysis areas completed.`;
}

export const __internal = Object.freeze({
  DISPLAY_LEVELS,
  DEFAULT_SENTENCES,
  deriveDisplayBottomLine,
  severityFromCounts,
  deriveCoverage,
  normalizeCoverage,
  normalizeFindingIds,
  buildCoverageNote,
});
