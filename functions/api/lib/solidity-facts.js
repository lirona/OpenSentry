const PRIVILEGED_NAME_RE = /(owner|admin|role|govern|guardian|operator|paus|blacklist|blocklist|denylist|auth)/i;
const FEE_NAME_RE = /(fee|tax|commission|spread)/i;
const FEE_DESTINATION_RE = /(recipient|receiver|treasury|wallet|address|collector|reserve|vault)$/i;
const UPGRADE_NAME_RE = /(upgrade|implementation|authorizeupgrade|proxyadmin|adminslot|beacon)/i;
const PAUSE_NAME_RE = /(pause|paused|freeze|frozen|blacklist|blocklist|denylist)/i;
const EXIT_NAME_RE = /(withdraw|redeem|claim|unstake|exit|emergencywithdraw)/i;
const DEPENDENCY_PATTERNS = Object.freeze([
  { category: 'oracle', pattern: /(oracle|pricefeed|aggregator|sequencer)/i },
  { category: 'router', pattern: /(router|swaprouter|uniswap|pool)/i },
  { category: 'registry', pattern: /(registry|registrar)/i },
  { category: 'treasury', pattern: /(treasury|fee(recipient|receiver)?|reserve)/i },
]);
const TOKEN_FEATURE_PATTERNS = Object.freeze({
  tradingToggle: /(trading(enabled|open)?|openTrading|enableTrading)/i,
  maxLimit: /(maxtx|maxtransaction|maxwallet|maxholding)/i,
  rebasing: /(rebase|gons|fragments|shares|sharestoassets|assetstoshares)/i,
});
const HUNDRED_SCALE = 100;
const BPS_SCALE = 10_000;

export function extractSolidityFacts({ compilerOutput, files = [] } = {}) {
  if (!compilerOutput || typeof compilerOutput !== 'object') {
    throw new TypeError('extractSolidityFacts: compilerOutput must be an object');
  }

  const sourceContents = Object.fromEntries(files.map((file) => [file.name, file.content]));
  const facts = {
    contracts: [],
    privilegedRoles: [],
    privilegedFunctions: [],
    mutableParameters: [],
    feeControls: [],
    upgradePaths: [],
    pauseControls: [],
    userExitFunctions: [],
    dependencies: [],
    tokenFeatures: {
      mintFunctions: [],
      burnFunctions: [],
      transferHooks: [],
      transferFunctions: [],
      feeOnTransferSignals: [],
      blacklistControls: [],
      tradingToggles: [],
      maxLimits: [],
      rebasingSignals: [],
    },
  };

  for (const [fileName, source] of Object.entries(compilerOutput.sources || {})) {
    const ast = source?.ast;
    if (!ast || typeof ast !== 'object') continue;

    const contracts = findContracts(ast);
    for (const contractNode of contracts) {
      const context = buildContractContext(contractNode, fileName, sourceContents[fileName] || '');
      populateFactsForContract(facts, context);
    }
  }

  dedupeFacts(facts);
  return facts;
}

