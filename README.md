# Wallet Risk Audit Agent

Read-only Ethereum wallet risk analysis agent for the CROO Agent Protocol (CAP). It can be hired by other agents over A2A, called as a local HTTP API, or used through the bundled web UI.

## Current Fact

This project currently exposes the same wallet-risk audit engine in three ways:

| Mode | What it is | Main entry |
| --- | --- | --- |
| A2A / CAP Provider | Other agents hire this agent through CROO CAP, pay USDC on Base, and receive a CAP delivery. | `npm start` or `npm run provider` |
| HTTP API | Local JSON/SSE endpoints for orders, tier discovery, and address vetting. | `npm start`, then `POST /api/orders` |
| Web UI | Browser wizard for audits, payment/demo flow, and report rendering. | `npm start`, then open the printed URL |

`npm start` is the default competition/demo path: it starts the CAP Provider and the Web/API server in one process, using one CAP identity and one CAP WebSocket. `npm run portal` starts only the Web/API server.

## What It Does

- Validates Ethereum wallet and contract addresses.
- Reads Ethereum mainnet data only; it never asks for private keys and never sends transactions for the audit itself.
- Analyzes balances, token holdings, approvals, contract interactions, high-risk counterparties, failed transactions, and recent activity.
- Produces both a human-readable Markdown report and a structured JSON deliverable.
- Supports three service tiers: `QUICK` (0.5 USDC), `FULL` (2 USDC), and `MULTI` (5 USDC).
- Adds optional LangChain/OpenAI-compatible LLM analysis when `LLM_API_KEY` is configured.
- Supports web payment gating through demo/free mode, CAP checkout with a user-supplied CROO key, or MetaMask USDC transfer verification on Base.

## Quick Start

```bash
npm install
cp .env.example .env
npm run preflight
npm run build
npm start
```

After startup, the process prints:

- The CAP Provider status.
- The frontend URL, usually `http://127.0.0.1:8787/`.
- The API base URL, usually `http://127.0.0.1:8787/api`.

The Provider requires `CROO_SDK_KEY`. Ethereum data quality improves when `ETHERSCAN_API_KEY` and `ALCHEMY_RPC_URL` are set.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check with `tsc` and copy portal static assets to `dist/portal/public`. |
| `npm start` | Start Provider + Web/API together from `dist/app.js`. This is the recommended default. |
| `npm run dev` | Build, then start Provider + Web/API together. |
| `npm run provider` | Start only the CAP Provider from `dist/main.js`. |
| `npm run provider:dev` | Build, then start only the CAP Provider. |
| `npm run portal` | Start only the Web/API server from `dist/portal/main.js`. |
| `npm run portal:dev` | Build, then start only the Web/API server. |
| `npm run requester` | Run the A2A Requester example from `dist/examples/requester.js`. |
| `npm test` | Run the Vitest test suite. |
| `npm run lint` | Run ESLint. |
| `npm run preflight` | Validate key environment configuration before a live run. |

There is no `npm run require` script. The A2A requester demo is `npm run requester`.

## A2A Provider Mode

The Provider is the production A2A service surface. Another CAP Requester Agent can:

1. Call `negotiateOrder` with one of this agent's `SERVICE_ID_*` values and audit requirements.
2. Pay the created order with `payOrder`, locking USDC in CAPVault escrow on Base.
3. Wait for this Provider to audit the requested wallet(s).
4. Fetch the delivery with `getDelivery`.
5. Use the structured report fields such as `riskLevelSummary` and `healthScore`.

Provider flow in this repo:

- `src/main.ts` starts the Provider-only runtime.
- `src/app.ts` starts Provider + Web/API together.
- `src/cap/provider.ts` listens for CAP events, accepts matching negotiations, runs the audit on `order_paid`, and delivers the report.
- `docs/cap-protocol.md` documents the CAP lifecycle and SDK calls used by the project.

### A2A Requester Example

The requester example lives in `src/examples/requester.ts`. Its standalone README is here:

[src/examples/README.md](src/examples/README.md)

Typical usage after `npm run build`:

```bash
export CROO_SDK_KEY="croo_sk_requester_agent_key"
export CROO_TARGET_SERVICE_ID="svc_target_audit_service"
export CROO_TARGET_ORDER_ID="order_created_by_the_negotiation"
npm run requester -- 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

The example demonstrates the consumer side of A2A composability: hire the audit agent, fetch the CAP delivery, parse the structured JSON, and decide whether to proceed or abort based on `riskLevelSummary` and `healthScore`.

## HTTP API Mode

When `npm start` or `npm run portal` is running, the local API is served under `/api`.

### Health

```bash
curl http://127.0.0.1:8787/api/health
```

### Tiers

```bash
curl http://127.0.0.1:8787/api/tiers
```

Returns tier metadata, prices, availability, and configured service IDs.

### Create Audit Order

```bash
curl -X POST http://127.0.0.1:8787/api/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "tier": "FULL",
    "walletAddresses": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]
  }'
