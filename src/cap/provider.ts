/**
 * CAP adapter layer (Provider) — task 16 (16.1 / 16.2 / 16.3 / 16.4), per design.md
 * "CAP 集成设计" and docs/cap-protocol.md section 6 (the Provider run loop).
 *
 * This is the ONLY layer that depends on the CAP SDK (@croo-network/sdk). It wires the real SDK to
 * the pure decision components (Payment_Gateway: decideNegotiation / decideSettlement / recordSettlement)
 * and the Audit Orchestrator, and runs the WebSocket event loop:
 *
 *   connectWebSocket → route negotiation_created / order_paid (and order_rejected / order_expired
 *   for logging) → accept/reject negotiations, run audits, deliver reports or reject-and-refund.
 *
 * Testability: the core handling logic depends on a minimal {@link CapClient} interface (exactly the
 * SDK methods we use), NOT on the concrete `AgentClient`. The real `AgentClient` structurally
 * satisfies `CapClient`, so the only place that imports the SDK is the {@link createCapClient}
 * factory (plus the `EventType` / `DeliverableType` constants and the error-classification helpers).
 * Unit tests drive the pure handlers with a fake client — no real network / SDK.
 *
 * Security constraint (requirement 13.x): this layer never touches private keys or the settlement
 * chain directly. USDC payment / escrow / settlement on Base are handled by the CAP SDK + CAPVault.
 */

import {
  AgentClient,
  EventType,
  DeliverableType,
  APIError,
  isNotFound,
  isUnauthorized,
  isInsufficientBalance,
} from "@croo-network/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeConfig, Tier } from "../config.js";
import type {
  Address,
  AuditReportStructured,
  ModuleStatus,
  MultiWalletReport,
  SettlementRecord,
  WalletActivity,
  AddressStanding,
} from "../models.js";
import {
  decideNegotiation,
  decideSettlement,
  parseAuditRequirements,
  SettlementLedger,
} from "../modules/payment-gateway.js";
import type {
  AuditWalletOptions,
  AuditWalletResult,
  MultiWalletAuditResult,
  PerWalletAuditResult,
} from "../orchestrator.js";
import type { AddressIntelOutcome } from "../modules/address-intel.js";
import type { AddressInspection } from "../modules/address-inspector.js";
import {
  buildResultUrls,
  resultFileNameForOrder,
  writeResultJson,
  type ResultStoreOptions,
  type StoredReportPayload,
  RESULT_DIR_NAME,
} from "../result-store.js";
import type { AuditSkillSet, LlmAddressVerdict } from "../llm/skills.js";

// ── Minimal CAP client surface (exactly the SDK methods this layer uses) ────────────────

/**
 * A CAP WebSocket event as seen by this layer. The SDK emits richer `Event` objects (snake_case
 * fields); we only depend on the type discriminator and the three ids we need to fetch full
 * objects. The real SDK `EventStream` events structurally satisfy this shape.
 */
export interface CapEvent {
  type: string;
  negotiation_id?: string;
  order_id?: string;
  service_id?: string;
}

/** Minimal event-stream surface: subscribe to a typed event and close the stream. */
export interface CapEventStream {
  on(type: string, handler: (event: CapEvent) => void): void;
  close(): void;
}

/** Deliverable payload for {@link CapClient.deliverOrder}; mirrors the SDK `DeliverOrderRequest`. */
export interface CapDeliverRequest {
  deliverableType: string;
  deliverableSchema?: string;
  deliverableText?: string;
}

/**
 * The exact CAP SDK methods this layer uses. The concrete `AgentClient` structurally satisfies this
 * interface, so the rest of the layer can be unit-tested against a fake implementation.
 *
 * Events carry only ids, so the full Negotiation / Order objects are fetched on demand (per the
 * cap-protocol.md appendix): `getNegotiation` yields `serviceId` + `requirements`; `getOrder`
 * yields the payer wallet and (by convention) the `requirements` JSON carrying address targets.
 */