function populateFactsForContract(facts, context) {
  facts.contracts.push({
    contract: context.name,
    kind: context.kind,
    file: context.file,
    line: context.location.line,
    bases: context.baseContracts,
  });

  for (const role of context.privilegedRoles) facts.privilegedRoles.push(role);
  for (const dependency of context.dependencies) facts.dependencies.push(dependency);
  for (const pause of context.pauseControls) facts.pauseControls.push(pause);
  pushTokenFeatures(facts.tokenFeatures, context.tokenFeatures);

  for (const fn of context.functions) {
    if (fn.isPrivileged) {
      facts.privilegedFunctions.push({
        contract: context.name,
        function: fn.name,
        file: context.file,
        line: fn.location.line,
        visibility: fn.visibility,
        guardType: fn.guardType,
        modifiers: fn.modifiers,
        parameters: fn.parameters,
        writes: fn.writes,
      });
    }

    if (fn.writes.length > 0) {
      facts.mutableParameters.push({
        contract: context.name,
        function: fn.name,
        file: context.file,
        line: fn.location.line,
        writes: fn.writes,
        parameters: fn.parameters,
        controllingParameters: fn.controllingParameters,
      });
    }

    if (EXIT_NAME_RE.test(fn.name)) {
      facts.userExitFunctions.push({
        contract: context.name,
        function: fn.name,
        file: context.file,
        line: fn.location.line,
        modifiers: fn.modifiers,
        guardKinds: fn.guardKinds,
        gatedByPause: fn.gatedByPause,
        gatedByBlacklist: fn.gatedByBlacklist,
      });
    }

    if (UPGRADE_NAME_RE.test(fn.name)) {
      facts.upgradePaths.push({
        contract: context.name,
        function: fn.name,
        file: context.file,
        line: fn.location.line,
        modifiers: fn.modifiers,
        guardType: fn.guardType,
        hasVisibleTimelock: fn.hasVisibleTimelock,
      });
    }
  }

  for (const [name, variable] of context.stateVariables) {
    if (!FEE_NAME_RE.test(name) || FEE_DESTINATION_RE.test(name)) continue;

    const setters = context.functions
      .filter((fn) => fn.writes.includes(name))
      .map((fn) => ({
        function: fn.name,
        file: context.file,
        line: fn.location.line,
        modifiers: fn.modifiers,
        parameters: fn.parameters,
        controllingParameters: fn.controllingParameters,
        capRaw: fn.feeCap?.raw || null,
        capValue: fn.feeCap?.value ?? null,
        scale: fn.feeScale,
        canReach100Percent: determineHundredPercent(fn.feeCap, fn.feeScale),
      }));

    const recipients = [...context.stateVariables.values()]
      .filter((entry) => FEE_DESTINATION_RE.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        file: context.file,
        line: entry.location.line,
      }));

    facts.feeControls.push({
      contract: context.name,
      variable: name,
      file: context.file,
      line: variable.location.line,
      setters,
      recipients,
    });
  }
}

