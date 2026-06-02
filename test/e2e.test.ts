/**
 * End-to-end assembly test (task 20.2) — drives the full CAP Provider flow built by
 * {@link buildProvider} against in-memory mock data sources and a fake CAP client (NO real network
 * / SDK). It exercises Negotiate → Pay → run audit → Deliver / settle (and the reject-and-refund
 * branch), and adds regression assertions on a clean wallet vs. a risky wallet.
 *
 * Determinism: an injected clock (`now`) and fully preloaded mock data make every audit
 * reproducible; no wall-clock or network dependence.
 */

import { describe, it, expect } from "vitest";
import { EventType } from "@croo-network/sdk";

import { buildProvider } from "../src/main.js";
import type { RuntimeConfig } from "../src/config.js";
import {
  MockChainDataSource,
  MockPriceDataSource,
  MockRiskRuleSource,
  type MockChainData,
} from "../src/datasource/mock.js";
import type {
  CapClient,
  CapDeliverRequest,
  CapEvent,
  CapEventStream,
} from "../src/cap/provider.js";

// ── Address / id fixtures (all lowercase 0x + 40 hex) ───────────────────────────────────

const RISKY_WALLET = "0x" + "a1".repeat(20); // wallet with an unlimited approval + high-risk tx
const CLEAN_WALLET = "0x" + "d".repeat(40); // wallet with only a priced balance, no risk
const DRAINER = "0x" + "b".repeat(40); // blacklisted spender of the unlimited approval
const HIGH_RISK_CONTRACT = "0x" + "c".repeat(40); // blacklisted contract the risky wallet interacts with
const TOKEN_USDC = "0x" + "e".repeat(40); // a priced ERC-20 holding
const PAYER = "0x" + "f".repeat(40); // CAP requester (settlement-side) wallet

/** Deterministic clock: all windows / report timestamps are relative to this instant. */
const NOW_ISO = "2024-06-01T00:00:00.000Z";
/** Max uint256 — an ERC-20 allowance at this value is an Unlimited_Approval (>= 2^255). */
const MAX_UINT256 = (2n ** 256n - 1n).toString();

/** A configured RuntimeConfig injected into buildProvider (avoids reading env / throwing). */
function testConfig(): RuntimeConfig {
  return {
    crooApiUrl: "https://example.invalid",
    crooWsUrl: "wss://example.invalid/ws",
    crooSdkKey: "test-sdk-key",
    serviceIdQuick: "svc-quick",
    serviceIdFull: "svc-full",
    serviceIdMulti: "svc-multi",
  };
}

/**
 * Preloaded mock chain data:
 *  - RISKY_WALLET: an unlimited ERC-20 approval to the blacklisted DRAINER, a priced native + ERC-20
 *    balance, and an outbound tx to the blacklisted HIGH_RISK_CONTRACT (a high-risk interaction).
 *  - CLEAN_WALLET: a single priced native balance, nothing risky.
 */
function mockChainData(): MockChainData {
  return {
    approvals: {
      [RISKY_WALLET]: [
        {
          tokenContract: TOKEN_USDC,
          spender: DRAINER,
          spenderLabel: "Known Drainer",
          kind: "ERC20",
          allowance: MAX_UINT256,
          lastUpdated: "2024-05-01T00:00:00.000Z",
        },
      ],
    },
    balances: {
      [RISKY_WALLET]: [
        { token: "NATIVE", symbol: "ETH", balance: "2", decimals: 18 },
        { token: TOKEN_USDC, symbol: "USDC", balance: "1000", decimals: 6 },
      ],
      [CLEAN_WALLET]: [{ token: "NATIVE", symbol: "ETH", balance: "5", decimals: 18 }],
    },
    transactions: {
      [RISKY_WALLET]: [
        {
          txHash: "0xhighriskinteraction",
          timestamp: "2024-05-20T00:00:00.000Z",
          from: RISKY_WALLET,
          to: HIGH_RISK_CONTRACT,
          valueWei: "1000000000000000000",
          valueUsd: 2000,
          success: true,
          gasFeeWei: "21000",
          toIsContract: true,
          direction: "OUT",
        },
      ],
    },
    addressType: {
      [RISKY_WALLET]: "EOA",
      [CLEAN_WALLET]: "EOA",
    },
  };
}

