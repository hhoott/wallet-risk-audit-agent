/**
 * Portal CAP Requester (managed-requester model).
 *
 * The portal backend is itself a CAP *Requester*: when a user places an order in the browser, this
 * service hires our live wallet-risk-audit *Provider* over CAP and pays in USDC. It runs the full
 * Requester-side flow end to end (docs/cap-protocol.md section 5):
 *
 *   negotiateOrder(serviceId, requirements)
 *     → [Provider accepts → backend auto-creates the order → order_created event yields orderId]
 *   payOrder(orderId)                       // SDK handles USDC approve + CAPVault escrow on Base
 *     → [Provider runs the audit → DeliverOrder → order_completed event]
 *   getDelivery(orderId)                    // fetch + parse the structured deliverable
 *
 * Unlike the example Requester (src/examples/requester.ts), which takes the orderId as input, this
 * service owns a persistent WebSocket connection and correlates events back to in-flight orders, so
 * the portal can run the whole lifecycle from a single `placeOrder` call.
 *
 * Testability: the flow depends only on the minimal {@link PortalCapClient} interface (the exact SDK
 * methods used) and matches events by their documented string `type` values, so it never imports the
 * SDK. The real `AgentClient` is constructed only in {@link createPortalCapClient}. Unit tests drive
 * `PortalRequester` with a fake client + a scripted event stream — no real network.
 *
 * Security: this is a read-only consumer. It never touches private keys; USDC payment / escrow /
 * settlement on Base are handled entirely by the CAP SDK + CAPVault.
 */

import type { AuditReportStructured, MultiWalletReport } from "../models.js";
import {
  parseDelivery,
  decideFromDelivery,
  type AuditDecision,
} from "../examples/requester.js";

// ── Minimal CAP client surface (exactly the SDK methods the portal Requester uses) ──────

/** A CAP WebSocket event as seen by the portal; only the type discriminator + ids are read. */
export interface PortalCapEvent {
  type: string;
  negotiation_id?: string;
  order_id?: string;
  reason?: string;
}

/** Minimal event-stream surface: subscribe to a typed event and close the stream. */
export interface PortalCapEventStream {
  on(type: string, handler: (event: PortalCapEvent) => void): void;
  close(): void;
}

/** A CAP delivery as seen by the portal; mirrors the SDK `Delivery` fields we read. */
export interface PortalDelivery {
  deliverableSchema?: string;
  deliverableText?: string;
}

/** The exact CAP SDK methods the portal Requester uses (the real `AgentClient` satisfies this). */
export interface PortalCapClient {
  connectWebSocket(): Promise<PortalCapEventStream>;
  negotiateOrder(req: { serviceId: string; requirements?: string }): Promise<{ negotiationId?: string }>;
  payOrder(orderId: string): Promise<unknown>;
  getDelivery(orderId: string): Promise<PortalDelivery>;
}

// ── CAP event type strings (documented values; see docs/cap-protocol.md appendix) ───────
// The portal matches events by these string values rather than importing the SDK's EventType so it
// stays SDK-agnostic and unit-testable. They mirror the real constant values exactly.

const EVENT_ORDER_CREATED = "order_created";
const EVENT_ORDER_COMPLETED = "order_completed";
const EVENT_ORDER_REJECTED = "order_rejected";
const EVENT_ORDER_EXPIRED = "order_expired";
const EVENT_NEGOTIATION_REJECTED = "order_negotiation_rejected";
const EVENT_NEGOTIATION_EXPIRED = "order_negotiation_expired";

// ── Public result types ──────────────────────────────────────────────────────────────────

/** The parsed report (single or multi-wallet) plus the human-readable text and A2A decision. */
export interface PortalOrderResult {
  /** The CAP order id that was paid and delivered. */
  orderId: string;
  /** Machine-readable structured report (single wallet) or multi-wallet summary. */
  structured: AuditReportStructured | MultiWalletReport;
  /** Human-readable Markdown report (when the Provider included one). */
  humanReadable: string;
  /** A2A gating decision derived from Risk_Level / Health_Score (proceed / abort). */
  decision: AuditDecision;
}

/** Thrown when an order cannot be completed (rejected / expired / timed out). */
export class PortalOrderError extends Error {
  constructor(
    message: string,
    /** Short machine-readable code so the HTTP layer can map to a status. */
    readonly code:
      | "NEGOTIATION_REJECTED"
      | "NEGOTIATION_EXPIRED"
      | "ORDER_REJECTED"
      | "ORDER_EXPIRED"
      | "TIMEOUT"
      | "NO_NEGOTIATION_ID",
  ) {
    super(message);
    this.name = "PortalOrderError";
  }
}

