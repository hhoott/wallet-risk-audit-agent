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

import type { RuntimeConfig, Tier } from "../config.js";
import type {
  Address,
  AuditReportStructured,
  ModuleStatus,
  MultiWalletReport,
  SettlementRecord,
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
 * yields the payer wallet and (by convention) the `requirements` JSON carrying wallet addresses.
 */
export interface CapClient {
  connectWebSocket(): Promise<CapEventStream>;
  getNegotiation(id: string): Promise<{ serviceId: string; requirements: string }>;
  acceptNegotiation(id: string): Promise<unknown>;
  rejectNegotiation(id: string, reason: string): Promise<unknown>;
  getOrder(id: string): Promise<{
    orderId: string;
    serviceId: string;
    requesterWalletAddress: string;
    requirements?: string;
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

/** A console-backed logger for the running Provider (prefixes lines so they are easy to grep). */
export function createConsoleLogger(): CapLogger {
  return {
    info: (m: string) => console.info(`[cap] ${m}`),
    warn: (m: string) => console.warn(`[cap] ${m}`),
    error: (m: string) => console.error(`[cap] ${m}`),
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
  if (err instanceof APIError) return `api-error(code=${err.code},status=${err.httpStatus})`;
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
interface AuditDeliverable {
  /** Machine-readable structured report (single wallet) or multi-wallet summary. */
  structured: AuditReportStructured | MultiWalletReport;
  /** Human-readable Markdown report. */
  humanReadable: string;
  /** Flattened per-module statuses used by the settlement decision. */
  statuses: ModuleStatus[];
}

/** Combine per-wallet human-readable reports into one Markdown document. */
function renderMultiWalletMarkdown(perWallet: PerWalletAuditResult[]): string {
  if (perWallet.length === 0) {
    return "# Multi-Wallet Risk Report\n\nNo valid wallet addresses were provided.";
  }
  const header = `# Multi-Wallet Risk Report\n\nThis report covers ${perWallet.length} wallet(s).`;
  const sections = perWallet.map((w) => w.report.humanReadable);
  return [header, ...sections].join("\n\n---\n\n");
}

/**
 * Run the audit for a paid order: MULTI fans out across wallets, every other tier audits the first
 * wallet. Returns the structured + human-readable report and the flattened module statuses.
 */
async function runAudit(
  orchestrator: AuditRunner,
  tier: Tier,
  addresses: Address[],
): Promise<AuditDeliverable> {
  if (tier === "MULTI") {
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
}

/**
 * Handle an `order_paid` event (tasks 16.3 / 16.4, requirements 2.3 / 2.4 / 2.7 / 5.4 / 14.1 /
 * 18.4 / 18.5).
 *
 * Flow:
 *  1. Fetch the order; resolve its tier from `serviceId`. Unknown service → RejectOrder.
 *  2. Parse wallet addresses from the order requirements. Missing → RejectOrder (requirement 2.7).
 *  3. Run the audit (MULTI fans out; otherwise single wallet) and collect module statuses.
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

    // Parse the audited wallet addresses (requirement 2.7: missing params → reject & refund).
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
    const decision = decideSettlement({
      escrowLocked: true,
      moduleStatuses: deliverable.statuses,
      tier,
    });

    if (decision.action === "DELIVER_AND_SETTLE") {
      const schemaJson = JSON.stringify(deliverable.structured);
      let deliverableText = deliverable.humanReadable;

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

      // Record the settlement with the hash available at delivery time (the CAPVault clearing tx
      // hash arrives later on order_completed). Payer is the requester's settlement-side wallet.
      const settlement = ctx.ledger.record(
        orderId,
        tier,
        order.requesterWalletAddress,
        extractTxHash(deliverResult),
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
  private stream: CapEventStream | undefined;

  constructor(deps: WalletAuditProviderDeps) {
    this.client = deps.client;
    this.orchestrator = deps.orchestrator;
    this.serviceTierMap = deps.serviceTierMap;
    this.ledger = deps.ledger ?? new SettlementLedger();
    this.logger = deps.logger ?? createConsoleLogger();
    this.uploadThresholdBytes = deps.uploadThresholdBytes;
  }

  /** The settlement ledger holding records for delivered orders. */
  get settlementLedger(): SettlementLedger {
    return this.ledger;
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

    this.logger.info("WalletAuditProvider started; listening for CAP events");
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
  const client = new AgentClient(
    { baseURL: config.crooApiUrl, wsURL: config.crooWsUrl, rpcURL: config.rpcUrl },
    sdkKey,
  );
  return client as unknown as CapClient;
}
