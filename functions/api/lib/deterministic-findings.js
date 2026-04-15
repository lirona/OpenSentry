const SEVERITY_RANK = Object.freeze({
  INFO: 1,
  WARNING: 2,
  CRITICAL: 3,
});

const SOURCE_LABEL = 'Compiler Facts';
const USER_BALANCE_PARAM_RE = /(account|holder|user|wallet|owner|from|target|recipient)/i;

export function deriveDeterministicFindings(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new TypeError('deriveDeterministicFindings: facts must be an object');
  }

  const findings = [
    ...deriveFeeFindings(facts),
    ...derivePauseBlockingFindings(facts),
    ...deriveBlacklistFreezeFindings(facts),
    ...derivePrivilegedSupplyFindings(facts),
    ...deriveUpgradeFindings(facts),
  ];

  return dedupeFindings(findings).sort(compareFindings);
}

function deriveFeeFindings(facts) {
  const findings = [];

  for (const control of facts.feeControls || []) {
    let best = null;
    for (const setter of control.setters || []) {
      const candidate = classifyFeeSetter(control, setter);
      if (!candidate) continue;
      if (!best || SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[best.severity]) {
        best = candidate;
      }
    }
    if (best) findings.push(best);
  }

  return findings;
}

function classifyFeeSetter(control, setter) {
  if (!Number.isFinite(setter?.scale) || setter.scale <= 0) return null;

  if (setter.capValue === null && setter.canReach100Percent === true) {
    return finding({
      ruleId: 'fee-uncapped-100',
      severity: 'CRITICAL',
      location: formatLocation(setter.file || control.file, setter.line || control.line),
      check: 'Configurable fee can reach 100%',
      summary: `${control.variable} is configurable without a visible cap and can reach 100% of the fee scale.`,
      detail:
        `${control.contract}.${setter.function} updates ${control.variable} without a visible maximum. ` +
        `The extracted fee scale is ${describeScale(setter.scale)}, so a full-value fee remains reachable.`,
      userImpact:
        'Users could lose all of the transferred, deposited, redeemed, or withdrawn value to fees if that setting is raised to the maximum.',
    });
  }

  if (Number.isFinite(setter.capValue) && setter.capValue >= setter.scale) {
    return finding({
      ruleId: 'fee-cap-at-least-100',
      severity: 'CRITICAL',
      location: formatLocation(setter.file || control.file, setter.line || control.line),
      check: 'Fee cap still allows 100%',
      summary: `${control.variable} has a visible cap, but that cap still allows a 100% fee.`,
      detail:
        `${control.contract}.${setter.function} limits ${control.variable} with ${setter.capRaw || setter.capValue}, ` +
        `which resolves to ${setter.capValue} on a ${describeScale(setter.scale)} scale.`,
      userImpact:
        'The contract still permits a fee level that can consume the entire user amount, even though a maximum exists.',
    });
  }

  if (Number.isFinite(setter.capValue) && setter.capValue > setter.scale / 2) {
    return finding({
      ruleId: 'fee-cap-over-50',
      severity: 'WARNING',
      location: formatLocation(setter.file || control.file, setter.line || control.line),
      check: 'Fee cap exceeds 50%',
      summary: `${control.variable} is capped, but the visible maximum is still above 50%.`,
      detail:
        `${control.contract}.${setter.function} limits ${control.variable} to ${setter.capRaw || setter.capValue}, ` +
        `which resolves to ${setter.capValue} on a ${describeScale(setter.scale)} scale.`,
      userImpact:
        'A fee setting that high can remove a majority of user value even if the contract does not allow the full 100%.',
    });
  }

  return null;
}

function derivePauseBlockingFindings(facts) {
  const affected = groupBy(
    (facts.userExitFunctions || []).filter((entry) =>
      hasGuardKind(entry, 'pause') &&
      !hasGuardKind(entry, 'freeze') &&
      !hasGuardKind(entry, 'blacklist'),
    ),
    (entry) => entry.contract,
  );

  return Object.values(affected).map((entries) => finding({
    ruleId: 'exit-blocked-by-pause',
    severity: 'WARNING',
    location: formatLocation(entries[0].file, entries[0].line),
    check: 'Pause can block user exit',
    summary: `${entries[0].contract} uses pause controls on user exit functions.`,
    detail:
      `The extracted facts show ${describeFunctionList(entries)} are gated by pause controls in ${entries[0].contract}. ` +
      `Those exit paths are unavailable while the contract is paused.`,
    userImpact:
      'Users may be unable to withdraw, redeem, claim, or otherwise exit until the contract is unpaused.',
  }));
}