/** Parameters for {@link PortalRequester.placeOrder}. */
export interface PlaceOrderParams {
  /** Target Service_ID of our audit Provider (one of its QUICK / FULL / MULTI tiers). */
  serviceId: string;
  /** Wallet address(es) to audit; conveyed through the negotiation `requirements` JSON. */
  walletAddresses: string[];
  /** Per-order timeout (ms); defaults to {@link PortalRequester}'s configured timeout. */
  timeoutMs?: number;
}

// ── In-flight order tracking ───────────────────────────────────────────────────────────

/** A single in-flight order awaiting its terminal event, keyed by orderId once known. */
interface PendingOrder {
  negotiationId: string | undefined;
  /** Resolves when order_created arrives (yields the orderId). */
  resolveCreated: (orderId: string) => void;
  /** Resolves when order_completed arrives. */
  resolveCompleted: () => void;
  /**
   * Fail the WHOLE flow with a terminal error. Backed by a dedicated rejection promise that
   * `placeOrder` races against, so a failure event aborts the order at any stage (even after
   * order_created has already resolved). Idempotent.
   */
  fail: (err: PortalOrderError) => void;
  orderId?: string;
}

/** Default per-order timeout: generous enough for a real audit + settlement round-trip. */
export const DEFAULT_ORDER_TIMEOUT_MS = 120_000;

/**
 * The portal's CAP Requester. Owns a single WebSocket connection, correlates lifecycle events to
 * in-flight orders, and exposes {@link placeOrder} which runs negotiate → pay → deliver end to end.
 */
export class PortalRequester {
  private readonly client: PortalCapClient;
  private readonly timeoutMs: number;
  private stream: PortalCapEventStream | undefined;
  private connectPromise: Promise<void> | undefined;

  /** Orders awaiting their order_created event, keyed by negotiationId. */
  private readonly byNegotiation = new Map<string, PendingOrder>();
  /** Orders awaiting their terminal event, keyed by orderId. */
  private readonly byOrder = new Map<string, PendingOrder>();

  /**
   * Events that arrived before their pending order was registered, buffered by id and replayed on
   * registration. This makes the Requester robust to the WebSocket pushing an event in the same tick
   * the negotiation resolves (a real possibility, and what the tests exercise). Bounded to avoid
   * unbounded growth from events that are never claimed.
   */
  private readonly bufferedByNegotiation = new Map<string, PortalCapEvent[]>();
  private readonly bufferedByOrder = new Map<string, PortalCapEvent[]>();
  /** Max distinct ids retained in each buffer before the oldest is evicted. */
  private static readonly MAX_BUFFERED_IDS = 256;

  constructor(client: PortalCapClient, options: { timeoutMs?: number } = {}) {
    this.client = client;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ORDER_TIMEOUT_MS;
  }

  /** Connect the WebSocket once and register lifecycle handlers (idempotent). */
  async connect(): Promise<void> {
    if (this.connectPromise !== undefined) return this.connectPromise;
    this.connectPromise = (async () => {
      const stream = await this.client.connectWebSocket();
      this.stream = stream;
      stream.on(EVENT_ORDER_CREATED, (e) => this.onOrderCreated(e));
      stream.on(EVENT_ORDER_COMPLETED, (e) => this.onOrderCompleted(e));
      stream.on(EVENT_ORDER_REJECTED, (e) =>
        this.failOrder(e, "ORDER_REJECTED", "The order was rejected by the Provider."),
      );
      stream.on(EVENT_ORDER_EXPIRED, (e) =>
        this.failOrder(e, "ORDER_EXPIRED", "The order expired before delivery."),
      );
      stream.on(EVENT_NEGOTIATION_REJECTED, (e) =>
        this.failNegotiation(e, "NEGOTIATION_REJECTED", "The Provider rejected the negotiation."),
      );
      stream.on(EVENT_NEGOTIATION_EXPIRED, (e) =>
        this.failNegotiation(e, "NEGOTIATION_EXPIRED", "The negotiation expired."),
      );
    })();
    return this.connectPromise;
  }

  /** Close the WebSocket stream (if open). */
  close(): void {
    this.stream?.close();
    this.stream = undefined;
    this.connectPromise = undefined;
  }

