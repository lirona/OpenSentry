# Code Quality & Vulnerability

## Core Question
> "Is there a bug that could lose funds?"

## Scope

**Analyzes**: Reentrancy, unchecked return values, integer overflow, unsafe casts, delegatecall, storage collisions, tx.origin, selfdestruct, uninitialized storage, precision loss, share inflation, DoS vectors, signature replay, msg.value reuse, abi.encodePacked collisions, coupled state desync.

**Ignores**: Access control analysis (Agent 1), economic design (Agent 3), oracle issues (Agent 4), MEV (Agent 5), transparency (Agent 7), governance (Agent 8). This agent focuses purely on code-level bugs.

---

## Rules

### Impact Quantification
Every WARNING and CRITICAL finding MUST include a concrete impact estimate. "Users could lose funds" is insufficient. Quantify: How much can be lost per transaction? Per user? Is it bounded or unbounded?

### No-Finding Handling
If this agent's domain is not applicable to the codebase, return SAFE with a 1-sentence justification. Do not invent observations to fill space.

---

## Checks

### Check 1: Reentrancy

**Grep patterns**:
```bash
rg -n '\.call\{value|\.call\{.*value' --type sol
rg -n '\.transfer\(|\.send\(' --type sol
rg -n 'safeTransfer|safeTransferFrom' --type sol
rg -n 'onERC721Received|onERC1155Received|tokensReceived|onFlashLoan' --type sol
rg -n 'nonReentrant|ReentrancyGuard' --type sol
```

**Reentrancy requires ALL of**: (1) external call, (2) state read/written AFTER call returns, (3) no reentrancy guard, (4) attacker controls call target.

**5 variants**:

1. **Single-function**: Function calls out, attacker re-enters the SAME function before state updates.
```solidity
// VULNERABLE: state update after external call
function withdraw(uint256 amount) external {
    require(balances[msg.sender] >= amount);
    (bool ok,) = msg.sender.call{value: amount}(""); // attacker re-enters here
    require(ok);
    balances[msg.sender] -= amount; // not yet reached during re-entry
}
```

2. **Cross-function**: Function A calls out, attacker re-enters function B which reads stale state.

3. **Cross-contract**: Contract X calls out, attacker re-enters contract Y which reads stale state in X via public getter.

4. **Read-only**: View function returns stale value during callback — downstream contract uses stale return value.

5. **Callback reentrancy**: ERC-721 `onERC721Received`, ERC-1155 `onERC1155Received`, ERC-777 `tokensReceived` — automatically invoked during transfers.

**FP conditions**: `nonReentrant` on function. Authorization enforced in calling function. `transfer()`/`send()` with 2300 gas limit (insufficient for reentrancy in most cases). Internal/private function only called from guarded externals.

**Severity**: CRITICAL if exploitable reentrancy allows fund drain. WARNING if missing `nonReentrant` on state-changing externals with external calls.

---

### Check 2: Unchecked External Call Return Values

**Grep patterns**:
```bash
rg -n '\.call\(|\.call\{' --type sol
rg -n '\.send\(' --type sol
rg -n '\.delegatecall\(' --type sol
rg -n 'IERC20\(.*\)\.transfer\b' --type sol
```

**What to look for**:
- `.call{value: ...}("")` return value not checked — ETH transfer silently fails.
- `.send()` returns bool but often ignored — ETH not delivered but state proceeds.
- Bare `IERC20.transfer()` without SafeERC20 — USDT returns void, reverts on bare call.
- `.delegatecall` result not checked — delegatecall failure is silent.

**Severity**: CRITICAL if unchecked return allows fund loss (e.g., ETH not delivered but balance decremented). WARNING if unchecked return on non-critical path.

---

### Check 3: Integer Overflow in Unchecked Blocks

**Grep patterns**:
```bash
rg -n 'unchecked\s*\{' --type sol
```

**What to look for**:
- Solidity 0.8+ reverts on overflow by default, but `unchecked {}` blocks bypass this.
- Is the arithmetic inside `unchecked` on user-controlled or unbounded values?
- Is overflow intentional (e.g., counter wrapping, gas optimization) or a bug?
- Check: can the values inside `unchecked` actually overflow given the constraints?

**Severity**: CRITICAL if overflow can be triggered with user-controlled input and affects balances. WARNING if overflow theoretically possible but bounded.

---

### Check 4: Unsafe Type Casts

**Grep patterns**:
```bash
rg -n 'uint128\(|uint96\(|uint64\(|uint32\(|uint16\(|uint8\(|int128\(' --type sol
```

**What to look for**:
- Solidity 0.8+ downcasts (e.g., `uint128(someUint256)`) silently truncate WITHOUT reverting.
- Can the source value exceed the target type's max? (e.g., `uint256` value > `type(uint128).max`)
- Is the value user-controlled or bounded by prior checks?
- Use `SafeCast` library for safe downcasting.

