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

**Stack:** Cloudflare Pages (static frontend) + Cloudflare Pages Functions (serverless backend) + Google Gemini API + Etherscan V2 API (contract source fetching)

**Note:** Current POC uses free tier, next version will use a more robust model for better results.

---

## Repository Structure

```
OpenSentry/
├── website/                         # Static frontend (served by Cloudflare Pages)
│   ├── index.html                   # Landing page
│   ├── audit-tool.html              # Security analysis tool UI
│   └── logo.png                     # Brand assets
├── functions/                       # Cloudflare Pages Functions (serverless backend)
│   └── api/
│       ├── analyze.js               # POST /api/analyze — main orchestrator
│       ├── _middleware.js            # CORS, rate limiting, request validation
│       └── lib/
│           ├── fetch-source.js      # Fetch verified source from Etherscan V2
│           ├── agent-runner.js      # Call the AI model per agent with retry + timeout
│           ├── prompt-wrapper.js    # Anti-injection preamble + agent prompt
│           ├── merge-results.js     # Dedup, quality gate, sort, assign IDs
│           ├── skill-loader.js      # (see embedded-skills.js below)
│           └── embedded-skills.js   # AUTO-GENERATED — `npm run build`
├── skill/                           # Agent prompts and orchestration definitions
│   ├── SKILL.md                     # Base orchestrator prompt
│   ├── agents/                      # 8 agent markdown files
│   │   ├── access-control.md
│   │   ├── token-mechanics.md
│   │   ├── economic-fees.md
│   │   ├── oracle-dependencies.md
│   │   ├── mev-safety.md
│   │   ├── code-quality.md
│   │   ├── transparency.md
│   │   └── governance.md
│   └── output/
│       └── report-template.md       # Report structure definition
├── scripts/
│   └── embed-skills.js              # Build script: skill/*.md → embedded-skills.js
├── tests/                           # Unit + integration tests (node:test)
│   ├── fetch-source.test.mjs
│   ├── agent-runner.test.mjs
│   ├── merge-results.test.mjs
│   ├── analyze.test.mjs
│   └── middleware.test.mjs
├── .dev.vars.example                # Template for local env vars
├── wrangler.toml                    # Cloudflare Pages config
├── package.json
└── PLAN.md                          # Full implementation plan
```

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

Edit `.dev.vars` and fill in your keys:

| Variable | Where to get it |
|----------|----------------|
| `AI_PROVIDER` | Model provider. Supported: `gemini` or `claude`. Defaults to `gemini` if omitted |
| `AI_API_KEY` | API key for the configured model provider |
| `AI_MODEL` | Model ID to use. Change this in env vars instead of code |
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

The CLI uses the same `AI_PROVIDER`, `AI_API_KEY`, and `AI_MODEL` environment variables as the API-backed flow.

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
                          Gemini API (JSON mode)
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

## Deployment

### Cloudflare Pages

```bash
npm run build          # regenerate embedded-skills.js
npm run deploy         # direct-upload the `website/` bundle to the `opensentry` Pages project
```

Recommended project settings in Cloudflare:

- Framework preset: `None`
- Build command: `npm run build`
- Build output directory: `website`
- Root directory: repository root

Set the following environment variables in the Cloudflare Pages dashboard (`Workers & Pages -> <project> -> Settings -> Variables and Secrets`):

- `AI_API_KEY`
- `AI_MODEL`
- `AI_AGENT_CONCURRENCY` (optional)
- `ANALYZE_IP_COOLDOWN_MS` (optional)
- `ANALYZE_DAILY_CAP` (optional)
- `ETHERSCAN_API_KEY`

Direct upload via Wrangler:

```bash
npm install
npm run build
npm run deploy
```

Git-based deployment via Cloudflare Pages:

1. Connect the GitHub repository in Cloudflare Pages.
2. Set the production branch to the branch you want to deploy from.
3. Use build command `npm run build`.
4. Use build output directory `website`.
5. Add the variables/secrets listed above.
6. Deploy and verify that `/api/analyze` responds from Pages Functions.

---

## Security Notes

- API keys are only in environment variables (`.dev.vars` locally, Cloudflare secrets in production)
- Every agent call is wrapped with an anti-injection preamble that treats contract source as untrusted data
- All user-supplied strings are HTML-escaped before rendering in the frontend
- CORS is restricted to `opensentry.tech` and `localhost`
- Error responses never leak API keys or stack traces
- `embedded-skills.js` is gitignored (contains prompt IP generated from `skill/agents/`)
- Configure provider-side limits in your model provider dashboard and use the optional middleware env vars for app-side abuse protection


---

## Contributing

OpenSentry is open source and welcomes contributions. If you are a security researcher, smart contract auditor, or web3 developer and want to contribute to the analysis engine or wallet extension, open an issue or [reach out directly](https://t.me/lirona1).

---

## License

MIT — free to use, fork, and build on.