export interface CapClient {
  connectWebSocket(): Promise<CapEventStream>;
  getNegotiation(id: string): Promise<{ serviceId: string; requirements: string }>;
  acceptNegotiation(id: string): Promise<{ order: { orderId: string } }>;
  rejectNegotiation(id: string, reason: string): Promise<unknown>;
  getOrder(id: string): Promise<{
    orderId: string;
    serviceId: string;
    requesterWalletAddress: string;
    requirements?: string;
    status?: string;
  }>;
  deliverOrder(id: string, req: CapDeliverRequest): Promise<unknown>;
  rejectOrder(id: string, reason: string): Promise<unknown>;
  uploadFile(name: string, body: Buffer): Promise<string>;
}

/**
 * The subset of the Audit Orchestrator this layer depends on. `AuditOrchestrator` satisfies it; a
 * fake runner can be substituted in tests.
 */
export interface AuditRunner {
  auditWallet(
    address: Address,
    tier: Tier,
    options?: AuditWalletOptions,
  ): Promise<AuditWalletResult>;
  auditMultipleWallets(
    addresses: string[],
    options?: AuditWalletOptions,
  ): Promise<MultiWalletAuditResult>;
  /** Optional extended target: vet an address / assess a counterparty (Address_Intel). */
  vetAddress?(address: Address): Promise<AddressIntelOutcome>;
  /** Optional type-aware inspection: detect type + gather type-specific facts. */
  inspectAddress?(address: Address): Promise<AddressInspection>;
  /** Optional annotated wallet activity (transaction records + ranked counterparties). */
  walletActivity?(address: Address, windowDays?: number): Promise<WalletActivity>;
}

// ── Logging ─────────────────────────────────────────────────────────────────────────────

/** Minimal logger used by the adapter. Defaults to a no-op so handlers stay quiet in tests. */
export interface CapLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** A logger that discards everything (the default for the pure handlers). */
export const NOOP_LOGGER: CapLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function appendProviderLog(level: "info" | "warn" | "error", message: string): void {
  try {
    const dir = join(process.cwd(), RESULT_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "provider.log"), `[${new Date().toISOString()}] [${level}] ${message}\n`, "utf8");
  } catch {
    /* Logging to file is best-effort and must never break the Provider. */
  }
}

/** A console-backed logger for the running Provider (prefixes lines so they are easy to grep). */
export function createConsoleLogger(): CapLogger {
  return {
    info: (m: string) => {
      appendProviderLog("info", m);
      console.info(`[cap] ${m}`);
    },
    warn: (m: string) => {
      appendProviderLog("warn", m);
      console.warn(`[cap] ${m}`);
    },
    error: (m: string) => {
      appendProviderLog("error", m);
      console.error(`[cap] ${m}`);
    },
  };
}

// ── Handler result types (returned for observability + testing) ─────────────────────────

/** Outcome of handling a `negotiation_created` event. */
export type NegotiationHandlerResult =
  | { action: "ACCEPTED"; tier: Tier }
  | { action: "REJECTED"; reason: string }
  | { action: "ERROR"; error: string };

/** Outcome of handling an `order_paid` event. */
export type OrderHandlerResult =
  | { action: "DELIVERED"; tier: Tier; settlement: SettlementRecord }
  | { action: "REJECTED"; reason: string }
  | { action: "WITHHELD"; reason: string }
  | { action: "ERROR"; error: string };

// ── Error classification (requirement 16.3: classify SDK errors, never crash the loop) ──

/**
 * Classify an unknown error thrown by an SDK call into a short, loggable tag using the SDK's own
 * helpers. Used only for logging / diagnostics — handlers swallow errors so the event loop survives.
 */
