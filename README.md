# OpenSentry

**Decentralizing smart contract security, bringing audit-grade protection to individuals as a public good.**

OpenSentry analyzes smart contracts the way a professional auditor would and delivers the findings in plain language at the moment of signing. E.g:

> *"All your deposited funds could be withdrawn at any time by the contract's admin — make sure you trust this protocol."*
>
> *"Withdrawing from this contract will cost you an extra ~$7 (0.00048 ETH) due to a rounding error. You will receive less than you are owed."*

**OpenSentry is free, open source, and built as a public good.**

---

## How It Works

OpenSentry orchestrates specialized AI security agents that analyze a smart contract in parallel, each attacking the code from a distinct angle. An orchestration layer deduplicates findings across all agents, chains related vulnerabilities where combined impact exceeds individual findings, and gates every result through a validation process before generating a plain-language risk report.

---

## Repository Structure

```
OpenSentry/
├── website/          # opensentry.tech — landing page and beta signup
└── agents/           # AI auditing skill and agent definitions
```

---

## Contributing

OpenSentry is open source and welcomes contributions. If you are a security researcher, smart contract auditor, or web3 developer and want to contribute to the analysis engine or wallet extension, open an issue or [reach out directly](https://t.me/lirona1)

---

## License

MIT — free to use, fork, and build on.
