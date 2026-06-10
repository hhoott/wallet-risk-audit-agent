# CROO Web3 Address Intel & Risk Agent

Evidence-based Web3 counterparty risk intelligence for the CROO Agent Protocol.

This agent answers one practical question before a user or another agent sends a transaction:

> Is this wallet, contract, token, router, bridge, or counterparty address safe, official, suspicious, or risky?

It collects read-only evidence from Etherscan and RPC providers, asks an LLM to classify that evidence, writes the result back into the final JSON, and returns a shareable report page.

## Competition Summary

The project exposes the same address intelligence engine through three product surfaces:

| Surface | Who uses it | What happens |
| --- | --- | --- |
| **A2A / CROO CAP** | Other agents | A requester hires this Provider, pays the CROO service, and receives a CAP delivery with JSON, Markdown, and a report URL. |
| **HTTP API** | Apps, bots, backend services | A client posts one or more addresses to `/api/orders` and receives structured risk intelligence. |
| **Web UI + Report Page** | Human users and judges | A browser flow displays the final badge, reasons, evidence, and recommended action. |

Recommended review path:

1. Watch the feature demo video: <https://youtu.be/KcomHAS7xQk>
   - Local render source: `test-guide/hyperframes-a2a-demo/croo-address-intel-feature-demo.mp4`
2. Inspect the three saved report URLs below.
3. Review the A2A flow in `src/examples/run-live-a2a.ts` and `src/cap/provider.ts`.
4. Run `npm run build` and the target tests listed in [Verification](#verification).

## Demo Results

These are real successful A2A runs saved during the competition demo.

| Case | Address | Result | Why it matters |
| --- | --- | --- | --- |
| Official contract | `0xE592427A0AEce92De3Edee1F18E0157C05861564` | `OFFICIAL` / `LOW` | The evidence log supports the official badge through contract code, verified source, canonical `SwapRouter` metadata, and long transaction history. |
| Normal high-activity EOA | `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` | `LIKELY_SAFE` / `LOW` | The wallet can be low risk without being marked official; the LLM output is evidence-gated so public fame or model memory is not enough. |
| Caution contract | `0xD90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b` | `CAUTION` / `MEDIUM` | The report highlights mixer-adjacent context and transaction-risk evidence without inventing an unsupported blacklist claim. |

Report pages:

```text
https://intel.say2agent.com/report?file=e149b86a-ca7d-447f-8763-25a9795b7f63.json
https://intel.say2agent.com/report?file=02528134-5c63-4dc9-8110-938fa59568c6.json
https://intel.say2agent.com/report?file=ce3ce2c9-f62d-44cf-904a-baa066933aea.json
```

Local demo evidence is documented in [test-guide/a2a-demo-runs-2026-06-10.md](test-guide/a2a-demo-runs-2026-06-10.md).

## What The Agent Delivers

For each submitted address, the agent returns:

- Address type: EOA, contract, ERC-20, ERC-721, ERC-1155, or unknown.
- Official / safe / caution / dangerous / unknown badge.
- Risk level: low, medium, high, or critical.
- Contract metadata: source verification, contract name, deployment facts, code presence.
- Approval and spender risk checks.
- Transaction and counterparty evidence.
- Blacklist / warning hints when the evidence supports them.
- LLM evidence verdict with cited fields, reasons, authorization risks, and transaction risks.
- Human-readable Markdown and machine-readable JSON.
- A report page URL that can be opened by a human reviewer.

The CROO-facing product is intentionally simple: **one paid service** that accepts one or many address targets and returns a full intelligence report. Internally, the engine still supports modular checks and multi-address reports.

## LLM Role

The LLM is not used as a decorative summary. It produces structured output that is written back into the final result.

The prompt receives a compact evidence log containing fields such as:

- `contractMeta.name`, `verified`, `isContract`, `deployedAt`, `txCount`
- address type and token facts
- approvals and spender exposure
- transaction findings and counterparties
- scanner warnings and blacklist hints
- source/explorer labels when available

The LLM must return:

```json
{
  "verdict": "OFFICIAL",
  "riskLevel": "LOW",
  "badge": {
    "level": "OFFICIAL",
    "label": "Official verified",
    "description": "Evidence supports an official protocol/service address."
  },
  "official": true,
  "blacklisted": false,
  "reasons": ["..."],
  "approvalRisks": [],
  "transactionRisks": [],
  "evidenceUsed": ["contractMeta.name", "contractMeta.verified"]
}
```

Important guardrail: an EOA is not allowed to become `official=true` only because the model recognizes it from memory. For EOAs, the evidence log must contain an explicit official-source or explorer-label signal. Otherwise, the result is downgraded to a non-official safe/caution verdict.

## A2A Flow

The A2A path follows the normal CROO CAP lifecycle:

```text
Requester Agent
  -> create negotiation for this service
  -> Provider accepts the negotiation
  -> Requester pays the created order
  -> CAP escrow is locked on Base
  -> Provider audits the submitted address target(s)
  -> Provider delivers Markdown + JSON + report URL
  -> Requester prints the final report URL
```

Provider implementation:

- [src/app.ts](src/app.ts): default competition entry, starts Provider and Web/API together.
- [src/main.ts](src/main.ts): Provider-only entry.
- [src/cap/provider.ts](src/cap/provider.ts): CAP event loop, payment handling, audit execution, LLM enrichment, result persistence, delivery.
- [src/result-store.ts](src/result-store.ts): writes `result/<orderId>.json` and creates public report URLs.

Requester implementation:

- [src/examples/run-live-a2a.ts](src/examples/run-live-a2a.ts): full live requester flow.
- [src/examples/README.md](src/examples/README.md): requester-specific guide.

Typical live requester command:

```bash
npm run requester:live -- 0xE592427A0AEce92De3Edee1F18E0157C05861564
```

The requester prints a final block like:

```text
==================== REPORT URL ====================
https://intel.say2agent.com/report?file=<orderId>.json
====================================================
```

## API Flow

Start the app:

```bash
npm run build
npm start
```

Then call the local API:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "chain": "ethereum",
    "walletAddresses": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]
  }'
