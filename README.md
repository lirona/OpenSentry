# OpenSentry

**Decentralizing smart contract security, bringing audit-grade protection to individuals as a public good.**

OpenSentry analyzes smart contracts the way a professional auditor would and delivers the findings in plain language at the moment of signing. E.g:

> *"All your deposited funds could be withdrawn at any time by the contract's admin — make sure you trust this protocol."*
>
> *"Withdrawing from this contract will cost you an extra ~$7 (0.00048 ETH) due to a rounding error. You will receive less than you are owed."*

**OpenSentry is free, open source, and built as a public good.**

---

## How It Works

OpenSentry orchestrates specialized AI security agents that analyze a smart contract in parallel, each attacking the code from a distinct angle. An orchestration layer deduplicates findings across all agents, resolves severity conflicts, gates every result through a quality-validation pipeline, and produces a plain-language risk report.

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

- For API-backed providers, set your own `AI_API_KEY`.
- For `codex-cli` and `claude-cli`, use your own local CLI installation and authenticated session, without having to set `AI_API_KEY`.


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

### 6. Run the local CLI

```bash
npm run cli -- analyze --path ./contracts
```

Useful options:

```bash
npm run cli -- analyze --file ./contracts/Vault.sol --json
npm run cli -- analyze --path ./contracts --out ./report.json --trace-dir ./.opensentry-trace
```

The CLI uses the same `AI_PROVIDER`, `AI_API_KEY`, and `AI_MODEL` environment variables as the API-backed flow. `AI_API_KEY` is only required for API-backed providers.

Example Codex/OpenAI setup:

```bash
AI_PROVIDER=codex AI_MODEL=gpt-5.3-codex AI_API_KEY=your_openai_key \
npm run cli -- analyze --file ./contracts/Vault.sol --trace-dir ./.opensentry-trace
```

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
