import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  hireAuditAgent,
  decideFromReport,
  decideFromReports,
  parseDelivery,
  DeliveryParseError,
  isBlockingRiskLevel,
  HEALTH_SCORE_THRESHOLD,
  type RequesterCapClient,
  type RequesterDelivery,
  type NegotiateResult,
} from "../src/examples/requester.js";
import { READ_ONLY_DECLARATION, SCHEMA_VERSION } from "../src/models.js";
import type {
  AuditReportStructured,
  HealthGrade,
  MultiWalletReport,
  RiskLevel,
} from "../src/models.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

const WALLET = "0x" + "1".repeat(40);
const WALLET_2 = "0x" + "2".repeat(40);
const ISO = "2024-01-01T00:00:00.000Z";

/** Map a Health_Score to its qualitative grade (mirrors the Health_Score_Engine bands). */
function gradeForScore(score: number): HealthGrade {
  if (score >= 80) return "EXCELLENT";
  if (score >= 60) return "GOOD";
  if (score >= 40) return "FAIR";
  return "POOR";
}

/** Build a minimal-but-valid AuditReportStructured with the given risk level + health score. */
function makeStructured(
  riskLevelSummary: RiskLevel,
  healthScore: number,
  walletAddress: string = WALLET,
): AuditReportStructured {
  return {
    schemaVersion: SCHEMA_VERSION,
    walletAddress,
    auditedChain: "Ethereum Mainnet",
    generatedAt: ISO,
    tier: "FULL",
    readOnlyDeclaration: READ_ONLY_DECLARATION,
    healthScore,
    healthGrade: gradeForScore(healthScore),
    riskLevelSummary,
    scoredOnIncompleteData: false,
    approvals: [],
    contractRisks: [],
    assets: null,
    txFindings: [],
    revokeAdvice: [],
    moduleStatuses: [],
  };
}

/** A fake Requester CAP client that records call order and returns a programmed delivery. */
class FakeRequesterClient implements RequesterCapClient {
  public readonly calls: string[] = [];
  public readonly negotiateArgs: Array<{ serviceId: string; requirements?: string }> = [];
  public readonly payArgs: string[] = [];
  public readonly deliveryArgs: string[] = [];

  constructor(
    private readonly delivery: RequesterDelivery,
    private readonly negotiationId: string = "neg-1",
  ) {}

  async negotiateOrder(req: {
    serviceId: string;
    requirements?: string;
    metadata?: string;
  }): Promise<NegotiateResult> {
    this.calls.push("negotiateOrder");
    this.negotiateArgs.push({ serviceId: req.serviceId, requirements: req.requirements });
    return { negotiationId: this.negotiationId };
  }

  async payOrder(orderId: string): Promise<unknown> {
    this.calls.push("payOrder");
    this.payArgs.push(orderId);
    return { ok: true };
  }

  async getDelivery(orderId: string): Promise<RequesterDelivery> {
    this.calls.push("getDelivery");
    this.deliveryArgs.push(orderId);
    return this.delivery;
  }
}

// ── hireAuditAgent flow (requirements 5.1 / 5.2 / 5.4) ──────────────────────────────────────

describe("hireAuditAgent — A2A call chain", () => {
  it("calls negotiateOrder → payOrder → getDelivery in order and proceeds on a clean report", async () => {
    const structured = makeStructured("LOW", 95);
    const client = new FakeRequesterClient({
      deliverableType: "schema",
      deliverableSchema: JSON.stringify(structured),
      deliverableText: "# Wallet Risk Audit Report",
    } as RequesterDelivery);

    const decision = await hireAuditAgent(client, {
      serviceId: "svc-full",
      walletAddresses: [WALLET],
      orderId: "order-1",
    });

    // Call chain order is exactly NegotiateOrder → PayOrder → GetDelivery.
    expect(client.calls).toEqual(["negotiateOrder", "payOrder", "getDelivery"]);
    // Wallet addresses are conveyed through the negotiation requirements JSON.
    expect(client.negotiateArgs[0]!.serviceId).toBe("svc-full");
    expect(JSON.parse(client.negotiateArgs[0]!.requirements!)).toEqual({
      walletAddresses: [WALLET],
    });
    // The provided orderId is used for both pay and delivery fetch.
    expect(client.payArgs).toEqual(["order-1"]);
    expect(client.deliveryArgs).toEqual(["order-1"]);
    // Clean report → proceed.
    expect(decision.proceed).toBe(true);
    expect(decision.riskLevel).toBe("LOW");
    expect(decision.healthScore).toBe(95);
  });

  it("aborts when the delivered report is CRITICAL", async () => {
    const structured = makeStructured("CRITICAL", 95);
    const client = new FakeRequesterClient({
      deliverableType: "schema",
      deliverableSchema: JSON.stringify(structured),
    } as RequesterDelivery);

    const decision = await hireAuditAgent(client, {
      serviceId: "svc-full",
      walletAddresses: [WALLET],
      orderId: "order-2",
    });

    expect(decision.proceed).toBe(false);
    expect(decision.riskLevel).toBe("CRITICAL");
  });

  it("resolves the order id via the injected waitForOrderId resolver", async () => {
    const structured = makeStructured("MEDIUM", 75);
    const client = new FakeRequesterClient(
      {
        deliverableType: "schema",
        deliverableSchema: JSON.stringify(structured),
      } as RequesterDelivery,
      "neg-xyz",
    );

    let seenNegotiationId: string | undefined;
    const decision = await hireAuditAgent(client, {
      serviceId: "svc-full",
      walletAddresses: [WALLET],
      waitForOrderId: async (negotiationId) => {
        seenNegotiationId = negotiationId;
        return "order-from-event";
      },
    });

    expect(seenNegotiationId).toBe("neg-xyz");
    expect(client.payArgs).toEqual(["order-from-event"]);
    expect(client.deliveryArgs).toEqual(["order-from-event"]);
    expect(decision.proceed).toBe(true);
  });

  it("aborts when any wallet in a multi-wallet delivery is risky", async () => {
    const multi: MultiWalletReport = {
      schemaVersion: SCHEMA_VERSION,
      walletCount: 2,
      reports: [makeStructured("LOW", 90, WALLET), makeStructured("HIGH", 90, WALLET_2)],
    };
    const client = new FakeRequesterClient({
      deliverableType: "schema",
      deliverableSchema: JSON.stringify(multi),
    } as RequesterDelivery);

    const decision = await hireAuditAgent(client, {
      serviceId: "svc-multi",
      walletAddresses: [WALLET, WALLET_2],
      orderId: "order-multi",
    });

    expect(decision.proceed).toBe(false);
    expect(decision.riskLevel).toBe("HIGH");
    expect(decision.healthScore).toBe(90);
  });

  it("throws without an orderId or resolver", async () => {
    const client = new FakeRequesterClient({
      deliverableType: "schema",
      deliverableSchema: JSON.stringify(makeStructured("LOW", 90)),
    } as RequesterDelivery);

    await expect(
      hireAuditAgent(client, { serviceId: "svc-full", walletAddresses: [WALLET] }),
    ).rejects.toThrow();
  });
});

