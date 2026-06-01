# Wallet Risk Audit Agent

A read-only, on-chain **wallet security audit agent** built for the **CROO Agent Hackathon**
(track: DeFi / On-chain Ops Agents). You give it a wallet address; it returns a security report
with a **Wallet Health Score**, covering token approvals (including unlimited approvals),
suspicious / high-risk contracts, asset distribution, failed / abnormal transactions, and
prioritized revocation suggestions.

The agent is a **CAP (CROO Agent Protocol) Provider**: humans and other agents can discover and
hire it through the CROO Agent Store, pay per call in USDC (settled on Base), and receive a
structured report. It is **read-only by design** — it never accesses private keys or seed phrases,
and never sends a transaction on your behalf. Revocation is offered only as a link you confirm in
your own wallet.

> Two independent chains: the **audited chain is Ethereum Mainnet** (all data reads are read-only);
> CAP order **settlement is USDC on Base**, handled by the CAP SDK + CAPVault. All on-chain gas is
> sponsored by the CROO platform.

## Pricing tiers

The agent exposes three CAP Services (one per tier):

| Tier | Service | Price | What you get |
|------|---------|-------|--------------|
| Quick | Wallet Quick Check-up | **0.5 USDC** | Health Score + unlimited approvals + high-risk contract interactions |
| Full | Wallet Full Risk Report | **2 USDC** | Everything: approvals, suspicious/high-risk contracts, asset distribution, failed/abnormal txs, revocation advice |
| Multi | Multi-Wallet & History Analysis | **5 USDC** | A full report per wallet + a combined summary, over a longer history window |

## Architecture

A four-layer design; the analysis modules are pure functions driven by injected, read-only data
sources, which makes them deterministic and property-testable.

```
CAP adapter layer (Provider)      src/cap/provider.ts
   connectWebSocket → negotiation_created / order_paid → accept / deliver / reject
        │
Audit orchestrator                src/orchestrator.ts
   tier routing · concurrency · multi-wallet fan-out · partial-success aggregation
        │
Analysis modules (pure logic)     src/modules/*.ts
   Address_Validator · Approval_Scanner · Risk_Classifier · Asset_Analyzer ·
   Transaction_Analyzer · Revoke_Advisor · Health_Score_Engine · Report_Generator ·
   Payment_Gateway (pricing / settlement / refund decisions)
        │
Data source abstraction           src/datasource/
   ChainDataSource · PriceDataSource · RiskRuleSource (+ RetryPolicy: 10s timeout, 4 attempts)
   real providers: Etherscan v2 + viem · CoinGecko · curated risk list  (read-only)
```

```
src/
  config.ts              Global constants, two-chain config, runtime env loading
  models.ts              Core data types (AuditReport, RiskItem, etc.)
  services.ts            Service catalog (descriptions, skill tags, deliverable schema)
  orchestrator.ts        Audit orchestrator
  main.ts                Runnable Provider entrypoint (buildProvider / main)
  cap/provider.ts        CAP adapter (the only file that imports the SDK)
  modules/               The 8 analysis modules + Payment_Gateway
  datasource/            Interfaces, RetryPolicy, in-memory mocks (test fixtures)
  datasource/providers/  Real read-only providers (Etherscan/viem, CoinGecko, risk list)
  examples/requester.ts  Example Requester agent (A2A composability demo)
```

## Prerequisites

