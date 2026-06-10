/**
 * Example Requester Agent — A2A composability demo (task 19.1, requirements 5.1 / 5.2 / 5.4).
 *
 * This module demonstrates the OTHER side of the CAP exchange: an arbitrary Agent that *hires* our
 * Web3 Address Intel Agent (the Provider) through the CROO Agent Protocol, then consumes the
 * structured deliverable's `Risk_Level` / `Health_Score` to make a downstream decision (e.g. proceed
 * with or abort some action that depends on the audited wallet being safe).
 *
 * Requester-side CAP call chain (docs/cap-protocol.md section 5, "Requester" column):
 *
 *   negotiateOrder(serviceId, requirements)   // start a negotiation for the target Service
 *      → [Provider accepts → backend auto-creates the order → order_created event]
 *   payOrder(orderId)                          // lock USDC into CAPVault escrow
 *      → [Provider runs the audit → DeliverOrder → order_completed event]
 *   getDelivery(orderId)                       // fetch the deliverable (schema + text)
 *      → parse deliverableSchema JSON → AuditReportStructured / MultiWalletReport
 *      → decideFromReport(...) → proceed / abort
 *
 * Testability: the core flow depends ONLY on the minimal {@link RequesterCapClient} interface
 * (exactly the three SDK methods the Requester uses), NOT on the concrete `AgentClient`. The real
 * SDK client structurally satisfies this interface, so the logic is unit/property-tested against a
 * fake client with no real network. The SDK is imported lazily, only inside {@link main} under the
 * entry-point guard.
 *
 * Security note: this is a read-only consumer of the audit report. It never touches private keys and
 * never broadcasts a transaction; it only reads `Risk_Level` / `Health_Score` to gate a decision.
 */

import type { AuditReportStructured, MultiWalletReport, RiskLevel } from "../models.js";
import { RISK_LEVEL_ORDER } from "../models.js";
import { loadConfig } from "../config.js";

// ── Minimal Requester-side CAP client surface ───────────────────────────────────────────

/** Result of {@link RequesterCapClient.negotiateOrder}; only the negotiation id is consumed here. */
export interface NegotiateResult {
  /** The created negotiation's id (the real SDK `Negotiation.negotiationId`). */
  negotiationId?: string;
}

/** Deliverable as seen by the Requester; mirrors the SDK `Delivery` fields we read. */
export interface RequesterDelivery {
  /** Machine-readable structured JSON (our Provider puts the structured report here). */
  deliverableSchema?: string;
  /** Human-readable Markdown report. */
  deliverableText?: string;
}

/**
 * The exact CAP SDK methods the Requester uses. The concrete `AgentClient` structurally satisfies
 * this interface, so the rest of this module stays SDK-agnostic and testable with a fake client.
 *
 * Note on order creation (docs/cap-protocol.md sections 3.2 / 5): accepting a negotiation makes the
 * backend auto-create the order on-chain; the Requester learns the resulting `orderId` from the
 * `order_created` WebSocket event (or by listing orders). To keep this example focused and testable,
 * the `orderId` is supplied to {@link hireAuditAgent} (via `params.orderId` or an injected
 * `waitForOrderId` resolver) rather than re-implementing event plumbing in the core flow.
 */
export interface RequesterCapClient {
  negotiateOrder(req: {
    serviceId: string;
    requirements?: string;
    metadata?: string;
  }): Promise<NegotiateResult>;
  payOrder(orderId: string): Promise<unknown>;
  getDelivery(orderId: string): Promise<RequesterDelivery>;
}

// ── Decision policy (consuming Risk_Level / Health_Score) ────────────────────────────────

/**
 * Minimum acceptable Health_Score for the Requester to proceed. A wallet scoring below this
 * threshold is treated as too risky for the downstream action. Documented here so the gating policy
 * is explicit and tunable; 60 corresponds to the "FAIR/GOOD" boundary in the Health_Score grading
 * (0–39 POOR, 40–59 FAIR, 60–79 GOOD, 80–100 EXCELLENT).
 */
export const HEALTH_SCORE_THRESHOLD = 60;

/** Risk levels that, on their own, are severe enough for the Requester to abort. */
export const BLOCKING_RISK_LEVELS: readonly RiskLevel[] = ["HIGH", "CRITICAL"];

/** The decision the Requester reaches after consuming an audit report. */
export interface AuditDecision {
  /** true = safe enough to proceed with the downstream action; false = abort. */
  proceed: boolean;
  /** Human-readable explanation of the decision (suitable for logs). */
  reason: string;
  /** The worst Risk_Level the decision was based on. */
  riskLevel: RiskLevel;
  /** The (lowest, across wallets) Health_Score the decision was based on. */
  healthScore: number;
}

/** Whether a Risk_Level is severe enough to block on its own. */
export function isBlockingRiskLevel(level: RiskLevel): boolean {
  return BLOCKING_RISK_LEVELS.includes(level);
}