function buildContractContext(contractNode, fileName, sourceContent) {
  const location = locationFromNode(contractNode, fileName, sourceContent);
  const stateVariables = new Map();
  const constantValues = new Map();
  const dependencies = [];
  const privilegedRoles = [];
  const pauseControls = [];
  const tokenFeatures = {
    mintFunctions: [],
    burnFunctions: [],
    transferHooks: [],
    transferFunctions: [],
    feeOnTransferSignals: [],
    blacklistControls: [],
    tradingToggles: [],
    maxLimits: [],
    rebasingSignals: [],
  };

  const nodes = childNodes(contractNode);
  for (const node of nodes) {
    if (node.nodeType === 'VariableDeclaration' && node.stateVariable === true) {
      const variable = {
        name: node.name || '',
        typeString: node.typeDescriptions?.typeString || null,
        location: locationFromNode(node, fileName, sourceContent),
      };
      stateVariables.set(variable.name, variable);

      if (PRIVILEGED_NAME_RE.test(variable.name)) {
        privilegedRoles.push({
          contract: contractNode.name,
          role: variable.name,
          file: fileName,
          line: variable.location.line,
          type: 'state_variable',
        });
      }

      const constantValue = literalValue(node.value);
      if (constantValue !== null) constantValues.set(variable.name, constantValue);

      const dependencyCategory = classifyDependency(variable.name);
      if (dependencyCategory) {
        dependencies.push({
          contract: contractNode.name,
          name: variable.name,
          category: dependencyCategory,
          file: fileName,
          line: variable.location.line,
        });
      }

      if (PAUSE_NAME_RE.test(variable.name)) {
        pauseControls.push({
          contract: contractNode.name,
          kind: classifyPauseControl(variable.name),
          name: variable.name,
          file: fileName,
          line: variable.location.line,
        });
      }

      if (TOKEN_FEATURE_PATTERNS.tradingToggle.test(variable.name)) {
        tokenFeatures.tradingToggles.push(tokenFeatureEntry(contractNode.name, variable, fileName));
      }
      if (TOKEN_FEATURE_PATTERNS.maxLimit.test(variable.name)) {
        tokenFeatures.maxLimits.push(tokenFeatureEntry(contractNode.name, variable, fileName));
      }
      if (TOKEN_FEATURE_PATTERNS.rebasing.test(variable.name)) {
        tokenFeatures.rebasingSignals.push(tokenFeatureEntry(contractNode.name, variable, fileName));
      }
      if (PAUSE_NAME_RE.test(variable.name) && /blacklist|blocklist|denylist/i.test(variable.name)) {
        tokenFeatures.blacklistControls.push(tokenFeatureEntry(contractNode.name, variable, fileName));
      }
    }

    if (node.nodeType === 'ModifierDefinition' && PRIVILEGED_NAME_RE.test(node.name || '')) {
      privilegedRoles.push({
        contract: contractNode.name,
        role: node.name,
        file: fileName,
        line: locationFromNode(node, fileName, sourceContent).line,
        type: 'modifier',
      });
    }
  }

  const functions = nodes
    .filter((node) => node.nodeType === 'FunctionDefinition' && node.body)
    .map((node) => analyzeFunction({
      contractName: contractNode.name,
      node,
      fileName,
      sourceContent,
      stateVariables,
      constantValues,
      dependencies,
      tokenFeatures,
    }));

  return {
    name: contractNode.name,
    kind: contractNode.contractKind || contractNode.kind || 'contract',
    file: fileName,
    location,
    baseContracts: extractBaseContracts(contractNode),
    stateVariables,
    privilegedRoles,
    dependencies,
    pauseControls,
    tokenFeatures,
    functions,
  };
}

function analyzeFunction({
  contractName,
  node,
  fileName,
  sourceContent,
  stateVariables,
  constantValues,
  dependencies,
  tokenFeatures,
}) {
  const name = node.name || (node.kind === 'constructor' ? 'constructor' : '(anonymous)');
  const modifiers = (node.modifiers || []).map(modifierName).filter(Boolean);
  const parameters = (node.parameters?.parameters || []).map((param) => param.name).filter(Boolean);
  const location = locationFromNode(node, fileName, sourceContent);
  const writes = collectStateWrites(node.body, stateVariables);
  const controllingParameters = parameters.filter((param) => bodyContainsIdentifier(node.body, param));
  const inlineSenderCheck = hasInlineSenderCheck(node.body, stateVariables);
  const privilegedModifier = modifiers.some((modifier) => PRIVILEGED_NAME_RE.test(modifier));
  const isPrivileged = privilegedModifier || inlineSenderCheck;
  const feeCap = inferFeeCap(node.body, parameters, constantValues);
  const feeScale = inferFeeScale(node.body, writes, stateVariables, constantValues);
  const guardKinds = inferGuardKinds(modifiers, node.body);

  for (const category of collectDependenciesFromFunction(node.body)) {
    dependencies.push({
      contract: contractName,
      name,
      category,
      file: fileName,
      line: location.line,
    });
  }

  if (/mint/i.test(name)) tokenFeatures.mintFunctions.push(functionFeatureEntry(contractName, name, fileName, location.line));
  if (/burn/i.test(name)) tokenFeatures.burnFunctions.push(functionFeatureEntry(contractName, name, fileName, location.line));
  if (/^(_transfer|_update|_beforeTokenTransfer|_afterTokenTransfer|transfer)$/i.test(name)) {
    tokenFeatures.transferHooks.push(functionFeatureEntry(contractName, name, fileName, location.line));
  }
  if (/^(transfer|transferFrom)$/i.test(name)) {
    tokenFeatures.transferFunctions.push({
      contract: contractName,
      name,
      file: fileName,
      line: location.line,
      modifiers,
      guardKinds,
      gatedByPause: guardKinds.includes('pause') || guardKinds.includes('freeze'),
      gatedByBlacklist: guardKinds.includes('blacklist'),
    });
  }
  if (FEE_NAME_RE.test(name) && /^transfer$/i.test(name)) {
    tokenFeatures.feeOnTransferSignals.push(functionFeatureEntry(contractName, name, fileName, location.line));
  }
  if (PAUSE_NAME_RE.test(name) && /blacklist|blocklist|denylist/i.test(name)) {
    tokenFeatures.blacklistControls.push(functionFeatureEntry(contractName, name, fileName, location.line));
  }
  if (TOKEN_FEATURE_PATTERNS.tradingToggle.test(name)) {
    tokenFeatures.tradingToggles.push(functionFeatureEntry(contractName, name, fileName, location.line));
  }
  if (TOKEN_FEATURE_PATTERNS.maxLimit.test(name)) {
    tokenFeatures.maxLimits.push(functionFeatureEntry(contractName, name, fileName, location.line));
  }
  if (TOKEN_FEATURE_PATTERNS.rebasing.test(name)) {
    tokenFeatures.rebasingSignals.push(functionFeatureEntry(contractName, name, fileName, location.line));
  }

  return {
    name,
    visibility: node.visibility || null,
    modifiers,
    parameters,
    controllingParameters,
    location,
    writes,
    guardType: describeGuardType(privilegedModifier, inlineSenderCheck),
    isPrivileged,
    guardKinds,
    gatedByPause: guardKinds.includes('pause') || guardKinds.includes('freeze'),
    gatedByBlacklist: guardKinds.includes('blacklist'),
    hasVisibleTimelock: guardKinds.includes('timelock'),
    feeCap,
    feeScale,
  };
}

