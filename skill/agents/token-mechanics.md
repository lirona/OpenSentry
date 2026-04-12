# Token Mechanics

## Core Question
> "Will this token behave the way the user expects?"

## Scope

**Analyzes**: Transfer restrictions, fee-on-transfer mechanics, tax rates, rebasing behavior, mint/burn functions, max transaction/wallet limits, cooldowns, approval patterns, hidden transfer hooks, balance manipulation, trading switches, ERC-20/721/1155 compliance.

**Ignores**: Gas optimizations, NatSpec completeness, event emissions, code style. Accounting correctness for protocols handling these tokens belongs to Agent 3 (Economic) and Agent 6 (Code Quality).

---

## Rules

### Impact Quantification
Every WARNING and CRITICAL finding MUST include a concrete impact estimate. "Users could lose funds" is insufficient. Quantify: How much can be lost per transaction? Per user? Is it bounded or unbounded?

### No-Finding Handling
If this agent's domain is not applicable to the codebase (e.g., no custom token mechanics — standard OpenZeppelin ERC20 with no modifications), return SAFE with a 1-sentence justification. Do not invent observations to fill space.

---

## Checks

### Check 1: Transfer Restrictions

**Grep patterns**:
```bash
rg -n 'blacklist|blocklist|denylist|whitelist|allowlist' --type sol
rg -n 'isBlacklisted|isBlocked|canTransfer|_beforeTokenTransfer|_update' --type sol
rg -n 'require.*transfer|require.*send' --type sol
```

**What to look for**: Can transfers be blocked for specific addresses? Is there an allowlist that restricts who can receive/send? Can the restriction be changed after deployment?

**Severity**: WARNING if admin-controlled blacklist exists. INFO if restrictions are transparent and documented (e.g., compliance requirement).

---

### Check 2: Fee-on-Transfer / Tax Token Mechanics

**Grep patterns**:
```bash
rg -n 'fee|tax|_fee|_tax|takeFee|deductFee' --type sol
rg -n '_transfer|_update' --type sol
rg -n 'feeRecipient|feeReceiver|taxWallet|treasury' --type sol
```

**What to look for**:
- Does `transfer`/`transferFrom` deduct a fee before crediting the recipient?
- The actual amount received is less than the amount sent — protocols integrating this token may credit more than received.
- Fee percentage: is it reasonable (<5%) or excessive?

**Vulnerable pattern**:
```solidity
function _transfer(address from, address to, uint256 amount) internal {
    uint256 fee = amount * taxRate / 100;
    uint256 netAmount = amount - fee;
    balances[from] -= amount;
    balances[to] += netAmount;
    balances[feeReceiver] += fee;
}
```

**Severity**: INFO if fee <5% and transparent. WARNING if fee >5% or if fee destination is admin-controlled.

---

### Check 3: Variable Tax Rates

**Grep patterns**:
```bash
rg -n 'setFee|setTax|updateFee|changeFee|_fee\s*=' --type sol
rg -n 'maxFee|MAX_FEE|FEE_CAP|MAX_TAX' --type sol
```

**What to look for**:
- Can admin change the fee/tax rate? To what maximum?
- Is there a hard cap in the contract? (`require(newFee <= MAX_FEE)`)
- Can fee be set to 100%? This creates a honeypot — users can buy but never sell.

**Severity**: CRITICAL if fee settable to 100% with no cap. WARNING if fee cap exists but is high (>20%). INFO if fee adjustable with reasonable cap (<10%).

---

### Check 4: Rebasing Behavior

**Grep patterns**:
```bash
rg -n 'rebase|elastic|scaledBalance|sharesOf|getSharesByPooledEth' --type sol
rg -n 'totalShares|_totalSupply.*!=.*balanceOf' --type sol
```

**What to look for**:
- Does the token balance change without explicit transfers? (rebasing tokens like stETH, AMPL)
- Protocols that cache `balanceOf` will have stale values after a rebase.
- Is the rebase up-only (positive rebase) or can it decrease balances?

**Severity**: INFO if rebasing is transparent and well-documented. WARNING if negative rebasing is possible without user awareness.

---

### Check 5: Mint Functions

**Grep patterns**:
```bash
rg -n 'function\s+mint|_mint\(' --type sol
rg -n 'maxSupply|MAX_SUPPLY|cap\(\)|_cap' --type sol
rg -n 'totalSupply' --type sol
```

**What to look for**:
- Who can mint? Is it restricted to specific roles?
- Is there a supply cap? (`require(totalSupply + amount <= MAX_SUPPLY)`)
- Can admin mint unlimited tokens, diluting all holders?

**Severity**: CRITICAL if admin can mint uncapped (unlimited dilution). WARNING if mint exists but is capped. INFO if mint is restricted to specific mechanisms (e.g., staking rewards).

---

### Check 6: Burn Mechanics

**Grep patterns**:
```bash
rg -n 'function\s+burn|_burn\(' --type sol
rg -n 'burnFrom' --type sol
```

**What to look for**:
- Can anyone burn tokens from another user's balance? (`burnFrom` without proper approval check)
- Is burn voluntary or can it be forced by admin?
- Does burning affect reward calculations or share ratios?

**Severity**: CRITICAL if forced burn without user consent. INFO if burn is voluntary (user burns their own tokens).

---

### Check 7: Max Transaction / Max Wallet Limits

**Grep patterns**:
```bash
rg -n 'maxTransaction|maxTx|maxTransfer|_maxTxAmount' --type sol
rg -n 'maxWallet|maxBalance|_maxWalletAmount' --type sol
```

