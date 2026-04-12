# Economic & Fee Analysis

## Core Question
> "What does this cost the user, including costs that aren't obvious?"

## Scope

**Analyzes**: Explicit fees (swap, deposit, withdrawal), hidden fees (slippage defaults, rounding), fee parameter ranges, fee destinations, reward distribution, deposit/withdrawal conditions, liquidation thresholds, staking locks, compounding mechanics, share/asset ratio manipulation, reward rate changes, withdrawal queue timing, fee-free arbitrage paths.

**Ignores**: Gas costs (inherent to blockchain), code style, documentation quality, access control (Agent 1 handles that).

---

## Rules

### Impact Quantification
Every WARNING and CRITICAL finding MUST include a concrete impact estimate. "Users could lose funds" is insufficient. Quantify: How much can be lost per transaction? Per user? Is it bounded or unbounded? Example: "Admin can set fee to 100%, meaning a user depositing 10 ETH would lose all 10 ETH."

### No-Finding Handling
If this agent's domain is not applicable to the codebase (e.g., a simple token with no DeFi mechanics), return SAFE with a 1-sentence justification. Do not invent observations to fill space.

---

## Checks

### Check 1: Explicit Fees

**Grep patterns**:
```bash
rg -n 'fee|Fee|FEE|commission|spread' --type sol
rg -n 'swapFee|depositFee|withdrawFee|protocolFee|performanceFee|managementFee' --type sol
```