function collectStateWrites(body, stateVariables) {
  const writes = new Set();

  walkAst(body, (node) => {
    if (node.nodeType === 'Assignment') {
      const written = referencedName(node.leftHandSide);
      if (written && stateVariables.has(written)) writes.add(written);
    }
    if (node.nodeType === 'UnaryOperation' && node.prefix === false) {
      const written = referencedName(node.subExpression);
      if (written && stateVariables.has(written)) writes.add(written);
    }
  });

  return [...writes];
}

function inferFeeCap(body, parameters, constantValues) {
  let best = null;

  walkAst(body, (node) => {
    if (node.nodeType !== 'FunctionCall' || referencedName(node.expression) !== 'require') return;
    const condition = node.arguments?.[0];
    const candidate = capFromCondition(condition, parameters, constantValues);
    if (!candidate) return;
    if (!best || (candidate.value !== null && (best.value === null || candidate.value < best.value))) {
      best = candidate;
    }
  });

  walkAst(body, (node) => {
    if (node.nodeType !== 'IfStatement') return;
    const candidate = capFromCondition(node.condition, parameters, constantValues, true);
    if (!candidate) return;
    if (!best || (candidate.value !== null && (best.value === null || candidate.value < best.value))) {
      best = candidate;
    }
  });

  return best;
}

function capFromCondition(condition, parameters, constantValues, invert = false) {
  if (!condition || condition.nodeType !== 'BinaryOperation') return null;
  const left = referencedName(condition.leftExpression);
  const right = referencedName(condition.rightExpression);
  const literalRight = literalValue(condition.rightExpression);
  const literalLeft = literalValue(condition.leftExpression);

  const leftIsParam = left && parameters.includes(left);
  const rightIsParam = right && parameters.includes(right);

  if (leftIsParam && (condition.operator === '<=' || condition.operator === '<')) {
    return capCandidate(right, literalRight, constantValues, condition.operator === '<');
  }
  if (rightIsParam && (condition.operator === '>=' || condition.operator === '>')) {
    return capCandidate(left, literalLeft, constantValues, condition.operator === '>');
  }
  if (invert && leftIsParam && (condition.operator === '>' || condition.operator === '>=')) {
    return capCandidate(right, literalRight, constantValues, condition.operator === '>=');
  }
  if (invert && rightIsParam && (condition.operator === '<' || condition.operator === '<=')) {
    return capCandidate(left, literalLeft, constantValues, condition.operator === '<=');
  }
  return null;
}

