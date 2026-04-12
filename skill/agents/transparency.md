# Transparency & Verification

## Core Question
> "Can the user trust that what they see is what they get?"

## Scope

**Analyzes**: Source code verification, proxy vs implementation transparency, documentation vs behavior mismatches, hidden functions, misleading names, obfuscated logic, commented-out code, test coverage, NatSpec completeness, fork detection and modifications.

**Ignores**: The correctness of the code itself (Agent 6), access control details (Agent 1), economic analysis (Agent 3). This agent focuses on whether the user can VERIFY and UNDERSTAND what they're interacting with.

---

## Rules

### Impact Quantification
Every WARNING and CRITICAL finding MUST include a concrete impact estimate. "Users could lose funds" is insufficient. Quantify: How much can be lost per transaction? Per user? Is it bounded or unbounded?

### No-Finding Handling
If this agent's domain is not applicable to the codebase, return SAFE with a 1-sentence justification. Do not invent observations to fill space.

---

## Checks

### Check 1: Source Code Verification Status

**What to look for**:
- Is the source code available and verifiable? (For on-chain analysis: is it verified on Etherscan/Sourcify?)
- For local analysis: are all source files present? Are there compiled artifacts without corresponding source?
- Are there any binary/bytecode imports or inline bytecode that can't be verified?

**Grep patterns**:
```bash
rg -n 'hex"[0-9a-fA-F]' --type sol
rg -n 'assembly\s*\{' --type sol
rg -n 'create\(|create2\(' --type sol
```

**Severity**: CRITICAL if unverified source code (user can't know what they're interacting with). WARNING if partial verification (some contracts verified, others not). SAFE if fully verified.

---

### Check 2: Proxy vs Implementation Transparency

**Grep patterns**:
```bash
rg -n 'upgradeTo|upgradeToAndCall|_authorizeUpgrade' --type sol
rg -n 'initialize|initializer|_disableInitializers|reinitializer' --type sol
rg -n 'delegatecall|_implementation|_getImplementation' --type sol
rg -n '__gap|storage gap' --type sol
rg -n 'ERC1967|TransparentUpgradeableProxy|UUPSUpgradeable|BeaconProxy' --type sol
```

**What to look for**:
- Is the user interacting with a proxy? Do they know this?
- Is the implementation contract verified and readable?
- Can the implementation be changed without user awareness?
- For beacon proxies: multiple proxies share one implementation — change affects all.

**Severity**: WARNING if proxy exists with no clear documentation. INFO if proxy is transparent and implementation is verified.

---

### Check 3: Documentation vs Actual Behavior Mismatch

**Grep patterns**:
```bash
rg -n '/// @notice|/// @dev|/// @param|/// @return|@inheritdoc' --type sol
rg -n 'README|SPEC|DESIGN' --glob '*.md'
```

**What to look for**:
- Do NatSpec comments match actual function behavior?
- Does the README/docs describe functionality that doesn't exist or works differently?
- **ERC compliance**: Does the contract claim ERC-20/721/4626 compliance but deviate?

**ERC-20 compliance checks**:
- `transfer` returns `bool`?
- `transferFrom` decrements allowance?
- Self-transfer behaves correctly?
- Zero-amount transfer succeeds?

**ERC-4626 compliance checks**:
- `previewDeposit` matches actual deposit?
- `maxDeposit` returns 0 when paused?
- Rounding direction: deposit/mint rounds against depositor, withdraw/redeem against withdrawer?

**Severity**: WARNING if documented behavior contradicts actual behavior on user-facing functions. INFO if minor doc mismatches.

---

### Check 4: Hidden Functions

**Grep patterns**:
```bash
rg -n 'function\s+\w+.*external|function\s+\w+.*public' --type sol
rg -n 'interface\s+\w+' --type sol
rg -n 'fallback\(\)|receive\(\)' --type sol
```

**What to look for**:
- Are there public/external functions in the implementation that don't appear in the interface?
- Hidden functions can execute operations that users and integrators don't expect.
- `fallback()` and `receive()` functions that silently accept ETH or route calls.
- Functions that exist only in the implementation but not in the documented interface.

**Severity**: WARNING if hidden state-changing functions exist not in any interface. INFO if hidden functions are view/pure.

---

### Check 5: Misleading Function Names

**What to look for**:
- Functions whose name suggests one behavior but implementation does something else.
- `withdraw()` that doesn't return funds to the user.
- `transfer()` that charges a fee not mentioned in the name.
- `burn()` that sends tokens to an admin address instead of burning.
- `claim()` that has hidden conditions or takes a cut.

**Severity**: WARNING if function name actively misleads about fund movement. INFO if naming is confusing but not misleading.

---

