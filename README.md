# OpenSentry

**OpenSentry is a free, open-source wallet safety and smart contract risk analysis tool for non-technical users.**

OpenSentry analyzes smart contracts the way a professional auditor would and delivers the findings in plain language at the moment of signing. The goal is not only to detect vulnerabilities, but also to surface protocol features that may be intentional yet still create meaningful user risk or hidden trust assumptions that users should understand before interacting with a protocol.

Example warnings produced by the prototype include:

> *"Platform fee is not constrained, so a 100% fee is allowed."*
>
> *"Reserved balances can be locked indefinitely because there is no timeout or user-controlled unlock path."*

**OpenSentry is free, open source, and built as a public good.**

---

## How It Works

OpenSentry's analysis pipeline, used by both local CLI and API-backed flows, can ingest one or more contracts, compile them through a Solidity facts extraction stage built on `solc` AST output, and analyze them through a set of specialized security analysis agents.

The compiler-backed stage deterministically extracts a normalized, queryable representation of contract structure and behavior, including privileged roles, mutable parameters, fee configuration and caps, upgrade paths, token features, external dependencies, and user exit conditions. It also derives a small set of high-confidence deterministic findings for clearly detectable user risks, such as uncapped configurable fees, direct privileged upgrade paths with no timelock, or admin-controlled withdrawal-blocking paths.

These compiler-derived facts and deterministic findings are supplied to downstream agents as trusted context, while the raw contract source remains separately handled as untrusted input, so the analysis is grounded not only in source text but also in normalized compiler-backed evidence.

The security analysis agents produce structured findings across access control and upgradeability, code-level vulnerabilities, token mechanics, oracle and external dependency risks, MEV and transaction safety, economic and fee risks, governance and centralization risks, and transparency and verification issues. An orchestration layer then merges these results into a plain-language risk report for non-technical users.

**Supported chains:** Ethereum, Base, Arbitrum, Optimism, Polygon

---

## Local Development Setup

### Prerequisites

- Node.js >= 18
- npm

### 1. Clone and install

```bash
git clone <repo-url> && cd OpenSentry
npm install
```

### 2. Configure environment variables

```bash
cp .dev.vars.example .dev.vars
```

OpenSentry does not ship with shared provider credentials.

If you want to run the project, you must use your own model-provider setup:

- For API-backed providers such as `gemini`, `claude`, and `codex`, set your own `AI_API_KEY`.
- For local CLI-backed providers such as `codex-cli` and `claude-cli`, use your own local CLI installation and authenticated session, without having to set `AI_API_KEY`.
- The cloud CLI tool follows the API-backed setup and still requires `AI_API_KEY`.


Edit `.dev.vars` and fill in your keys:

| Variable | Where to get it |
|----------|----------------|
| `AI_PROVIDER` | Model provider. Supported: `gemini`, `claude`, `codex`, `codex-cli`, or `claude-cli`. Defaults to `gemini` if omitted |
| `AI_API_KEY` | API key for API-backed providers |
| `AI_MODEL` | Model ID to use. Change this in env vars instead of code |
| `AI_TOTAL_BUDGET_MS` | Optional per-agent total timeout override in milliseconds. Useful for slower local providers like `codex-cli` or `claude-cli` |
| `AI_PER_ATTEMPT_TIMEOUT_MS` | Optional per-attempt timeout override in milliseconds |
| `AI_AGENT_CONCURRENCY` | Optional model-call concurrency. Defaults to `1` for free-tier friendliness |
| `ANALYZE_IP_COOLDOWN_MS` | Optional per-IP cooldown in milliseconds. Set `0` to disable |
| `ANALYZE_DAILY_CAP` | Optional global daily cap. Set `0` to disable |
| `ETHERSCAN_API_KEY` | [Etherscan](https://etherscan.io/apis) — free tier is sufficient. One key works across all chains via V2 API |

### 3. Build embedded skills

```bash
npm run build
```

This reads `skill/agents/*.md` and generates `functions/api/lib/embedded-skills.js` (gitignored). Must be re-run whenever agent prompts change.

### 4. Start dev server

```bash
npm run dev
```

Opens `http://localhost:8788`. The audit tool is at `/audit-tool.html`.

### 5. Run tests

```bash
npm test
```

All tests use stubbed fetch — no API keys or network access needed.

### 6. Run the local CLI with your own API key

```bash
npm run cli -- analyze --path ./contracts
```

Useful options:

```bash
npm run cli -- analyze --file ./contracts/Vault.sol --json
npm run cli -- analyze --path ./contracts --out ./report.json --trace-dir ./.opensentry-trace
```

The CLI uses the same `AI_PROVIDER`, `AI_API_KEY`, and `AI_MODEL` environment variables as the API-backed flow.

Example API-backed Codex/OpenAI setup:

```bash
AI_PROVIDER=codex AI_MODEL=gpt-5.3-codex AI_API_KEY=your_openai_key \
npm run cli -- analyze --file ./contracts/Vault.sol --trace-dir ./.opensentry-trace
```

This is also the setup to use with the cloud CLI tool, since it is API-backed.

### 7. Run the local CLI without your own API key

For local CLI-backed providers, use your own local CLI installation and authenticated session instead of `AI_API_KEY`.

Prerequisites:

- Install the local CLI you want to use so the binary is available in your shell `PATH`.
- For `codex-cli`, install the `codex` CLI and sign in with your Codex/ChatGPT account before running OpenSentry.
- For `claude-cli`, install the `claude` CLI and sign in with your Claude Code account before running OpenSentry.
- Set `AI_PROVIDER` to the matching local provider and choose a compatible `AI_MODEL`.

Example local Codex CLI setup with a personal Codex/ChatGPT login session:

```bash
AI_PROVIDER=codex-cli AI_MODEL=gpt-5.3-codex \
npm run cli -- analyze --file ./contracts/Vault.sol --trace-dir ./.opensentry-trace
```

`codex-cli` uses the locally installed `codex` binary and your existing Codex CLI login session instead of direct OpenAI API billing.

Example local Claude Code setup with a personal Claude Code login session:

```bash
AI_PROVIDER=claude-cli AI_MODEL=sonnet \
npm run cli -- analyze --file ./contracts/Vault.sol --trace-dir ./.opensentry-trace
```

`claude-cli` uses the locally installed `claude` binary and your existing Claude Code login session instead of direct Anthropic API billing.

By default, `codex-cli` and `claude-cli` get a much larger local timeout budget than the API-backed providers. You can override it explicitly, for example:

```bash
AI_PROVIDER=claude-cli AI_MODEL=sonnet AI_TOTAL_BUDGET_MS=600000 AI_PER_ATTEMPT_TIMEOUT_MS=600000 \
npm run cli -- analyze --file ./contracts/Vault.sol --trace-dir ./.opensentry-trace
```

---

## Architecture

```
Browser                    Cloudflare Pages Functions              External
───────                    ──────────────────────────              ────────
                           ┌─────────────────────┐
  POST /api/analyze  ───►  │   _middleware.js     │
  { address, chain }       │  CORS, rate limit,   │
                           │  request validation  │
                           └──────────┬──────────┘
                                      ▼
                           ┌─────────────────────┐
                           │    analyze.js        │
                           │  (orchestrator)      │
                           └──────────┬──────────┘
                              ┌───────┴───────┐
                              ▼               ▼
                     ┌──────────────┐  ┌──────────────┐
                     │ fetch-source │  │ embedded-     │
                     │    .js       │  │ skills.js     │
                     └──────┬───────┘  └──────┬───────┘
                            │                 │
                            ▼                 ▼
                     Etherscan V2      prompt-wrapper.js
                        API            (anti-injection
                                        + agent prompt)
                                             │
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
                        ┌──────────┐  ┌──────────┐  ┌──────────┐
                        │  agent   │  │  agent   │  │  agent   │  x8 parallel
                        │ runner   │  │ runner   │  │ runner   │  via
                        └────┬─────┘  └────┬─────┘  └────┬─────┘  Promise.allSettled
                             │             │             │
                             ▼             ▼             ▼
                          AI API (JSON mode)
                              │
                              ▼
                     ┌──────────────────┐
                     │  merge-results   │
                     │  quality gate,   │
                     │  dedup, sort,    │
                     │  assign OS-###   │
                     └────────┬─────────┘
                              ▼
                     JSON response ───► Browser renders report
```

### Pipeline summary

1. **Middleware** — CORS (opensentry.tech + localhost), configurable abuse protection, POST + JSON validation
2. **Orchestrator** — validates input, fetches source, fans out 8 agents, merges results
3. **Fetch source** — Etherscan V2 multichain API, handles single/multi-file, proxies, retries on rate limit
4. **Prompt wrapper** — prepends anti-injection preamble to each agent's markdown prompt
5. **Agent runner** — calls the configured model with 25s budget, 1 retry for transient errors, validates output schema
6. **Merger** — classifies results, quality-gates findings (citation check, contradiction filter, finding cap), deduplicates by root cause (location + Jaccard check-name similarity), resolves severity conflicts, sorts CRITICAL > WARNING > INFO, assigns OS-001/002/... IDs

---

## Contributing

OpenSentry is open source and welcomes contributions. If you are a security researcher, smart contract auditor, or web3 developer and want to contribute to the analysis engine or wallet extension, open an issue or [reach out directly](https://t.me/lirona1).

---

## Support the Project

OpenSentry is a public good. If you find it useful, consider donating via [Giveth](https://giveth.io/project/opensentry).

---

## License

MIT — free to use, fork, and build on.