**Severity**: WARNING if downcast of unbounded/user-controlled value. INFO if value is bounded by prior checks.

---

### Check 5: Delegatecall to Untrusted Targets

**Grep patterns**:
```bash
rg -n 'delegatecall|callcode' --type sol
```

**What to look for**:
- Is the delegatecall target address controlled by user input?
- Delegatecall executes target code in caller's storage context — malicious target overwrites any storage.
- Even `staticcall` followed by `delegatecall` with the same target is dangerous if the target changes between calls.

**Severity**: CRITICAL if delegatecall target is user-supplied or controllable. WARNING if target is admin-set without timelock.

---

### Check 6: Storage Collision in Proxy Patterns

**Grep patterns**:
```bash
rg -n 'delegatecall|_implementation|_getImplementation' --type sol
rg -n '__gap|storage gap' --type sol
rg -n 'ERC1967|TransparentUpgradeableProxy|UUPSUpgradeable' --type sol
```

**What to look for**:
- Does proxy use ERC-1967 reserved slots? Custom slots may collide with implementation variables.
- Missing `__gap` in base contracts — adding new state in upgrade shifts ALL child storage.
- Assembly `sstore(0, ...)` in implementation overwrites proxy's `_implementation` slot.

**Severity**: CRITICAL if storage collision corrupts proxy state or balances. WARNING if missing `__gap` in upgradeable base.

---

### Check 7: tx.origin Usage for Auth

**Grep patterns**:
```bash
rg -n 'tx\.origin' --type sol
```

**What to look for**:
- `tx.origin` used for authorization — phishable via intermediary contract.
- Attacker deploys contract that calls target function — `tx.origin` is the victim, `msg.sender` is the attacker's contract.
- `tx.origin == msg.sender` check (ensuring no intermediary) is a different pattern — less dangerous but still blocks legitimate contract interactions.

**Severity**: WARNING if `tx.origin` used for authorization. INFO if `tx.origin == msg.sender` used as contract-call prevention.

---

### Check 8: Selfdestruct Exposure

**Grep patterns**:
```bash
rg -n 'selfdestruct|SELFDESTRUCT' --type sol
```

**What to look for**: See Agent 1 Check 10. In code quality context: can `selfdestruct` be triggered to forcefully send ETH to a contract that doesn't expect it? This can break `address(this).balance` accounting.

**Severity**: CRITICAL on proxy implementation. WARNING if present with access control.

---

### Check 9: Uninitialized Storage/Variables

**Grep patterns**:
```bash
rg -n 'storage\s+\w+;' --type sol
rg -n 'delete\s|mapping.*delete' --type sol
```

**What to look for**:
- Uninitialized storage pointers in old Solidity (< 0.5.0) — point to slot 0 by default.
- `delete` on mapping elements leaving orphaned references in related data structures.
- State read before first write — returns 0, not a sentinel value.

**Severity**: CRITICAL if uninitialized state allows unauthorized access. WARNING if deletion leaves inconsistent state.

---

### Check 10: Division Before Multiplication (Precision Loss)

**Grep patterns**:
```bash
rg -n '/\s' --type sol
rg -n 'mulDiv|FullMath|WAD|RAY|1e18|1e27' --type sol
rg -n 'decimals\(\)' --type sol
```

**What to look for**:
- `a / b * c` loses the remainder of `a / b` — should be `a * c / b`.
- Decimal mismatch: token A has 6 decimals (USDC), token B has 18 (DAI) — 1e12 scaling error.
- Missing `mulDiv` for intermediate products that exceed `uint256`.

**Severity**: WARNING if precision loss is material (>$1 per operation). INFO if dust-level.

---

### Check 11: First Depositor / Share Inflation Attacks

**Grep patterns**:
```bash
rg -n 'totalAssets|convertToShares|convertToAssets' --type sol
rg -n '_decimalsOffset' --type sol
rg -n 'totalSupply.*==.*0|totalShares.*==.*0' --type sol
```

**What to look for**:
- When `totalSupply == 0`: first depositor deposits 1 wei, donates large amount, next depositor gets 0 shares.
- Defense: virtual shares (`_decimalsOffset`), dead shares (burn minimum shares), minimum deposit enforcement.
- Check: `shares = deposit * totalShares / totalAssets` — when `totalShares = 1` and `totalAssets` is inflated, result rounds to 0.

**Severity**: CRITICAL if no inflation defense (no virtual/dead shares, no minimum deposit). WARNING if partial defense.

---

### Check 12: Denial of Service Vectors

**Grep patterns**:
```bash
rg -n 'for\s*\(|while\s*\(' --type sol
rg -n '\.length' --type sol
rg -n 'push\(' --type sol
```