function deriveBlacklistFreezeFindings(facts) {
  const entries = [
    ...(facts.userExitFunctions || []).filter((entry) =>
      hasGuardKind(entry, 'blacklist') || hasGuardKind(entry, 'freeze'),
    ),
    ...((facts.tokenFeatures?.transferFunctions) || []).filter((entry) =>
      hasGuardKind(entry, 'blacklist') || hasGuardKind(entry, 'freeze'),
    ),
  ];

  const affected = groupBy(entries, (entry) => entry.contract);
  return Object.values(affected).map((group) => finding({
    ruleId: 'blacklist-or-freeze-blocks-user-actions',
    severity: 'WARNING',
    location: formatLocation(group[0].file, group[0].line),
    check: 'Blacklist or freeze can block transfers or exits',
    summary: `${group[0].contract} has blacklist or freeze controls on user transfer or exit paths.`,
    detail:
      `The extracted facts show ${describeFunctionList(group)} are gated by blacklist or freeze conditions in ${group[0].contract}.`,
    userImpact:
      'A privileged operator may be able to stop specific users from transferring, claiming, or withdrawing until the restriction is removed.',
  }));
}

function derivePrivilegedSupplyFindings(facts) {
  const privilegedFunctions = indexPrivilegedFunctions(facts.privilegedFunctions || []);
  const findings = [];

  const privilegedMints = (facts.tokenFeatures?.mintFunctions || []).filter((entry) =>
    privilegedFunctions.has(functionKey(entry.contract, entry.name)),
  );
  for (const [contract, group] of Object.entries(groupBy(privilegedMints, (entry) => entry.contract))) {
    findings.push(finding({
      ruleId: 'privileged-mint',
      severity: 'CRITICAL',
      location: formatLocation(group[0].file, group[0].line),
      check: 'Privileged mint path',
      summary: `${contract} exposes a privileged mint function.`,
      detail:
        `The extracted facts identify ${describeFunctionList(group)} as mint functions that also require privileged access in ${contract}.`,
      userImpact:
        'A privileged actor can increase supply at discretion, which can dilute holders or redirect value.',
    }));
  }

  const privilegedBurns = (facts.tokenFeatures?.burnFunctions || []).filter((entry) => {
    const privileged = privilegedFunctions.get(functionKey(entry.contract, entry.name));
    return privileged && privileged.parameters.some((name) => USER_BALANCE_PARAM_RE.test(name));
  });
  for (const [contract, group] of Object.entries(groupBy(privilegedBurns, (entry) => entry.contract))) {
    findings.push(finding({
      ruleId: 'privileged-user-burn',
      severity: 'CRITICAL',
      location: formatLocation(group[0].file, group[0].line),
      check: 'Privileged burn of user balances',
      summary: `${contract} exposes a privileged burn path over user balances.`,
      detail:
        `The extracted facts identify ${describeFunctionList(group)} as privileged burn functions with user-targeting parameters in ${contract}.`,
      userImpact:
        'A privileged actor may be able to destroy tokens from user-controlled balances.',
    }));
  }

  return findings;
}

function deriveUpgradeFindings(facts) {
  const candidates = (facts.upgradePaths || []).filter((entry) =>
    entry.hasVisibleTimelock === false && entry.guardType !== 'none',
  );

  return Object.values(groupBy(candidates, (entry) => entry.contract)).map((group) => finding({
    ruleId: 'upgrade-without-timelock',
    severity: 'WARNING',
    location: formatLocation(group[0].file, group[0].line),
    check: 'Privileged upgrade path lacks timelock',
    summary: `${group[0].contract} exposes a privileged upgrade path with no visible timelock or delay.`,
    detail:
      `The extracted facts identify ${describeFunctionList(group)} as upgrade-related functions in ${group[0].contract}, ` +
      `and none of those paths show a visible timelock or delay guard.`,
    userImpact:
      'Users rely on operator restraint because the implementation can potentially change immediately.',
  }));
}

function indexPrivilegedFunctions(functions) {
  const index = new Map();
  for (const entry of functions) {
    index.set(functionKey(entry.contract, entry.function), entry);
  }
  return index;
}

function finding({ ruleId, severity, location, check, summary, detail, userImpact }) {
  return {
    ruleId,
    source: SOURCE_LABEL,
    severity,
    check,
    location,
    summary,
    detail,
    user_impact: userImpact,
  };
}

function describeScale(scale) {
  if (scale === 10_000) return '10,000 basis points';
  if (scale === 100) return '100 percentage points';
  return `${scale} units`;
}

function describeFunctionList(entries) {
  const names = [...new Set(entries.map((entry) => entry.function || entry.name).filter(Boolean))];
  return names.join(', ');
}

function formatLocation(file, line) {
  if (typeof file !== 'string' || file.length === 0) return '(unknown)';
  if (!Number.isFinite(line) || line <= 0) return file;
  return `${file}:${line}`;
}

function functionKey(contract, name) {
  return `${contract}::${name}`;
}

function hasGuardKind(entry, kind) {
  return Array.isArray(entry?.guardKinds) && entry.guardKinds.includes(kind);
}

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function dedupeFindings(findings) {
  const seen = new Set();
  const deduped = [];
  for (const finding of findings) {
    const key = JSON.stringify({
      ruleId: finding.ruleId,
      location: finding.location,
      check: finding.check,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

function compareFindings(a, b) {
  const severityDelta = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (severityDelta !== 0) return severityDelta;
  return a.check.localeCompare(b.check);
}

export const __internal = Object.freeze({
  classifyFeeSetter,
  formatLocation,
  describeFunctionList,
});