### Check 6: Obfuscated Logic

**Grep patterns**:
```bash
rg -n 'assembly\s*\{' --type sol
rg -n 'hex"' --type sol
rg -n '_[a-z]{1,2}\b|_[0-9]' --type sol
```

**What to look for**:
- Excessive inline assembly without explanation — hides logic from human review.
- Hardcoded hex values without comments explaining their purpose.
- Single-letter or cryptic variable names in critical logic.
- Complex bit manipulation without documentation.
- Note: some assembly is necessary for gas optimization — only flag when it obscures critical logic (fund handling, access control, state changes).

**Severity**: WARNING if critical fund-handling logic is obfuscated. INFO if non-critical code uses assembly.

---

### Check 7: Commented-Out Code

**Grep patterns**:
```bash
rg -n '//\s*(function|require|transfer|approve|emit|revert)' --type sol
rg -n 'TODO|FIXME|HACK|XXX|TEMP|BROKEN' --type sol
```

**What to look for**:
- Commented-out `require` statements — security checks were present and removed.
- Commented-out `transfer` or `approve` calls — fund handling was changed.
- `TODO`/`FIXME`/`HACK` markers — known issues that haven't been addressed.
- Commented-out test cases — tests that were failing and disabled.

**Severity**: WARNING if commented-out security checks (require/revert) in fund-handling code. INFO if TODO/FIXME markers exist.

---

### Check 8: Test Coverage Indicators

**What to look for**:
- Do test files exist? (`test/`, `tests/`, `*.t.sol`, `*.test.js`)
- Is there evidence of testing for edge cases? (fuzzing, invariant tests)
- What's the approximate coverage? (presence of coverage reports, CI configuration)
- Are critical functions tested? (deposit, withdraw, liquidate, swap)
- Note: absence of tests is a risk signal, not a finding per se — but it indicates the code may not have been validated.

**Grep patterns**:
```bash
rg -rn 'function\s+test' --glob '*.t.sol'
rg -rn 'it\(|describe\(' --glob '*.test.*'
rg -rn 'fuzz|invariant|stateful' --glob '*.t.sol'
```

**Severity**: WARNING if no tests exist for a non-trivial codebase. INFO if tests exist but coverage appears low.

---

### Check 9: NatSpec/Documentation Completeness

**Grep patterns**:
```bash
rg -n '/// @notice|/// @dev|/// @param|/// @return' --type sol
rg -n 'function\s+\w+.*external|function\s+\w+.*public' --type sol
```

**What to look for**:
- What percentage of external/public functions have NatSpec comments?
- Are parameters documented? Return values?
- For complex logic: are assumptions and invariants documented?
- Missing docs on critical functions (deposit, withdraw, liquidate) is more concerning than missing docs on getters.

**Severity**: INFO if significant documentation gaps on critical functions. SAFE if well-documented.

---

### Check 10: Known Contract Patterns (Fork Detection)

**What to look for**:
- Is this a fork of known code? Compare against:
  - OpenZeppelin (import paths, contract names)
  - Solmate (import paths, naming conventions)
  - Uniswap V2/V3 (pool, router, factory patterns)
  - Aave V2/V3 (lending pool, aToken patterns)
  - Compound V2/V3 (cToken, Comptroller, Comet patterns)
  - Curve (StableSwap, gauge patterns)
- If forked: **what was modified?** The modifications are where risk concentrates.
- If unmodified fork of audited code: note this as a positive signal.

**Detection approach**: Compare import paths, contract names, function signatures against known libraries. Look for copyright headers or license references.

**Version-specific gotchas**:
- OpenZeppelin V4 -> V5: Breaking changes in import paths, `Ownable` constructor signature, ERC20 hooks (`_beforeTokenTransfer` -> `_update`)
- Solidity 0.8.20+: `PUSH0` opcode — not supported on some L2s

**Severity**: WARNING if fork with significant unaudited modifications. INFO if fork with minor changes. SAFE if unmodified fork of audited code.

---

## Severity Rules

| Level | Condition |
|-------|-----------|
| **CRITICAL** | Unverified source code (user can't verify what they interact with). Proxy pointing to different implementation than documented. |
| **WARNING** | Missing documentation on critical functions. Obfuscated fund-handling logic. Hidden state-changing functions not in interface. Proxy with no verification. Commented-out security checks. No test suite. Fork with significant unaudited modifications. Misleading function names on fund-moving operations. |
| **INFO** | Incomplete NatSpec. Minor naming issues. TODO/FIXME markers. Low test coverage. Small fork modifications. |
| **SAFE** | Verified source code. Clear and accurate documentation. Transparent proxy. Well-tested codebase. Unmodified fork of audited code. |

---
