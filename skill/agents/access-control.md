# Access Control

## Core Question
> "Who can change things, and what can they change?"

## Scope

**Analyzes**: All privileged functions, role hierarchies, initialization flows, proxy/upgrade patterns, pause mechanisms, blacklists, emergency functions, timelocks, admin capabilities, state transition guards, and external call recipients.

**Ignores**: View/pure functions, standard event emissions, gas optimizations, code style.

---

## Rules

### Impact Quantification
Every WARNING and CRITICAL finding MUST include a concrete impact estimate. "Users could lose funds" is insufficient. Quantify: How much can be lost per transaction? Per user? Is it bounded or unbounded?

### No-Finding Handling
If this agent's domain is not applicable to the codebase, return SAFE with a 1-sentence justification. Do not invent observations to fill space.

---

## Checks

### Check 1: Owner/Admin Identification

**What to look for**: Who has privileged roles and what can they do?

**Grep patterns**:
```bash
rg -n 'onlyOwner|onlyRole|onlyAdmin|require\(msg\.sender' --type sol
rg -n 'function\s+\w+\s*\([^)]*\)\s*(external|public)\s+(?!.*\b(view|pure|only|require)\b)' --type sol
```

**Build a permission map**:

| Function | Modifier/Guard | Who Can Call | State Changes | Severity if Unprotected |
|----------|---------------|-------------|---------------|------------------------|
| {function} | {onlyOwner/etc} | {role} | {what changes} | {CRITICAL/HIGH/MED} |

**What it means**: State-writing external/public functions without access modifiers allow anyone to execute privileged operations — asset theft, parameter manipulation, or contract takeover.

**Vulnerable pattern — missing modifier**:
```solidity
// VULNERABLE: no access control — anyone can drain
function sweep(address token, address to) external {
    IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
}
```

**Vulnerable pattern — wrong check (existence vs ownership)**:
```solidity
function setFee(uint256 newFee) external {
    // VULNERABLE: checks that caller exists, not that caller is authorized
    require(msg.sender != address(0), "Invalid caller");
    fee = newFee;
}
```

**Vulnerable pattern — tautology**:
```solidity
function withdraw(uint256 amount) external {
    // VULNERABLE: uint256 is always >= 0, this check does nothing
    require(amount >= 0, "Invalid amount");
    payable(msg.sender).transfer(amount);
}
```

**Vulnerable pattern — silent modifier**:
```solidity
modifier onlyAdmin() {
    // VULNERABLE: uses 'if' instead of 'require'
    // unauthorized calls skip the function body silently
    if (msg.sender == admin) {
        _;
    }
}
```

**Detection heuristics**:
1. Find all state-writing external/public functions. Each MUST have an authorization modifier.
2. Compare sibling functions: if 4 out of 5 functions writing to `balances` have `onlyOwner` but one does not, the unguarded one is the bug.
3. Read modifier internals: verify it uses `require(condition)` or `revert`, NOT `if (condition) { _; }`.
4. Check role management functions (`setAdmin`, `grantRole`) — are THESE access-controlled?

**FP conditions**: Authorization may be enforced in a calling function (check full call chain). Internal/private functions do not need modifiers. Some functions are intentionally permissionless (e.g., `liquidate`, `harvest`).

**Severity**: CRITICAL if unprotected function can drain funds or change ownership. WARNING if unprotected function changes non-critical state.

---

### Check 2: Single-Step Ownership Transfer

**Grep patterns**:
```bash
rg -n 'transferOwnership|changeOwner|setOwner' --type sol
rg -n 'Ownable2Step|acceptOwnership|pendingOwner' --type sol
```

**What to look for**: Single-step `transferOwnership(newOwner)` — a typo in the address permanently loses admin access. Two-step pattern (`transferOwnership` + `acceptOwnership`) prevents this.

**Severity**: INFO — best practice, not a vulnerability.

---

### Check 3: Unprotected Initializers

**Grep patterns**:
```bash
rg -n 'initialize|initializer|_disableInitializers|reinitializer' --type sol
rg -n 'upgradeTo|upgradeToAndCall|_authorizeUpgrade' --type sol
```