  /**
   * Place and complete one order end to end: negotiate, wait for order creation, pay, wait for
   * completion, then fetch and parse the deliverable. Rejects with a {@link PortalOrderError} on any
   * terminal failure or timeout.
   */
  async placeOrder(params: PlaceOrderParams): Promise<PortalOrderResult> {
    await this.connect();
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;
    const requirements = JSON.stringify({ walletAddresses: params.walletAddresses });

    // Set up the pending-order tracker before negotiating so we never miss a fast event.
    // Three independent channels: created (order_created), completed (order_completed), and a
    // dedicated failure promise the whole flow races against so a terminal failure event aborts the
    // order at ANY stage (even after order_created has resolved).
    let resolveCreated!: (orderId: string) => void;
    let resolveCompleted!: () => void;
    let failFlow!: (err: PortalOrderError) => void;
    const created = new Promise<string>((resolve) => {
      resolveCreated = resolve;
    });
    const completedPromise = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const failure = new Promise<never>((_, reject) => {
      failFlow = reject;
    });
    // The failure promise is intentionally only consumed via Promise.race below; attach a no-op
    // catch so an early rejection never surfaces as an unhandled rejection.
    failure.catch(() => {});

    let settled = false;
    const pending: PendingOrder = {
      negotiationId: undefined,
      resolveCreated: (orderId) => resolveCreated(orderId),
      resolveCompleted: () => resolveCompleted(),
      fail: (err) => {
        if (settled) return;
        settled = true;
        failFlow(err);
      },
    };

    const negotiation = await this.client.negotiateOrder({ serviceId: params.serviceId, requirements });
    const negotiationId = negotiation.negotiationId;
    if (negotiationId === undefined || negotiationId.trim().length === 0) {
      throw new PortalOrderError(
        "The negotiation did not return a negotiationId; cannot track the order.",
        "NO_NEGOTIATION_ID",
      );
    }
    pending.negotiationId = negotiationId;
    this.byNegotiation.set(negotiationId, pending);
    // Replay any negotiation-keyed events that arrived before registration.
    this.drainBuffered(this.bufferedByNegotiation, negotiationId);

    // Wrap the lifecycle in a single timeout so a stuck order cannot hang the request forever.
    // The `failure` promise aborts the flow if a terminal failure event arrives at any stage.
    const flow = (async () => {
      const orderId = await created;
      await this.client.payOrder(orderId);
      await completedPromise;
      const delivery = await this.client.getDelivery(orderId);
      const structured = parseDelivery(delivery);
      const decision = decideFromDelivery(structured);
      return {
        orderId,
        structured,
        humanReadable: delivery.deliverableText ?? "",
        decision,
      } satisfies PortalOrderResult;
    })();

    return this.withTimeout(timeoutMs, negotiationId, Promise.race([flow, failure]));
  }