export function classifyError(err: unknown): string {
  if (isInsufficientBalance(err)) return "insufficient-balance";
  if (isNotFound(err)) return "not-found";
  if (isUnauthorized(err)) return "unauthorized";
  if (err instanceof APIError) return `api-error(code=${err.code},status=${err.httpStatus},msg=${err.message})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Best-effort extraction of a transaction hash from an SDK deliver result. The SDK's
 * `DeliverOrderResult` carries a `txHash` (the on-chain deliver tx). The final CAPVault clearing tx
 * hash only arrives later (on `order_completed`); recording the deliver tx hash here is the hash
 * available at delivery time. Returns "" when no hash is present.
 */
export function extractTxHash(result: unknown): string {
  if (result !== null && typeof result === "object") {
    const candidate = (result as Record<string, unknown>).txHash;
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

// ── Deliverable assembly ─────────────────────────────────────────────────────────────────

/** Normalized audit output ready to be turned into a CAP deliverable. */
export interface AuditDeliverable {
  /** Machine-readable structured report (single wallet) or multi-wallet summary. */
  structured: AuditReportStructured | MultiWalletReport;
  /** Human-readable Markdown report. */
  humanReadable: string;
  /** Flattened per-module statuses used by the settlement decision. */
  statuses: ModuleStatus[];
}

export interface A2aAddressIntelEntry {
  address: Address;
  standing: AddressStanding;
  evidenceLog: unknown;
  aiVerdict: LlmAddressVerdict;
}

function renderA2aLlmSummary(entries: readonly A2aAddressIntelEntry[] | undefined): string {
  if (entries === undefined || entries.length === 0) return "";
  const lines = ["## LLM Evidence Verdict"];
  for (const entry of entries) {
    const v = entry.aiVerdict;
    lines.push("");
    lines.push(`### ${entry.address}`);
    lines.push(`- Badge: ${v.badge.label} (${v.badge.level})`);
    lines.push(`- Verdict: ${v.verdict}`);
    lines.push(`- Risk Level: ${v.riskLevel}`);
    lines.push(`- Official: ${v.official}`);
    lines.push(`- Blacklisted: ${v.blacklisted}`);
    if (v.label !== undefined) lines.push(`- Label: ${v.label}`);
    if (v.reasons.length > 0) {
      lines.push("- Reasons:");
      for (const reason of v.reasons.slice(0, 5)) lines.push(`  - ${reason}`);
    }
    if (v.approvalRisks.length > 0) {
      lines.push("- Approval risks:");
      for (const risk of v.approvalRisks.slice(0, 5)) lines.push(`  - ${risk}`);
    }
    if (v.transactionRisks.length > 0) {
      lines.push("- Transaction risks:");
      for (const risk of v.transactionRisks.slice(0, 5)) lines.push(`  - ${risk}`);
    }
    if (v.evidenceUsed.length > 0) {
      lines.push(`- Evidence used: ${v.evidenceUsed.slice(0, 5).join("; ")}`);
    }
  }
  return lines.join("\n");
}

/** Convert rich internal report JSON into the simpler shape accepted by CROO's Schema builder. */
export function normalizeForCapSchema(
  structured: AuditReportStructured | MultiWalletReport,
): Record<string, unknown> {
  const out = { ...(structured as unknown as Record<string, unknown>) };

  // Dashboard schema fields are required when declared. Keep null object fields as minimal objects.
  if (out.assets === null || out.assets === undefined) out.assets = { totalUsd: 0, items: [] };
  if (out.addressStanding === null || out.addressStanding === undefined) out.addressStanding = {};
  for (const key of [
    "approvals",
    "contractRisks",
    "txFindings",
    "revokeAdvice",
    "moduleStatuses",
    "reports",
  ]) {
    const value = out[key];
    if (value === undefined || value === null) {
      out[key] = [];
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === "object" ? JSON.stringify(item) : item,
      );
    }
  }

  return out;
}

/** Combine per-wallet human-readable reports into one Markdown document. */
function renderMultiWalletMarkdown(perWallet: PerWalletAuditResult[]): string {
  if (perWallet.length === 0) {
    return "# Multi-Address Risk Report\n\nNo valid address targets were provided.";
  }
  const header = `# Multi-Address Risk Report\n\nThis report covers ${perWallet.length} address target(s).`;
  const sections = perWallet.map((w) => w.report.humanReadable);
  return [header, ...sections].join("\n\n---\n\n");
}

function findReportForAddress(
  structured: AuditReportStructured | MultiWalletReport,
  address: Address,
): AuditReportStructured | undefined {
  const key = address.toLowerCase();
  if ("reports" in structured) {
    return structured.reports.find((r) => r.walletAddress.toLowerCase() === key);
  }
  return structured.walletAddress.toLowerCase() === key ? structured : undefined;
}

