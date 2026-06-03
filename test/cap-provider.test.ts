import { describe, it, expect } from "vitest";

import {
  WalletAuditProvider,
  handleNegotiationCreated,
  handleOrderPaid,
  createConsoleLogger,
  type CapClient,
  type CapDeliverRequest,
  type CapEvent,
  type CapEventStream,
} from "../src/cap/provider.js";
import { SettlementLedger } from "../src/modules/payment-gateway.js";
import { AuditOrchestrator } from "../src/orchestrator.js";
import {
  MockChainDataSource,
  MockPriceDataSource,
  MockRiskRuleSource,
  type MockChainData,
} from "../src/datasource/mock.js";
import { APIError, EventType } from "@croo-network/sdk";
import type { Tier } from "../src/config.js";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

const WALLET = "0x" + "1".repeat(40);
const WALLET_2 = "0x" + "2".repeat(40);
const PAYER = "0x" + "f".repeat(40);
const ISO = "2024-01-01T00:00:00.000Z";

/** A configured Service_ID → Tier map mirroring buildServiceTierMap output. */
function tierMap(): Map<string, Tier> {
  return new Map<string, Tier>([
    ["svc-quick", "QUICK"],
    ["svc-full", "FULL"],
    ["svc-multi", "MULTI"],
  ]);
}

/** Build a real orchestrator over mock data sources (all OK unless `fail` flags are set). */
function makeOrchestrator(data: MockChainData = {}): {
  orchestrator: AuditOrchestrator;
  chain: MockChainDataSource;
  price: MockPriceDataSource;
  rules: MockRiskRuleSource;
} {
  const chain = new MockChainDataSource(data);
  const price = new MockPriceDataSource({ native: 2000 }, "MockPrice");
  const rules = new MockRiskRuleSource();
  const orchestrator = new AuditOrchestrator({ chain, price, rules, now: () => new Date(ISO) });
  return { orchestrator, chain, price, rules };
}

// ── Fake CAP client (records calls; returns programmed negotiations / orders) ───────────

interface NegotiationData {
  serviceId: string;
  requirements: string;
}
interface OrderData {
  orderId: string;
  serviceId: string;
  requesterWalletAddress: string;
  requirements?: string;
}

interface FakeCalls {
  acceptNegotiation: string[];
  rejectNegotiation: Array<{ id: string; reason: string }>;
  deliverOrder: Array<{ id: string; req: CapDeliverRequest }>;
  rejectOrder: Array<{ id: string; reason: string }>;
  uploadFile: Array<{ name: string; size: number }>;
}

/** A fake event stream that records registered handlers so tests can emit events directly. */
class FakeEventStream implements CapEventStream {
  public readonly handlers = new Map<string, (event: CapEvent) => void>();
  public closed = false;

  on(type: string, handler: (event: CapEvent) => void): void {
    this.handlers.set(type, handler);
  }
  close(): void {
    this.closed = true;
  }
  /** Synchronously invoke the handler registered for `type` (no-op when none). */
  emit(type: string, event: CapEvent): void {
    this.handlers.get(type)?.(event);
  }
}

interface FakeClientOptions {
  negotiations?: Record<string, NegotiationData>;
  orders?: Record<string, OrderData>;
  /** Force a specific method to throw the given error (loop-resilience tests). */
  throwOn?: Partial<Record<keyof CapClient, unknown>>;
  uploadKey?: string;
}

class FakeCapClient implements CapClient {
  public readonly calls: FakeCalls = {
    acceptNegotiation: [],
    rejectNegotiation: [],
    deliverOrder: [],
    rejectOrder: [],
    uploadFile: [],
  };
  public readonly stream = new FakeEventStream();

  constructor(private readonly opts: FakeClientOptions = {}) {}

  private maybeThrow(method: keyof CapClient): void {
    const err = this.opts.throwOn?.[method];
    if (err !== undefined) throw err;
  }

  async connectWebSocket(): Promise<CapEventStream> {
    return this.stream;
  }

  async getNegotiation(id: string): Promise<{ serviceId: string; requirements: string }> {
    this.maybeThrow("getNegotiation");
    const n = this.opts.negotiations?.[id];
    if (n === undefined) throw new Error(`fake: no negotiation ${id}`);
    return n;
  }