  /** Race a flow against a timeout, cleaning up tracking maps on timeout. */
  private async withTimeout<T>(
    ms: number,
    negotiationId: string,
    flow: Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const pending = this.byNegotiation.get(negotiationId);
        this.cleanup(pending);
        reject(new PortalOrderError(`The order did not complete within ${ms}ms.`, "TIMEOUT"));
      }, ms);
    });
    try {
      return await Promise.race([flow, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ── Event handlers ───────────────────────────────────────────────────────────────────

  /** order_created: learn the orderId, re-key the pending record, and unblock payment. */
  private onOrderCreated(event: PortalCapEvent): void {
    const negotiationId = event.negotiation_id;
    const orderId = event.order_id;
    if (negotiationId === undefined || orderId === undefined) return;
    const pending = this.byNegotiation.get(negotiationId);
    if (pending === undefined) {
      this.buffer(this.bufferedByNegotiation, negotiationId, event);
      return;
    }
    pending.orderId = orderId;
    this.byOrder.set(orderId, pending);
    pending.resolveCreated(orderId);
    // A terminal event may have arrived before order_created was matched; replay it now.
    this.drainBuffered(this.bufferedByOrder, orderId);
  }

  /** order_completed: the deliverable is ready to fetch. */
  private onOrderCompleted(event: PortalCapEvent): void {
    const orderId = event.order_id;
    if (orderId === undefined) return;
    const pending = this.byOrder.get(orderId);
    if (pending === undefined) {
      this.buffer(this.bufferedByOrder, orderId, event);
      return;
    }
    pending.resolveCompleted();
    this.cleanup(pending);
  }

  /** Fail an order keyed by order_id (rejected / expired). */
  private failOrder(event: PortalCapEvent, code: PortalOrderError["code"], base: string): void {
    const orderId = event.order_id;
    if (orderId === undefined) return;
    const pending = this.byOrder.get(orderId);
    if (pending === undefined) {
      this.buffer(this.bufferedByOrder, orderId, event);
      return;
    }
    pending.fail(new PortalOrderError(this.withReason(base, event.reason), code));
    this.cleanup(pending);
  }

  /** Fail an order still keyed by negotiation_id (negotiation rejected / expired). */
  private failNegotiation(
    event: PortalCapEvent,
    code: PortalOrderError["code"],
    base: string,
  ): void {
    const negotiationId = event.negotiation_id;
    if (negotiationId === undefined) return;
    const pending = this.byNegotiation.get(negotiationId);
    if (pending === undefined) {
      this.buffer(this.bufferedByNegotiation, negotiationId, event);
      return;
    }
    pending.fail(new PortalOrderError(this.withReason(base, event.reason), code));
    this.cleanup(pending);
  }

  /** Buffer an event under an id, evicting the oldest id when the buffer is full. */
  private buffer(
    store: Map<string, PortalCapEvent[]>,
    id: string,
    event: PortalCapEvent,
  ): void {
    if (!store.has(id) && store.size >= PortalRequester.MAX_BUFFERED_IDS) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    const list = store.get(id) ?? [];
    list.push(event);
    store.set(id, list);
  }

  /** Replay (and clear) any buffered events for an id through the matching handler. */
  private drainBuffered(store: Map<string, PortalCapEvent[]>, id: string): void {
    const events = store.get(id);
    if (events === undefined) return;
    store.delete(id);
    for (const event of events) this.dispatch(event);
  }

  /** Route a (buffered) event to its handler by type. */
  private dispatch(event: PortalCapEvent): void {
    switch (event.type) {
      case EVENT_ORDER_CREATED:
        this.onOrderCreated(event);
        break;
      case EVENT_ORDER_COMPLETED:
        this.onOrderCompleted(event);
        break;
      case EVENT_ORDER_REJECTED:
        this.failOrder(event, "ORDER_REJECTED", "The order was rejected by the Provider.");
        break;
      case EVENT_ORDER_EXPIRED:
        this.failOrder(event, "ORDER_EXPIRED", "The order expired before delivery.");
        break;
      case EVENT_NEGOTIATION_REJECTED:
        this.failNegotiation(event, "NEGOTIATION_REJECTED", "The Provider rejected the negotiation.");
        break;
      case EVENT_NEGOTIATION_EXPIRED:
        this.failNegotiation(event, "NEGOTIATION_EXPIRED", "The negotiation expired.");
        break;
    }
  }

  /** Append a Provider-supplied reason to a base message when present. */
  private withReason(base: string, reason: string | undefined): string {
    return reason !== undefined && reason.trim().length > 0 ? `${base} Reason: ${reason}` : base;
  }

  /** Remove a pending record from both tracking maps. */
  private cleanup(pending: PendingOrder | undefined): void {
    if (pending === undefined) return;
    if (pending.negotiationId !== undefined) this.byNegotiation.delete(pending.negotiationId);
    if (pending.orderId !== undefined) this.byOrder.delete(pending.orderId);
  }
}

// ── SDK factory (the ONLY place that constructs the concrete AgentClient for the portal) ─

/**
 * Construct a real CAP `AgentClient` typed as {@link PortalCapClient}. The SDK's `AgentClient`
 * structurally implements every method used here, so the rest of the portal stays SDK-agnostic.
 *
 * MANUAL(H1-1): the portal Requester needs its own funded CROO Agent (CROO_SDK_KEY) with USDC in its
 * AA wallet, since it pays for every order it places on the user's behalf.
 */
export async function createPortalCapClient(config: {
  crooApiUrl: string;
  crooWsUrl: string;
  crooSdkKey: string;
  rpcUrl?: string;
}): Promise<PortalCapClient> {
  const { AgentClient } = await import("@croo-network/sdk");
  const client = new AgentClient(
    { baseURL: config.crooApiUrl, wsURL: config.crooWsUrl, rpcURL: config.rpcUrl },
    config.crooSdkKey,
  );
  return client as unknown as PortalCapClient;
}
