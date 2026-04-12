# MEV & Transaction Safety

## Core Question
> "Can someone exploit the user's transaction in the mempool?"

## Scope

**Analyzes**: Sandwich attack exposure, slippage protection, deadline parameters, frontrunning vectors, flashloan attack surface, transaction ordering dependence, commit-reveal presence, backrunning opportunities, JIT liquidity attacks, timestamp manipulation, hardcoded zero slippage, oracle update front-running.

**Ignores**: Internal accounting bugs (Agent 6), fee analysis (Agent 3), access control (Agent 1). This agent focuses on transaction-level and mempool-level risks.

---

## Rules

### Impact Quantification
Every WARNING and CRITICAL finding MUST include a concrete impact estimate. "Users could lose funds" is insufficient. Quantify: How much can be lost per transaction? Per user? Is it bounded or unbounded?

### No-Finding Handling
If this agent's domain is not applicable to the codebase (e.g., a governance-only contract with no swaps, price-sensitive operations, or value transfers), return SAFE with a 1-sentence justification. Do not invent observations to fill space.

---

## Checks

### Check 1: Sandwich Attack Exposure on Swaps

**Grep patterns**:
```bash
rg -n 'swap|Swap|exchange' --type sol
rg -n 'ISwapRouter|IUniswapV2Router|IRouter' --type sol
```

**What to look for**:
- Does the protocol perform swaps on behalf of users?
- Standard sandwich: attacker buys before victim's swap, sells after — victim gets worse price.
- With concentrated liquidity: attacker manipulates active tick range so victim's swap crosses into range with no liquidity = massive slippage.

**Sandwich attack pattern table**:

| Victim Operation | Front-Run | Back-Run | Attacker Profit |
|-----------------|-----------|----------|----------------|
| User swaps A->B | Buy B (price up) | Sell B (price down) | Price impact delta |
| User adds liquidity | Swap to imbalance pool | Swap back | IL inflicted on victim |
| User deposits to vault | Inflate share price | Withdraw at inflated rate | Share dilution |

**Severity**: WARNING if swaps exist without user-controlled slippage. CRITICAL if router performs swaps with no slippage protection at all.

---

### Check 2: Slippage Protection Presence and Defaults

**Grep patterns**:
```bash
rg -n 'amountOutMin|minAmountOut|amountOutMinimum|minimumReceived' --type sol
rg -n 'sqrtPriceLimitX96' --type sol
rg -n 'slippage|maxSlippage|slippageTolerance' --type sol
```

**What to look for**:
- Is there a `minAmountOut` or `amountOutMinimum` parameter on swap functions?
- Is it passed through from user input or set by the contract?
- If set by the contract: what's the default? If 0 or very low = no protection.
- For Uniswap V3: is `sqrtPriceLimitX96` set to 0? (0 = no price limit = full sandwich)

**Severity**: CRITICAL if no slippage parameter exists. WARNING if default slippage is 0. INFO if slippage protection exists but is generous.

---

### Check 3: Deadline Parameters on Swaps

**Grep patterns**:
```bash
rg -n 'deadline|block\.timestamp' --type sol
rg -n 'require.*deadline|require.*block\.timestamp' --type sol
```

**What to look for**:
- Is there a deadline parameter on swaps/operations?
- `deadline = block.timestamp` provides ZERO protection — it always passes because the check happens in the same block.
- Missing deadline: transaction can sit in mempool indefinitely and be executed at an unfavorable price later.

**Vulnerable pattern**:
```solidity
// VULNERABLE: deadline is always current block — provides no protection
router.exactInputSingle(ISwapRouter.ExactInputSingleParams({
    ...
    deadline: block.timestamp,  // always passes
    amountOutMinimum: 0         // no slippage protection
}));
```

**Severity**: WARNING if `deadline = block.timestamp` or no deadline. INFO if deadline exists and is user-supplied.

---

### Check 4: Frontrunning Vulnerability on Price-Sensitive Operations

**Grep patterns**:
```bash
rg -n 'setPrice|updatePrice|submitPrice|notifyRewardAmount' --type sol
rg -n 'liquidat|Liquidat' --type sol
rg -n 'auction|bid|reveal' --type sol
```