**What to look for**:
- What fees exist? (swap, deposit, withdrawal, performance, management)
- What are the current values?
- Are fees applied before or after the operation? (affects user's received amount)
- Map ALL fee-charging paths:

| Operation | Fee | Path | Collected By |
|-----------|-----|------|-------------|
| {swap via router} | 0.3% | {router.swap()} | {feeRecipient} |

**Severity**: INFO if fees exist and are reasonable (<5%). WARNING if fees are high (>10%).

---

### Check 2: Hidden Fees (Slippage, Rounding)

**Grep patterns**:
```bash
rg -n 'slippage|slippageTolerance|minAmount|amountOutMin' --type sol
rg -n 'roundUp|roundDown|mulDiv|FullMath' --type sol
rg -n '/\s' --type sol
```

**What to look for**:
- Slippage tolerance defaults: does the contract set a default slippage tolerance that is unfavorable to users?
- Rounding direction: does rounding systematically favor the protocol? For vaults: `deposit`/`mint` should round against depositor, `withdraw`/`redeem` against withdrawer.
- Division before multiplication: `a / b * c` loses the remainder — precision loss.
- Are there rounding errors that compound over many operations?

**Severity**: WARNING if rounding systematically favors protocol by more than dust. INFO if standard rounding practice.

---

### Check 3: Fee Parameter Ranges

**Grep patterns**:
```bash
rg -n 'setFee|updateFee|changeFee|_fee\s*=' --type sol
rg -n 'maxFee|MAX_FEE|FEE_CAP|MAX_.*FEE|FEE_MAX' --type sol
rg -n 'require.*fee.*<=|require.*<=.*fee' --type sol
```

**What to look for**:
- What is the maximum possible fee? Is there a hard cap?
- Can admin set fee to 100%? (This means user loses everything on deposit/swap/withdrawal)
- Is the fee range validated? (`require(newFee <= MAX_FEE)`)

**Severity**: CRITICAL if fee settable to 100% with no cap. WARNING if fee cap exists but is high (>50%). INFO if fee adjustable with reasonable cap.

---

### Check 4: Fee Destination

**Grep patterns**:
```bash
rg -n 'feeRecipient|feeReceiver|feeTo|treasury|feeAddress' --type sol
rg -n 'setFeeRecipient|setTreasury|setFeeTo' --type sol
```

**What to look for**:
- Where do fees go? Is it a known address (DAO treasury, multisig) or arbitrary?
- Can admin change the fee destination?
- Can fees be redirected to admin's personal address?

**Severity**: INFO if fee destination is transparent and fixed. WARNING if admin can change fee destination without timelock.

---

### Check 5: Reward Distribution Fairness

**Grep patterns**:
```bash
rg -n 'rewardPerShare|accRewardPerShare|rewardRate|cumulativeReward|pendingReward' --type sol
rg -n 'accrue|accrueReward|updateReward|_updateReward' --type sol
rg -n 'earned\(|claimReward|getReward|harvest' --type sol
```

**What to look for**:
- Is the reward accumulator updated before every state change? (deposit, withdraw, claim)
- Can a user deposit right before reward distribution, claim, then withdraw? (flash-stake)
- Is there a minimum staking period before rewards vest?
- Early staker advantage: time-weighted rewards give disproportionate share to first staker

**Severity**: WARNING if reward distribution can be gamed via flash-stake. INFO if minor timing advantage exists.

---

### Check 6: Deposit/Withdrawal Conditions

**Grep patterns**:
```bash
rg -n 'minDeposit|minimumDeposit|MIN_DEPOSIT|minAmount' --type sol
rg -n 'lockPeriod|lockDuration|lockedUntil|lock\(' --type sol
rg -n 'withdrawalDelay|cooldown|unstakeDelay' --type sol
```

**What to look for**:
- Are there minimum deposit/withdrawal amounts? What are they?
- Is there a lock period? How long? Can it be changed by admin?
- Can users exit at any time or are they locked?
- Can withdrawal be permanently blocked? (by pausing, by changing parameters)

**Severity**: CRITICAL if funds can be locked indefinitely. WARNING if lock period >30 days. INFO if lock period is short and transparent.

---

### Check 7: Liquidation Thresholds and Penalties

**Grep patterns**:
```bash
rg -n 'liquidat|healthFactor|collateralRatio|collateralFactor' --type sol
rg -n 'liquidationBonus|liquidationPenalty|liquidationThreshold' --type sol
rg -n 'badDebt|socialize|shortfall' --type sol
```

**What to look for**:
- At what collateral ratio can a position be liquidated?
- What is the liquidation penalty? (e.g., 5% of collateral seized)
- `liquidator_profit = seized_collateral * price - repaid_debt - gas - slippage` — at what point does this go negative? (bad debt zone)
- Is the liquidation bonus fixed or dynamic? Fixed bonus + volatile collateral = bad debt zone.
- Can pause block liquidations? (bad debt accumulates)
- Is there partial liquidation? Can liquidators loop partial liquidations for amplified profit?

**Severity**: WARNING if liquidation terms are aggressive (high penalty, low threshold). INFO if standard DeFi liquidation mechanics.

---

### Check 8: Staking Lock Periods and Early Withdrawal Penalties

**Grep patterns**:
```bash
rg -n 'unstake|cooldown|lockPeriod|vestingPeriod|cliff' --type sol
rg -n 'earlyWithdraw|penalty|slash' --type sol
rg -n 'epoch|epochDuration|epochEnd' --type sol
```

**What to look for**:
- How long are funds locked? Is there an early withdrawal option?
- What is the penalty for early withdrawal? Can it take 100% of the stake?
- Can admin change lock period after users have staked?
- Can admin extend lock periods indefinitely?

**Severity**: CRITICAL if admin can extend locks indefinitely or early withdrawal penalty can take 100%. WARNING if lock >30 days with no early exit. INFO if reasonable lock with transparent terms.

---

### Check 9: Compounding Mechanics

**Grep patterns**:
```bash
rg -n 'compound|autoCompound|reinvest|harvest' --type sol
rg -n 'totalAssets|yield|strateg' --type sol
```

**What to look for**:
- Does the user miss yield if they don't manually compound/harvest?
- Is compounding automatic or manual? If manual, can someone front-run the compound call?
- Does the compounding operation charge a fee?

**Severity**: INFO if compounding requires manual action. WARNING if front-running compound calls steals user yield.

---

### Check 10: Share/Asset Ratio Manipulation (Inflation Attacks)

**Grep patterns**:
```bash
rg -n 'totalAssets|convertToShares|convertToAssets|previewDeposit|previewMint' --type sol
rg -n '_decimalsOffset|_decimalsOffset\(\)|10\s*\*\*' --type sol
rg -n 'ERC4626|ERC-4626|IERC4626' --type sol
```

**What to look for**:
- **First depositor attack**: Attacker deposits 1 wei, donates large amount directly, next depositor gets 0 shares due to rounding.
- **Virtual shares defense**: Does vault use `_decimalsOffset()` (OZ) or dead shares to prevent inflation?
- **Round-trip extraction**: Does `deposit(X) -> redeem(shares)` ever return more than X? Test at edge values (1, 1e6, MAX).
- **totalAssets manipulation**: Does `totalAssets` include donated tokens via `balanceOf(address(this))`? If so, manipulable.

**Severity**: CRITICAL if inflation attack is possible (no virtual shares, no dead shares, no minimum deposit). WARNING if partial mitigation exists. SAFE if virtual shares / dead shares defense is implemented.

---

### Check 11: Reward Rate Change Without Settling Accumulator

**Grep patterns**:
```bash
rg -n 'setRewardRate|updateRewardRate|changeRewardRate|notifyRewardAmount' --type sol
rg -n 'accrue|_updateReward|rewardPerToken' --type sol
```

**What to look for**:
- If admin calls `setRewardRate()` without first calling `accrue()` or `_updateReward()`, the new rate retroactively applies to the unsettled period.
- This can over-distribute or under-distribute rewards.
- Does every rate-changing function settle the accumulator first?

**Severity**: WARNING if rate change doesn't settle first — users may lose or gain unearned rewards.

---

### Check 12: Withdrawal Queue Rate Lock-in

**Grep patterns**:
```bash
rg -n 'requestWithdraw|queueWithdraw|withdrawalRequest|requestRedeem' --type sol
rg -n 'claimWithdraw|completeWithdraw|fulfillWithdraw|processWithdraw' --type sol
rg -n 'exchangeRate.*request|request.*rate' --type sol
```

**What to look for**:
- If exchange rate at withdrawal REQUEST time differs from FULFILLMENT time, arbitrage is possible.
- User requests withdrawal when rate is high, fulfillment happens when rate is lower (or vice versa).
- Which rate is used — request-time or fulfillment-time?
- Can attacker request withdrawal, wait for rate change, cancel and re-request?

**Severity**: WARNING if rate lock-in enables arbitrage. INFO if queue exists but uses fulfillment-time rate.

---

### Check 13: Fee-Free Arbitrage Paths

**What to look for**:
- Map ALL paths for the same operation. If any path charges a fee and an alternative path doesn't, rational users bypass the fee.
- Example: swap via router (0.3% fee) vs direct pool call (0% fee).
- Example: mint via frontend (1% fee) vs mint via direct contract call (0% fee).

| Operation | Fee Path | Alternative Path | Alternative Fee |
|-----------|----------|-----------------|----------------|
| {operation} | {path + fee} | {alt path} | {fee or 0%} |

**Severity**: INFO if fee-free path exists with low practical impact. WARNING if fee bypass undermines protocol revenue significantly.

---

## Severity Rules

| Level | Condition |
|-------|-----------|
| **CRITICAL** | Fees configurable to 100%. Withdrawal permanently blockable. Funds lockable indefinitely. Reward rate manipulation steals user yield. Inflation attack drains depositors. |
| **WARNING** | High fees (>10%). Long lock periods (>30 days). Unfavorable liquidation terms. Rate lock-in arbitrage. Front-runnable compounding. Reward rate change without settle. |
| **INFO** | Moderate fees (2-10%). Short lock periods. Standard DeFi economics. Fee-free path exists but low impact. Manual compounding required. |
| **SAFE** | Transparent, reasonable fees with caps. No lock periods or short transparent ones. Virtual shares defense. Proper accumulator settlement. |