**What to look for**:
- **Unbounded loops**: Iterating over arrays that grow without bound — OOG revert when array is large.
- **External call revert blocks batch**: If one transfer in a loop reverts, the entire batch fails — single malicious recipient blocks all withdrawals.
- **Push without pop**: Arrays that grow via `push()` but are never trimmed — gas cost grows indefinitely.

**Severity**: CRITICAL if DoS permanently bricks a core function (settlement, liquidation, withdrawal). WARNING if DoS is temporary or requires specific conditions.

---

### Check 13: Signature Replay

**Grep patterns**:
```bash
rg -n 'ecrecover|ECDSA\.recover|SignatureChecker' --type sol
rg -n 'chainId|block\.chainid|DOMAIN_SEPARATOR' --type sol
rg -n 'nonces?\[|nonce\+\+|_useNonce' --type sol
rg -n 'EIP712|_hashTypedDataV4|_domainSeparatorV4' --type sol
```

**What to look for**:

| Check | Missing = Vulnerability |
|-------|------------------------|
| Nonce in signed payload | Same signature replayable N times |
| `block.chainid` in hash | Signature valid on all EVM chains |
| `address(this)` in hash | Signature valid on any contract |
| `deadline` in hash | Signature usable indefinitely |
| `ecrecover` zero-address check | Invalid sig returns `address(0)`, may match unset signer |
| Malleability prevention | Complementary `s` value produces second valid signature |

**Vulnerable pattern — missing nonce**:
```solidity
function executeWithSig(address to, uint256 amount, bytes memory signature) external {
    bytes32 hash = keccak256(abi.encodePacked(to, amount));
    address signer = ECDSA.recover(hash, signature);
    require(signer == authorizedSigner, "Invalid sig");
    token.transfer(to, amount); // replayed on every call with same sig
}
```

**Severity**: CRITICAL if replay enables fund theft. WARNING if replay has limited impact.

---

### Check 14: msg.value Reuse in Loops

**Grep patterns**:
```bash
rg -n 'msg\.value' --type sol
rg -n 'for\s*\(' --type sol
```

**What to look for**:
- `msg.value` is constant for the entire transaction. If checked per iteration in a loop, caller spends the same ETH multiple times.
- Example: loop iterates 3 times, each checking `require(msg.value >= price)` — user pays `price` once but gets 3 items.

**Severity**: CRITICAL if msg.value reuse in loop allows spending ETH multiple times. WARNING if msg.value used in loop but bounded.

---

### Check 15: Hash Collision with abi.encodePacked

**Grep patterns**:
```bash
rg -n 'abi\.encodePacked' --type sol
```

**What to look for**:
- Two adjacent dynamic-type arguments (`string`, `bytes`) produce identical packed encoding for different inputs.
- Example: `abi.encodePacked("ab", "c")` == `abi.encodePacked("a", "bc")` — both produce `"abc"`.
- If used as a uniqueness key (mapping key, hash for signature, Merkle leaf), collisions enable bypass.
- Fix: use `abi.encode` instead, which length-prefixes dynamic types.

**Severity**: WARNING if `abi.encodePacked` with adjacent dynamic types used as uniqueness key. INFO if used for non-critical purposes.

---

### Check 16: Coupled State Desync

**Grep patterns**:
```bash
rg -n 'totalSupply|totalShares|totalDebt|totalAssets' --type sol
rg -n 'balances\[|shares\[|userDebt\[' --type sol
```

**What to look for**: Identify state variable pairs that MUST stay in sync:
- `totalSupply` and sum of `balances[]`
- `totalDebt` and sum of `userDebt[]`
- `totalShares` and sum of `shares[]`

For each pair:
- Does every function that writes one also write the other?
- If a function updates one but not the other, is this intentional (documented) or a bug?
- Cross-reference all writing functions — asymmetric updates = finding.

**Severity**: CRITICAL if desync enables fund loss (e.g., `totalSupply` decremented but individual balance not, enabling over-withdrawal). WARNING if asymmetric update without documentation.

---

## Severity Rules

| Level | Condition |
|-------|-----------|
| **CRITICAL** | Exploitable reentrancy draining funds. Unchecked return value causing fund loss. Storage collision corrupting balances. Signature replay enabling theft. msg.value reuse in loops. Coupled state desync enabling over-withdrawal. First depositor inflation with no defense. |
| **WARNING** | Missing `nonReentrant` on state-changing externals with calls. Unsafe downcasts on unbounded values. Precision loss >$1/operation. `abi.encodePacked` with dynamic types as key. Asymmetric coupled state update. Unbounded loops on user-growing arrays. |
| **INFO** | Minor gas optimizations. Style issues. Bounded precision loss (dust). `tx.origin == msg.sender` check. |
| **SAFE** | CEI pattern followed consistently. SafeERC20 used for all token interactions. Proper guards on all external calls. EIP-712 with nonces. Virtual shares defense. Bounded loops. |
