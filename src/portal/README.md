# HTTP Portal & Web UI

This directory implements the local Web UI and REST API. It serves as an adapter over the core audit engine, allowing browsers and local scripts to trigger audit runs.

## Contents

- [`server.ts`](./server.ts): Express-like HTTP server with endpoints for health checks, tier details, address vetting, and order creation. Supports SSE (Server-Sent Events) streaming.
- [`local-auditor.ts`](./local-auditor.ts): Adapts the core `AuditOrchestrator` to the API layer, managing local audit states without duplicating the Provider event loops.
- [`multichain-auditor.ts`](./multichain-auditor.ts): Manages instance pools of orchestrators across the supported EVM chains.
- [`cap-checkout.ts`](./cap-checkout.ts): Manages local checkouts when a consumer supplies their own CROO key.
- [`metamask-payment.ts`](./metamask-payment.ts): Direct-transfer verifier that validates USDC payments by checking RPC transfer receipts.
- [`public/`](./public/): Static client assets, including the browser wizard dashboard (`app.js`, `styles.css`) and a standalone report rendering interface (`report-render.js`).
