# Governance & Centralization

## Core Question
> "How decentralized is this really?"

## Scope

**Analyzes**: Governance token concentration, voting mechanisms, proposal thresholds, quorum requirements, timelocks, multisig adequacy, emergency powers, upgrade authority, treasury control, key person risk, governance attack vectors.

**Ignores**: Code-level bugs (Agent 6), access control on non-governance functions (Agent 1), economic analysis (Agent 3). This agent focuses on the governance structure and centralization risk.

---

## Rules

### Impact Quantification
Every WARNING and CRITICAL finding MUST include a concrete impact estimate. "Users could lose funds" is insufficient. Quantify: How much can be lost per transaction? Per user? Is it bounded or unbounded?

### No-Finding Handling
If this agent's domain is not applicable to the codebase (e.g., a simple token contract with a single owner and no governance), return SAFE with a 1-sentence justification. Still check centralization (single owner = INFO/WARNING). Do not invent observations to fill space.

---

## Checks

### Check 1: Governance Token Concentration

**Grep patterns**:
```bash
rg -n 'totalSupply|balanceOf|getVotes' --type sol
rg -n 'mint.*onlyOwner|_mint.*only' --type sol
```

**What to look for**:
- Can the governance token be minted by admin? If so, admin can dilute all holders and take control.
- Is governance token supply capped?
- Is there a snapshot mechanism to prevent flash-loan voting?

**Voting power source analysis**:

| Source | Mechanism | Snapshot? | Flash-Loan Resistant? |
|--------|-----------|-----------|----------------------|
| Token balance | `balanceOf(voter)` | YES/NO | NO if no snapshot |
| Delegation | `getVotes(delegate)` | YES/NO | Depends on checkpoint |
| NFT-based | `ownerOf(tokenId)` | YES/NO | N/A |
| Staking | `stakedBalance(voter)` | YES/NO | Depends |

If no snapshot: flash-loan voting is possible — borrow tokens, vote, return in same tx.

**Severity**: WARNING if admin can mint unlimited governance tokens. INFO if concentration exists but with mitigations.

---

### Check 2: Voting Mechanism

**Grep patterns**:
```bash
rg -n 'vote\(|castVote|submitVote' --type sol
rg -n 'snapshot|Snapshot|checkpoints|_checkpoints' --type sol
rg -n 'delegate|delegateBySig' --type sol
```

**What to look for**:
- Is voting on-chain or off-chain (Snapshot)?
- If on-chain: is voting power snapshot-based? (prevents flash-loan attacks)
- Can votes be changed after casting?
- Can proposals be created, voted on, and executed in the same block?

**Advanced vectors**:
- **Flash-loaned delegation**: Attacker flash-loans tokens -> delegates to self -> votes -> undelegates -> returns. Works if no snapshot.
- **Self-delegation doubling**: If delegating to self counts as both holder AND delegate voting power = 2x votes.
- **Same-block deposit-vote-withdraw**: Deposit to get tokens, vote (snapshot not yet updated), withdraw. Does deposit update voting power in same block?

**Severity**: WARNING if no snapshot mechanism (flash-loan voting possible). INFO if off-chain governance (centralized but transparent).

---

### Check 3: Proposal Threshold

**Grep patterns**:
```bash
rg -n 'proposalThreshold|propose\(' --type sol
rg -n 'require.*getVotes|require.*balanceOf.*propose' --type sol
```

**What to look for**:
- What percentage of total supply is needed to create a proposal?
- Can regular users propose, or is it restricted to large holders/admin?
- Very high threshold = only whales participate. Very low threshold = spam proposals.

**Severity**: INFO — informational for users to understand governance accessibility.

---

### Check 4: Quorum Requirements

**Grep patterns**:
```bash
rg -n 'quorum|_quorum|quorumNumerator|quorumDenominator' --type sol
rg -n 'quorumVotes|QUORUM' --type sol
```

**What to look for**:
- What is the quorum? Is it reachable given current token distribution?
- Is quorum a percentage of total supply or a fixed number?
- Edge cases:
  - `totalSupply == 0`: quorum = 0, any proposal passes with 0 votes.
  - Very low participation: is there a minimum absolute quorum?
  - Can quorum be changed while proposals are active?
- **Quorum racing**: If quorum is from live supply (not snapshot), attacker can mint/burn to manipulate threshold mid-vote.
- **Phantom voting power**: If burned/inaccessible tokens retain voting power in `totalSupply`, quorum becomes harder to reach — potential governance DoS.

**Severity**: WARNING if quorum issues enable governance attacks. INFO if quorum is reachable but high.

---

### Check 5: Timelock on Governance Actions

**Grep patterns**:
```bash
rg -n 'timelock|TimeLock|delay|MIN_DELAY|TIMELOCK|TimelockController' --type sol
rg -n 'queue|execute.*after|eta|executionTime' --type sol
rg -n 'cancel\(' --type sol
```