```

The field name `walletAddresses` is kept for backward compatibility, but it now means address targets: wallets, contracts, tokens, routers, bridges, recipients, senders, or transaction counterparties.

Useful API endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check. |
| `GET` | `/api/tiers` | Single service catalog, price, payment mode, supported chains. |
| `POST` | `/api/orders` | Run address intelligence and return the final report. |
| `GET` | `/result/<orderId>.json` | Load a saved report JSON for the report page. |

## Web Flow

`npm start` also prints the frontend URL, usually:

```text
http://127.0.0.1:8787/
```

The Web UI supports:

- single or multi-address checks
- chain selection
- progress display
- payment-gated or local demo mode
- final report rendering
- report page URLs such as `/report.html?file=<orderId>.json`

## Supported Chains

Audits are read-only. The app never asks for private keys and never sends transactions from the audited address.

| Chain | API value | Chain id |
| --- | --- | --- |
| Ethereum Mainnet | `ethereum` | 1 |
| Base | `base` | 8453 |
| Arbitrum One | `arbitrum` | 42161 |
| OP Mainnet | `optimism` | 10 |
| Polygon PoS | `polygon` | 137 |

Etherscan V2 is used with one API key across chains. Per-chain RPC URLs are used for read-only code, balance, approval, and metadata checks. Transaction-history coverage outside Ethereum may require a paid Etherscan plan; the audit degrades gracefully when a chain endpoint is unavailable.

## Quick Start

```bash
npm install
cp .env.example .env
npm run preflight
npm run build
npm start
```

Minimum environment for a live Provider:

```env
CROO_SDK_KEY=<provider-agent-key>
SERVICE_ID=<croo-service-id>
ETHERSCAN_API_KEY=<etherscan-key>
ETH_RPC_URL=<ethereum-rpc-url>
```

Recommended data-source environment:

```env
BASE_RPC_URL=<base-rpc-url>
ARBITRUM_RPC_URL=<arbitrum-rpc-url>
OPTIMISM_RPC_URL=<optimism-rpc-url>
POLYGON_RPC_URL=<polygon-rpc-url>
LLM_API_KEY=<openai-compatible-key>
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
RESULT_BASE_URL=https://intel.say2agent.com
```

Requester-side A2A demo environment:

```env
CROO_REQUESTER_SDK_KEY=<requester-agent-key>
CROO_TARGET_SERVICE_ID=<provider-service-id>
```

Never commit real keys. `.env` is ignored.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check and copy portal assets into `dist/`. |
| `npm start` | Start Provider + Web/API together. This is the recommended competition/demo command. |
| `npm run provider` | Start only the CROO CAP Provider. |
| `npm run portal` | Start only the Web/API server. |
| `npm run requester:live` | Run the live A2A requester example. |
| `npm test` | Run the Vitest suite. |
| `npm run preflight` | Validate environment configuration before live runs. |

## Verification

The focused competition verification command is:

```bash
npm run build
npx vitest --run test/llm-skills.test.ts test/local-auditor-llm.test.ts test/cap-provider.test.ts test/requester-example.test.ts
```

Latest verified result in this workspace:

```text
npm run build: passed
target vitest suite: 4 files, 39 tests passed
HyperFrames video check: 0 layout issues
feature demo video: 1920x1080, 30fps, 192s
```

## Project Layout

```text
src/
  app.ts                         Provider + Web/API entry
  main.ts                        Provider-only entry
  cap/provider.ts                CROO CAP event loop and delivery logic
  result-store.ts                Saved result JSON and report URL helper
  orchestrator.ts                Audit orchestration
  datasource/                    Etherscan/RPC/CoinGecko providers
  modules/                       Address inspection, reports, payment helpers
  llm/                           LLM prompts and structured verdict parsing
  portal/
    server.ts                    HTTP API and static file server
    local-auditor.ts             Web/API adapter over the audit engine
    public/                      Web UI and report renderer
  examples/
    run-live-a2a.ts              Full live A2A requester demo