```

For streaming progress, include `"stream": true`; the server responds with Server-Sent Events.

Payment-related fields depend on the selected payment path:

- `crooKey`: optional user-supplied CROO key for the CAP checkout path when `PORTAL_ALLOW_CROO_KEY=true`.
- `method`: optional payment method hint — `"cap"`, `"metamask"`, or `"none"` (inferred from the credentials when omitted).
- `payTxHash`: optional MetaMask/Base USDC transfer hash for the direct-transfer verification path.
- In `PORTAL_PAYMENT_MODE=free`, payment failure does not block report generation.
- In `PORTAL_PAYMENT_MODE=paid`, payment must verify or the API returns `402 Payment Required`.

### `POST /api/orders` response schema

On success (`200`), the JSON body has these fields:

| Field | Type | Notes |
| --- | --- | --- |
| `orderId` | string | A CAP order id when paid over CAP, or a local run id (`local-…`). |
| `tier` | `"QUICK" \| "FULL" \| "MULTI"` | The requested tier. |
| `mode` | `"free" \| "paid"` | The active payment gate. |
| `paid` | boolean | `true` when a CAP/MetaMask payment was confirmed. |
| `paymentMethod` | `"metamask"` | Present only for the MetaMask path. |
| `payTxHash` | string | Settlement/transfer tx hash, when a payment occurred. |
| `paymentBypassed` | boolean | `true` when free mode returned a report without enforcing payment. |
| `paymentNote` | string | Why payment was bypassed (free mode only). |
| `structured` | object | Machine-readable report. `AuditReportStructured` (single) or `MultiWalletReport` (has `reports[]` + `walletCount`). |
| `humanReadable` | string | Markdown version of the report. |
| `decision` | object | A2A gating: `{ proceed, reason, riskLevel, healthScore }`. |
| `addressIntel` | array | Per-address type-aware intelligence (see below). |
| `ai` | object | Optional AI insight: `{ explanation, remediation }` or `{ error }`. Present on FULL/MULTI when an LLM is configured. |

`structured` (single-wallet `AuditReportStructured`) key fields:

```jsonc
{
  "schemaVersion": "1.0.0",
  "walletAddress": "0x…",
  "auditedChain": "Ethereum Mainnet",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "tier": "FULL",
  "healthScore": 88,                  // 0–100
  "healthGrade": "EXCELLENT",         // EXCELLENT | GOOD | FAIR | POOR
  "riskLevelSummary": "LOW",          // LOW | MEDIUM | HIGH | CRITICAL
  "scoredOnIncompleteData": false,
  "readOnlyDeclaration": "…",
  "approvals": [],                    // ApprovalRecord[]
  "contractRisks": [],                // ContractRisk[]
  "assets": null,                     // AssetDistribution | null
  "txFindings": [],                   // TxFinding[]
  "revokeAdvice": [],                 // RevokeAdvice[] (each has a revokeLink.url)
  "moduleStatuses": []                // per-module OK | INCOMPLETE | FAILED
}
```

Each `addressIntel[]` entry:

```jsonc
{
  "address": "0x…",
  "type": "ERC20",                    // EOA | ERC20 | ERC721 | ERC1155 | CONTRACT | UNKNOWN
  "verdict": "DANGEROUS",             // OFFICIAL | LIKELY_SAFE | CAUTION | DANGEROUS | UNKNOWN
  "official": false,
  "blacklisted": true,
  "label": "…",                       // curated label, if known
  "reasons": ["…"],
  "token": {                          // present for ERC-20 token contracts
    "symbol": "…", "name": "…",
    "hasOwner": true, "mintable": true, "pausable": false, "hasBlacklist": true
  },
  "aiAssessment": "…"                 // Markdown; present on FULL/MULTI with an LLM
}
```

Error responses use `{ "error": string, "code"?: string }` with an appropriate status:
`400` (bad input), `402` (`PAYMENT_REQUIRED` / `PAYMENT_NOT_VERIFIED`), `403` (`CROO_KEY_DISABLED`),
`502`/`504` (CAP checkout failure / timeout).

The canonical TypeScript types are in [`src/models.ts`](./src/models.ts).

### Vet Address

```bash
curl -X POST http://127.0.0.1:8787/api/vet \
  -H 'Content-Type: application/json' \
  -d '{ "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }'
```

This endpoint performs focused address/counterparty intelligence for fast risk screening.

## Web UI Mode

The Web UI is served by the same portal server. Start it with:

```bash
npm start
```

Then open the URL printed by the process, normally:

```text
http://127.0.0.1:8787/
```

The browser flow supports:

- Tier selection.
- One or more wallet addresses.
- Progress updates during audit.
- Demo/free mode for competition testing.
- Optional CAP checkout using a user-supplied CROO key when enabled.
- Optional MetaMask payment verification by Base USDC transfer.
- Dedicated report rendering page.

## Environment

Core CAP Provider:

| Variable | Required | Purpose |
| --- | --- | --- |
| `CROO_SDK_KEY` | Yes | Provider Agent API key from CROO. |
| `CROO_API_URL` | No | CAP API base URL. Defaults to `https://api.croo.network`. |
| `CROO_WS_URL` | No | CAP WebSocket URL. Defaults to `wss://api.croo.network/ws`. |
| `RPC_URL` | No | Base settlement RPC override for the CROO SDK. |
| `SERVICE_ID_QUICK` | Live Provider | CAP Service ID for `QUICK`. |
| `SERVICE_ID_FULL` | Live Provider | CAP Service ID for `FULL`. |
| `SERVICE_ID_MULTI` | Live Provider | CAP Service ID for `MULTI`. |

