import { describe, it, expect } from "vitest";

import {
  PortalRequester,
  PortalOrderError,
  type PortalCapClient,
  type PortalCapEvent,
  type PortalCapEventStream,
  type PortalDelivery,
} from "../src/portal/cap-requester.js";
import type { AuditReportStructured } from "../src/models.js";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

const WALLET = "0x" + "1".repeat(40);
const SERVICE_ID = "svc-full";

/** A minimal structured report good enough for the Requester to parse + decide on. */
function structuredReport(overrides: Partial<AuditReportStructured> = {}): AuditReportStructured {
  return {
    schemaVersion: "1.0.0",
    walletAddress: WALLET,
    auditedChain: "Ethereum Mainnet",
    generatedAt: "2024-01-01T00:00:00.000Z",
    tier: "FULL",
    readOnlyDeclaration: "read-only",
    healthScore: 90,
    healthGrade: "EXCELLENT",
    riskLevelSummary: "LOW",
    scoredOnIncompleteData: false,
    approvals: [],
    contractRisks: [],
    assets: null,
    txFindings: [],
    revokeAdvice: [],
    moduleStatuses: [],
    ...overrides,
  };
}

// ── Fake event stream: lets the test emit CAP events on demand ──────────────────────────

class FakeStream implements PortalCapEventStream {
  readonly handlers = new Map<string, (e: PortalCapEvent) => void>();
  closed = false;
  on(type: string, handler: (e: PortalCapEvent) => void): void {
    this.handlers.set(type, handler);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: PortalCapEvent): void {
    this.handlers.get(event.type)?.(event);
  }
}

// ── Fake CAP client ─────────────────────────────────────────────────────────────────────

interface FakeOptions {
  /** Delivery returned by getDelivery. */
  delivery?: PortalDelivery;
  /** When set, negotiateOrder returns no negotiationId (error path). */
  noNegotiationId?: boolean;
  /** Auto-drive the lifecycle events when negotiateOrder is called. */
  autoEvents?: "complete" | "order-rejected" | "negotiation-rejected" | "none";
  negotiationId?: string;
  orderId?: string;
}

class FakeClient implements PortalCapClient {
  readonly stream = new FakeStream();
  readonly calls = { negotiate: 0, pay: [] as string[], delivery: 0 };
  constructor(private readonly opts: FakeOptions = {}) {}

  connectWebSocket(): Promise<PortalCapEventStream> {
    return Promise.resolve(this.stream);
  }

  negotiateOrder(_req: { serviceId: string; requirements?: string }): Promise<{ negotiationId?: string }> {
    this.calls.negotiate += 1;
    const negotiationId = this.opts.negotiationId ?? "neg-1";
    const orderId = this.opts.orderId ?? "ord-1";
    const mode = this.opts.autoEvents ?? "complete";

    if (!this.opts.noNegotiationId && mode !== "none") {
      // Emit lifecycle events asynchronously, mimicking the WebSocket push order.
      queueMicrotask(() => {
        if (mode === "negotiation-rejected") {
          this.stream.emit({ type: "order_negotiation_rejected", negotiation_id: negotiationId, reason: "busy" });
          return;
        }
        this.stream.emit({ type: "order_created", negotiation_id: negotiationId, order_id: orderId });
        if (mode === "order-rejected") {
          this.stream.emit({ type: "order_rejected", order_id: orderId, reason: "all sources down" });
          return;
        }
        this.stream.emit({ type: "order_completed", order_id: orderId });
      });
    }
    return Promise.resolve({ negotiationId: this.opts.noNegotiationId ? undefined : negotiationId });
  }

  payOrder(orderId: string): Promise<unknown> {
    this.calls.pay.push(orderId);
    return Promise.resolve({});
  }