/**
 * Pure decision function over a single structured audit report (requirements 5.2 / 5.4).
 *
 * Gating policy: abort (proceed = false) when the report's `riskLevelSummary` is HIGH or CRITICAL,
 * OR when its `healthScore` is below {@link HEALTH_SCORE_THRESHOLD}. Otherwise proceed.
 *
 * Equivalently, proceed = true requires BOTH `riskLevelSummary ∈ {LOW, MEDIUM}` AND
 * `healthScore >= HEALTH_SCORE_THRESHOLD`.
 */
export function decideFromReport(structured: AuditReportStructured): AuditDecision {
  const riskLevel = structured.riskLevelSummary;
  const healthScore = structured.healthScore;

  const riskBlocks = isBlockingRiskLevel(riskLevel);
  const scoreBlocks = healthScore < HEALTH_SCORE_THRESHOLD;

  if (riskBlocks || scoreBlocks) {
    const reasons: string[] = [];
    if (riskBlocks) reasons.push(`risk level is ${riskLevel}`);
    if (scoreBlocks) {
      reasons.push(
        `health score ${healthScore} is below the threshold of ${HEALTH_SCORE_THRESHOLD}`,
      );
    }
    return {
      proceed: false,
      reason: `Aborting: ${reasons.join(" and ")} for wallet ${structured.walletAddress}.`,
      riskLevel,
      healthScore,
    };
  }

  return {
    proceed: true,
    reason: `Proceeding: wallet ${structured.walletAddress} is acceptable (risk level ${riskLevel}, health score ${healthScore}).`,
    riskLevel,
    healthScore,
  };
}

/**
 * Aggregate a decision over several structured reports (used for the MULTI tier / multi-wallet
 * deliverables). The Requester proceeds only when EVERY wallet is acceptable; the aggregate
 * `riskLevel` is the worst across wallets and the aggregate `healthScore` is the lowest. An empty
 * set of reports is treated as "no data" → abort.
 */
export function decideFromReports(reports: readonly AuditReportStructured[]): AuditDecision {
  if (reports.length === 0) {
    return {
      proceed: false,
      reason: "Aborting: the delivery contained no wallet reports.",
      riskLevel: "LOW",
      healthScore: 0,
    };
  }

  const decisions = reports.map(decideFromReport);
  const proceed = decisions.every((d) => d.proceed);
  const worstRisk = reports.reduce<RiskLevel>(
    (worst, r) =>
      RISK_LEVEL_ORDER[r.riskLevelSummary] > RISK_LEVEL_ORDER[worst] ? r.riskLevelSummary : worst,
    "LOW",
  );
  const lowestScore = reports.reduce<number>(
    (min, r) => Math.min(min, r.healthScore),
    Number.POSITIVE_INFINITY,
  );

  const reason = proceed
    ? `Proceeding: all ${reports.length} audited wallet(s) are acceptable (worst risk ${worstRisk}, lowest health score ${lowestScore}).`
    : `Aborting: at least one of ${reports.length} audited wallet(s) is too risky (worst risk ${worstRisk}, lowest health score ${lowestScore}).`;

  return { proceed, reason, riskLevel: worstRisk, healthScore: lowestScore };
}

// ── Deliverable parsing ──────────────────────────────────────────────────────────────────

/** Thrown when a CAP delivery cannot be parsed into a structured audit report. */
export class DeliveryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryParseError";
  }
}

/** Type guard: a parsed object is a multi-wallet report (carries `walletCount` + `reports`). */
function isMultiWalletReport(value: unknown): value is MultiWalletReport {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { reports?: unknown }).reports) &&
    typeof (value as { walletCount?: unknown }).walletCount === "number"
  );
}

/**
 * Parse a CAP delivery's structured schema JSON into a single report or a multi-wallet report.
 * Throws {@link DeliveryParseError} when the schema is missing or not valid JSON.
 */
