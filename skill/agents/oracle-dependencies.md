# Oracle & External Dependencies

## Core Question
> "What external things can break this?"

## Scope

**Analyzes**: Oracle sources (Chainlink, Pyth, TWAP, spot), staleness checks, fallback oracles, zero/negative price handling, L2 sequencer checks, hardcoded addresses, external protocol dependencies, cross-contract trust assumptions, external registries, aggregator configuration.

**Ignores**: Internal contract logic (Agent 6), economic impact of price changes (Agent 3), MEV exploitation of oracle updates (Agent 5).

---

## Rules

### Impact Quantification
Every WARNING and CRITICAL finding MUST include a concrete impact estimate. "Users could lose funds" is insufficient. Quantify: How much can be lost per transaction? Per user? Is it bounded or unbounded?

### No-Finding Handling
If this agent's domain is not applicable to the codebase (e.g., a standalone token with no external data feeds or protocol integrations), return SAFE with a 1-sentence justification. Do not invent observations to fill space.

---

## Checks

### Check 1: Oracle Source Identification

**Grep patterns**:
```bash
rg -n 'slot0|getReserves|latestRoundData|latestAnswer' --type sol
rg -n 'getPrice|priceOracle|priceFeed|twap|TWAP|observe' --type sol
rg -n 'AggregatorV3|AggregatorInterface|IPyth|IChainlinkOracle' --type sol
```

**What to look for**: Build an oracle inventory:

| Oracle | Type | Source | Functions Called | Consumers | Heartbeat |
|--------|------|--------|-----------------|-----------|-----------|
| {name} | Chainlink/TWAP/Spot/Pyth | {contract} | {latestRoundData/observe} | {consumer functions} | {documented or UNKNOWN} |

Key question: What decisions does the protocol make based on this data? (pricing, liquidation, reward rate, rebase?)

**Spot price as oracle (CRITICAL pattern)**:
```solidity
// VULNERABLE: slot0 returns current tick — manipulable via flash loan + swap
(uint160 sqrtPriceX96,,,,,,) = pool.slot0();
uint256 price = (uint256(sqrtPriceX96) ** 2 * 1e18) >> 192;
```

```solidity
// VULNERABLE: reserves change with every swap in the same tx
(uint112 reserve0, uint112 reserve1,) = pair.getReserves();
return (uint256(reserve1) * 1e18) / uint256(reserve0);
```

**Severity**: CRITICAL if spot price (`slot0`, `getReserves`) used for value-critical calculations. INFO if oracle exists and type identified.

---

### Check 2: Staleness Checks on Price Feeds

**Grep patterns**:
```bash
rg -n 'updatedAt|stalePrice|heartbeat|sequencerUp' --type sol
rg -n 'latestRoundData' --type sol
rg -n 'block\.timestamp.*updatedAt|updatedAt.*block\.timestamp' --type sol
```

**What to look for**: For EACH oracle, verify the staleness analysis table:

| Check | Status |
|-------|--------|
| `updatedAt` checked? | YES/NO |
| Max staleness threshold enforced? | YES/NO |
| Threshold appropriate for the feed's heartbeat? | YES/NO |
| `answeredInRound >= roundId`? | YES/NO |
| `price > 0` validated? | YES/NO |
| `updatedAt != 0`? | YES/NO |

**Vulnerable pattern — no staleness check**:
```solidity
function getPrice() external view returns (uint256) {
    // VULNERABLE: no staleness check, no answer validation
    (, int256 answer,,,) = priceFeed.latestRoundData();
    return uint256(answer);
}
```

**Severity**: CRITICAL if no staleness check and price used for liquidations, collateral valuation, or swap amounts. WARNING if staleness check exists but threshold is too generous.

---

### Check 3: Fallback Oracle Presence

**Grep patterns**:
```bash
rg -n 'fallback.*oracle|secondary.*oracle|backup.*price|fallbackOracle' --type sol
rg -n 'try\s*{.*latestRoundData|catch' --type sol
```

**What to look for**:
- If the primary oracle fails (reverts, returns 0, goes stale), is there a fallback?
- If no fallback: what happens? Does the entire protocol freeze?
- If fallback exists: is the fallback itself properly validated (staleness, zero price)?
- Multi-oracle disagreement: if two oracles disagree significantly, which one wins?

**Severity**: CRITICAL if no fallback and single oracle failure freezes the protocol. WARNING if single oracle source with no fallback but protocol doesn't freeze.

---

### Check 4: Zero/Negative Price Handling

**Grep patterns**:
```bash
rg -n 'answer\s*>|answer\s*>=|price\s*>|price\s*>=' --type sol
rg -n 'int256.*answer|int.*price' --type sol
```

**What to look for**:
- Chainlink returns `int256` — is it validated to be positive before casting to `uint256`?
- What happens if `answer == 0`? (Chainlink returns 0 during feed malfunction)
- Negative price cast to `uint256` wraps to a very large number — catastrophic for calculations.

**Vulnerable pattern**:
```solidity
(, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
require(block.timestamp - updatedAt < 3600, "Stale");
// VULNERABLE: answer could be 0 or negative
return uint256(answer);
```

**Severity**: CRITICAL if zero/negative price not validated and used in value-critical calculations.

---

### Check 5: L2 Sequencer Uptime Checks

**Grep patterns**:
```bash
rg -n 'sequencer|SequencerUptimeFeed|isSequencerUp' --type sol
rg -n 'Arbitrum|Optimism|L2|layer2' --type sol
rg -n 'GRACE_PERIOD|gracePeriod' --type sol
```