  getDelivery(_orderId: string): Promise<PortalDelivery> {
    this.calls.delivery += 1;
    return Promise.resolve(
      this.opts.delivery ?? {
        deliverableSchema: JSON.stringify(structuredReport()),
        deliverableText: "# Report\nAll good.",
      },
    );
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────

describe("PortalRequester.placeOrder", () => {
  it("runs negotiate → pay → deliver and returns the parsed report + decision", async () => {
    const client = new FakeClient({ autoEvents: "complete" });
    const requester = new PortalRequester(client, { timeoutMs: 5000 });

    const result = await requester.placeOrder({ serviceId: SERVICE_ID, walletAddresses: [WALLET] });

    expect(client.calls.negotiate).toBe(1);
    expect(client.calls.pay).toEqual(["ord-1"]);
    expect(client.calls.delivery).toBe(1);
    expect(result.orderId).toBe("ord-1");
    expect(result.humanReadable).toContain("Report");
    expect(result.decision.proceed).toBe(true);
    // The structured report round-trips.
    expect((result.structured as AuditReportStructured).walletAddress).toBe(WALLET);
  });

  it("only pays AFTER order_created (never pays without an order id)", async () => {
    const client = new FakeClient({ autoEvents: "complete" });
    const requester = new PortalRequester(client, { timeoutMs: 5000 });
    await requester.placeOrder({ serviceId: SERVICE_ID, walletAddresses: [WALLET] });
    // payOrder was called exactly once, with the id learned from order_created.
    expect(client.calls.pay).toEqual(["ord-1"]);
  });

  it("derives an abort decision from a high-risk report", async () => {
    const client = new FakeClient({
      delivery: {
        deliverableSchema: JSON.stringify(
          structuredReport({ healthScore: 20, healthGrade: "POOR", riskLevelSummary: "CRITICAL" }),
        ),
        deliverableText: "# Report",
      },
    });
    const requester = new PortalRequester(client, { timeoutMs: 5000 });
    const result = await requester.placeOrder({ serviceId: SERVICE_ID, walletAddresses: [WALLET] });
    expect(result.decision.proceed).toBe(false);
    expect(result.decision.riskLevel).toBe("CRITICAL");
  });

  it("rejects with NO_NEGOTIATION_ID when the negotiation returns no id", async () => {
    const client = new FakeClient({ noNegotiationId: true });
    const requester = new PortalRequester(client, { timeoutMs: 1000 });
    await expect(
      requester.placeOrder({ serviceId: SERVICE_ID, walletAddresses: [WALLET] }),
    ).rejects.toMatchObject({ code: "NO_NEGOTIATION_ID" });
    // It must NOT pay when it cannot track the order.
    expect(client.calls.pay).toEqual([]);
  });

  it("rejects with ORDER_REJECTED when the Provider rejects the paid order", async () => {
    const client = new FakeClient({ autoEvents: "order-rejected" });
    const requester = new PortalRequester(client, { timeoutMs: 1000 });
    const err = await requester
      .placeOrder({ serviceId: SERVICE_ID, walletAddresses: [WALLET] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalOrderError);
    expect((err as PortalOrderError).code).toBe("ORDER_REJECTED");
    expect((err as PortalOrderError).message).toContain("all sources down");
  });

  it("rejects with NEGOTIATION_REJECTED when the negotiation is refused (no payment)", async () => {
    const client = new FakeClient({ autoEvents: "negotiation-rejected" });
    const requester = new PortalRequester(client, { timeoutMs: 1000 });
    await expect(
      requester.placeOrder({ serviceId: SERVICE_ID, walletAddresses: [WALLET] }),
    ).rejects.toMatchObject({ code: "NEGOTIATION_REJECTED" });
    expect(client.calls.pay).toEqual([]);
  });

  it("times out when no terminal event arrives", async () => {
    const client = new FakeClient({ autoEvents: "none" });
    const requester = new PortalRequester(client, { timeoutMs: 50 });
    await expect(
      requester.placeOrder({ serviceId: SERVICE_ID, walletAddresses: [WALLET], timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("connect() is idempotent (single WebSocket)", async () => {
    const client = new FakeClient({ autoEvents: "complete" });
    const requester = new PortalRequester(client, { timeoutMs: 5000 });
    await requester.connect();
    await requester.connect();
    // Both calls share one stream; emitting still works.
    await requester.placeOrder({ serviceId: SERVICE_ID, walletAddresses: [WALLET] });
    expect(client.calls.delivery).toBe(1);
  });
});