// ── decideFromReport unit tests (requirements 5.2 / 5.4) ────────────────────────────────────

describe("decideFromReport — gating policy", () => {
  it("aborts on CRITICAL risk even with a perfect score", () => {
    const decision = decideFromReport(makeStructured("CRITICAL", 100));
    expect(decision.proceed).toBe(false);
  });

  it("aborts on HIGH risk even with a perfect score", () => {
    const decision = decideFromReport(makeStructured("HIGH", 100));
    expect(decision.proceed).toBe(false);
  });

  it("aborts on a low health score even with LOW risk", () => {
    const decision = decideFromReport(makeStructured("LOW", HEALTH_SCORE_THRESHOLD - 1));
    expect(decision.proceed).toBe(false);
  });

  it("proceeds on a clean report (LOW risk + high score)", () => {
    const decision = decideFromReport(makeStructured("LOW", 100));
    expect(decision.proceed).toBe(true);
  });

  it("proceeds at the exact health score threshold with MEDIUM risk", () => {
    const decision = decideFromReport(makeStructured("MEDIUM", HEALTH_SCORE_THRESHOLD));
    expect(decision.proceed).toBe(true);
  });
});

describe("decideFromReports — multi-wallet aggregation", () => {
  it("aborts on an empty report set", () => {
    expect(decideFromReports([]).proceed).toBe(false);
  });

  it("proceeds only when every wallet is acceptable", () => {
    const ok = decideFromReports([makeStructured("LOW", 90), makeStructured("MEDIUM", 70)]);
    expect(ok.proceed).toBe(true);
    const bad = decideFromReports([makeStructured("LOW", 90), makeStructured("LOW", 10)]);
    expect(bad.proceed).toBe(false);
  });
});

// ── parseDelivery unit tests ─────────────────────────────────────────────────────────────

describe("parseDelivery", () => {
  it("parses a single structured report", () => {
    const structured = makeStructured("MEDIUM", 70);
    const parsed = parseDelivery({ deliverableSchema: JSON.stringify(structured) });
    expect((parsed as AuditReportStructured).walletAddress).toBe(WALLET);
  });

  it("parses a multi-wallet report", () => {
    const multi: MultiWalletReport = {
      schemaVersion: SCHEMA_VERSION,
      walletCount: 1,
      reports: [makeStructured("LOW", 90)],
    };
    const parsed = parseDelivery({ deliverableSchema: JSON.stringify(multi) });
    expect((parsed as MultiWalletReport).walletCount).toBe(1);
  });

  it("throws DeliveryParseError on a missing schema", () => {
    expect(() => parseDelivery({})).toThrow(DeliveryParseError);
  });

  it("throws DeliveryParseError on invalid JSON", () => {
    expect(() => parseDelivery({ deliverableSchema: "{not json" })).toThrow(DeliveryParseError);
  });
});

// ── Property test (example-level): requester gating ─────────────────────────────────────────
// Feature: wallet-risk-audit-agent, Property: requester gating
// For ANY structured report, the Requester aborts (proceed === false) whenever the report's
// riskLevelSummary is HIGH or CRITICAL OR its healthScore is below HEALTH_SCORE_THRESHOLD; and it
// proceeds (proceed === true) exactly when neither blocking condition holds. This is an
// example-level property (not one of the numbered design properties 1–30).

const RISK_LEVELS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

describe("decideFromReport — property: requester gating", () => {
  it("proceed === false iff risk is HIGH/CRITICAL or score < threshold", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RISK_LEVELS),
        fc.integer({ min: 0, max: 100 }),
        (riskLevel, healthScore) => {
          const decision = decideFromReport(makeStructured(riskLevel, healthScore));

          const shouldBlock =
            isBlockingRiskLevel(riskLevel) || healthScore < HEALTH_SCORE_THRESHOLD;
          expect(decision.proceed).toBe(!shouldBlock);

          // The decision echoes the inputs it gated on.
          expect(decision.riskLevel).toBe(riskLevel);
          expect(decision.healthScore).toBe(healthScore);
        },
      ),
      { numRuns: 300 },
    );
  });
});