**What to look for**:
- Can price-sensitive operations be front-run? (oracle updates, liquidations, auctions)
- For oracle updates: attacker sees pending update in mempool, trades at old price, oracle updates, attacker profits from delta.
- For liquidations: multiple liquidators compete — only one wins, others waste gas.
- For auctions: can bids be seen and outbid in the mempool?

**Severity**: WARNING if price-sensitive operations are frontrunnable with material profit. INFO if theoretical but impractical.

---

### Check 5: Flashloan Attack Surface

**Grep patterns**:
```bash
rg -n 'balanceOf\(address\(this\)\)' --type sol
rg -n 'slot0|getReserves' --type sol
rg -n 'totalAssets|totalSupply' --type sol
rg -n 'flashLoan|flash\(' --type sol
```

**What to look for**: Build a flash-accessible state inventory:

| State | Read By | Flash-Manipulable? | Manipulation Cost |
|-------|---------|-------------------|-------------------|
| `balanceOf(this)` | {functions} | YES (donation) | 0 |
| `totalSupply` | {functions} | YES if permissionless mint | Deposit amount |
| `getReserves()` | {functions} | YES (swap) | Slippage cost |
| Oracle spot price | {functions} | YES (trade on source) | Market depth |

- Can flash-borrowed funds inflate `balanceOf(address(this))`? → Share price manipulation.
- Can flash-borrowed funds manipulate spot price via `slot0()`/`getReserves()`?
- For share-based systems: `shares = deposit * totalShares / totalAssets` — if `totalShares = 1` and attacker donates to inflate `totalAssets`, new depositors get 0 shares.
- Flash loan fees: Aave 0.09%, dYdX 0%, Balancer 0% — assume essentially free.

**Flash loan attack variants**:
1. **Price manipulation**: Flash borrow -> swap to move price -> use inflated price in target protocol -> swap back
2. **Collateral inflation**: Flash borrow -> deposit as collateral -> borrow against inflated collateral -> repay flash loan
3. **First depositor**: Flash borrow -> deposit 1 wei -> donate large amount -> next depositor gets 0 shares
4. **Governance voting**: Flash borrow governance tokens -> vote -> return tokens

**Severity**: CRITICAL if flashloan-manipulable pricing used for critical logic (liquidations, exchange rates). WARNING if manipulation possible but bounded.

---

### Check 6: Transaction Ordering Dependence

**Grep patterns**:
```bash
rg -n 'nonce|sequence|order' --type sol
rg -n 'firstCome|fifo|queue' --type sol
```

**What to look for**:
- Does the outcome depend on transaction ordering? (first-come-first-served, race conditions)
- Can block producers reorder transactions to extract value?
- Are there state reads that become stale between submission and execution?

**Severity**: WARNING if ordering determines who receives value. INFO if ordering affects non-critical operations.

---

### Check 7: Commit-Reveal Schemes

**Grep patterns**:
```bash
rg -n 'commit|reveal|sealed|hidden|secret' --type sol
rg -n 'keccak256.*msg\.sender|hash.*bid' --type sol
```

**What to look for**:
- For auctions or bid-reveal processes: is there a commit-reveal scheme?
- If bids are visible in the mempool, competitors can see and outbid.
- Is the reveal phase time-bound? Can late reveals be exploited?
- Is the commit binding? (Can committer change their mind?)

**Severity**: WARNING if price-sensitive auction has no commit-reveal. INFO if commit-reveal exists but has minor issues.

---

### Check 8: Backrunning Opportunities

**Grep patterns**:
```bash
rg -n 'liquidat|arb|arbitrage|rebalance' --type sol
rg -n 'harvest|compound|poke' --type sol
```

**What to look for**:
- After liquidations, large swaps, or oracle updates: is there a profitable backrunning opportunity?
- Can keepers/bots extract value by executing immediately after a state change?
- Does the protocol have mechanisms to capture this value (e.g., MEV-aware liquidation auctions)?

**Severity**: INFO — backrunning is generally less harmful to users than sandwiching.

---

### Check 9: JIT Liquidity Attack Surface

