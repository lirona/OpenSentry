# OpenSentry

**User-facing smart contract risk analyzer**

OpenSentry answers one question: **"Is this contract safe for a regular user to interact with?"**

Unlike deep auditing tools (which target security researchers), OpenSentry produces plain-language risk assessments that help regular users make informed decisions about interacting with smart contracts.

## How It Works

8 specialized analysis agents run in parallel, each examining the codebase from a different angle:

| # | Agent | Question |
|---|-------|----------|
| 1 | Access Control | Who has power and what can they change? |
| 2 | Token Mechanics | Will this token behave as expected? |
| 3 | Economic & Fees | What are the obvious and hidden costs? |
| 4 | Oracle & Dependencies | What external things can break this? |
| 5 | MEV & Tx Safety | Can transactions be exploited in the mempool? |
| 6 | Code Quality | Are there bugs that could lose funds? |
| 7 | Transparency | Can the user verify what they're interacting with? |
| 8 | Governance | How decentralized is this really? |

Results are merged, deduplicated by root cause, and cross-checked for consistency.

## Severity Scale

| Level | Meaning |
|-------|---------|
| SAFE | No concerns found |
| INFO | No risk, but tradeoffs to be aware of |
| WARNING | Meaningful risk that could cost money or control |
| CRITICAL | Strong indicators of malicious intent or severe vulnerability |

## Key Design Principles

- **User-facing**: Findings are explained in plain language before technical detail
- **Parallel**: All 8 agents run simultaneously for speed
- **Deduplicated**: Same root cause flagged by multiple agents = single finding
- **Evidence-based**: Every finding must cite a specific `file.sol:line`
- **Conservative**: False positives are actively prevented via mitigation verification, impact quantification, and anti-hallucination rules
- **Quantified**: Every WARNING/CRITICAL includes a concrete impact estimate

## Agent Architecture

Each agent is defined in `agents/<name>.md` and follows the same methodology. To keep agent files DRY and maintainable:

- **`shared-rules.md`** — Contains the shared audit methodology that all agents follow:
  - Evidence Requirement, Anti-Hallucination, False Positive Prevention, Call-Chain Tracing, Mitigation Verification, Grep-First Mandate, Finding Cap
  - JSON Output Format schema
  
  These rules are injected into every agent at build time by `scripts/embed-skills.js`.

- **`agents/<name>.md`** — Each agent defines:
  - Core Question and Scope (unique per agent)
  - Agent-specific rules (Impact Quantification, No-Finding Handling)
  - Checks (specific patterns to grep, vulnerabilities to detect)
  - Severity Rules (what constitutes CRITICAL/WARNING/INFO/SAFE for this domain)
  
  The shared rules are automatically prepended to the Rules section during the build.