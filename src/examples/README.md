# A2A Requester Example

This directory contains the requester-side demo for CROO Agent Protocol (CAP) composability.

The Provider side of this project sells wallet risk audits. The requester example shows the other side: a separate agent hires that Provider over A2A, pays through CAP, reads the delivered structured report, and decides whether to proceed with a downstream action.

## Important Command Name

The full live demo npm script is:

```bash
npm run requester:live
```

The offline replay script is:

```bash
npm run requester:dry-run
```

There is no `npm run require` script in the current `package.json`.

## What The Example Demonstrates

`src/examples/run-live-a2a.ts` runs the full CAP Requester flow:

1. `negotiateOrder({ serviceId, requirements })`
2. poll requester orders until the Provider-created order is `created`
3. `payOrder(orderId)`
4. wait until the order is `completed`
5. `getDelivery(orderId)`
6. parse `deliverableSchema`
7. print the result-page URL delivered by the Provider
8. save/replay the same successful exchange through `result/<orderId>.json`

`src/examples/requester.ts` still contains the lower-level pure decision helpers and minimal requester flow used by tests.

## Build First

```bash
npm run build
```

The built entry point is:

```text
dist/examples/requester.js
```

## Required Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `CROO_REQUESTER_SDK_KEY` | Yes | API key for the Requester Agent that will hire the audit Provider. Its AA wallet must be funded for live payment. Falls back to `CROO_SDK_KEY` for old env files. |
| `CROO_TARGET_SERVICE_ID` | Yes | The target audit Provider's CAP Service ID. Use the Provider's single `SERVICE_ID`. |
| `CROO_AUDIT_WALLET` | If no CLI arg | Wallet address to audit. A CLI argument takes priority. |
| `RESULT_BASE_URL` | No | Public result URL base. Defaults to `https://intel.say2agent.com`. |
| `CROO_API_URL` | No | CAP API base URL. Defaults to `https://api.croo.network`. |
| `CROO_WS_URL` | No | CAP WebSocket URL. Defaults to `wss://api.croo.network/ws`. |
| `RPC_URL` | No | Base settlement RPC override for the CROO SDK. |

## Run

```bash
export CROO_REQUESTER_SDK_KEY="croo_sk_requester_agent_key"
export CROO_TARGET_SERVICE_ID="svc_target_audit_service"

npm run requester:live -- 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

Or provide the wallet through the environment:

```bash
export CROO_AUDIT_WALLET="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
npm run requester:live
```

Expected success output:

```text
==================== REPORT URL ====================
https://intel.say2agent.com/report?file=<orderId>.json
====================================================
```

The Provider writes the full report JSON to `result/<orderId>.json` before delivery and updates it after delivery succeeds. The delivered schema includes `resultPageUrl` and `resultJsonUrl`. When LLM is enabled, the saved JSON also includes `addressIntel[].evidenceLog` and `addressIntel[].aiVerdict` so the official/risk badge can be reviewed against the facts the model used.
Runtime logs are kept in `result/provider.log` and `result/requester-live-*.log`.

## Dry Run Replay

After one successful live run, replay the saved communication flow offline:

```bash
npm run requester:dry-run
```

Replay a specific file:

```bash
npm run requester:dry-run -- --result-file <orderId>.json
```

This dry run does not connect to CROO, does not pay, and does not consume the Requester wallet balance. It prints simulated negotiation/payment/delivery logs, the saved structured JSON, and the same report URL for video rehearsal.
Dry-run logs are written as `result/requester-dry-run-*.log`.

## Decision Policy

The requester blocks when either condition is true:

- `riskLevelSummary` is `HIGH` or `CRITICAL`
- `healthScore` is below `60`

Otherwise it proceeds. This logic is implemented in:

- `decideFromReport`
- `decideFromReports`
- `decideFromDelivery`

These functions are pure and can be reused by another requester agent without the CLI wrapper.

The delivered JSON also includes `addressStanding` for the audited address. With LLM enabled, the
Provider applies this field from the evidence-log classification. Use `addressStanding.badge.level`
for UI or policy labels:

| Badge level | Meaning |
| --- | --- |
| `OFFICIAL` | Evidence supports an official protocol/service address. |
| `SAFE` | No material risk signals found in the available evidence. |
| `CAUTION` | Suspicious or incomplete signals need review. |
| `DANGEROUS` | Blacklisted or high-risk signals found. |
| `UNKNOWN` | Not enough data for a confident claim. |

## Single Wallet vs Multi Wallet

The reusable `hireAuditAgent` function accepts:

```ts
walletAddresses: string[]
```

The CLI demo sends one address target because it is optimized for a short competition demo. The parser and decision layer also support a `MultiWalletReport` delivery.

## How To Use In Another Agent

Import the reusable functions:

```ts
import {
  hireAuditAgent,
  decideFromDelivery,
  parseDelivery,
  type RequesterCapClient,
} from "./requester.js";
```

Then provide any object that satisfies the `RequesterCapClient` interface:

```ts
const decision = await hireAuditAgent(client, {
  serviceId: "svc_target_audit_service",
  walletAddresses: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
  orderId: "order_created_after_acceptance",
});

if (!decision.proceed) {
  throw new Error(decision.reason);
}
```

For a production requester, replace the explicit `orderId` with `waitForOrderId`, backed by `order_created` event handling or `listOrders` polling.

## Related Files

- `src/examples/requester.ts` - implementation
- `test/requester-example.test.ts` - tests for parser, decision policy, and requester flow
- `docs/cap-protocol.md` - CAP lifecycle reference
- `README.md` - project-level overview of A2A, API, and Web modes