  async acceptNegotiation(id: string): Promise<{ order: { orderId: string } }> {
    this.maybeThrow("acceptNegotiation");
    this.calls.acceptNegotiation.push(id);
    return { order: { orderId: "order-1" } };
  }

  async rejectNegotiation(id: string, reason: string): Promise<unknown> {
    this.maybeThrow("rejectNegotiation");
    this.calls.rejectNegotiation.push({ id, reason });
    return { ok: true };
  }

  async getOrder(id: string): Promise<OrderData> {
    this.maybeThrow("getOrder");
    const o = this.opts.orders?.[id];
    if (o === undefined) throw new Error(`fake: no order ${id}`);
    return o;
  }

  async deliverOrder(id: string, req: CapDeliverRequest): Promise<unknown> {
    this.maybeThrow("deliverOrder");
    this.calls.deliverOrder.push({ id, req });
    return { txHash: "0xdeliverhash" };
  }

  async rejectOrder(id: string, reason: string): Promise<unknown> {
    this.maybeThrow("rejectOrder");
    this.calls.rejectOrder.push({ id, reason });
    return { ok: true };
  }

  async uploadFile(name: string, body: Buffer): Promise<string> {
    this.maybeThrow("uploadFile");
    this.calls.uploadFile.push({ name, size: body.length });
    return this.opts.uploadKey ?? "object-key-123";
  }
}

// ── Negotiation wiring (task 16.2, requirements 2.2 / 2.6) ──────────────────────────────

describe("CAP Provider — negotiation handler wiring", () => {
  it("accepts a negotiation for a configured service with valid requirements", async () => {
    const client = new FakeCapClient({
      negotiations: {
        "neg-1": {
          serviceId: "svc-full",
          requirements: JSON.stringify({ walletAddresses: [WALLET] }),
        },
      },
    });

    const result = await handleNegotiationCreated(
      client,
      { type: "x", negotiation_id: "neg-1" },
      tierMap(),
    );

    expect(result.action).toBe("ACCEPTED");
    expect(client.calls.acceptNegotiation).toEqual(["neg-1"]);
    expect(client.calls.rejectNegotiation).toHaveLength(0);
  });

  it("rejects a negotiation for an unknown serviceId, with a reason", async () => {
    const client = new FakeCapClient({
      negotiations: {
        "neg-2": {
          serviceId: "svc-unknown",
          requirements: JSON.stringify({ walletAddresses: [WALLET] }),
        },
      },
    });

    const result = await handleNegotiationCreated(
      client,
      { type: "x", negotiation_id: "neg-2" },
      tierMap(),
    );

    expect(result.action).toBe("REJECTED");
    expect(client.calls.acceptNegotiation).toHaveLength(0);
    expect(client.calls.rejectNegotiation).toHaveLength(1);
    expect(client.calls.rejectNegotiation[0]!.reason.length).toBeGreaterThan(0);
  });

  it("rejects a negotiation when wallet parameters are missing, with a reason", async () => {
    const client = new FakeCapClient({
      negotiations: {
        "neg-3": { serviceId: "svc-quick", requirements: JSON.stringify({ walletAddresses: [] }) },
      },
    });

    const result = await handleNegotiationCreated(
      client,
      { type: "x", negotiation_id: "neg-3" },
      tierMap(),
    );

    expect(result.action).toBe("REJECTED");
    expect(client.calls.rejectNegotiation).toHaveLength(1);
    expect(client.calls.rejectNegotiation[0]!.reason.length).toBeGreaterThan(0);
  });
});

// ── Order delivery / refund wiring (tasks 16.3 / 16.4, requirements 2.3/2.4/2.7/18.4/18.5) ──