**What to look for**:
- On L2 chains (Arbitrum, Optimism): when the sequencer goes down, prices go stale but `updatedAt` appears recent when the feed resumes.
- Is there a sequencer uptime feed check?
- Is there a grace period after sequencer restart? (Users need time to adjust positions)

**Vulnerable pattern**:
```solidity
// On Arbitrum — no sequencer check
function getPrice() external view returns (uint256) {
    (, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
    require(block.timestamp - updatedAt < 3600, "Stale");
    require(answer > 0, "Bad price");
    // VULNERABLE on L2: sequencer downtime makes prices unreliable
    return uint256(answer);
}
```

**Severity**: WARNING if deployed on L2 without sequencer check. INFO if L1 only.

---

### Check 6: Hardcoded External Addresses

**Grep patterns**:
```bash
rg -n '0x[a-fA-F0-9]{40}' --type sol
rg -n 'constant.*address|immutable.*address' --type sol
```

**What to look for**:
- Are external contract addresses (oracles, DEXes, bridges) hardcoded?
- If the external contract is upgraded, migrated, or deprecated, the protocol breaks silently.
- Is there a way to update these addresses? Is the update function access-controlled?

**Severity**: WARNING if critical dependency addresses are hardcoded with no update path. INFO if hardcoded but pointing to immutable contracts.

---

### Check 7: Dependency on Specific Protocol Versions

**Grep patterns**:
```bash
rg -n 'IUniswapV2|IUniswapV3|ICurve|IAave|ICompound|ILido' --type sol
rg -n 'import.*uniswap|import.*aave|import.*compound|import.*lido' --type sol
```

**What to look for**:
- Version-specific gotchas:
  - **Uniswap V3**: `slot0` is manipulable (use TWAP `observe()` instead)
  - **Curve**: `get_virtual_price` can be reentered via ETH pool — read-only reentrancy
  - **Aave V3**: `getReserveData` struct layout changed from V2
  - **Compound V3 (Comet)**: Different interface from V2, `borrowBalanceOf` vs `borrowBalanceCurrent`
  - **Lido**: `stETH.balanceOf` changes on rebase — use `wstETH` instead
  - **OpenZeppelin V4 -> V5**: Breaking changes in import paths, `Ownable` constructor, `ERC20` hooks

**Severity**: WARNING if using known-vulnerable version-specific patterns. INFO if using specific version with correct patterns.

---

### Check 8: Cross-Contract Call Trust Assumptions

**Grep patterns**:
```bash
rg -n '\.call\{|\.staticcall\(|\.delegatecall\(' --type sol
rg -n 'interface\s+I\w+' --type sol
```

**What to look for**:
- When calling external contracts, what trust assumptions are being made?
- Is the return value validated?
- Can the external contract revert and block the caller? (DoS via external dependency)
- Is the external contract address user-supplied or protocol-controlled?
- Can external calls return stale or manipulated data?

**Severity**: WARNING if external contract failure blocks critical protocol functionality. INFO if external calls have proper error handling.

---

### Check 9: Token Whitelist/Blacklist Dependency on External Registries

**Grep patterns**:
```bash
rg -n 'registry|Registry|isApproved|isWhitelisted|tokenList' --type sol
rg -n 'onlyApprovedToken|validToken|supportedToken' --type sol
```

**What to look for**:
- Does the protocol depend on an external registry to determine which tokens are allowed?
- If the registry is compromised or deprecated, what happens?
- Can registry changes retroactively affect existing positions?

**Severity**: WARNING if external registry failure blocks withdrawals. INFO if registry dependency is for new deposits only.

---

### Check 10: Chainlink Aggregator Configuration

**Grep patterns**:
```bash
rg -n 'heartbeat|HEARTBEAT|maxStaleness|MAX_STALENESS' --type sol
rg -n 'decimals\(\)|priceFeed\.decimals' --type sol
rg -n '3600|7200|86400|ONE_HOUR|ONE_DAY' --type sol
```

**What to look for**:
- Is the staleness threshold configured to match the feed's actual heartbeat? (ETH/USD heartbeat is 3600s on mainnet, but varies by chain and pair)
- Is `decimals()` queried dynamically or hardcoded? (Feeds can change decimals on upgrade — rare but possible)
- Multi-hop price calculations: if Price A is USD/ETH (8 dec) and Price B is ETH/TOKEN (18 dec), is the combined calculation correct?

**Pyth-specific**: Pyth prices require explicit `updatePriceFeeds()` call before reading — if protocol reads without updating, price may be arbitrarily stale.

**Wrong feed for derivative assets**: Using BTC feed for WBTC, ETH feed for stETH, USD feed for USDT — all have depeg risk. Each asset needs its OWN price feed.

**Severity**: WARNING if heartbeat mismatch or decimal hardcoding. INFO if minor configuration concern.

---

## Severity Rules

| Level | Condition |
|-------|-----------|
| **CRITICAL** | No oracle staleness check on price used for liquidations/swaps. Spot price (`slot0`, `getReserves`) used for critical calculations. No fallback and single oracle failure freezes protocol. Zero/negative price not validated. |
| **WARNING** | Single oracle source with no fallback. Missing L2 sequencer check. Hardcoded critical dependency addresses. Version-specific gotchas in use. Heartbeat mismatch. Wrong feed for derivative asset. |
| **INFO** | TWAP with short window (<30 min). External dependency on audited protocols. Minor decimal handling. Pyth price feed without update reminder. |
| **SAFE** | Multiple oracles with fallback. Proper staleness checks matching heartbeats. Zero/negative validation. L2 sequencer check with grace period. Dynamic decimal handling. |

---
