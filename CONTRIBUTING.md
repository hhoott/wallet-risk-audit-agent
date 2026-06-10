# Contributing

Thanks for your interest in improving the Web3 Address Intel & Risk Agent. This document covers the
local setup, the project layout, and the conventions we follow.

## Prerequisites

- Node.js >= 18.20 (developed on Node 20; see `.nvmrc`).
- No API keys are required to build or run the test suite — all tests use in-memory mock data
  sources and never touch the network.

## Setup

```bash
npm install
npm run build      # tsc + copy the portal's static assets into dist/
npm test           # vitest (unit + property-based tests)
```

## Useful scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Type-check + emit to `dist/`, then copy `src/portal/public` assets. |
| `npm test` | Run the full Vitest suite once. |
| `npm run test:watch` | Watch mode. |
| `npm run typecheck` | `tsc --noEmit` (types only). |
| `npm run lint` | ESLint (flat config). |
| `npm run format` | Prettier write. `npm run format:check` to verify only. |
| `npm run preflight` | Validate `.env` before a live run (never prints secrets). |
| `npm start` | Run the Provider + Web/API in one process (`dist/app.js`). |
| `npm run provider` / `npm run portal` / `npm run requester` | Run a single surface. |

## Project layout

```
src/
  app.ts              Unified entry: Provider + Web/API in one process (one CAP connection)
  main.ts             Provider-only entry (CAP Provider event loop)
  config.ts           Two-chain config + env loading
  models.ts           Core data types (no key/signature fields by design)
  orchestrator.ts     Audit orchestration: tier routing, concurrency, partial-success
  services.ts         CAP Service catalog (tier metadata)
  cap/                CAP adapter (the only layer that imports the SDK)
  datasource/         Read-only data-source interfaces, retry policy, mocks
  datasource/providers/  Real read-only providers (Etherscan/viem, CoinGecko, risk list)
  modules/            Pure analysis modules (validator, scanner, classifier, intel, ...)
  llm/                Optional LangChain (OpenAI-compatible) AI skill layer
  portal/             Web UI + HTTP API (server, payment paths, static frontend)
  examples/           Example A2A Requester (see src/examples/README.md)
test/                 Vitest unit + property-based tests
docs/                 Architecture, CAP protocol, hackathon mapping, design system
```

## Conventions

- **Language:** all source comments, identifiers, and UI strings are in English.
- **Read-only boundary:** the agent never accesses private keys / seed phrases and never sends a
  transaction for the audit. Data-source interfaces expose only `get*` / `lookup` methods. Do not
  add a signing or `eth_sendRawTransaction` path.
- **Secrets:** never hard-code keys. All secrets come from environment variables (see
  `.env.example`). `.env` is gitignored.
- **Determinism + tests:** analysis modules are pure and driven by injected data sources. New
  behavior should come with unit and/or property-based tests; the suite must pass with no network.
- **Style:** Prettier + ESLint. Run `npm run format && npm run lint` before opening a PR.

## Pull requests

1. Branch from `main`.
2. Keep changes focused; include tests for new behavior.
3. Ensure `npm run build`, `npm run lint`, and `npm test` all pass.
4. Describe what changed and how you verified it.