**What to look for**:
- `initialize()` callable by anyone (missing `initializer` modifier)
- Missing `_disableInitializers()` in implementation constructor — attacker initializes implementation directly, becomes owner
- Gap between deploy and initialize: attacker can front-run `initialize()`

**Vulnerable pattern**:
```solidity
contract VaultV1 is Initializable, OwnableUpgradeable {
    // VULNERABLE: no constructor calling _disableInitializers()
    function initialize(address _owner) external initializer {
        __Ownable_init(_owner);
    }
    function withdrawAll(address to) external onlyOwner {
        payable(to).transfer(address(this).balance);
    }
}
```

**Severity**: CRITICAL — unprotected initializer = complete contract takeover.

---

### Check 4: Proxy/Upgrade Patterns

**Grep patterns**:
```bash
rg -n 'upgradeTo|upgradeToAndCall|_authorizeUpgrade' --type sol
rg -n 'delegatecall|_implementation|_getImplementation' --type sol
rg -n '__gap|storage gap' --type sol
rg -n 'ERC1967|TransparentUpgradeableProxy|UUPSUpgradeable|BeaconProxy' --type sol
```

**What to look for**:
1. **Unrestricted upgrade**: Can anyone call `upgradeTo()`? Missing access control = complete takeover.
2. **Storage collision**: Does proxy use ERC-1967 reserved slots? Custom slots that collide with implementation variables?
3. **Missing `__gap`**: Base contracts without `uint256[50] private __gap` — adding variables in upgrades shifts ALL child storage.
4. **UUPS losing upgrade**: New implementation doesn't inherit `UUPSUpgradeable` — proxy permanently bricked.
5. **Delegatecall context confusion**: Implementation writes to `slot 0` thinking it's its own variable — overwrites proxy's `_implementation`.
6. **Function selector clash**: Proxy function with same 4-byte selector as implementation function — proxy intercepts the call.
7. **Immutables in implementation**: `immutable` variables stored in bytecode — proxy can't access them.
8. **Timelock on upgrades**: Is there a timelock/delay before upgrades take effect? Users need time to exit.

**Severity**: CRITICAL if upgradeable with no timelock/multisig (admin can swap code instantly). WARNING if upgradeable with short timelock or single-key upgrade authority.

---

### Check 5: Pause/Freeze Capabilities

**Grep patterns**:
```bash
rg -n 'pause|unpause|whenNotPaused|Pausable' --type sol
rg -n 'freeze|frozen|locked' --type sol
```

**What to look for**:
- Can admin pause the contract? What functions are affected?
- Can pause block user withdrawals? This traps user funds.
- For lending protocols: can pause block liquidations? This allows bad debt to accumulate.
- Is there a timelock on pause/unpause?
- Can admin pause indefinitely with no forced unpause mechanism?

**Severity**: WARNING if pause can block withdrawals without timelock. WARNING if pause blocks liquidations (lending). INFO if pause only affects deposits (users can still exit).

---

### Check 6: Blacklist/Whitelist Functions

**Grep patterns**:
```bash
rg -n 'blacklist|blocklist|denylist|whitelist|allowlist' --type sol
rg -n 'isBlacklisted|isBlocked|isFrozen|canTransfer' --type sol
```

**What to look for**:
- Can admin blacklist addresses and prevent them from transferring/withdrawing?
- Is the blacklist function timelocked?
- Can blacklisted users still claim rewards or recover funds through alternative paths?

**Severity**: WARNING — blacklist capability gives admin power to freeze individual user funds.

---

### Check 7: Emergency Withdrawal Functions

**Grep patterns**:
```bash
rg -n 'emergencyWithdraw|rescue|sweep|drain|recover' --type sol
rg -n 'withdraw.*onlyOwner|transfer.*onlyOwner' --type sol
```

**What to look for**:
- Can admin drain user funds via emergency functions?
- Does the emergency function bypass normal accounting (shares, balances)?
- Is there a timelock on emergency withdrawals?
- Can admin sweep arbitrary ERC20 tokens including user deposits?

**Severity**: CRITICAL if admin can drain user-deposited funds without timelock. WARNING if admin can only sweep non-user tokens (rescue stuck tokens).

---

### Check 8: Timelock Presence on Destructive Actions