**Grep patterns**:
```bash
rg -n 'addLiquidity|removeLiquidity|mint.*position' --type sol
rg -n 'concentrated|tick|position' --type sol
```

**What to look for**:
- Can liquidity be added and removed in the same block?
- JIT attack: attacker sees pending swap -> adds concentrated liquidity around the price -> earns fees from the swap -> removes liquidity. All in same block.
- Is there a minimum lock period for LP positions?
- Impact: existing LPs earn less because JIT captures the highest-fee trades.

**Severity**: WARNING if LP positions can be created and destroyed in same block with no minimum lock. INFO if JIT is possible but has natural costs.

---

### Check 10: Block.timestamp Manipulation Sensitivity

**Grep patterns**:
```bash
rg -n 'block\.timestamp' --type sol
rg -n 'now\b' --type sol
```

**What to look for**:
- Is `block.timestamp` used for time-sensitive logic? (unlock times, deadline checks, interest calculations)
- Block producers can manipulate timestamp by ~15 seconds (Ethereum) — is this enough to exploit?
- For most DeFi operations, 15 seconds of manipulation is NOT enough to be a finding.

**Severity**: INFO if timestamp used in time-sensitive logic but manipulation window is too small to exploit meaningfully.

---

### Check 11: Hardcoded Zero Slippage

**Grep patterns**:
```bash
rg -n 'amountOutMinimum\s*[:=]\s*0|amountOutMin\s*[:=]\s*0|minAmountOut\s*[:=]\s*0' --type sol
rg -n 'sqrtPriceLimitX96\s*[:=]\s*0' --type sol
rg -n 'slippage.*0|0.*slippage' --type sol
```

**What to look for**:
- `amountOutMinimum = 0` in ANY swap path = 100% sandwich-able.
- Router contracts that don't pass through user's slippage params are especially dangerous.
- Even if slippage is passed for one swap, compound swap paths may reset it to 0 in intermediate steps.

**Vulnerable pattern**:
```solidity
// VULNERABLE: hardcoded 0 slippage — attacker sandwiches for 100% of swap value
router.exactInputSingle(ISwapRouter.ExactInputSingleParams({
    tokenIn: tokenA,
    tokenOut: tokenB,
    fee: 3000,
    recipient: address(this),
    deadline: block.timestamp,
    amountIn: amount,
    amountOutMinimum: 0,  // CRITICAL: no slippage protection
    sqrtPriceLimitX96: 0  // CRITICAL: no price limit
}));
```

**Severity**: CRITICAL if hardcoded 0 in any swap path that handles user funds. WARNING if 0 slippage in admin/keeper paths.

---

### Check 12: Oracle Price Update Front-Running

**Grep patterns**:
```bash
rg -n 'updatePriceFeeds|updatePrice|submitAnswer' --type sol
rg -n 'pendingPrice|priceUpdate' --type sol
```

**What to look for**:
- Attacker sees pending oracle update in mempool -> trades at old price -> oracle updates -> profit from delta.
- For protocols that allow trading in the same block as oracle updates: this is exploitable.
- Pyth requires explicit `updatePriceFeeds()` — this is visible in the mempool.

**Severity**: WARNING if users can trade in the same block as visible oracle updates. INFO if oracle updates are automated/private.

---

## Severity Rules

| Level | Condition |
|-------|-----------|
| **CRITICAL** | No slippage protection on user swaps. Flashloan-manipulable pricing used for critical logic (liquidations, exchange rates). Hardcoded zero slippage (`amountOutMinimum = 0`) in swap paths handling user funds. |
| **WARNING** | Default 0 slippage (user can override but default is dangerous). No deadline or `deadline = block.timestamp`. Frontrunnable price-sensitive state changes. JIT liquidity exposure on user swaps. Same-block oracle update + trade possible. |
| **INFO** | Slippage protection exists but generous. Timestamp dependence (15s manipulation window). Backrunning opportunities. Commit-reveal present but minor issues. |
| **SAFE** | Proper user-controlled slippage on all swaps. User-supplied deadlines. TWAP oracles with adequate window. Commit-reveal where needed. Minimum LP lock periods. |

---