**What to look for**:
- Are there limits on how much can be transferred per transaction or held per wallet?
- Can these limits be changed by admin? Can they be set to 0 (blocking all transfers)?
- Are certain addresses exempt (owner, liquidity pool)?

**Severity**: WARNING if limits exist and admin can set them to effectively block transfers. INFO if limits are reasonable and transparent.

---

### Check 8: Cooldown Periods Between Transfers

**Grep patterns**:
```bash
rg -n 'cooldown|lastTransfer|lastTx|transferDelay|_holderLastTransferTimestamp' --type sol
rg -n 'block\.timestamp.*last|last.*block\.timestamp' --type sol
```

**What to look for**:
- Is there a forced delay between transfers for the same address?
- Can cooldown be changed or disabled by admin?
- Does the cooldown prevent emergency exits?

**Severity**: WARNING if cooldown prevents timely exit. INFO if cooldown is short and transparent.

---

### Check 9: Approval Patterns

**Grep patterns**:
```bash
rg -n 'approve\(|allowance' --type sol
rg -n 'permit\(' --type sol
rg -n 'increaseAllowance|decreaseAllowance' --type sol
rg -n 'MAX_UINT|type\(uint256\)\.max' --type sol
```

**What to look for**:
- **Infinite approval**: Does the protocol request `type(uint256).max` approval? If the protocol is compromised, all approved funds are at risk.
- **Approval race condition**: `approve(spender, newAmount)` without first setting to 0 — spender frontruns to spend old + new.
- **Permit frontrun DoS**: `permit()` called before `transferFrom()` — frontrunner calls `permit()` first causing victim's tx to revert.

**Vulnerable pattern**:
```solidity
// Approval race: spender sees approve(100) pending, spends current 50, then gets new 100
token.approve(spender, newAmount); // should set to 0 first

// Permit DoS: frontrunner calls permit with same sig, victim's tx reverts
token.permit(owner, spender, value, deadline, v, r, s);
token.transferFrom(owner, address(this), value);
```

**Severity**: INFO for infinite approval requests (standard practice but user should be aware). WARNING if approval pattern has race condition in critical flow.

---

### Check 10: Hidden Transfer Hooks / Callbacks

**Grep patterns**:
```bash
rg -n '_beforeTokenTransfer|_afterTokenTransfer|_update' --type sol
rg -n 'onERC721Received|onERC1155Received|tokensReceived' --type sol
rg -n 'ERC777|IERC777' --type sol
```

**What to look for**:
- Are there hooks in `_beforeTokenTransfer` or `_afterTokenTransfer` that modify behavior beyond standard transfers?
- Do hooks call external contracts? (reentrancy surface)
- ERC-777 `tokensReceived` callbacks can re-enter the contract mid-transfer.
- Do hooks silently block certain transfers without reverting?

**Severity**: CRITICAL if hooks enable reentrancy that can drain funds. WARNING if hooks modify transfer behavior in non-obvious ways. INFO if hooks exist but are benign (e.g., snapshot updates).

---

### Check 11: Balance Manipulation (Reflection Tokens, Elastic Supply)

**Grep patterns**:
```bash
rg -n 'reflect|reflection|_rTotal|_tTotal|tokenFromReflection' --type sol
rg -n 'balanceOf.*return.*div|balanceOf.*return.*mul' --type sol
rg -n 'excludeFromReward|includeInReward|isExcluded' --type sol
```

**What to look for**:
- Reflection tokens: `balanceOf` returns a calculated value based on total reflections, not a stored balance. This makes integrations unreliable.
- Elastic supply: total supply changes, individual balances scale proportionally.
- Excluded addresses: some addresses don't participate in reflections — creates accounting divergence.

**Severity**: WARNING if balance is calculated (reflection) — integrating protocols may malfunction. INFO if elastic supply with transparent mechanics.

---

### Check 12: Trading Enable/Disable Switch

**Grep patterns**:
```bash
rg -n 'tradingEnabled|tradingActive|swapEnabled|canTrade|tradingOpen' --type sol
rg -n 'enableTrading|openTrading|startTrading' --type sol
```

**What to look for**:
- Can admin enable/disable trading? This is a common honeypot pattern — admin enables trading to attract buyers, then disables it so no one can sell.
- Is the switch one-way (once enabled, can't be disabled)? This is safer.
- Are certain addresses (owner, router) exempt from the restriction?

**Severity**: CRITICAL if admin can repeatedly toggle trading (honeypot). WARNING if admin can disable trading even once after enabling. INFO if one-way enable-only switch.

---

## Severity Rules

| Level | Condition |
|-------|-----------|
| **CRITICAL** | Uncapped mint by admin (unlimited dilution). Transfer fee settable to 100% (honeypot). Hidden balance manipulation that can drain integrated protocols. Admin can toggle trading repeatedly. Forced burns from user balances. |
| **WARNING** | Fee-on-transfer >5%. Trading killswitch (even one-time disable). Max tx/wallet limits that admin can set to 0. Cooldowns preventing exit. Reflection token mechanics. Approval race in critical flow. |
| **INFO** | Standard fee-on-transfer <5%. Rebasing with documentation. Max wallet limits (reasonable). Infinite approval requests. One-way trading enable. |
| **SAFE** | Standard ERC20 behavior. No custom transfer logic. No admin-changeable parameters. SafeERC20 used for all interactions. |

---