**Grep patterns**:
```bash
rg -n 'timelock|TimeLock|delay|MIN_DELAY|TIMELOCK' --type sol
rg -n 'queue|execute.*after|pendingAdmin' --type sol
```

**What to look for**:
- For every admin function that changes critical parameters (fees, oracles, collateral factors, interest rates): is there a timelock?
- Alternative code paths that bypass the timelock (e.g., an `emergencySetFee` that skips the delay)
- Timelock duration — is it meaningful? (1 hour is nearly useless; 48 hours gives users time to exit)
- Parameters that are "destructive" if changed: fee to 100%, oracle to attacker-controlled, pause permanently

**Severity**: CRITICAL if destructive admin actions have no timelock. WARNING if timelock exists but is short (<24 hours) or has bypass paths.

---

### Check 9: Multisig vs EOA Ownership

**Grep patterns**:
```bash
rg -n 'owner\(\)|_owner|admin|governance' --type sol
```

**What to look for**:
- Is the owner/admin a single EOA or a multisig/governance contract?
- For multisig: what's the threshold? (2-of-3 is weak; 4-of-7 is better)
- Is ownership hardcoded or configurable?
- Note: this check often requires off-chain verification (checking the deployer address on-chain)

**Severity**: WARNING if single EOA controls critical functions. INFO if multisig with adequate threshold. SAFE if governance-controlled with timelock.

---

### Check 10: Self-Destruct Capability

**Grep patterns**:
```bash
rg -n 'selfdestruct|SELFDESTRUCT' --type sol
```

**What to look for**:
- Can anyone trigger `selfdestruct`? This destroys the contract and sends ETH to an arbitrary address.
- For proxy implementations: `selfdestruct` in the implementation destroys it, bricking ALL proxies.
- Note: `selfdestruct` is deprecated post-Cancun (EIP-6780) — only works in same-tx as creation. Still dangerous in constructor context or on pre-Cancun chains.

**Severity**: CRITICAL if `selfdestruct` is callable by admin on a proxy implementation. WARNING if present but restricted. INFO if on non-proxy contract with proper access control.

---

### Check 11: Untrusted Recipient Map

**Grep patterns**:
```bash
rg -n '\.call\{value|\.call\{.*value' --type sol
rg -n '\.transfer\(|\.send\(' --type sol
rg -n 'safeTransfer|safeTransferFrom' --type sol
```

**What to look for**: For every point where an external address receives a call or transfer:
- Is the recipient validated? (user-supplied address vs hardcoded)
- Can the recipient be a contract? (reentrancy surface)
- Is the call result checked? (unchecked `.call` returns true even on failure for empty addresses)
- Can an attacker set themselves as the recipient for someone else's funds?

**Severity**: CRITICAL if unvalidated recipient can redirect user funds. WARNING if recipient is a contract with reentrancy surface and no guard.

---

### Check 12: State Transition Safety

**Grep patterns**:
```bash
rg -n 'enum\s+\w+\s*\{|Status|State|Phase' --type sol
rg -n 'require.*status|require.*state|require.*phase' --type sol
```

**What to look for**: For multi-state systems (proposals, orders, positions, auctions):
- Can states be skipped? (PENDING -> EXECUTED, skipping APPROVED)
- Can states go backward? (EXECUTED -> PENDING)
- Is the "completed" state truly terminal? Can it be re-entered?
- Are transitions validated with require/assert or just if-statements?

**Severity**: CRITICAL if state skip allows unauthorized execution (e.g., executing a proposal without approval). WARNING if backward transitions possible but limited impact.

---

## Severity Rules

| Level | Condition |
|-------|-----------|
| **CRITICAL** | Admin can drain user funds without timelock. Unprotected initializer on proxy. Upgradeable with no timelock and single EOA. Unrestricted delegatecall target. Missing access control on fund-moving function. |
| **WARNING** | Single owner EOA on significant protocol. Pausable without timelock (traps funds). Blacklist capability without timelock. Pause blocks liquidations (lending). Short timelock (<24h) on destructive actions. |
| **INFO** | Ownable without 2-step transfer. Missing events on admin actions. Low multisig threshold (2-of-3). |
| **SAFE** | Proper access control on all state-writing functions. Timelocks on destructive actions. Multisig or governance ownership. Two-step ownership transfer. |
