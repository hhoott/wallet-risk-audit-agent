# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Three access surfaces over one in-process audit engine: A2A (CAP Provider), HTTP API, and a
  bundled web UI.
- Type-aware address inspection: detects EOA / ERC-20 / ERC-721 / ERC-1155 / contract and routes to
  type-specific analysis and (optionally) a type-specific LLM assessment.
- Address intelligence: legitimacy / counterparty verdict (official, likely-safe, caution,
  dangerous) reusing the risk-feature engine; gracefully degrades to a rule-only verdict when an
  on-chain RPC is unavailable.
- Optional LangChain (OpenAI-compatible) AI insight layer for the FULL/MULTI tiers: plain-language
  risk explanation, remediation plan, and report Q&A. Disabled cleanly when no `LLM_API_KEY` is set.
- Web payment options: a demo CAP-checkout path with a user-supplied CROO key
  (`PORTAL_ALLOW_CROO_KEY`, off by default) and a MetaMask direct-USDC-transfer path on Base
  (verified on-chain via `PORTAL_PAYEE_ADDRESS`).
- Standalone result page, live progress (SSE), and per-type report styling.
- Developer tooling: ESLint v9 flat config, Prettier config, EditorConfig, `.nvmrc`, GitHub Actions
  CI, and contributor docs (CONTRIBUTING, SECURITY).

### Notes

- The agent remains read-only by design: no private keys, no signing, no `eth_sendRawTransaction`.
- `PORTAL_PAYMENT_MODE=free` is for development/demo only; it does not enforce payment.

## [0.1.0]

### Added

- Initial CAP Provider: wallet risk audit (approvals, unlimited-approval detection, suspicious /
  high-risk contracts, asset distribution, failed/abnormal transactions, revocation advice, and a
  Wallet Health Score), with three USDC tiers (Quick 0.5 / Full 2 / Multi 5) settled over CAP.
- Read-only data providers (Etherscan v2 + viem, CoinGecko, curated risk list), retry policy, and a
  property-based test suite.
- Example A2A Requester demonstrating composability.
