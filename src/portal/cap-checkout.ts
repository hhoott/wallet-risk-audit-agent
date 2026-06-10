/**
 * Per-request CAP checkout driver.
 *
 * When a user places a paid order (web wizard or API), they supply their OWN CROO key at pay time
 * (never stored / configured). That key identifies a Requester Agent whose AA wallet holds USDC.
 * This driver acts as that Requester and runs the real CAP flow against OUR Provider:
 *
 *   negotiateOrder(serviceId, requirements)
 *     → [our Provider auto-accepts → backend creates the order on-chain]
 *   (poll listOrders to learn the orderId for this negotiation)
 *   payOrder(orderId)                         // SDK pulls USDC from the Requester AA wallet → escrow
 *     → [our Provider audits on order_paid → DeliverOrder]
 *   (poll getOrder until completed)
 *   getDelivery(orderId)                      // the CAP-delivered report (proof we were really hired)
 *
 * It is stateless and polling-based (no persistent WebSocket for the ephemeral user key), and emits
 * step-by-step progress so the web UI can show a wizard / progress bar. Each failure is classified
 * (bad key → UNAUTHORIZED, empty AA wallet → INSUFFICIENT_BALANCE, etc.) so the caller can decide:
 * free mode falls back to a local audit; paid mode asks the user to re-enter the key / top up.
 *
 * Security: read-only audit; the user's key is used only for this single checkout and is never
 * persisted or logged.
 */

import type { AuditReportStructured, MultiWalletReport } from "../models.js";
import { parseDelivery, decideFromDelivery, type AuditDecision } from "../examples/requester.js";

// ── Progress ────────────────────────────────────────────────────────────────────────────

/** Ordered steps of a CAP checkout, surfaced to the UI progress bar. */
export type CheckoutStep =
  | "negotiating" // creating the negotiation with the user's key
  | "accepted" // our Provider accepted; order created on-chain
  | "paying" // submitting payOrder (USDC escrow)
  | "paid" // escrow locked; Provider is auditing
  | "delivering" // waiting for the Provider to deliver
  | "delivered"; // delivery fetched

/** A single progress update. */
export interface CheckoutProgress {
  step: CheckoutStep;
  message: string;
  orderId?: string;
  txHash?: string;
}

/** Progress callback. */
export type ProgressFn = (p: CheckoutProgress) => void;

// ── Minimal Requester-side CAP client surface (the exact SDK methods we use) ────────────

/** The CAP SDK methods this driver uses (the real `AgentClient` structurally satisfies it). */
export interface CheckoutCapClient {
  negotiateOrder(req: {
    serviceId: string;
    requirements?: string;
  }): Promise<{ negotiationId: string }>;
  listOrders(opts?: {
    status?: string;
    role?: string;
    page?: number;
    pageSize?: number;
  }): Promise<Array<{ orderId: string; negotiationId: string; status: string }>>;
  getOrder(
    orderId: string,
  ): Promise<{ orderId: string; status: string; payTxHash?: string; clearTxHash?: string }>;
  payOrder(orderId: string): Promise<{ txHash: string }>;
  getDelivery(orderId: string): Promise<{ deliverableSchema?: string; deliverableText?: string }>;
}