function sanitizeAuditEvidenceForLlm(report: unknown): unknown {
  return JSON.parse(
    JSON.stringify(report, (field, value) => {
      // The evidence log should not ask the LLM to echo a pre-existing address badge.
      if (field === "addressStanding") return undefined;
      return value;
    }),
  );
}

function buildA2aEvidenceLog(
  structured: AuditReportStructured | MultiWalletReport,
  address: Address,
  inspection: AddressInspection | undefined,
  activity: WalletActivity | undefined,
): Record<string, unknown> {
  const report = findReportForAddress(structured, address);
  return {
    address,
    auditEvidence: sanitizeAuditEvidenceForLlm(report ?? structured),
    addressInspection: inspection
      ? {
          address: inspection.address,
          type: inspection.type,
          token: inspection.token,
          facts: inspection.facts,
        }
      : undefined,
    walletActivity: activity
      ? {
          windowDays: activity.windowDays,
          analyzedCount: activity.analyzedCount,
          records: activity.records.slice(0, 25),
          counterparties: activity.counterparties.slice(0, 20),
        }
      : undefined,
  };
}

function applyA2aStanding(
  structured: AuditReportStructured | MultiWalletReport,
  address: Address,
  inspection: AddressInspection | undefined,
  ai: LlmAddressVerdict,
): AddressStanding {
  const standing: AddressStanding = {
    address,
    type: inspection?.type ?? "UNKNOWN",
    verdict: ai.verdict,
    riskLevel: ai.riskLevel,
    official: ai.official,
    blacklisted: ai.blacklisted,
    badge: ai.badge,
    reasons: ai.reasons,
  };
  if (ai.label !== undefined) standing.label = ai.label;
  const report = findReportForAddress(structured, address);
  if (report !== undefined) report.addressStanding = standing;
  return standing;
}