Ethereum data sources:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ETHERSCAN_API_KEY` | Recommended | Etherscan transaction, token, and contract metadata. |
| `ALCHEMY_RPC_URL` | Recommended | Ethereum mainnet read-only RPC. |
| `COINGECKO_API_KEY` | No | Higher rate limits for valuation data. |
| `COINGECKO_PRO` | No | Set to `true` when using CoinGecko Pro. |

Portal/Web/API:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORTAL_PORT` | No | HTTP port. Defaults to `8787`. |
| `PORTAL_ORDER_TIMEOUT_MS` | No | Per-audit timeout. Defaults to `120000`. |
| `PORTAL_PAYMENT_MODE` | No | `free` or `paid`. Defaults to `free`. |
| `PORTAL_ALLOW_CROO_KEY` | No | Set to `true` to show/accept user CROO keys for CAP checkout. |
| `PORTAL_PAYEE_ADDRESS` | MetaMask path | Base address that receives USDC transfers. |
| `PORTAL_BASE_RPC_URL` | No | Base RPC for verifying MetaMask USDC transfers. Defaults to public Base RPC. |

LLM skills:

| Variable | Required | Purpose |
| --- | --- | --- |
| `LLM_API_KEY` | No | Enables optional LLM insight layer. |
| `LLM_BASE_URL` | No | OpenAI-compatible base URL. Defaults to `https://api.openai.com/v1`. |
| `LLM_MODEL` | No | Model name. Defaults to `gpt-4o-mini`. |
| `LLM_TEMPERATURE` | No | Defaults to `0.2`. |
| `LLM_MAX_TOKENS` | No | Defaults to `1200`. |

A2A Requester example:

| Variable | Required | Purpose |
| --- | --- | --- |
| `CROO_SDK_KEY` | Yes | Requester Agent API key when running `npm run requester`. |
| `CROO_TARGET_SERVICE_ID` | Yes | Target Provider Service ID to hire. |
| `CROO_TARGET_ORDER_ID` | Yes for current runnable demo | Order ID created after negotiation acceptance. |
| `CROO_AUDIT_WALLET` | If no CLI arg | Wallet address to audit. |

See `.env.example` for a complete template.

## Architecture

```text
src/
  app.ts                         Unified Provider + Web/API entry
  main.ts                        Provider-only entry
  cap/provider.ts                CAP event loop and delivery logic
  orchestrator.ts                Audit orchestration
  datasource/                    Ethereum data providers and risk rules
  modules/                       Address inspection, intel, reports, payment helpers
  llm/                           Optional LangChain/OpenAI-compatible skills
  portal/
    main.ts                      Portal-only entry
    server.ts                    HTTP API and static file server
    local-auditor.ts             Web/API adapter over the audit engine
    cap-checkout.ts              Per-request CAP checkout driver
    metamask-payment.ts          Base USDC transfer verifier
    public/                      Web UI assets and report renderer
  examples/requester.ts          A2A Requester demo
```

Key runtime decision:

- `npm start` uses `src/app.ts`.
- The Provider owns the CAP WebSocket.
- Web/API orders reuse the same in-process audit engine instead of opening a second CAP connection.
- `npm run portal` is still useful for local Web/API development without the Provider loop.

## Security Model

- Audits are read-only on Ethereum mainnet.
- The service does not require, store, or log private keys.
- CROO SDK keys are injected through environment variables.
- Browser-supplied CROO keys are a demo checkout capability and are off unless `PORTAL_ALLOW_CROO_KEY=true`.
- `PORTAL_PAYMENT_MODE=free` is for local development and competition demos only; use `paid` when settlement must be enforced.
- MetaMask payment verification reads Base receipts and checks USDC `Transfer` logs to `PORTAL_PAYEE_ADDRESS`.

## Testing And Verification

```bash
npm run build
npm test
npm run lint
```

Useful focused tests include:

- `test/requester-example.test.ts` for A2A requester decision logic.
- `test/portal-server.test.ts` for API behavior.
- `test/address-inspector.test.ts` and `test/address-intel.test.ts` for address risk modules.
- `test/llm-skills.test.ts` for optional LLM skill behavior.

## Competition Demo Checklist

1. Fill `.env` with `CROO_SDK_KEY`, `SERVICE_ID_*`, and data source keys.
2. Run `npm run preflight`.
3. Run `npm run build`.
4. Run `npm start`.
5. Confirm the console prints the Web UI URL and API order URL.
6. Demo the Web UI.
7. Demo the API with `POST /api/orders` or `POST /api/vet`.
8. Demo A2A using `npm run requester` and the dedicated requester README.

## More Documentation

- [CAP protocol reference](docs/cap-protocol.md)
- [A2A requester example](src/examples/README.md)
- [.env template](.env.example)
