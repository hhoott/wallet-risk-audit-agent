import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  decideNegotiation,
  parseAuditRequirements,
  priceForTier,
  decideSettlement,
  recordSettlement,
  SettlementLedger,
  someModuleSucceeded,
  type NegotiationDecision,
  type ModuleSuccessSignal,
} from "../src/modules/payment-gateway.js";
import type { Tier } from "../src/config.js";
import { TIER_PRICE_USDC } from "../src/config.js";
import type { ModuleState } from "../src/models.js";

const ALL_TIERS: Tier[] = ["QUICK", "FULL", "MULTI"];
const MODULE_STATES: ModuleState[] = ["OK", "INCOMPLETE", "FAILED"];

/** Build a fresh Service_ID -> Tier map mirroring buildServiceTierMap output. */
function tierMap(entries: Array<[string, Tier]>): Map<string, Tier> {
  return new Map(entries);
}

/** Arbitrary EVM-ish address string (format depth not required here). */
const addressArb = fc.hexaString({ minLength: 40, maxLength: 40 }).map((h) => "0x" + h);

const tierArb = fc.constantFrom<Tier>(...ALL_TIERS);
const moduleStateArb = fc.constantFrom<ModuleState>(...MODULE_STATES);

describe("Payment_Gateway", () => {
  // ── Property 3: negotiation decision correctness ──────────────────────────────────────
  // Feature: wallet-risk-audit-agent, Property 3: for any negotiation request (serviceId and
  // parameter completeness), the decision is ACCEPT if and only if the serviceId is one of this
  // Agent's configured tiers AND the requirements payload parses to a non-empty wallet list;
  // otherwise REJECT with a reason.
  it("Property 3: negotiation decision correctness", () => {
    fc.assert(
      fc.property(
        // A configured map of service ids -> tiers
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 12 }), tierArb), {
          maxLength: 5,
        }),
        // The serviceId presented in the negotiation (may or may not be configured)
        fc.string({ maxLength: 12 }),
        // The wallet list that a "valid" payload would carry
        fc.array(addressArb, { maxLength: 5 }),
        // Whether to present a valid payload, a malformed one, or undefined
        fc.constantFrom<"valid-list" | "valid-single" | "garbage" | "empty" | "undefined">(
          "valid-list",
          "valid-single",
          "garbage",
          "empty",
          "undefined",
        ),
        (mapEntries, serviceId, wallets, payloadKind) => {
          const map = tierMap(mapEntries);

          let requirements: string | undefined;
          // Compute the wallet list the parser is expected to extract from this payload.
          let parsedWallets: string[];
          switch (payloadKind) {
            case "valid-list": {
              requirements = JSON.stringify({ walletAddresses: wallets });
              parsedWallets = wallets.filter((w) => w.trim().length > 0);
              break;
            }
            case "valid-single": {
              const single = wallets[0];
              requirements = JSON.stringify({ walletAddress: single });
              parsedWallets =
                typeof single === "string" && single.trim().length > 0 ? [single] : [];
              break;
            }
            case "garbage": {
              requirements = "this-is-not-json{";
              parsedWallets = [];
              break;
            }
            case "empty": {
              requirements = "   ";
              parsedWallets = [];
              break;
            }
            case "undefined": {
              requirements = undefined;
              parsedWallets = [];
              break;
            }
          }

          const decision: NegotiationDecision = decideNegotiation({ serviceId, requirements }, map);

          const isConfigured = map.has(serviceId);
          const hasWallets = parsedWallets.length > 0;
          const expectAccept = isConfigured && hasWallets;

          expect(decision.action).toBe(expectAccept ? "ACCEPT" : "REJECT");

          if (decision.action === "ACCEPT") {
            expect(decision.tier).toBe(map.get(serviceId));
            expect(decision.walletAddresses).toEqual(parsedWallets);
          } else {
            // Reject must always carry a non-empty reason.
            expect(decision.reason.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── Property 29: pay-deliver & settle-refund invariants ───────────────────────────────
  // Feature: wallet-risk-audit-agent, Property 29: for any paid CAP order and its module
  // completion state: deliver only when USDC is escrowed; when escrow is locked and at least one
  // module succeeded, deliver and settle the full tier amount (0.5/2/5 USDC); when escrow is locked
  // and no module succeeded, RejectOrder and refund escrow without delivering.
  it("Property 29: pay-deliver and settle-refund invariants", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(moduleStateArb, { maxLength: 8 }),
        tierArb,
        (escrowLocked, moduleStatuses, tier) => {
          const decision = decideSettlement({ escrowLocked, moduleStatuses, tier });
          const someOk = moduleStatuses.some((s) => s === "OK");

          if (!escrowLocked) {
            // Never settle without escrow.
            expect(decision.action).toBe("WITHHOLD_DELIVERY");
            return;
          }

          if (someOk) {
            // Full-amount settlement when any module succeeds.
            expect(decision.action).toBe("DELIVER_AND_SETTLE");
            if (decision.action === "DELIVER_AND_SETTLE") {
              expect(decision.amountUsdc).toBe(priceForTier(tier));
              expect([0.5, 2, 5]).toContain(decision.amountUsdc);
            }
          } else {
            // Refund when all modules fail / are incomplete.
            expect(decision.action).toBe("REJECT_AND_REFUND");
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── Property 30: settlement record completeness ───────────────────────────────────────
  // Feature: wallet-risk-audit-agent, Property 30: for any completed settlement, recordSettlement
  // yields a record whose tier, payerAddress and settlementTxHash match the inputs and whose
  // amountUsdc equals the tier price; SettlementLedger.get returns that exact record.
  it("Property 30: settlement record completeness", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        tierArb,
        addressArb,
        fc.hexaString({ minLength: 64, maxLength: 64 }).map((h) => "0x" + h),
        (orderId, tier, payerAddress, settlementTxHash) => {
          const ledger = new SettlementLedger();
          const rec = ledger.record(orderId, tier, payerAddress, settlementTxHash);

          expect(rec.orderId).toBe(orderId);
          expect(rec.tier).toBe(tier);
          expect(rec.payerAddress).toBe(payerAddress);
          expect(rec.settlementTxHash).toBe(settlementTxHash);
          expect(rec.amountUsdc).toBe(priceForTier(tier));

          // The ledger returns the exact stored record.
          expect(ledger.get(orderId)).toEqual(rec);

          // recordSettlement (the pure builder) agrees with the ledger.
          expect(recordSettlement(orderId, tier, payerAddress, settlementTxHash)).toEqual(rec);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── Unit tests ────────────────────────────────────────────────────────────────────────

  it("price table: QUICK = 0.5, FULL = 2, MULTI = 5 USDC", () => {
    expect(priceForTier("QUICK")).toBe(0.5);
    expect(priceForTier("FULL")).toBe(2);
    expect(priceForTier("MULTI")).toBe(5);
    // Mirrors the config source of truth.
    expect(TIER_PRICE_USDC).toEqual({ QUICK: 0.5, FULL: 2, MULTI: 5 });
  });

  it("rejects negotiation for an unknown service id", () => {
    const map = tierMap([["svc-quick", "QUICK"]]);
    const decision = decideNegotiation(
      {
        serviceId: "svc-unknown",
        requirements: JSON.stringify({ walletAddresses: ["0xabc"] }),
      },
      map,
    );
    expect(decision.action).toBe("REJECT");
    if (decision.action === "REJECT") {
      expect(decision.reason).toMatch(/serviceId/i);
    }
  });

  it("rejects negotiation when required wallet parameters are missing", () => {
    const map = tierMap([["svc-full", "FULL"]]);
    const decision = decideNegotiation(
      { serviceId: "svc-full", requirements: JSON.stringify({ walletAddresses: [] }) },
      map,
    );
    expect(decision.action).toBe("REJECT");
  });

  it("accepts negotiation and resolves tier + wallets for a configured service", () => {
    const map = tierMap([["svc-multi", "MULTI"]]);
    const decision = decideNegotiation(
      {
        serviceId: "svc-multi",
        requirements: JSON.stringify({ walletAddresses: ["0xaaa", "0xbbb"] }),
      },
      map,
    );
    expect(decision.action).toBe("ACCEPT");
    if (decision.action === "ACCEPT") {
      expect(decision.tier).toBe("MULTI");
      expect(decision.walletAddresses).toEqual(["0xaaa", "0xbbb"]);
    }
  });

  it("parseAuditRequirements accepts the single-wallet convenience shape", () => {
    expect(parseAuditRequirements(JSON.stringify({ walletAddress: "0x123" }))).toEqual(["0x123"]);
  });

  it("parseAuditRequirements returns [] for undefined / blank / garbage payloads", () => {
    expect(parseAuditRequirements(undefined)).toEqual([]);
    expect(parseAuditRequirements("   ")).toEqual([]);
    expect(parseAuditRequirements("{not json")).toEqual([]);
    expect(parseAuditRequirements(JSON.stringify({ walletAddresses: ["", "  "] }))).toEqual([]);
  });

  it("withholds delivery for an unescrowed order regardless of module success", () => {
    const decision = decideSettlement({
      escrowLocked: false,
      moduleStatuses: ["OK", "OK"],
      tier: "FULL",
    });
    expect(decision.action).toBe("WITHHOLD_DELIVERY");
  });

  it("rejects and refunds when escrow is locked but no module succeeded", () => {
    const decision = decideSettlement({
      escrowLocked: true,
      moduleStatuses: ["FAILED", "INCOMPLETE"],
      tier: "QUICK",
    });
    expect(decision.action).toBe("REJECT_AND_REFUND");
  });

  it("someModuleSucceeded handles boolean, enum and ModuleStatus signals", () => {
    const signals: ModuleSuccessSignal[] = [false, "FAILED", { module: "x", status: "OK" }];
    expect(someModuleSucceeded(signals)).toBe(true);
    expect(someModuleSucceeded([false, "INCOMPLETE"])).toBe(false);
  });
});