/** Factory: build a real Requester `AgentClient` from a user-supplied key, typed as our client. */
export async function createCheckoutClient(
  crooKey: string,
  config: { crooApiUrl: string; crooWsUrl: string; rpcUrl?: string },
): Promise<CheckoutCapClient> {
  const { AgentClient } = await import("@croo-network/sdk");
  const client = new AgentClient(
    { baseURL: config.crooApiUrl, wsURL: config.crooWsUrl, rpcURL: config.rpcUrl },
    crooKey,
  );
  return client as unknown as CheckoutCapClient;
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────

/** Machine-readable failure code so the HTTP layer + UI can react precisely. */
export type CheckoutErrorCode =
  | "UNAUTHORIZED" // the supplied CROO key is invalid / not recognized
  | "INSUFFICIENT_BALANCE" // the Requester AA wallet has no / not enough USDC
  | "NEGOTIATION_REJECTED" // our Provider rejected the negotiation (bad params / service)
  | "ORDER_REJECTED" // the paid order was rejected (e.g. all data sources down → refund)
  | "TIMEOUT" // the order did not reach a terminal state in time
  | "ERROR"; // anything else

/** A checkout failure carrying a code + which step it failed at. */
export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly code: CheckoutErrorCode,
    readonly step: CheckoutStep,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

/** Classify an unknown SDK error into a CheckoutErrorCode using the SDK's own helpers. */
async function classify(err: unknown): Promise<CheckoutErrorCode> {
  try {
    const sdk = await import("@croo-network/sdk");
    if (sdk.isUnauthorized?.(err)) return "UNAUTHORIZED";
    if (sdk.isInsufficientBalance?.(err)) return "INSUFFICIENT_BALANCE";
  } catch {
    /* fall through to message-based heuristics */
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("unauthor") || msg.includes("sdkkey") || msg.includes("api key"))
    return "UNAUTHORIZED";
  if (msg.includes("insufficient") || msg.includes("balance")) return "INSUFFICIENT_BALANCE";
  return "ERROR";
}

// ── Checkout flow ─────────────────────────────────────────────────────────────────────────

/** Successful CAP checkout result: the delivered report + the on-chain order proof. */
export interface CheckoutResult {
  orderId: string;
  /** Machine-readable structured report parsed from the CAP delivery. */
  structured: AuditReportStructured | MultiWalletReport;
  /** Human-readable Markdown report. */
  humanReadable: string;
  /** A2A gating decision derived from Risk_Level / Health_Score. */
  decision: AuditDecision;
  /** The USDC payment tx hash (proof of settlement). */
  payTxHash: string;
}

/** Parameters for {@link runCapCheckout}. */
export interface CheckoutParams {
  serviceId: string;
  walletAddresses: string[];
  /** Poll interval (ms) while waiting for order creation / completion. */
  pollIntervalMs?: number;
  /** Overall timeout (ms) for the whole checkout. */
  timeoutMs?: number;
}

const TERMINAL_FAIL = new Set([
  "rejected",
  "expired",
  "create_failed",
  "pay_failed",
  "deliver_failed",
]);

/** Sleep helper. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run a full CAP checkout as the Requester identified by `client` (built from the user's key).
 * Emits progress for the UI and throws {@link CheckoutError} (classified) on any failure.
 */
export async function runCapCheckout(
  client: CheckoutCapClient,
  params: CheckoutParams,
  onProgress: ProgressFn = () => {},
): Promise<CheckoutResult> {
  const pollIntervalMs = params.pollIntervalMs ?? 2_000;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const requirements = JSON.stringify({ walletAddresses: params.walletAddresses });

  // 1) Negotiate (this is where an invalid key fails fast).
  onProgress({ step: "negotiating", message: "Creating the order negotiation over CAP…" });
  let negotiationId: string;
  try {
    const neg = await client.negotiateOrder({ serviceId: params.serviceId, requirements });
    negotiationId = neg.negotiationId;
  } catch (err) {
    throw new CheckoutError(
      `Negotiation failed: ${err instanceof Error ? err.message : String(err)}`,
      await classify(err),
      "negotiating",
    );
  }

  // 2) Our Provider auto-accepts and the backend creates the order; learn its orderId by polling
  //    the Requester's order list for this negotiation.
  onProgress({ step: "accepted", message: "Provider accepted; waiting for the on-chain order…" });
  const orderId = await waitForOrder(client, negotiationId, deadline, pollIntervalMs);

  // 3) Pay: SDK pulls USDC from the Requester AA wallet into CAPVault escrow (empty wallet fails here).
  onProgress({ step: "paying", message: "Paying in USDC (escrow on Base)…", orderId });
  let payTxHash: string;
  try {
    const pay = await client.payOrder(orderId);
    payTxHash = pay.txHash;
  } catch (err) {
    throw new CheckoutError(
      `Payment failed: ${err instanceof Error ? err.message : String(err)}`,
      await classify(err),
      "paying",
    );
  }
  onProgress({
    step: "paid",
    message: "Payment locked in escrow; the agent is auditing…",
    orderId,
    txHash: payTxHash,
  });

  // 4) Wait for the Provider to deliver (order_completed), then fetch the delivery.
  onProgress({
    step: "delivering",
    message: "Waiting for the audit report to be delivered…",
    orderId,
  });
  await waitForCompletion(client, orderId, deadline, pollIntervalMs);

  const delivery = await client.getDelivery(orderId);
  const structured = parseDelivery(delivery);
  const decision = decideFromDelivery(structured);
  onProgress({ step: "delivered", message: "Report delivered.", orderId, txHash: payTxHash });

  return {
    orderId,
    structured,
    humanReadable: delivery.deliverableText ?? "",
    decision,
    payTxHash,
  };
}

/** Poll the Requester's orders until the one created for `negotiationId` appears; return its id. */
async function waitForOrder(
  client: CheckoutCapClient,
  negotiationId: string,
  deadline: number,
  pollIntervalMs: number,
): Promise<string> {
  while (Date.now() < deadline) {
    let orders: Array<{ orderId: string; negotiationId: string; status: string }>;
    try {
      orders = await client.listOrders({ role: "buyer", pageSize: 50 });
    } catch (err) {
      throw new CheckoutError(
        `Could not list orders: ${err instanceof Error ? err.message : String(err)}`,
        await classify(err),
        "accepted",
      );
    }
    const match = orders.find((o) => o.negotiationId === negotiationId);
    if (match !== undefined) {
      if (TERMINAL_FAIL.has(match.status)) {
        throw new CheckoutError(
          `The negotiation did not result in a payable order (status: ${match.status}).`,
          "NEGOTIATION_REJECTED",
          "accepted",
        );
      }
      return match.orderId;
    }
    await delay(pollIntervalMs);
  }
  throw new CheckoutError("Timed out waiting for the order to be created.", "TIMEOUT", "accepted");
}

/** Poll an order until it is completed; throw on a terminal failure or timeout. */
async function waitForCompletion(
  client: CheckoutCapClient,
  orderId: string,
  deadline: number,
  pollIntervalMs: number,
): Promise<void> {
  while (Date.now() < deadline) {
    let order: { status: string };
    try {
      order = await client.getOrder(orderId);
    } catch (err) {
      throw new CheckoutError(
        `Could not fetch the order: ${err instanceof Error ? err.message : String(err)}`,
        await classify(err),
        "delivering",
      );
    }
    if (order.status === "completed") return;
    if (TERMINAL_FAIL.has(order.status)) {
      throw new CheckoutError(
        `The order was not completed (status: ${order.status}); escrow is refunded.`,
        "ORDER_REJECTED",
        "delivering",
      );
    }
    await delay(pollIntervalMs);
  }
  throw new CheckoutError(
    "Timed out waiting for the audit to be delivered.",
    "TIMEOUT",
    "delivering",
  );
}