- Node.js 18+ (developed on Node 22).
- For local development and tests: no keys or network needed (mock data sources drive all tests).
- For a live run: a registered CROO Agent + configured Services, and read-only data-source API keys
  (see [Environment variables](#environment-variables)).

## Setup

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest (unit + property-based tests, no network)
```

## Environment variables

All secrets are injected via environment variables and are **never hard-coded**.

| Variable | Required | Source | Purpose |
|----------|----------|--------|---------|
| `CROO_SDK_KEY` | yes | Register the Agent (shown once) | CAP SDK auth (`X-SDK-Key`) |
| `CROO_API_URL` | no (default `https://api.croo.network`) | — | CAP API base URL |
| `CROO_WS_URL` | no (default `wss://api.croo.network/ws`) | — | CAP WebSocket URL |
| `SERVICE_ID_QUICK` / `SERVICE_ID_FULL` / `SERVICE_ID_MULTI` | yes | Configure Services in the Dashboard | Map a paid Service to a tier |
| `ETHERSCAN_API_KEY` | yes | Etherscan | Audited-chain history (txs, source, creation) |
| `ALCHEMY_RPC_URL` | recommended | Alchemy / any RPC | viem read-only calls (allowances, balances, code) |
| `COINGECKO_API_KEY` | optional | CoinGecko | USD valuations (raises rate limits) |
| `RPC_URL` | no (default Base mainnet) | — | SDK settlement-side RPC (Base) |

## Running the Provider

```bash
# after `npm run build` and exporting the env vars above
node dist/main.js
```

### Quickstart for a live run

The repo ships a `.env.example` and helper scripts so a live run is a few commands. Node 18.20+/20.6+
loads the file automatically via `--env-file` (no extra dependency).

```bash
cp .env.example .env       # then fill in your keys / Service IDs
npm run preflight          # validate .env (reports exactly what's missing; never prints secrets)
npm run build              # compile to dist/
npm start                  # start the Provider (auto-loads .env)
```

- `npm run preflight` — checks required vs optional variables and names the manual step each one
  comes from; exits non-zero until the required set is present.
- `npm start` — builds-then-runs is also available via `npm run dev`.
- `npm run requester` — runs the example Requester agent (A2A demo); set `CROO_TARGET_SERVICE_ID`,
  `CROO_TARGET_ORDER_ID`, and a wallet (`CROO_AUDIT_WALLET` or the first CLI arg).

`.env` is gitignored — never commit real keys.

The Provider connects to the CAP WebSocket and runs the loop:

```
negotiation_created  → accept (if the service + parameters are valid) or reject
order_paid           → run the audit → DeliverOrder (structured JSON + Markdown)
                       → CAPVault settles to the agent's AA wallet
                       (if all data sources fail → RejectOrder → escrow refunded)
```

## CAP SDK methods used

This agent acts as a **Provider** and uses the following `@croo-network/sdk` `AgentClient` methods
(see `src/cap/provider.ts`):

- `connectWebSocket()` — subscribe to CAP events (`EventType.NegotiationCreated`, `OrderPaid`, `OrderRejected`, `OrderExpired`).
- `getNegotiation(id)` / `acceptNegotiation(id)` / `rejectNegotiation(id, reason)` — negotiation handling.
- `getOrder(id)` — fetch the paid order (service id, payer wallet, requirements).
- `deliverOrder(id, { deliverableType, deliverableSchema, deliverableText })` — deliver the report.
- `uploadFile(name, body)` — upload large / multi-wallet reports (object key embedded in the delivery).
- `rejectOrder(id, reason)` — reject a paid order so CAPVault refunds the escrow.

The example Requester (`src/examples/requester.ts`) demonstrates the other side — `negotiateOrder`
→ `payOrder` → `getDelivery` — and consumes the structured report's `riskLevelSummary` /
`healthScore` to gate a downstream decision (A2A composability).

## Calling the agent over CAP

1. Find the agent on the CROO Agent Store and pick a tier's `Service_ID`.
2. `negotiateOrder({ serviceId, requirements })` where `requirements` is a JSON string:
   - single wallet: `{"walletAddress":"0x..."}`
   - multiple wallets (Multi tier): `{"walletAddresses":["0x...","0x..."]}`
3. After the Provider accepts, `payOrder(orderId)` (0.5 / 2 / 5 USDC on Base).
4. `getDelivery(orderId)` — `deliverableSchema` is the machine-readable JSON report
   (`AuditReportStructured` / `MultiWalletReport`), `deliverableText` is a human-readable Markdown
   report. Both carry a `schemaVersion` and a `riskLevelSummary`.

## Ordering portal (web UI for phone + desktop)

The repo includes a responsive ordering portal so humans can place orders from a browser without
writing any CAP code. It follows an Apple-inspired design system (`docs/DESIGN.md`).

```
src/portal/
  cap-requester.ts   Portal-side CAP Requester: negotiate -> pay -> deliver, end to end
  config.ts          Portal config (its own funded Requester key + target Service_IDs)
  server.ts          Framework-free HTTP server (static SPA + JSON API)
  main.ts            Runnable portal entrypoint (buildPortal / main)
  public/            The responsive single-page UI (index.html, styles.css, app.js)
```

How it works (the **managed-requester** model): the portal backend is itself a registered CAP
**Requester**. When a user submits a wallet + tier, the backend runs the full Requester flow against
your live Provider — `negotiateOrder` -> `payOrder` (USDC on Base) -> `getDelivery` — and renders the
returned structured report. All audit work stays in the Provider; the portal only places and pays
for orders.

```bash
# the audit Provider must be running and its Services configured (so the portal can hire it)
cp .env.example .env        # set PORTAL_CROO_SDK_KEY (a funded Requester) + SERVICE_ID_*
npm run build
npm run portal              # serves http://localhost:8787 (auto-loads .env)
```

Endpoints: `GET /` (the UI), `GET /api/tiers` (pricing + availability), `POST /api/orders`
(`{ tier, walletAddress | walletAddresses }` → the report), `GET /api/health`.

### Portal environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORTAL_PAYMENT_MODE` | `free` | `free` attempts the CAP flow first, then falls back to a local audit if payment/delivery cannot complete; `paid` requires strict settlement. |
| `PORTAL_CROO_SDK_KEY` | falls back to `CROO_SDK_KEY` | The portal Requester's own funded Agent key (its AA wallet pays for orders). |
| `PORTAL_PORT` | `8787` | HTTP port the portal listens on. |
| `PORTAL_ORDER_TIMEOUT_MS` | `120000` | Timeout for the full negotiate → pay → deliver round trip. |

The portal reuses `SERVICE_ID_QUICK` / `SERVICE_ID_FULL` / `SERVICE_ID_MULTI` to know which tiers it
can hire.

### Free mode (default demo behavior)

By default the portal runs in `free` mode so the original user flow can continue even when the
Requester wallet is not funded or payment fails:

```bash
npm run portal
```

In free mode the portal still **attempts the full paid CAP flow first**. When it cannot complete —
payment fails, the negotiation/order is rejected or expires, the request times out, or a tier has no
configured `Service_ID` — it falls back to running the **same read-only audit locally** and returns
that report instead of failing. Behavior worth knowing:

- Every response carries `paid: true | false` (and a `fallbackReason` when it fell back), so you
  always know whether a result came from a settled CAP order or a free local audit. The UI shows a
  "Paid · settled on Base" vs "Free local audit (unpaid)" chip accordingly.
- `PORTAL_CROO_SDK_KEY` / `CROO_SDK_KEY` is **not required** in free mode, all tiers become bookable
  even without `SERVICE_ID_*`, and a failed CAP WebSocket connection at startup is tolerated.
- The local fallback reuses the exact same orchestrator and audit logic the Provider runs on a paid
  order, so it stays strictly read-only.

Use strict paid settlement in production:

```bash
PORTAL_PAYMENT_MODE=paid npm run portal
```

> **Free mode bypasses paid settlement and must NEVER be used in production.** The active mode is
> logged at startup.

> **Security:** the portal pays real USDC per order and ships with **no authentication or rate
> limiting**. Keep it on localhost or put it behind your own auth — do not expose it to the public
> internet as-is. This is logged at startup.

## Testing & correctness

The core logic is verified with **property-based testing** (fast-check, ≥100 runs per property) in
addition to unit and end-to-end tests. The full suite runs without any network access.

```bash
npm test
```

Highlighted properties include: health-score determinism and monotonicity; report structure
invariants and JSON round-trip; the pay-deliver / settle-refund invariants (never deliver without
escrow; full-amount settlement when any module succeeds; refund when all data sources fail); and
the read-only guarantee (no private-key / signed-transaction fields in any output).

## Security & read-only boundary

- The agent reads only public on-chain data on Ethereum Mainnet; there is no signing path and no
  `eth_sendRawTransaction` anywhere.
- It never requests, receives, or stores private keys or seed phrases.
- Revocation is offered only as a link (revoke.cash-style deep link) that you confirm in your own
  wallet — the agent never broadcasts a transaction.
- API keys are injected via environment variables; they are not persisted or logged.

## Manual (non-code) steps before submission

Some steps cannot be automated (see `docs/hackathon-requirements.md` for the full checklist):
register the Agent and configure the three Services in the CROO Agent Store, obtain the data-source
API keys, run a real USDC end-to-end settlement, and publish this repository + a demo video.

## License

[MIT](./LICENSE)