test/
  llm-skills.test.ts             LLM verdict and evidence-gate tests
  local-auditor-llm.test.ts      Web/API LLM writeback test
  cap-provider.test.ts           A2A provider delivery and result-store tests
test-guide/
  testing_guide.md               Detailed Chinese demo/testing guide
  a2a-demo-runs-2026-06-10.md    Pinned successful live A2A demo runs
  hyperframes-a2a-demo/          Competition feature video source
```

## CROO Agent Store Copy

Recommended agent name:

```text
Web3 Address Intel & Risk Agent
```

Recommended service name:

```text
Web3 Address Intel Report
```

Short description:

```text
Read-only multi-chain Web3 address intelligence agent. Submit any EVM wallet, token, NFT, contract, router, bridge, recipient, sender, or transaction counterparty address; the agent collects Etherscan/RPC evidence and returns an evidence-backed official/safe/caution/dangerous badge, risk level, explanation, JSON report, and shareable report URL.
```

Suggested deliverable text:

```text
The buyer receives a Web3 address intelligence report for the submitted address target(s), including address type, official/safe/caution/dangerous badge, risk level, health score, contract metadata, approval and transaction-risk findings, LLM evidence verdict, machine-readable JSON, Markdown summary, and a shareable report page URL.
```

Suggested requirements text:

```text
Provide one or more EVM address targets to inspect. Each target may be a wallet, token, NFT collection, contract, router, bridge, recipient, sender, or transaction counterparty address. Optionally specify the audited chain; Ethereum Mainnet is used by default.
```

## Security Notes

- The audit is read-only.
- The service never asks for an audited wallet private key.
- A2A payment and escrow are handled through CROO CAP on Base.
- Web/API deployments need external authentication and rate limiting before public exposure.
- LLM output is evidence-gated and should not be treated as a replacement for independent user verification.