function capCandidate(raw, literal, constantValues, exclusive) {
  const resolved = literal ?? (raw ? constantValues.get(raw) ?? null : null);
  return {
    raw: raw || (literal !== null ? String(literal) : null),
    value: resolved === null ? null : (exclusive ? resolved - 1 : resolved),
  };
}

function inferFeeScale(body, writes, stateVariables, constantValues) {
  const feeWrites = writes.filter((name) => FEE_NAME_RE.test(name) && !FEE_DESTINATION_RE.test(name));
  if (feeWrites.length === 0) return null;

  let scale = null;
  walkAst(body, (node) => {
    if (node.nodeType !== 'BinaryOperation' || node.operator !== '/') return;
    const denominatorName = referencedName(node.rightExpression);
    const denominatorValue = literalValue(node.rightExpression) ?? (denominatorName ? constantValues.get(denominatorName) ?? null : null);
    if (denominatorValue === HUNDRED_SCALE || denominatorValue === BPS_SCALE) {
      scale = denominatorValue;
    }
  });

  if (scale !== null) return scale;

  for (const name of feeWrites) {
    if (/bps|basis/i.test(name)) return BPS_SCALE;
    if (/percent|pct/i.test(name)) return HUNDRED_SCALE;
  }
  for (const [name, value] of constantValues.entries()) {
    if (/bps|basis/i.test(name) && value === BPS_SCALE) return BPS_SCALE;
    if (/percent|pct/i.test(name) && value === HUNDRED_SCALE) return HUNDRED_SCALE;
  }

  return null;
}

function determineHundredPercent(cap, scale) {
  if (scale === null) return null;
  if (!cap) return true;
  if (cap.value === null) return null;
  return cap.value >= scale;
}

function hasInlineSenderCheck(body, stateVariables) {
  let found = false;

  walkAst(body, (node) => {
    if (found || node.nodeType !== 'BinaryOperation') return;
    const left = referencedName(node.leftExpression);
    const right = referencedName(node.rightExpression);
    const msgSenderInvolved =
      isMsgSender(node.leftExpression) ||
      isMsgSender(node.rightExpression) ||
      left === '_msgSender' ||
      right === '_msgSender';
    const stateVarInvolved =
      (left && stateVariables.has(left)) ||
      (right && stateVariables.has(right));

    if (msgSenderInvolved && stateVarInvolved) found = true;
  });

  return found;
}

function collectDependenciesFromFunction(body) {
  const categories = new Set();

  walkAst(body, (node) => {
    const name = node.name || node.memberName || null;
    const category = classifyDependency(name);
    if (category) categories.add(category);
  });

  return [...categories];
}

function classifyDependency(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  for (const entry of DEPENDENCY_PATTERNS) {
    if (entry.pattern.test(name)) return entry.category;
  }
  return null;
}

function classifyPauseControl(name) {
  if (/blacklist|blocklist|denylist/i.test(name)) return 'blacklist';
  if (/freeze|frozen/i.test(name)) return 'freeze';
  return 'pause';
}

function bodyContainsIdentifier(body, identifier) {
  let found = false;
  walkAst(body, (node) => {
    if (!found && referencedName(node) === identifier) found = true;
  });
  return found;
}

function bodyContainsName(body, pattern) {
  let found = false;
  walkAst(body, (node) => {
    if (found) return;
    const name = node.name || node.memberName || modifierName(node) || null;
    if (typeof name === 'string' && pattern.test(name)) found = true;
  });
  return found;
}