describe("CAP Provider — order_paid delivery wiring", () => {
  it("delivers a schema deliverable and records the settlement on a successful audit", async () => {
    const { orchestrator } = makeOrchestrator();
    const ledger = new SettlementLedger();
    const client = new FakeCapClient({
      orders: {
        "order-1": {
          orderId: "order-1",
          serviceId: "svc-full",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddress: WALLET }),
        },
      },
    });

    const result = await handleOrderPaid(
      client,
      { type: "x", order_id: "order-1" },
      { orchestrator, serviceTierMap: tierMap(), ledger },
    );

    expect(result.action).toBe("DELIVERED");
    expect(client.calls.deliverOrder).toHaveLength(1);
    expect(client.calls.rejectOrder).toHaveLength(0);

    const { req } = client.calls.deliverOrder[0]!;
    // Deliverable carries both forms: schema type + non-empty schema (valid JSON) + text.
    expect(req.deliverableType).toBe("schema");
    expect(typeof req.deliverableSchema).toBe("string");
    expect(req.deliverableSchema!.length).toBeGreaterThan(0);
    const parsed = JSON.parse(req.deliverableSchema!);
    expect(parsed.walletAddress).toBe(WALLET);
    expect(parsed.tier).toBe("FULL");
    expect(typeof req.deliverableText).toBe("string");
    expect(req.deliverableText!.length).toBeGreaterThan(0);

    // Settlement recorded against the payer with the full tier amount.
    const settlement = ledger.get("order-1");
    expect(settlement).toBeDefined();
    expect(settlement!.tier).toBe("FULL");
    expect(settlement!.payerAddress).toBe(PAYER);
    expect(settlement!.amountUsdc).toBe(2);
  });

  it("delivers a multi-wallet schema deliverable for the MULTI tier", async () => {
    const { orchestrator } = makeOrchestrator();
    const ledger = new SettlementLedger();
    const client = new FakeCapClient({
      orders: {
        "order-multi": {
          orderId: "order-multi",
          serviceId: "svc-multi",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddresses: [WALLET, WALLET_2] }),
        },
      },
    });

    const result = await handleOrderPaid(
      client,
      { type: "x", order_id: "order-multi" },
      { orchestrator, serviceTierMap: tierMap(), ledger },
    );

    expect(result.action).toBe("DELIVERED");
    const { req } = client.calls.deliverOrder[0]!;
    const parsed = JSON.parse(req.deliverableSchema!);
    // Multi-wallet structured report carries a walletCount and per-wallet reports.
    expect(parsed.walletCount).toBe(2);
    expect(Array.isArray(parsed.reports)).toBe(true);
    expect(ledger.get("order-multi")!.amountUsdc).toBe(5);
  });

  it("uploads the report when it exceeds the upload threshold and embeds the object key", async () => {
    const { orchestrator } = makeOrchestrator();
    const ledger = new SettlementLedger();
    const client = new FakeCapClient({
      uploadKey: "uploaded/report.json",
      orders: {
        "order-big": {
          orderId: "order-big",
          serviceId: "svc-full",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddress: WALLET }),
        },
      },
    });

    const result = await handleOrderPaid(
      client,
      { type: "x", order_id: "order-big" },
      { orchestrator, serviceTierMap: tierMap(), ledger, uploadThresholdBytes: 1 },
    );

    expect(result.action).toBe("DELIVERED");
    expect(client.calls.uploadFile).toHaveLength(1);
    expect(client.calls.deliverOrder[0]!.req.deliverableText).toContain("uploaded/report.json");
  });

  it("rejects and refunds when all data sources fail (no module succeeded)", async () => {
    const { orchestrator, chain } = makeOrchestrator();
    chain.fail.approvals = true;
    chain.fail.balances = true;
    chain.fail.transactions = true;
    chain.fail.internalTxs = true;
    chain.fail.contractMeta = true;

    const ledger = new SettlementLedger();
    const client = new FakeCapClient({
      orders: {
        "order-fail": {
          orderId: "order-fail",
          serviceId: "svc-full",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddress: WALLET }),
        },
      },
    });

    const result = await handleOrderPaid(
      client,
      { type: "x", order_id: "order-fail" },
      { orchestrator, serviceTierMap: tierMap(), ledger },
    );

    expect(result.action).toBe("REJECTED");
    expect(client.calls.rejectOrder).toHaveLength(1);
    expect(client.calls.deliverOrder).toHaveLength(0);
    expect(ledger.get("order-fail")).toBeUndefined();
  });

  it("rejects and refunds a paid order missing wallet addresses (requirement 2.7)", async () => {
    const { orchestrator } = makeOrchestrator();
    const ledger = new SettlementLedger();
    const client = new FakeCapClient({
      orders: {
        "order-noargs": {
          orderId: "order-noargs",
          serviceId: "svc-full",
          requesterWalletAddress: PAYER,
          // No parseable wallet addresses.
          requirements: JSON.stringify({ foo: "bar" }),
        },
      },
    });

    const result = await handleOrderPaid(
      client,
      { type: "x", order_id: "order-noargs" },
      { orchestrator, serviceTierMap: tierMap(), ledger },
    );

    expect(result.action).toBe("REJECTED");
    expect(client.calls.rejectOrder).toHaveLength(1);
    expect(client.calls.rejectOrder[0]!.reason.length).toBeGreaterThan(0);
    expect(client.calls.deliverOrder).toHaveLength(0);
  });

  it("rejects an order whose service is not configured", async () => {
    const { orchestrator } = makeOrchestrator();
    const ledger = new SettlementLedger();
    const client = new FakeCapClient({
      orders: {
        "order-unknown": {
          orderId: "order-unknown",
          serviceId: "svc-unknown",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddress: WALLET }),
        },
      },
    });

    const result = await handleOrderPaid(
      client,
      { type: "x", order_id: "order-unknown" },
      { orchestrator, serviceTierMap: tierMap(), ledger },
    );

    expect(result.action).toBe("REJECTED");
    expect(client.calls.rejectOrder).toHaveLength(1);
  });
});