export function parseDelivery(
  delivery: RequesterDelivery,
): AuditReportStructured | MultiWalletReport {
  const schema = delivery.deliverableSchema;
  if (schema === undefined || schema.trim().length === 0) {
    throw new DeliveryParseError("Delivery has no deliverableSchema to parse.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(schema);
  } catch (err) {
    throw new DeliveryParseError(
      `Delivery deliverableSchema is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (isMultiWalletReport(parsed)) return parsed;
  return parsed as AuditReportStructured;
}

/** Extract the optional human-clickable report page URL delivered by the Provider. */
export function extractResultPageUrl(
  parsed: AuditReportStructured | MultiWalletReport,
): string | undefined {
  const value = (parsed as unknown as Record<string, unknown>).resultPageUrl;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Decide from a parsed delivery, dispatching on single vs multi-wallet report. */
export function decideFromDelivery(
  parsed: AuditReportStructured | MultiWalletReport,
): AuditDecision {
  if (isMultiWalletReport(parsed)) return decideFromReports(parsed.reports);
  return decideFromReport(parsed);
}

// ── Hire flow ──────────────────────────────────────────────────────────────────────────

/** Parameters for {@link hireAuditAgent}. */
export interface HireAuditAgentParams {
  /** The target Service_ID of our Address Intel Agent. */
  serviceId: string;
  /** The address target(s) to inspect; passed through the negotiation `requirements` JSON. */
  walletAddresses: string[];
  /**
   * The order id to pay/fetch. In a real run this arrives via the `order_created` WS event after
   * the Provider accepts the negotiation; supply it directly here for a deterministic example/test.
   * Exactly one of `orderId` or `waitForOrderId` must be provided.
   */
  orderId?: string;
  /**
   * Optional async resolver that yields the order id (e.g. by awaiting the `order_created` event or
   * polling `listOrders`) given the negotiation id. Used when `orderId` is not known up front.
   */
  waitForOrderId?: (negotiationId: string | undefined) => Promise<string>;
}

/**
 * Hire our Web3 Address Intel Agent over CAP and turn the structured deliverable into a decision
 * (task 19.1, requirements 5.1 / 5.2 / 5.4).
 *
 * Steps:
 *   1. `negotiateOrder` for `serviceId`, passing the address targets in the `requirements` JSON.
 *   2. Resolve the `orderId` (from `params.orderId` or the injected `waitForOrderId` resolver).
 *   3. `payOrder(orderId)` to lock USDC into CAPVault escrow.
 *   4. `getDelivery(orderId)` and parse `deliverableSchema` into the structured report.
 *   5. Consume `riskLevelSummary` / `healthScore` via {@link decideFromDelivery} to decide.
 */
export async function hireAuditAgent(
  client: RequesterCapClient,
  params: HireAuditAgentParams,
): Promise<AuditDecision> {
  // 1) Start the negotiation, conveying the audit parameters through `requirements`.
  const requirements = JSON.stringify({ walletAddresses: params.walletAddresses });
  const negotiation = await client.negotiateOrder({ serviceId: params.serviceId, requirements });

  // 2) Learn the order id (auto-created by the backend once the Provider accepts).
  const orderId = await resolveOrderId(params, negotiation.negotiationId);

  // 3) Pay; the SDK handles USDC approve + CAPVault escrow on Base.
  await client.payOrder(orderId);

  // 4) Fetch and parse the deliverable.
  const delivery = await client.getDelivery(orderId);
  const parsed = parseDelivery(delivery);

  // 5) Consume Risk_Level / Health_Score to gate the downstream action.
  return decideFromDelivery(parsed);
}

/** Resolve the order id from explicit params or the injected resolver. */
async function resolveOrderId(
  params: HireAuditAgentParams,
  negotiationId: string | undefined,
): Promise<string> {
  if (params.orderId !== undefined && params.orderId.trim().length > 0) {
    return params.orderId;
  }
  if (params.waitForOrderId !== undefined) {
    return params.waitForOrderId(negotiationId);
  }
  throw new Error(
    "hireAuditAgent requires either params.orderId or params.waitForOrderId to learn the created order id.",
  );
}

// ── Entry point (real SDK wiring lives ONLY here) ────────────────────────────────────────

/**
 * Runnable entry point: build a real CAP client and hire the Address Intel Agent for an address read from the
 * environment / argv, then print the decision. The SDK is imported lazily so importing this module
 * (e.g. from tests) never pulls in the network client.
 *
 * Configuration (injected via env; never hard-coded):
 *   - MANUAL(H1-1): CROO_REQUESTER_SDK_KEY — produced when registering the Requester Agent.
 *     Falls back to CROO_SDK_KEY for backward compatibility.
 *   - CROO_TARGET_SERVICE_ID — the target Service_ID of our Address Intel Agent to hire.
 *   - CROO_TARGET_ORDER_ID — the created order id (from the order_created event in a real run).
 *   - address target to inspect — first CLI argument, else CROO_AUDIT_WALLET.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfig();
  const requesterKey = process.env.CROO_REQUESTER_SDK_KEY ?? config.crooSdkKey;
  const serviceId = process.env.CROO_TARGET_SERVICE_ID;
  const orderId = process.env.CROO_TARGET_ORDER_ID;
  const wallet = argv[0] ?? process.env.CROO_AUDIT_WALLET;

  if (serviceId === undefined || serviceId.trim().length === 0) {
    throw new Error(
      "Set CROO_TARGET_SERVICE_ID to the Service_ID of the Address Intel Agent to hire.",
    );
  }
  if (wallet === undefined || wallet.trim().length === 0) {
    throw new Error(
      "Provide an address target to inspect as the first CLI argument or via CROO_AUDIT_WALLET.",
    );
  }
  if (orderId === undefined || orderId.trim().length === 0) {
    throw new Error(
      "Set CROO_TARGET_ORDER_ID (obtained from the order_created event after the Provider accepts).",
    );
  }

  // Lazily import the SDK so the core logic / tests stay free of the network client.
  const { AgentClient } = await import("@croo-network/sdk");
  const client = new AgentClient(
    { baseURL: config.crooApiUrl, wsURL: config.crooWsUrl, rpcURL: config.rpcUrl },
    requesterKey,
  ) as unknown as RequesterCapClient;

  const decision = await hireAuditAgent(client, {
    serviceId,
    walletAddresses: [wallet],
    orderId,
  });

  console.info(`[requester] decision: proceed=${decision.proceed} — ${decision.reason}`);
}

// Entry-point guard: run main() only when this file is executed directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(`[requester] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
