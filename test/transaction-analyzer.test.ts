import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  TransactionAnalyzer,
  detectTxReasons,
  isWithinWindow,
  isAddressPoisoning,
  clampWindowDays,
  MAX_HIGH_RISK_INTERACTIONS,
  MAX_RETRIEVED_TX,
  HIGH_GAS_MULTIPLIER,
  NO_HIGH_RISK_INTERACTIONS_MESSAGE,
  NO_FAILED_OR_ABNORMAL_TX_MESSAGE,
  RETRIEVAL_FAILED_MESSAGE,
  type AbnormalDetectionContext,
} from "../src/modules/transaction-analyzer.js";
import { MockChainDataSource, MockRiskRuleSource } from "../src/datasource/mock.js";
import type {
  ContractMeta,
  RawInternalTx,
  RawTransaction,
} from "../src/datasource/types.js";
import type { Address, TxFindingReason } from "../src/models.js";

// ── Shared constants / helpers ─────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FIXED_NOW = new Date("2024-06-01T00:00:00.000Z");
const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const VALID_REASONS: readonly TxFindingReason[] = [
  "FAILED",
  "DUST",
  "ADDRESS_POISONING",
  "RISKY_OUTFLOW",
  "HIGH_GAS_FAILED",
  "NEW_CONTRACT",
  "HIGH_RISK_INTERACTION",
];

/** Build a deterministic lowercase 0x + 40-hex address from an index. */
function addrFromIndex(i: number): Address {
  return ("0x" + (i + 1).toString(16).padStart(40, "0")) as Address;
}

/** ISO-8601 UTC string for a timestamp `ageDays` before `now` (negative = future). */
function isoFromAgeDays(now: Date, ageDays: number): string {
  return new Date(now.getTime() - ageDays * MS_PER_DAY).toISOString();
}

/** Flip the first hex char so the result is guaranteed different from the input. */
function flipHex(s: string): string {
  const first = s[0] === "0" ? "1" : "0";
  return first + s.slice(1);
}

/** A RawTransaction with neutral defaults (triggers nothing), overridable per field. */
function makeTx(overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    txHash: "0xhash",
    timestamp: FIXED_NOW.toISOString(),
    from: "0x2222222222222222222222222222222222222222" as Address,
    to: "0x3333333333333333333333333333333333333333" as Address,
    valueWei: "1000",
    valueUsd: 100,
    success: true,
    gasFeeWei: "1000",
    toIsContract: false,
    direction: "OUT",
    ...overrides,
  };
}

// ── Generators ─────────────────────────────────────────────────────

/** 40-hex address generator. */
const addressArb: fc.Arbitrary<Address> = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((h) => `0x${h}` as Address);

// ── Property 8: high-risk interaction marking & interaction type ───