function inferGuardKinds(modifiers, body) {
  const kinds = new Set();
  const capture = (name) => {
    if (typeof name !== 'string' || name.length === 0) return;
    if (/blacklist|blocklist|denylist/i.test(name)) kinds.add('blacklist');
    if (/freeze|frozen/i.test(name)) kinds.add('freeze');
    if (/pause|paused|whennotpaused|whenpaused/i.test(name)) kinds.add('pause');
    if (/timelock|delay/i.test(name)) kinds.add('timelock');
  };

  for (const modifier of modifiers) capture(modifier);
  walkAst(body, (node) => {
    capture(node.name || node.memberName || modifierName(node) || null);
  });

  return [...kinds];
}

function referencedName(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.nodeType === 'Identifier') return node.name || null;
  if (node.nodeType === 'IdentifierPath') return node.name || null;
  if (node.nodeType === 'MemberAccess') return node.memberName || null;
  if (node.nodeType === 'FunctionCall') return referencedName(node.expression);
  return null;
}

function isMsgSender(node) {
  return node?.nodeType === 'MemberAccess' &&
    node.memberName === 'sender' &&
    node.expression?.nodeType === 'Identifier' &&
    node.expression?.name === 'msg';
}

function literalValue(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.nodeType === 'Literal' && typeof node.value === 'string' && /^\d[\d_]*$/.test(node.value)) {
    return Number.parseInt(node.value.replaceAll('_', ''), 10);
  }
  return null;
}

function describeGuardType(hasModifier, hasInlineCheck) {
  if (hasModifier && hasInlineCheck) return 'modifier+inline_sender_check';
  if (hasModifier) return 'modifier';
  if (hasInlineCheck) return 'inline_sender_check';
  return 'none';
}

function extractBaseContracts(contractNode) {
  return (contractNode.baseContracts || [])
    .map((base) => referencedName(base.baseName || base))
    .filter(Boolean);
}

function modifierName(modifier) {
  if (!modifier || typeof modifier !== 'object') return null;
  return referencedName(modifier.modifierName || modifier);
}

function findContracts(ast) {
  const nodes = childNodes(ast);
  return nodes.filter((node) => node.nodeType === 'ContractDefinition');
}

function childNodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node.nodes)) return node.nodes;
  if (Array.isArray(node.children)) return node.children;
  return [];
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visit);
      continue;
    }
    if (value && typeof value === 'object') {
      walkAst(value, visit);
    }
  }
}

function locationFromNode(node, fileName, sourceContent) {
  const [offsetText] = String(node?.src || '').split(':');
  const offset = Number.parseInt(offsetText, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    return { file: fileName, line: null, column: null };
  }

  const prefix = sourceContent.slice(0, offset);
  const lines = prefix.split('\n');
  return {
    file: fileName,
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function tokenFeatureEntry(contract, variable, file) {
  return {
    contract,
    name: variable.name,
    file,
    line: variable.location.line,
  };
}

function functionFeatureEntry(contract, name, file, line) {
  return { contract, name, file, line };
}

function pushTokenFeatures(target, source) {
  for (const key of Object.keys(target)) {
    target[key].push(...source[key]);
  }
}

function dedupeFacts(facts) {
  for (const key of ['contracts', 'privilegedRoles', 'privilegedFunctions', 'mutableParameters', 'feeControls', 'upgradePaths', 'pauseControls', 'userExitFunctions', 'dependencies']) {
    facts[key] = dedupeArray(facts[key]);
  }
  for (const key of Object.keys(facts.tokenFeatures)) {
    facts.tokenFeatures[key] = dedupeArray(facts.tokenFeatures[key]);
  }
}

function dedupeArray(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export const __internal = Object.freeze({
  childNodes,
  walkAst,
  locationFromNode,
  inferFeeCap,
  inferFeeScale,
  determineHundredPercent,
  inferGuardKinds,
});
