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

**Stack:** Cloudflare Pages (static frontend) + Cloudflare Pages Functions (serverless backend) + Google Gemini API (Gemini 2.5 Flash, free tier) + Etherscan V2 API (contract source fetching)

**Note:** Current POC uses Gemini free tier, next version will use a more robust model for better results.

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
│           ├── agent-runner.js      # Call Gemini per agent with retry + timeout
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
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) — free, no credit card |
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
                          Gemini 2.5 Flash API (JSON mode)
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

1. **Middleware** — CORS (opensentry.tech + localhost), IP rate limiting (1 req/60s), global daily cap (~30/day), POST + JSON validation
2. **Orchestrator** — validates input, fetches source, fans out 8 agents, merges results
3. **Fetch source** — Etherscan V2 multichain API, handles single/multi-file, proxies, retries on rate limit
4. **Prompt wrapper** — prepends anti-injection preamble to each agent's markdown prompt
5. **Agent runner** — calls Gemini with 25s budget, 1 retry for transient errors, validates output schema
6. **Merger** — classifies results, quality-gates findings (citation check, contradiction filter, finding cap), deduplicates by root cause (location + Jaccard check-name similarity), resolves severity conflicts, sorts CRITICAL > WARNING > INFO, assigns OS-001/002/... IDs

---

## Deployment

### Cloudflare Pages

```bash
npm run build          # regenerate embedded-skills.js
npm run deploy         # deploy via wrangler
```

Set the following **encrypted** environment variables in the Cloudflare Pages dashboard (Settings > Environment variables):

- `GEMINI_API_KEY`
- `ETHERSCAN_API_KEY`

### Gemini free tier constraints

- 10 requests/minute — each analysis uses 8 (one per agent)
- 250 requests/day — allows ~31 analyses/day
- The middleware and frontend enforce these limits client-side and server-side

---

## Security Notes

- API keys are only in environment variables (`.dev.vars` locally, Cloudflare secrets in production)
- Every agent call is wrapped with an anti-injection preamble that treats contract source as untrusted data
- All user-supplied strings are HTML-escaped before rendering in the frontend
- CORS is restricted to `opensentry.tech` and `localhost`
- Error responses never leak API keys or stack traces
- `embedded-skills.js` is gitignored (contains prompt IP generated from `skill/agents/`)
- Restrict your Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey) to `opensentry.tech` referrer before going live


---

## Contributing

OpenSentry is open source and welcomes contributions. If you are a security researcher, smart contract auditor, or web3 developer and want to contribute to the analysis engine or wallet extension, open an issue or [reach out directly](https://t.me/lirona1).

---

## License

MIT — free to use, fork, and build on.