async function enrichA2aWithLlm(
  orchestrator: AuditRunner,
  deliverable: AuditDeliverable,
  addresses: Address[],
  skills: AuditSkillSet | undefined,
): Promise<A2aAddressIntelEntry[] | undefined> {
  if (skills === undefined) return undefined;
  const entries: A2aAddressIntelEntry[] = [];
  for (const address of addresses) {
    try {
      const [inspection, activity] = await Promise.all([
        typeof orchestrator.inspectAddress === "function"
          ? orchestrator.inspectAddress(address)
          : Promise.resolve(undefined),
        typeof orchestrator.walletActivity === "function"
          ? orchestrator.walletActivity(address)
          : Promise.resolve(undefined),
      ]);
      const evidenceLog = buildA2aEvidenceLog(deliverable.structured, address, inspection, activity);
      const aiVerdict = await skills.classifyAddressEvidence(evidenceLog);
      const standing = applyA2aStanding(deliverable.structured, address, inspection, aiVerdict);
      entries.push({ address, standing, evidenceLog, aiVerdict });
    } catch {
      /* LLM evidence classification is best-effort; deterministic report remains deliverable. */
    }
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * Run the audit for a paid order: multiple submitted addresses fan out into the existing
 * multi-address report shape; a single address uses the requested analysis depth.
 */
export async function runAudit(
  orchestrator: AuditRunner,
  tier: Tier,
  addresses: Address[],
): Promise<AuditDeliverable> {
  if (addresses.length > 1 || tier === "MULTI") {
    const { multi, perWallet } = await orchestrator.auditMultipleWallets(addresses);
    return {
      structured: multi,
      humanReadable: renderMultiWalletMarkdown(perWallet),
      statuses: perWallet.flatMap((w) => w.statuses),
    };
  }

  const result = await orchestrator.auditWallet(addresses[0]!, tier);
  return {
    structured: result.report.structured,
    humanReadable: result.report.humanReadable,
    statuses: result.statuses,
  };
}

// ── Pure handlers (standalone, fake-client friendly) ────────────────────────────────────

/**
 * Handle a `negotiation_created` event (task 16.2, requirements 2.2 / 2.6).
 *
 * Fetches the negotiation, runs {@link decideNegotiation} against the configured Service_ID → Tier
 * map, then calls `acceptNegotiation` (ACCEPT) or `rejectNegotiation` (REJECT, with reason). Any SDK
 * error is classified and swallowed so the event loop keeps running.
 */
export async function handleNegotiationCreated(
  client: CapClient,
  event: CapEvent,
  serviceTierMap: Map<string, Tier>,
  logger: CapLogger = NOOP_LOGGER,
): Promise<NegotiationHandlerResult> {
  const negotiationId = event.negotiation_id;
  if (negotiationId === undefined || negotiationId.trim().length === 0) {
    logger.warn("negotiation_created event without negotiation_id; ignoring");
    return { action: "ERROR", error: "missing negotiation_id" };
  }

  try {
    const negotiation = await client.getNegotiation(negotiationId);
    const decision = decideNegotiation(
      { serviceId: negotiation.serviceId, requirements: negotiation.requirements },
      serviceTierMap,
    );

    if (decision.action === "ACCEPT") {
      await client.acceptNegotiation(negotiationId);
      logger.info(`Accepted negotiation ${negotiationId} (tier ${decision.tier})`);
      return { action: "ACCEPTED", tier: decision.tier };
    }

    await client.rejectNegotiation(negotiationId, decision.reason);
    logger.info(`Rejected negotiation ${negotiationId}: ${decision.reason}`);
    return { action: "REJECTED", reason: decision.reason };
  } catch (err) {
    const error = classifyError(err);
    logger.error(`Error handling negotiation ${negotiationId}: ${error}`);
    return { action: "ERROR", error };
  }
}

/** Dependencies for {@link handleOrderPaid}. */
export interface OrderHandlerContext {
  orchestrator: AuditRunner;
  serviceTierMap: Map<string, Tier>;
  ledger: SettlementLedger;
  logger?: CapLogger;
  /**
   * When the structured report JSON exceeds this many bytes, upload it via `uploadFile` and embed
   * the returned object key in the human-readable text (per cap-protocol.md: large / multi reports
   * may be uploaded first). Defaults to inline-only (no upload).
   */
  uploadThresholdBytes?: number;
  /**
   * When present, persist each A2A report to result/<orderId>.json and add resultPageUrl /
   * resultJsonUrl to the delivered schema. Direct unit tests omit this to avoid filesystem writes.
   */
  resultStore?: ResultStoreOptions;
  /** Optional LLM skill set used to classify evidence logs into final badges and risk levels. */
  skills?: AuditSkillSet;
}

/**
 * Handle an `order_paid` event (tasks 16.3 / 16.4, requirements 2.3 / 2.4 / 2.7 / 5.4 / 14.1 /
 * 18.4 / 18.5).
 *
 * Flow:
 *  1. Fetch the order; resolve its tier from `serviceId`. Unknown service → RejectOrder.
 *  2. Parse address targets from the order requirements. Missing → RejectOrder (requirement 2.7).
 *  3. Run the audit (multiple addresses fan out; otherwise single address) and collect statuses.
 *  4. {@link decideSettlement} with `escrowLocked: true`:
 *      - DELIVER_AND_SETTLE → build a schema deliverable (deliverableSchema = structured JSON,
 *        deliverableText = Markdown), optionally UploadFile for large reports, DeliverOrder, then
 *        record the settlement (requirements 2.3 / 2.4 / 14.1 / 18.4).
 *      - REJECT_AND_REFUND → RejectOrder so CAPVault refunds the escrow (requirement 18.5).
 *      - WITHHOLD_DELIVERY → defensive no-op (escrow is locked on order_paid, so this should not
 *        occur); logged only.
 * SDK errors are classified and swallowed so the loop keeps running.
 */
export async function handleOrderPaid(
  client: CapClient,
  event: CapEvent,
  ctx: OrderHandlerContext,
): Promise<OrderHandlerResult> {
  const logger = ctx.logger ?? NOOP_LOGGER;
  const orderId = event.order_id;
  if (orderId === undefined || orderId.trim().length === 0) {
    logger.warn("order_paid event without order_id; ignoring");
    return { action: "ERROR", error: "missing order_id" };
  }

  try {
    const order = await client.getOrder(orderId);

    // Resolve the tier from the order's service. We accepted the negotiation, so this should be
    // configured; reject defensively if not.
    const tier = ctx.serviceTierMap.get(order.serviceId);
    if (tier === undefined) {
      const reason = `Unsupported service: serviceId "${order.serviceId}" is not one of this Agent's configured tiers.`;
      await client.rejectOrder(orderId, reason);
      logger.warn(`Rejected order ${orderId}: ${reason}`);
      return { action: "REJECTED", reason };
    }

    // Parse the audited address targets (requirement 2.7: missing params → reject & refund).
    const addresses = parseAuditRequirements(order.requirements);
    if (addresses.length === 0) {
      const reason =
        "Missing required parameters: the paid order carries no parseable walletAddresses; rejecting so CAPVault refunds the escrow.";
      await client.rejectOrder(orderId, reason);
      logger.warn(`Rejected order ${orderId}: ${reason}`);
      return { action: "REJECTED", reason };
    }

    // Execute the audit. Escrow is already locked (the event is order_paid).
    const deliverable = await runAudit(ctx.orchestrator, tier, addresses);
    const addressIntel = await enrichA2aWithLlm(
      ctx.orchestrator,
      deliverable,
      addresses,
      ctx.skills,
    );
    const llmSummaryText = renderA2aLlmSummary(addressIntel);
    const finalHumanReadable =
      llmSummaryText.length > 0
        ? `${deliverable.humanReadable}\n\n${llmSummaryText}`
        : deliverable.humanReadable;
    const decision = decideSettlement({
      escrowLocked: true,
      moduleStatuses: deliverable.statuses,
      tier,
    });

    if (decision.action === "DELIVER_AND_SETTLE") {
      const fileName = resultFileNameForOrder(orderId);
      const resultUrls =
        ctx.resultStore !== undefined ? buildResultUrls(fileName, ctx.resultStore) : undefined;
      const communicationLog = [
        {
          step: "order_paid",
          message: `CAP order ${orderId} is paid; escrow is locked and the Provider can audit.`,
          at: new Date().toISOString(),
        },
        {
          step: "audit_completed",
          message: `Read-only address intelligence completed for ${addresses.length} address target(s).`,
          at: new Date().toISOString(),
        },
        ...(addressIntel !== undefined
          ? [
              {
                step: "llm_classified",
                message: `LLM classified ${addressIntel.length} address target(s) from the saved evidence log and wrote the verdict back to the final result.`,
                at: new Date().toISOString(),
              },
            ]
          : []),
      ];
      let storedPayload: StoredReportPayload | undefined;
      if (resultUrls !== undefined) {
        storedPayload = {
          orderId,
          tier,
          mode: "a2a",
          paid: true,
          structured: deliverable.structured,
          humanReadable: finalHumanReadable,
          addressIntel,
          resultJsonUrl: resultUrls.resultJsonUrl,
          resultPageUrl: resultUrls.resultPageUrl,
          status: "saved",
          communicationLog: [
            ...communicationLog,
            {
              step: "result_saved",
              message: `Provider saved the report JSON as ${fileName}.`,
              at: new Date().toISOString(),
            },
          ],
        };
        const filePath = await writeResultJson(
          fileName,
          storedPayload,
          ctx.resultStore,
        );
        logger.info(`Saved result JSON for order ${orderId}: ${filePath}`);
      }

      const schemaPayload = normalizeForCapSchema(deliverable.structured);
      if (addressIntel !== undefined) {
        schemaPayload.addressIntel = addressIntel;
      }
      if (resultUrls !== undefined) {
        schemaPayload.resultPageUrl = resultUrls.resultPageUrl;
        schemaPayload.resultJsonUrl = resultUrls.resultJsonUrl;
      }
      const schemaJson = JSON.stringify(schemaPayload);
      let deliverableText = finalHumanReadable;
      if (resultUrls !== undefined) {
        deliverableText = `${deliverableText}\n\nReport page: ${resultUrls.resultPageUrl}`;
      }

      // Large / multi reports may be uploaded first; embed the object key for GetDownloadURL.
      const threshold = ctx.uploadThresholdBytes ?? Number.POSITIVE_INFINITY;
      if (Buffer.byteLength(schemaJson, "utf8") > threshold) {
        const objectKey = await client.uploadFile(
          `${orderId}-report.json`,
          Buffer.from(schemaJson, "utf8"),
        );
        deliverableText = `${deliverableText}\n\n> Full machine-readable report uploaded as object key: ${objectKey}`;
        logger.info(`Uploaded large report for order ${orderId}: ${objectKey}`);
      }

      const req: CapDeliverRequest = {
        deliverableType: DeliverableType.Schema,
        deliverableSchema: schemaJson,
        deliverableText,
      };
      const deliverResult = await client.deliverOrder(orderId, req);
      const deliveryTxHash = extractTxHash(deliverResult);
      if (resultUrls !== undefined && storedPayload !== undefined) {
        await writeResultJson(
          fileName,
          {
            ...storedPayload,
            status: "delivered",
            deliveryTxHash,
            communicationLog: [
              ...(storedPayload.communicationLog ?? []),
              {
                step: "delivered",
                message: `Provider delivered the schema and report URL to CROO.${deliveryTxHash ? ` tx=${deliveryTxHash}` : ""}`,
                at: new Date().toISOString(),
              },
            ],
          },
          ctx.resultStore,
        );
      }

      // Record the settlement with the hash available at delivery time (the CAPVault clearing tx
      // hash arrives later on order_completed). Payer is the requester's settlement-side wallet.
      const settlement = ctx.ledger.record(
        orderId,
        tier,
        order.requesterWalletAddress,
        deliveryTxHash,
      );
      logger.info(
        `Delivered order ${orderId} (tier ${tier}); recorded settlement of ${settlement.amountUsdc} USDC`,
      );
      return { action: "DELIVERED", tier, settlement };
    }

    if (decision.action === "REJECT_AND_REFUND") {
      await client.rejectOrder(orderId, decision.reason);
      logger.warn(`Rejected order ${orderId} (refund): ${decision.reason}`);
      return { action: "REJECTED", reason: decision.reason };
    }

    // WITHHOLD_DELIVERY: defensive — escrow is locked on order_paid, so this branch should not run.
    logger.warn(`Withholding delivery for order ${orderId}: ${decision.reason}`);
    return { action: "WITHHELD", reason: decision.reason };
  } catch (err) {
    const error = classifyError(err);
    logger.error(`Error handling order_paid ${orderId}: ${error}`);
    return { action: "ERROR", error };
  }
}

// ── Provider event loop ──────────────────────────────────────────────────────────────────

/** Dependencies for the {@link WalletAuditProvider}. */
export interface WalletAuditProviderDeps {
  client: CapClient;
  orchestrator: AuditRunner;
  /** Service_ID → Tier map (see buildServiceTierMap / resolveServiceTierMap). */
  serviceTierMap: Map<string, Tier>;
  /** Settlement ledger; a fresh one is created when omitted. */
  ledger?: SettlementLedger;
  /** Logger; defaults to a console-backed logger. */
  logger?: CapLogger;
  /** Optional upload threshold for large reports (bytes); defaults to inline-only. */
  uploadThresholdBytes?: number;
  /** Local result JSON directory and public base URL for clickable report pages. */
  resultStore?: ResultStoreOptions;
  /** Optional LLM skill set for evidence-based address classification. */
  skills?: AuditSkillSet;
}

/**
 * The CAP Provider event loop (task 16.1). Connects the WebSocket, routes negotiation_created /
 * order_paid to the pure handlers, and logs order_rejected / order_expired. Reconnection (1s→30s
 * backoff) and heartbeats are handled by the SDK's EventStream.
 */
export class WalletAuditProvider {
  private readonly client: CapClient;
  private readonly orchestrator: AuditRunner;
  private readonly serviceTierMap: Map<string, Tier>;
  private readonly ledger: SettlementLedger;
  private readonly logger: CapLogger;
  private readonly uploadThresholdBytes: number | undefined;
  private readonly resultStore: ResultStoreOptions | undefined;
  private readonly skills: AuditSkillSet | undefined;
  private stream: CapEventStream | undefined;

  constructor(deps: WalletAuditProviderDeps) {
    this.client = deps.client;
    this.orchestrator = deps.orchestrator;
    this.serviceTierMap = deps.serviceTierMap;
    this.ledger = deps.ledger ?? new SettlementLedger();
    this.logger = deps.logger ?? createConsoleLogger();
    this.uploadThresholdBytes = deps.uploadThresholdBytes;
    this.resultStore = deps.resultStore ?? {};
    this.skills = deps.skills;
  }

  /** The settlement ledger holding records for delivered orders. */
  get settlementLedger(): SettlementLedger {
    return this.ledger;
  }

  /** The CAP client this Provider uses. */
  get capClient(): CapClient {
    return this.client;
  }

  /**
   * The audit engine (AuditRunner) this Provider uses. Exposed so an in-process web/API portal can
   * reuse the SAME engine — and the SAME single CAP connection / process — rather than opening a
   * second connection or self-hiring over CAP.
   */
  get auditRunner(): AuditRunner {
    return this.orchestrator;
  }

  /**
   * Connect to the CAP WebSocket and register event handlers. Returns the live stream so callers can
   * close it. Uses the real `EventType` constants (never hardcoded strings).
   */
  async start(): Promise<CapEventStream> {
    const stream = await this.client.connectWebSocket();
    this.stream = stream;

    stream.on(EventType.NegotiationCreated, (event) => {
      void this.onNegotiationCreated(event);
    });
    stream.on(EventType.OrderPaid, (event) => {
      void this.onOrderPaid(event);
    });
    // Informational only: these terminal events need no action on the Provider side.
    stream.on(EventType.OrderRejected, (event) => {
      this.logger.info(`order_rejected: ${event.order_id ?? "?"}`);
    });
    stream.on(EventType.OrderExpired, (event) => {
      this.logger.info(`order_expired: ${event.order_id ?? "?"}`);
    });

    this.logger.info("AddressIntelProvider started; listening for CAP events");
    return stream;
  }

  /** Close the WebSocket stream (if open). */
  stop(): void {
    this.stream?.close();
    this.stream = undefined;
  }

  /** Route a negotiation_created event to the pure handler. */
  onNegotiationCreated(event: CapEvent): Promise<NegotiationHandlerResult> {
    return handleNegotiationCreated(this.client, event, this.serviceTierMap, this.logger);
  }

  /** Route an order_paid event to the pure handler. */
  onOrderPaid(event: CapEvent): Promise<OrderHandlerResult> {
    return handleOrderPaid(this.client, event, {
      orchestrator: this.orchestrator,
      serviceTierMap: this.serviceTierMap,
      ledger: this.ledger,
      logger: this.logger,
      uploadThresholdBytes: this.uploadThresholdBytes,
      resultStore: this.resultStore,
      skills: this.skills,
    });
  }
}

// ── SDK factory (the ONLY place that constructs the concrete AgentClient) ───────────────

/**
 * Construct a real CAP `AgentClient` and return it typed as {@link CapClient}. The SDK's
 * `AgentClient` structurally implements every method in `CapClient`, so the rest of this module
 * stays SDK-agnostic and unit-testable with a fake client.
 *
 * MANUAL(H1-1): `sdkKey` (CROO_SDK_KEY) is produced when registering the Agent; injected via env.
 */
export function createCapClient(
  config: RuntimeConfig,
  sdkKey: string = config.crooSdkKey,
): CapClient {
  const sdkLogger = {
    info: (msg: string, ...args: unknown[]) => {
      // Suppress noisy low-level SDK logs to keep console clean for presentation/video
      if (
        msg.startsWith("websocket:") ||
        msg.startsWith("got negotiation") ||
        msg.startsWith("got order") ||
        msg.startsWith("listed ") ||
        msg.startsWith("websocket connecting") ||
        msg.startsWith("websocket connected") ||
        msg.startsWith("websocket reconnected") ||
        msg.startsWith("websocket reconnecting")
      ) {
        return;
      }
      console.info(`[sdk] ${msg}`, ...args);
    },
    warn: (msg: string, ...args: unknown[]) => console.warn(`[sdk:warn] ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(`[sdk:error] ${msg}`, ...args),
    debug: () => {}, // silence http request logging
  };
  const client = new AgentClient(
    {
      baseURL: config.crooApiUrl,
      wsURL: config.crooWsUrl,
      rpcURL: config.rpcUrl,
      logger: sdkLogger,
    },
    sdkKey,
  );
  return client as unknown as CapClient;
}