describe("Transaction_Analyzer — high-risk interaction marking", () => {
  /**
   * A single interaction record: it becomes either an external tx (DIRECT) or an internal
   * call (INTERNAL); its `to` is a unique address that may or may not be a High_Risk_Contract.
   */
  const interactionArb = fc.record({
    isInternal: fc.boolean(),
    blacklisted: fc.boolean(),
    ageDays: fc.integer({ min: 0, max: 80 }), // always within the default 90-day window
  });

  // Feature: wallet-risk-audit-agent, Property 8: for any transaction, if its direct counterparty
  // (the `to` address) hits a High_Risk_Contract it is flagged as a high-risk interaction with type
  // "DIRECT"; if its internal-call counterparty hits a High_Risk_Contract it is flagged with type
  // "INTERNAL".
  it("Property 8: high-risk interaction marking & interaction type", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(interactionArb, { minLength: 0, maxLength: 50 }),
        async (records) => {
          const transactions: RawTransaction[] = [];
          const internalTxs: RawInternalTx[] = [];
          const ruleEntries: Record<string, { blacklisted: boolean }> = {};
          // Expected (txHash, interactionType) pairs that should be flagged.
          const expectedDirect = new Set<string>();
          const expectedInternal = new Set<string>();

          records.forEach((rec, i) => {
            const to = addrFromIndex(i);
            const txHash = `0xtx${i}`;
            ruleEntries[to] = { blacklisted: rec.blacklisted };
            const timestamp = isoFromAgeDays(FIXED_NOW, rec.ageDays);
            if (rec.isInternal) {
              internalTxs.push({ txHash, timestamp, to, valueWei: "0" });
              if (rec.blacklisted) expectedInternal.add(txHash);
            } else {
              transactions.push(makeTx({ txHash, timestamp, to, direction: "OUT" }));
              if (rec.blacklisted) expectedDirect.add(txHash);
            }
          });

          const chain = new MockChainDataSource({
            transactions: { [WALLET.toLowerCase()]: transactions },
            internalTxs: { [WALLET.toLowerCase()]: internalTxs },
          });
          const rules = new MockRiskRuleSource(ruleEntries);
          const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });

          const result = await analyzer.analyze(WALLET);
          expect(result.status).toBe("OK");
          if (result.status !== "OK") return;

          const gotDirect = new Set<string>();
          const gotInternal = new Set<string>();
          for (const f of result.highRiskInteractions) {
            expect(f.reason).toBe("HIGH_RISK_INTERACTION");
            expect(f.contract).toBeDefined();
            if (f.interactionType === "DIRECT") gotDirect.add(f.txHash);
            else if (f.interactionType === "INTERNAL") gotInternal.add(f.txHash);
            else throw new Error(`unexpected interactionType: ${String(f.interactionType)}`);
          }

          // Marked as high-risk if and only if the counterparty is a High_Risk_Contract, with the
          // matching interaction type (direct vs internal).
          expect([...gotDirect].sort()).toEqual([...expectedDirect].sort());
          expect([...gotInternal].sort()).toEqual([...expectedInternal].sort());
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ── Property 9: window / cap / sort / field completeness ───────────

describe("Transaction_Analyzer — window, cap, sort and fields", () => {
  const txRecordArb = fc.record({
    ageDays: fc.integer({ min: -5, max: 450 }), // mix of in-window, out-of-window and future
    blacklisted: fc.boolean(),
    success: fc.boolean(),
    direction: fc.constantFrom<"IN" | "OUT">("IN", "OUT"),
    valueUsd: fc.option(fc.double({ min: 0, max: 1000, noNaN: true }), { nil: null }),
    valueWei: fc.constantFrom("0", "1000", "5000000000000000"),
    gasFeeWei: fc.constantFrom("1000", "21000", "9000000000000000"),
  });

  const internalRecordArb = fc.record({
    ageDays: fc.integer({ min: -5, max: 450 }),
    blacklisted: fc.boolean(),
  });

  // Feature: wallet-risk-audit-agent, Property 9: for any transaction set and time window, all
  // analyzed transactions fall within the window and number at most 1000; the high-risk interaction
  // list and the failed/abnormal list are both sorted newest-first, high-risk interactions number at
  // most 100, and every entry contains txHash, UTC time and reason (high-risk also carries the
  // interaction type).
  it("Property 9: window/cap/sort/field completeness", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(txRecordArb, { minLength: 0, maxLength: 40 }),
        fc.array(internalRecordArb, { minLength: 0, maxLength: 20 }),
        fc.integer({ min: 1, max: 365 }),
        async (txRecords, internalRecords, windowDays) => {
          const transactions: RawTransaction[] = [];
          const internalTxs: RawInternalTx[] = [];
          const ruleEntries: Record<string, { blacklisted: boolean }> = {};

          txRecords.forEach((rec, i) => {
            const to = addrFromIndex(i);
            ruleEntries[to] = { blacklisted: rec.blacklisted };
            transactions.push(
              makeTx({
                txHash: `0xext${i}`,
                timestamp: isoFromAgeDays(FIXED_NOW, rec.ageDays),
                to,
                success: rec.success,
                direction: rec.direction,
                valueUsd: rec.valueUsd,
                valueWei: rec.valueWei,
                gasFeeWei: rec.gasFeeWei,
                toIsContract: true,
              }),
            );
          });
          internalRecords.forEach((rec, i) => {
            const to = addrFromIndex(1000 + i);
            ruleEntries[to] = { blacklisted: rec.blacklisted };
            internalTxs.push({
              txHash: `0xint${i}`,
              timestamp: isoFromAgeDays(FIXED_NOW, rec.ageDays),
              to,
              valueWei: "0",
            });
          });

          const chain = new MockChainDataSource({
            transactions: { [WALLET.toLowerCase()]: transactions },
            internalTxs: { [WALLET.toLowerCase()]: internalTxs },
          });
          const rules = new MockRiskRuleSource(ruleEntries);
          const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });

          const result = await analyzer.analyze(WALLET, { windowDays });
          expect(result.status).toBe("OK");
          if (result.status !== "OK") return;

          // Window length reported in days (requirement 8.5).
          expect(result.appliedWindowDays).toBe(windowDays);
          // At most 1000 transactions analyzed (requirement 8.1).
          expect(result.analyzedTxCount).toBeLessThanOrEqual(MAX_RETRIEVED_TX);
          // At most 100 high-risk interactions (requirement 8.4).
          expect(result.highRiskInteractions.length).toBeLessThanOrEqual(
            MAX_HIGH_RISK_INTERACTIONS,
          );

          const assertSortedAndComplete = (
            findings: typeof result.highRiskInteractions,
            isHighRisk: boolean,
          ): void => {
            let prev = Number.POSITIVE_INFINITY;
            for (const f of findings) {
              // Required fields present.
              expect(typeof f.txHash).toBe("string");
              expect(f.txHash.length).toBeGreaterThan(0);
              expect(VALID_REASONS).toContain(f.reason);
              // Timestamp is a valid UTC ISO-8601 instant within the window.
              const t = Date.parse(f.timestamp);
              expect(Number.isNaN(t)).toBe(false);
              expect(new Date(t).toISOString()).toBe(f.timestamp);
              expect(isWithinWindow(f.timestamp, FIXED_NOW, windowDays)).toBe(true);
              // Sorted newest-first.
              expect(t).toBeLessThanOrEqual(prev);
              prev = t;
              if (isHighRisk) {
                expect(f.reason).toBe("HIGH_RISK_INTERACTION");
                expect(f.interactionType === "DIRECT" || f.interactionType === "INTERNAL").toBe(
                  true,
                );
                expect(f.contract).toBeDefined();
              }
            }
          };

          assertSortedAndComplete(result.highRiskInteractions, true);
          assertSortedAndComplete(result.failedAbnormal, false);
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ── Property 10: failed & abnormal transaction identification ──────

describe("Transaction_Analyzer — failed & abnormal identification", () => {
  /** Neutral context: nothing triggers unless a scenario overrides it. */
  function neutralCtx(over: Partial<AbnormalDetectionContext> = {}): AbnormalDetectionContext {
    return {
      failedGasMedianWei: null,
      isRiskListed: () => false,
      isNewContract: () => false,
      historicalAddresses: [],
      ...over,
    };
  }

  interface Scenario {
    tx: RawTransaction;
    ctx: AbnormalDetectionContext;
    expected: TxFindingReason[];
  }

  // FAILED, isolated (median null so HIGH_GAS_FAILED cannot fire).
  const failedScenarioArb: fc.Arbitrary<Scenario> = fc
    .boolean()
    .map((hit) => ({
      tx: makeTx({ success: !hit ? true : false }),
      ctx: neutralCtx(),
      expected: hit ? (["FAILED"] as TxFindingReason[]) : [],
    }));

  // DUST (a): inbound value < $1; null valueUsd is not dust.
  const dustScenarioArb: fc.Arbitrary<Scenario> = fc
    .oneof(
      fc.double({ min: 0, max: 0.999, noNaN: true }).map((v) => ({ usd: v as number | null, hit: true })),
      fc.double({ min: 1, max: 1000, noNaN: true }).map((v) => ({ usd: v as number | null, hit: false })),
      fc.constant({ usd: null as number | null, hit: false }),
    )
    .map(({ usd, hit }) => ({
      tx: makeTx({ direction: "IN", valueUsd: usd, valueWei: "1000" }),
      ctx: neutralCtx(),
      expected: hit ? (["DUST"] as TxFindingReason[]) : [],
    }));

  // ADDRESS_POISONING (b): zero value + counterparty sharing BOTH first4 and last4 with a different
  // historical address. Partial (only-first / only-last) matches and the same address do NOT count.
  const poisonScenarioArb: fc.Arbitrary<Scenario> = fc
    .record({
      first4: fc.hexaString({ minLength: 4, maxLength: 4 }),
      last4: fc.hexaString({ minLength: 4, maxLength: 4 }),
      mid1: fc.hexaString({ minLength: 32, maxLength: 32 }),
      hit: fc.boolean(),
    })
    .map(({ first4, last4, mid1, hit }) => {
      const to = `0x${first4}${mid1}${last4}` as Address;
      const shareBoth = `0x${first4}${flipHex(mid1)}${last4}` as Address; // different addr, both endpoints
      const shareFirstOnly = `0x${first4}${mid1}${flipHex(last4)}` as Address; // only first4 matches
      const shareLastOnly = `0x${flipHex(first4)}${mid1}${last4}` as Address; // only last4 matches
      const historical = hit
        ? [shareFirstOnly, shareBoth, shareLastOnly]
        : [shareFirstOnly, shareLastOnly, to]; // `to` itself is excluded by the detector
      return {
        tx: makeTx({ direction: "OUT", to, valueWei: "0", valueUsd: null }),
        ctx: neutralCtx({ historicalAddresses: historical }),
        expected: hit ? (["ADDRESS_POISONING"] as TxFindingReason[]) : [],
      };
    });

  // RISKY_OUTFLOW (c): outbound to a risk-listed address.
  const riskyOutflowScenarioArb: fc.Arbitrary<Scenario> = fc
    .record({ to: addressArb, hit: fc.boolean() })
    .map(({ to, hit }) => ({
      tx: makeTx({ direction: "OUT", to, valueWei: "1000" }),
      ctx: neutralCtx({ isRiskListed: (a) => hit && a.toLowerCase() === to.toLowerCase() }),
      expected: hit ? (["RISKY_OUTFLOW"] as TxFindingReason[]) : [],
    }));

  // HIGH_GAS_FAILED (d): a failed tx whose gas exceeds 3× the failed-tx gas median (so FAILED is
  // always present too). Exactly 3× the median is NOT a hit (strictly greater than).
  const highGasScenarioArb: fc.Arbitrary<Scenario> = fc
    .record({
      median: fc.bigInt({ min: 1n, max: 10n ** 18n }),
      delta: fc.bigInt({ min: 1n, max: 10n ** 9n }),
      hit: fc.boolean(),
      missFactor: fc.bigInt({ min: 0n, max: 10n ** 18n }),
    })
    .map(({ median, delta, hit, missFactor }) => {
      const threshold = HIGH_GAS_MULTIPLIER * median;
      const gas = hit ? threshold + delta : (missFactor % (threshold + 1n)); // miss ∈ [0, 3×median]
      return {
        tx: makeTx({ success: false, gasFeeWei: gas.toString() }),
        ctx: neutralCtx({ failedGasMedianWei: median }),
        expected: hit
          ? (["FAILED", "HIGH_GAS_FAILED"] as TxFindingReason[])
          : (["FAILED"] as TxFindingReason[]),
      };
    });

  // NEW_CONTRACT (e): interaction with a contract deployed < 7 days ago.
  const newContractScenarioArb: fc.Arbitrary<Scenario> = fc
    .record({ to: addressArb, hit: fc.boolean() })
    .map(({ to, hit }) => ({
      tx: makeTx({ direction: "OUT", to, valueWei: "1000", toIsContract: true }),
      ctx: neutralCtx({ isNewContract: (a) => hit && a.toLowerCase() === to.toLowerCase() }),
      expected: hit ? (["NEW_CONTRACT"] as TxFindingReason[]) : [],
    }));

  const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
    failedScenarioArb,
    dustScenarioArb,
    poisonScenarioArb,
    riskyOutflowScenarioArb,
    highGasScenarioArb,
    newContractScenarioArb,
  );

  // Feature: wallet-risk-audit-agent, Property 10: for any transaction, it is identified as a failed
  // transaction if and only if its on-chain status is failure; it is marked abnormal if and only if
  // it matches one of the five abnormal features (dust < $1, zero-value address poisoning sharing
  // first/last 4 chars with a different historical address, outflow to a risk-listed address, a
  // failed tx whose gas exceeds 3× the window's failed-tx gas median, or interaction with a contract
  // deployed < 7 days ago).
  it("Property 10: failed & abnormal transaction identification", () => {
    fc.assert(
      fc.property(scenarioArb, ({ tx, ctx, expected }) => {
        expect(detectTxReasons(tx, ctx)).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  // Companion check for the address-poisoning helper's "BOTH endpoints + different address" rule.
  it("isAddressPoisoning requires both first4 and last4 to match a different address", () => {
    // body = first4 (abcd) + 32 middle + last4 (00ef), total 40 hex chars.
    const to = "0xabcd0000000000000000000000000000000000ef" as Address; // first4=abcd last4=00ef
    const both = "0xabcd1111111111111111111111111111111100ef" as Address; // different middle, both endpoints
    const firstOnly = "0xabcd0000000000000000000000000000000011ef" as Address; // first4 matches, last4=11ef
    const lastOnly = "0x12340000000000000000000000000000000000ef" as Address; // last4 matches, first4=1234
    expect(isAddressPoisoning(to, [both])).toBe(true);
    expect(isAddressPoisoning(to, [firstOnly])).toBe(false);
    expect(isAddressPoisoning(to, [lastOnly])).toBe(false);
    expect(isAddressPoisoning(to, [to])).toBe(false); // same address excluded
  });
});

// ── Property 11: invalid address is rejected with no tx data ───────

describe("Transaction_Analyzer — invalid address rejection", () => {
  /** Generators that are guaranteed to be invalid wallet addresses. */
  const invalidAddressArb: fc.Arbitrary<string> = fc
    .oneof(
      fc.constantFrom("", "   ", "\t\n", "vitalik.eth", "0x", "not-an-address"),
      // missing 0x prefix (40 hex)
      fc.hexaString({ minLength: 40, maxLength: 40 }),
      // wrong length with 0x prefix
      fc.hexaString({ minLength: 0, maxLength: 39 }).map((h) => `0x${h}`),
      fc.hexaString({ minLength: 41, maxLength: 80 }).map((h) => `0x${h}`),
      // correct length but contains a non-hex char
      fc
        .hexaString({ minLength: 39, maxLength: 39 })
        .map((h) => `0x${h}z`),
    )
    .filter((s) => !/^0x[0-9a-fA-F]{40}$/.test(s.trim()));

  // Feature: wallet-risk-audit-agent, Property 11: for any invalid-format wallet address, the
  // Transaction_Analyzer rejects the request and returns an error result indicating the invalid
  // address format, returning no transaction analysis data.
  it("Property 11: invalid address rejected with no tx data", async () => {
    await fc.assert(
      fc.asyncProperty(invalidAddressArb, async (bad) => {
        // Fail every data method: if the analyzer wrongly proceeded to retrieval it would surface
        // RETRIEVAL_FAILED instead of INVALID_ADDRESS, so INVALID_ADDRESS proves it short-circuited.
        const chain = new MockChainDataSource();
        chain.fail.transactions = true;
        chain.fail.internalTxs = true;
        chain.fail.contractMeta = true;
        const rules = new MockRiskRuleSource();
        rules.fail = true;
        const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });

        const result = await analyzer.analyze(bad);
        expect(result.status).toBe("INVALID_ADDRESS");
        // No transaction analysis data is present on the result.
        expect("highRiskInteractions" in result).toBe(false);
        expect("failedAbnormal" in result).toBe(false);
        expect("appliedWindowDays" in result).toBe(false);
        if (result.status === "INVALID_ADDRESS") {
          expect(result.errorKind).toBeDefined();
          expect(result.error.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 150 },
    );
  });
});

// ── Unit tests: empty results, caps, retrieval failure, examples ───

describe("Transaction_Analyzer — unit tests", () => {
  it("returns the \"no high-risk interactions\" message when none are found (req 8.6)", async () => {
    const chain = new MockChainDataSource({
      transactions: {
        [WALLET.toLowerCase()]: [
          makeTx({ txHash: "0xa", to: addrFromIndex(1), timestamp: isoFromAgeDays(FIXED_NOW, 5) }),
        ],
      },
    });
    const rules = new MockRiskRuleSource(); // nothing blacklisted
    const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });
    const result = await analyzer.analyze(WALLET);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.highRiskInteractions).toEqual([]);
    expect(result.highRiskMessage).toBe(NO_HIGH_RISK_INTERACTIONS_MESSAGE);
  });

  it("returns the \"no failed or abnormal transactions\" message when none are found (req 10.4)", async () => {
    const chain = new MockChainDataSource({
      transactions: {
        [WALLET.toLowerCase()]: [
          makeTx({
            txHash: "0xb",
            to: addrFromIndex(2),
            timestamp: isoFromAgeDays(FIXED_NOW, 3),
            success: true,
            direction: "OUT",
            valueUsd: 100,
            valueWei: "1000",
          }),
        ],
      },
    });
    const rules = new MockRiskRuleSource();
    const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });
    const result = await analyzer.analyze(WALLET);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.failedAbnormal).toEqual([]);
    expect(result.failedAbnormalMessage).toBe(NO_FAILED_OR_ABNORMAL_TX_MESSAGE);
  });

  it("returns both \"none found\" messages when the wallet has no transactions", async () => {
    const chain = new MockChainDataSource();
    const rules = new MockRiskRuleSource();
    const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });
    const result = await analyzer.analyze(WALLET);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.analyzedTxCount).toBe(0);
    expect(result.highRiskMessage).toBe(NO_HIGH_RISK_INTERACTIONS_MESSAGE);
    expect(result.failedAbnormalMessage).toBe(NO_FAILED_OR_ABNORMAL_TX_MESSAGE);
  });

  it("distinguishes DIRECT vs INTERNAL high-risk interactions (req 8.2/8.3)", async () => {
    const directTo = addrFromIndex(10);
    const internalTo = addrFromIndex(11);
    const chain = new MockChainDataSource({
      transactions: {
        [WALLET.toLowerCase()]: [
          makeTx({ txHash: "0xdirect", to: directTo, timestamp: isoFromAgeDays(FIXED_NOW, 1) }),
        ],
      },
      internalTxs: {
        [WALLET.toLowerCase()]: [
          { txHash: "0xinternal", to: internalTo, valueWei: "0", timestamp: isoFromAgeDays(FIXED_NOW, 2) },
        ],
      },
    });
    const rules = new MockRiskRuleSource({
      [directTo]: { blacklisted: true },
      [internalTo]: { blacklisted: true },
    });
    const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });
    const result = await analyzer.analyze(WALLET);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    const byHash = new Map(result.highRiskInteractions.map((f) => [f.txHash, f]));
    expect(byHash.get("0xdirect")?.interactionType).toBe("DIRECT");
    expect(byHash.get("0xinternal")?.interactionType).toBe("INTERNAL");
    // Newest-first: the direct tx (1 day ago) precedes the internal tx (2 days ago).
    expect(result.highRiskInteractions[0].txHash).toBe("0xdirect");
  });

  it("caps high-risk interactions at 100, keeping the newest (req 8.4)", async () => {
    const transactions: RawTransaction[] = [];
    const ruleEntries: Record<string, { blacklisted: boolean }> = {};
    for (let i = 0; i < 150; i++) {
      const to = addrFromIndex(i);
      ruleEntries[to] = { blacklisted: true };
      transactions.push(
        makeTx({ txHash: `0xh${i}`, to, timestamp: isoFromAgeDays(FIXED_NOW, i + 1) }),
      );
    }
    const chain = new MockChainDataSource({ transactions: { [WALLET.toLowerCase()]: transactions } });
    const rules = new MockRiskRuleSource(ruleEntries);
    const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });
    // Use the full 365-day window so all 150 blacklisted txs (ages 1–150 days) fall within it.
    const result = await analyzer.analyze(WALLET, { windowDays: 365 });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.highRiskInteractions.length).toBe(MAX_HIGH_RISK_INTERACTIONS);
    // The newest (smallest age) must be first and retained.
    expect(result.highRiskInteractions[0].txHash).toBe("0xh0");
  });

  it("caps analyzed transactions at 1000 (req 8.1)", async () => {
    const transactions: RawTransaction[] = [];
    for (let i = 0; i < 1200; i++) {
      transactions.push(
        makeTx({ txHash: `0xn${i}`, to: addrFromIndex(i), timestamp: isoFromAgeDays(FIXED_NOW, 1) }),
      );
    }
    const chain = new MockChainDataSource({ transactions: { [WALLET.toLowerCase()]: transactions } });
    const rules = new MockRiskRuleSource();
    const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });
    const result = await analyzer.analyze(WALLET);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.analyzedTxCount).toBe(MAX_RETRIEVED_TX);
  });

  it("returns a retrieval-failed result when the transaction data source is unavailable (req 10.6)", async () => {
    const chain = new MockChainDataSource();
    chain.fail.transactions = true;
    const rules = new MockRiskRuleSource();
    const analyzer = new TransactionAnalyzer({ chain, rules, now: () => FIXED_NOW });
    const result = await analyzer.analyze(WALLET);
    expect(result.status).toBe("RETRIEVAL_FAILED");
    if (result.status !== "RETRIEVAL_FAILED") return;
    expect(result.message).toBe(RETRIEVAL_FAILED_MESSAGE);
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("clamps the window to [1, 365] and defaults to 90 days (req 8.1)", () => {
    expect(clampWindowDays(undefined)).toBe(90);
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(-50)).toBe(1);
    expect(clampWindowDays(500)).toBe(365);
    expect(clampWindowDays(120)).toBe(120);
    expect(clampWindowDays(30.9)).toBe(30);
  });
});
