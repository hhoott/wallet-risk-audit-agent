# A2A Requester Example

This directory contains the requester-side demo for CROO Agent Protocol (CAP) composability.

The Provider side of this project sells wallet risk audits. The requester example shows the other side: a separate agent hires that Provider over A2A, pays through CAP, reads the delivered structured report, and decides whether to proceed with a downstream action.

## Important Command Name

The npm script is:

```bash
npm run requester
```

There is no `npm run require` script in the current `package.json`.

## What The Example Demonstrates

`src/examples/requester.ts` uses the minimal CAP Requester flow:

1. `negotiateOrder({ serviceId, requirements })`
2. wait for or provide the created `orderId`
3. `payOrder(orderId)`
4. `getDelivery(orderId)`
5. parse `deliverableSchema`
6. gate a downstream decision with `riskLevelSummary` and `healthScore`

The current runnable CLI keeps event handling intentionally small: it expects the created order ID in `CROO_TARGET_ORDER_ID`. In a full requester agent, that value would normally come from the `order_created` WebSocket event or from polling `listOrders` for the negotiation.

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
| `CROO_SDK_KEY` | Yes | API key for the Requester Agent that will hire the audit Provider. Its AA wallet must be funded for live payment. |
| `CROO_TARGET_SERVICE_ID` | Yes | The target audit Provider's CAP Service ID. Use one of the Provider's `SERVICE_ID_QUICK`, `SERVICE_ID_FULL`, or `SERVICE_ID_MULTI`. |
| `CROO_TARGET_ORDER_ID` | Yes for this CLI | The order ID created after the Provider accepts the negotiation. |
| `CROO_AUDIT_WALLET` | If no CLI arg | Wallet address to audit. A CLI argument takes priority. |
| `CROO_API_URL` | No | CAP API base URL. Defaults to `https://api.croo.network`. |
| `CROO_WS_URL` | No | CAP WebSocket URL. Defaults to `wss://api.croo.network/ws`. |
| `RPC_URL` | No | Base settlement RPC override for the CROO SDK. |

## Run

```bash
export CROO_SDK_KEY="croo_sk_requester_agent_key"
export CROO_TARGET_SERVICE_ID="svc_target_audit_service"
export CROO_TARGET_ORDER_ID="order_created_after_acceptance"

npm run requester -- 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

Or provide the wallet through the environment:

```bash
export CROO_AUDIT_WALLET="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
npm run requester
```

Expected success output:

```text
[requester] decision: proceed=true ...
```

If the wallet is too risky, the example prints `proceed=false` with the blocking reason.

## Decision Policy

The requester blocks when either condition is true:

- `riskLevelSummary` is `HIGH` or `CRITICAL`
- `healthScore` is below `60`

Otherwise it proceeds. This logic is implemented in:

- `decideFromReport`
- `decideFromReports`
- `decideFromDelivery`

These functions are pure and can be reused by another requester agent without the CLI wrapper.

## Single Wallet vs Multi Wallet

The reusable `hireAuditAgent` function accepts:

```ts
walletAddresses: string[]
```

The CLI demo sends one wallet address because it is optimized for a short competition demo. The parser and decision layer also support a `MultiWalletReport` delivery.

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