/** Build the three mock data sources (DRAINER + HIGH_RISK_CONTRACT are blacklisted). */
function mockProviders(): {
  chain: MockChainDataSource;
  price: MockPriceDataSource;
  rules: MockRiskRuleSource;
} {
  return {
    chain: new MockChainDataSource(mockChainData()),
    price: new MockPriceDataSource({ native: 2000, [TOKEN_USDC]: 1 }, "MockPrice"),
    rules: new MockRiskRuleSource({
      [DRAINER]: { blacklisted: true, label: "Known Drainer" },
      [HIGH_RISK_CONTRACT]: { blacklisted: true, label: "Phishing Contract" },
      [CLEAN_WALLET]: { official: true, label: "Official Treasury" },
    }),
  };
}

// ── Fake CAP client (records calls; serves programmed negotiations / orders) ────────────

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
  emit(type: string, event: CapEvent): void {
    this.handlers.get(type)?.(event);
  }
}

interface FakeClientOptions {
  negotiations?: Record<string, NegotiationData>;
  orders?: Record<string, OrderData>;
}

/** Minimal fake CapClient: no SDK, no network; records every call for assertions. */
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

  async connectWebSocket(): Promise<CapEventStream> {
    return this.stream;
  }

  async getNegotiation(id: string): Promise<{ serviceId: string; requirements: string }> {
    const n = this.opts.negotiations?.[id];
    if (n === undefined) throw new Error(`fake: no negotiation ${id}`);
    return n;
  }

  async acceptNegotiation(id: string): Promise<unknown> {
    this.calls.acceptNegotiation.push(id);
    return { ok: true };
  }

  async rejectNegotiation(id: string, reason: string): Promise<unknown> {
    this.calls.rejectNegotiation.push({ id, reason });
    return { ok: true };
  }

  async getOrder(id: string): Promise<OrderData> {
    const o = this.opts.orders?.[id];
    if (o === undefined) throw new Error(`fake: no order ${id}`);
    return o;
  }

  async deliverOrder(id: string, req: CapDeliverRequest): Promise<unknown> {
    this.calls.deliverOrder.push({ id, req });
    return { txHash: "0xdeliverhash" };
  }

  async rejectOrder(id: string, reason: string): Promise<unknown> {
    this.calls.rejectOrder.push({ id, reason });
    return { ok: true };
  }

  async uploadFile(name: string, body: Buffer): Promise<string> {
    this.calls.uploadFile.push({ name, size: body.length });
    return "object-key";
  }
}

/** Silent logger so the assembled Provider stays quiet during tests. */
const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

/** Assemble the Provider via buildProvider with all real-network deps injected as fakes/mocks. */
async function buildE2EProvider(client: FakeCapClient): ReturnType<typeof buildProvider> {
  return buildProvider({
    config: testConfig(),
    capClient: client,
    providers: mockProviders(),
    now: () => new Date(NOW_ISO),
    logger: SILENT_LOGGER,
  });
}

// ── Full Negotiate → Pay → Deliver flow ─────────────────────────────────────────────────

describe("E2E — full CAP Provider flow over mock data + fake client", () => {
  it("starts, accepts a valid negotiation, delivers a full report and records settlement", async () => {
    const client = new FakeCapClient({
      negotiations: {
        "neg-full": {
          serviceId: "svc-full",
          requirements: JSON.stringify({ walletAddress: RISKY_WALLET }),
        },
      },
      orders: {
        "order-full": {
          orderId: "order-full",
          serviceId: "svc-full",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddress: RISKY_WALLET }),
        },
        "order-nowallet": {
          orderId: "order-nowallet",
          serviceId: "svc-full",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ note: "no wallet here" }),
        },
      },
    });

    const provider = await buildE2EProvider(client);

    // 1. start() connects the WebSocket and registers the real event-type handlers.
    const stream = (await provider.start()) as FakeEventStream;
    expect(stream.handlers.has(EventType.NegotiationCreated)).toBe(true);
    expect(stream.handlers.has(EventType.OrderPaid)).toBe(true);

    // 2. A negotiation for a configured service with a valid wallet → acceptNegotiation.
    const negResult = await provider.onNegotiationCreated({
      type: EventType.NegotiationCreated,
      negotiation_id: "neg-full",
    });
    expect(negResult.action).toBe("ACCEPTED");
    expect(client.calls.acceptNegotiation).toContain("neg-full");
    expect(client.calls.rejectNegotiation).toHaveLength(0);

    // 3. A paid order → run audit → deliver a schema deliverable + record settlement.
    const orderResult = await provider.onOrderPaid({
      type: EventType.OrderPaid,
      order_id: "order-full",
    });
    expect(orderResult.action).toBe("DELIVERED");

    const delivered = client.calls.deliverOrder.find((c) => c.id === "order-full");
    expect(delivered).toBeDefined();
    expect(delivered!.req.deliverableType).toBe("schema");
    expect(typeof delivered!.req.deliverableSchema).toBe("string");
    expect(delivered!.req.deliverableSchema!.length).toBeGreaterThan(0);
    expect(typeof delivered!.req.deliverableText).toBe("string");
    expect(delivered!.req.deliverableText!.length).toBeGreaterThan(0);

    const report = JSON.parse(delivered!.req.deliverableSchema!);
    expect(report.walletAddress).toBe(RISKY_WALLET);
    expect(report.tier).toBe("FULL");
    expect(typeof report.healthScore).toBe("number");
    // CRITICAL contract risk (blacklisted spender) drives the overall risk summary.
    expect(report.riskLevelSummary).toBe("CRITICAL");
    // The unlimited approval to a blacklisted spender yields at least one revocation advice.
    expect(Array.isArray(report.revokeAdvice)).toBe(true);
    expect(report.revokeAdvice.length).toBeGreaterThan(0);

    // Settlement recorded against the payer with the FULL tier amount (2 USDC).
    const settlement = provider.settlementLedger.get("order-full");
    expect(settlement).toBeDefined();
    expect(settlement!.tier).toBe("FULL");
    expect(settlement!.payerAddress).toBe(PAYER);
    expect(settlement!.amountUsdc).toBe(2);

    // 4. A second paid order whose requirements carry no wallet → rejectOrder (refund), no delivery.
    const noWalletResult = await provider.onOrderPaid({
      type: EventType.OrderPaid,
      order_id: "order-nowallet",
    });
    expect(noWalletResult.action).toBe("REJECTED");
    expect(client.calls.rejectOrder.some((c) => c.id === "order-nowallet")).toBe(true);
    expect(client.calls.deliverOrder.some((c) => c.id === "order-nowallet")).toBe(false);
    expect(provider.settlementLedger.get("order-nowallet")).toBeUndefined();

    provider.stop();
    expect(stream.closed).toBe(true);
  });
});