// ── Loop resilience (requirement 16.x: SDK errors must not crash the loop) ──────────────

describe("CAP Provider — loop resilience", () => {
  it("a thrown APIError inside the negotiation handler does not propagate", async () => {
    const client = new FakeCapClient({
      negotiations: {
        "neg-err": {
          serviceId: "svc-full",
          requirements: JSON.stringify({ walletAddresses: [WALLET] }),
        },
      },
      throwOn: { acceptNegotiation: new APIError(500, 1000, "boom", "internal error") },
    });

    // Must resolve (not reject), reporting an ERROR result.
    const result = await handleNegotiationCreated(
      client,
      { type: "x", negotiation_id: "neg-err" },
      tierMap(),
    );
    expect(result.action).toBe("ERROR");
  });

  it("a thrown APIError inside the order handler does not propagate", async () => {
    const { orchestrator } = makeOrchestrator();
    const ledger = new SettlementLedger();
    const client = new FakeCapClient({
      orders: {
        "order-err": {
          orderId: "order-err",
          serviceId: "svc-full",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddress: WALLET }),
        },
      },
      throwOn: { deliverOrder: new APIError(404, 2000, "not found", "order not found") },
    });

    const result = await handleOrderPaid(
      client,
      { type: "x", order_id: "order-err" },
      { orchestrator, serviceTierMap: tierMap(), ledger },
    );
    expect(result.action).toBe("ERROR");
    // No settlement recorded when delivery throws.
    expect(ledger.get("order-err")).toBeUndefined();
  });
});

// ── Event routing (task 16.1): start() wires real EventType constants to the handlers ───

describe("CAP Provider — event routing", () => {
  it("routes negotiation_created and order_paid via connectWebSocket to the right SDK calls", async () => {
    const { orchestrator } = makeOrchestrator();
    const client = new FakeCapClient({
      negotiations: {
        "neg-r": {
          serviceId: "svc-quick",
          requirements: JSON.stringify({ walletAddress: WALLET }),
        },
      },
      orders: {
        "order-r": {
          orderId: "order-r",
          serviceId: "svc-quick",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddress: WALLET }),
        },
      },
    });

    const provider = new WalletAuditProvider({
      client,
      orchestrator,
      serviceTierMap: tierMap(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const stream = (await provider.start()) as FakeEventStream;

    // Handlers are registered under the real SDK event-type constants.
    expect(stream.handlers.has(EventType.NegotiationCreated)).toBe(true);
    expect(stream.handlers.has(EventType.OrderPaid)).toBe(true);

    // Emit a negotiation_created event → acceptNegotiation; await the routed async handler.
    stream.emit(EventType.NegotiationCreated, {
      type: EventType.NegotiationCreated,
      negotiation_id: "neg-r",
    });
    await provider.onNegotiationCreated({
      type: EventType.NegotiationCreated,
      negotiation_id: "neg-r",
    });
    expect(client.calls.acceptNegotiation).toContain("neg-r");

    // Emit an order_paid event → deliverOrder.
    const orderResult = await provider.onOrderPaid({
      type: EventType.OrderPaid,
      order_id: "order-r",
    });
    expect(orderResult.action).toBe("DELIVERED");
    expect(client.calls.deliverOrder.some((c) => c.id === "order-r")).toBe(true);

    provider.stop();
    expect(stream.closed).toBe(true);
  });

  it("createConsoleLogger produces a usable logger", () => {
    const logger = createConsoleLogger();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });
});