**What to look for**:
- Is there a timelock between proposal passing and execution?
- Timelock duration — meaningful? (1 hour is nearly useless; 48+ hours gives users time to exit)
- **Timelock collision**: If timelock uses `keccak256(target, value, data)` as key, identical proposals collide — second overwrites first.
- **Cancellation front-running**: Attacker sees proposal about to pass -> front-runs with cancel tx. Who can cancel? When?
- **Proposal executable before voting ends**: If `execute()` checks `state == Succeeded` but state transitions at `block.number >= endBlock` and execution is in same block = race condition.

**Severity**: CRITICAL if no timelock on governance actions that move funds. WARNING if short timelock (<24h) or timelock collision possible.

---

### Check 6: Multisig Threshold Adequacy

**Grep patterns**:
```bash
rg -n 'multisig|MultiSig|Safe|GnosisSafe|threshold' --type sol
rg -n 'confirmTransaction|submitTransaction|executeTransaction' --type sol
rg -n 'owners|signers|required' --type sol
```

**What to look for**:
- What is the multisig threshold? (e.g., 2-of-3, 4-of-7)
- 2-of-3 is weak — compromise of 2 keys = full control.
- 4-of-7 or higher is more robust.
- Are signers diversified? (same org = single point of failure)
- Is the multisig the ONLY admin, or can it be bypassed?

**Severity**: WARNING if low threshold (2-of-3 or less). INFO if multisig exists with adequate threshold. SAFE if 4-of-7 or higher.

---

### Check 7: Emergency Powers

**Grep patterns**:
```bash
rg -n 'emergency|Emergency|EMERGENCY' --type sol
rg -n 'guardian|Guardian|GUARDIAN' --type sol
rg -n 'pause|freeze|shutdown|kill' --type sol
```

**What to look for**:
- Who has emergency powers? (guardian, admin, multisig?)
- What can emergency powers do? (pause, freeze funds, change parameters, drain treasury?)
- Are emergency powers bounded? (auto-expire after X time, limited to specific operations?)
- Can emergency powers bypass the timelock?
- Can emergency powers be irrevocable? (permanent pause)

**Severity**: WARNING if emergency powers can drain funds or permanently freeze contracts. INFO if emergency powers are bounded and transparent.

---

### Check 8: Upgrade Authority

**Grep patterns**:
```bash
rg -n 'upgradeTo|upgradeToAndCall|_authorizeUpgrade' --type sol
rg -n 'admin|governance|owner.*upgrade' --type sol
```

**What to look for**:
- Who controls upgrades? Single admin or governance?
- Is there a timelock on upgrades?
- Can upgrades be performed without user notification?
- Upgrade via governance vote is more decentralized than admin key.

**Severity**: CRITICAL if single EOA can upgrade with no timelock. WARNING if governance-controlled but short timelock. INFO if proper governance with meaningful timelock.

---

### Check 9: Treasury Control

**Grep patterns**:
```bash
rg -n 'treasury|Treasury|TREASURY' --type sol
rg -n 'withdraw.*treasury|transfer.*treasury|send.*treasury' --type sol
rg -n 'protocolFund|communityFund|dao.*fund' --type sol
```

**What to look for**:
- Who controls the protocol treasury? (single admin, multisig, governance?)
- Can treasury funds be withdrawn without governance approval?
- Is there a spending limit or timelock on treasury operations?
- What percentage of protocol fees go to treasury vs what's the total value controlled?

**Severity**: CRITICAL if single EOA can drain treasury. WARNING if treasury controlled by low-threshold multisig. INFO if governance-controlled with timelock.

---

### Check 10: Key Person Risk

**Grep patterns**:
```bash
rg -n 'owner\(\)|_owner|admin\b' --type sol
rg -n 'transferOwnership|renounceOwnership' --type sol
rg -n 'grantRole|revokeRole|renounceRole' --type sol
```

**What to look for**:
- Is there a single address that controls all critical functions?
- If that key is compromised or lost, what breaks?
- Can ownership be renounced? Would renouncing break the protocol?
- How many different roles exist? Can one entity hold all of them?
- **Delegation griefing**: Can a delegatee prevent the delegator from re-delegating? (gas exhaustion via checkpoint accumulation)
- **Voting dust inflation**: Creating many tiny governance positions to grief redelegate operations.

**Severity**: CRITICAL if single EOA controls everything with no succession plan. WARNING if moderate centralization with some mitigations. INFO if minor centralization concerns.

---

## Severity Rules

| Level | Condition |
|-------|-----------|
| **CRITICAL** | Single EOA controls everything (funds, upgrades, parameters) with no timelock. Can drain treasury. No governance mechanism at all on high-value protocol. |
| **WARNING** | Low multisig threshold (2-of-3). Governance token admin-mintable (dilution). Short timelock (<24h). Emergency powers can permanently freeze. Flash-loan voting possible (no snapshot). Timelock collision. |
| **INFO** | Off-chain governance (Snapshot). Moderate centralization with multisig. High proposal threshold. Quorum concerns. Minor key person risk. |
| **SAFE** | Proper DAO structure with on-chain voting. Adequate multisig threshold (4-of-7+). Meaningful timelock (48h+). Snapshot-based voting power. Bounded emergency powers. Treasury controlled by governance. |