// ── Regression assertions on representative wallets ─────────────────────────────────────

describe("E2E — regression assertions (clean vs. risky wallet)", () => {
  /** Drive a single paid FULL-tier order through the Provider and return its delivered structured report. */
  async function deliverFor(orderId: string, wallet: string): Promise<Record<string, unknown>> {
    const client = new FakeCapClient({
      orders: {
        [orderId]: {
          orderId,
          serviceId: "svc-full",
          requesterWalletAddress: PAYER,
          requirements: JSON.stringify({ walletAddress: wallet }),
        },
      },
    });
    const provider = await buildE2EProvider(client);
    await provider.start();
    const result = await provider.onOrderPaid({ type: EventType.OrderPaid, order_id: orderId });
    expect(result.action).toBe("DELIVERED");
    const delivered = client.calls.deliverOrder.find((c) => c.id === orderId);
    expect(delivered).toBeDefined();
    return JSON.parse(delivered!.req.deliverableSchema!) as Record<string, unknown>;
  }

  it("a clean wallet scores high with no revocation advice", async () => {
    const report = await deliverFor("order-clean", CLEAN_WALLET);
    expect(report.walletAddress).toBe(CLEAN_WALLET);
    // No risk items → perfect score and an EXCELLENT grade.
    expect(report.healthScore).toBe(100);
    expect(report.healthGrade).toBe("EXCELLENT");
    expect(report.riskLevelSummary).toBe("LOW");
    expect((report.addressStanding as { official?: boolean })?.official).toBe(true);
    expect(
      (report.addressStanding as { badge?: { level?: string; label?: string } })?.badge?.level,
    ).toBe("OFFICIAL");
    expect(Array.isArray(report.revokeAdvice)).toBe(true);
    expect((report.revokeAdvice as unknown[]).length).toBe(0);
  });

  it("a risky wallet scores lower and surfaces revocation advice", async () => {
    const report = await deliverFor("order-risky", RISKY_WALLET);
    expect(report.walletAddress).toBe(RISKY_WALLET);
    // Unlimited approval (HIGH) + blacklisted contract (CRITICAL) + high-risk interaction (HIGH).
    expect(typeof report.healthScore).toBe("number");
    expect(report.healthScore as number).toBeLessThan(100);
    expect(report.riskLevelSummary).toBe("CRITICAL");
    expect((report.revokeAdvice as unknown[]).length).toBeGreaterThan(0);
  });

  it("the clean wallet scores strictly higher than the risky wallet", async () => {
    const clean = await deliverFor("order-clean-2", CLEAN_WALLET);
    const risky = await deliverFor("order-risky-2", RISKY_WALLET);
    expect(clean.healthScore as number).toBeGreaterThan(risky.healthScore as number);
  });
});
