import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { analyzeAssets } from "../src/modules/asset-analyzer.js";
import { MockPriceDataSource } from "../src/datasource/mock.js";
import type { RawBalance } from "../src/datasource/types.js";
import type { Address } from "../src/models.js";

// Fixed price-fetch time so every result is deterministic (requirement 9.3).
const NOW = "2024-01-01T00:00:00.000Z";

// The "Other" aggregate sentinel emitted by the analyzer (mirrors OTHER_TOKEN_SENTINEL).
const OTHER_SENTINEL = "OTHER";

// ── Generators ─────────────────────────────────────────────────────

/** 40-hex EVM address generator. */
const addressArb: fc.Arbitrary<Address> = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((h) => `0x${h}` as Address);

/** Token generator: the native marker "NATIVE" or a random ERC-20 address. */
const tokenArb: fc.Arbitrary<Address | "NATIVE"> = fc.oneof(
  fc.constant("NATIVE" as const),
  addressArb,
);

/** Positive, finite, human-readable balance amount rendered as a decimal string. */
const balanceArb: fc.Arbitrary<string> = fc
  .double({ min: 0.0001, max: 1e9, noNaN: true, noDefaultInfinity: true })
  .map((n) => String(n));

/**
 * One generated wallet entry: a balance plus an optional USD price.
 * `price === null` models a token the price source cannot value (requirement 9.4).
 */
interface GeneratedEntry {
  token: Address | "NATIVE";
  symbol: string;
  balance: string;
  decimals: number;
  price: number | null;
}

const entryArb: fc.Arbitrary<GeneratedEntry> = fc.record({
  token: tokenArb,
  symbol: fc.string({ minLength: 1, maxLength: 5 }),
  balance: balanceArb,
  decimals: fc.integer({ min: 0, max: 18 }),
  price: fc.option(fc.double({ min: 0.0001, max: 100000, noNaN: true, noDefaultInfinity: true }), {
    nil: null,
  }),
});

/** Normalize a token to its lookup key (native is its own key; addresses are lowercased). */
function normKey(token: Address | "NATIVE"): string {
  return token === "NATIVE" ? "native" : token.toLowerCase();
}

/** Split generated entries into the analyzer inputs: balances and a lowercased price map. */
function buildInputs(entries: GeneratedEntry[]): {
  balances: RawBalance[];
  prices: Record<string, number>;
} {
  const balances: RawBalance[] = entries.map((e) => ({
    token: e.token,
    symbol: e.symbol,
    balance: e.balance,
    decimals: e.decimals,
  }));
  const prices: Record<string, number> = {};
  for (const e of entries) {
    if (e.price !== null) prices[normKey(e.token)] = e.price;
  }
  return { balances, prices };
}

// ── Property 12: asset distribution invariants (requirement 9) ──────

describe("Asset_Analyzer — asset distribution invariants", () => {
  // Feature: wallet-risk-audit-agent, Property 12: asset distribution invariants.
  it("Property 12: asset distribution invariants", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(entryArb, { maxLength: 25 }), async (entries) => {
        const { balances, prices } = buildInputs(entries);
        const source = new MockPriceDataSource(prices, "MockPrice");
        const result = await analyzeAssets(balances, source, { now: NOW });

        // The set of normalized tokens that were actually provided as input.
        const inputKeys = new Set(balances.map((b) => normKey(b.token)));

        // (1) Only native + ERC-20 appear: every displayed token comes from the inputs
        //     (or is the "Other" sentinel). NFTs are excluded by the input type itself.
        for (const item of result.top) {
          expect(inputKeys.has(normKey(item.token))).toBe(true);
        }
        if (result.other !== null) {
          expect(result.other.token).toBe(OTHER_SENTINEL);
        }

        // (2) "top" contains at most 10 priced items.
        const pricedTop = result.top.filter((i) => i.usdValue !== null);
        expect(pricedTop.length).toBeLessThanOrEqual(10);

        // (3) Priced items in "top" are sorted by usdValue descending.
        for (let i = 0; i + 1 < pricedTop.length; i++) {
          expect(pricedTop[i].usdValue as number).toBeGreaterThanOrEqual(
            pricedTop[i + 1].usdValue as number,
          );
        }

        // (4) For a non-empty result, the displayed priced percentages (top entries with a
        //     non-null percentage) plus "Other" sum to exactly 100.00 (tiny float tolerance).
        if (!result.empty) {
          let sum = 0;
          for (const item of result.top) {
            if (item.percentage !== null) sum += item.percentage;
          }
          if (result.other !== null && result.other.percentage !== null) {
            sum += result.other.percentage;
          }
          expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.001);
        }

        // (5) An item with unavailable valuation has both usdValue === null and percentage === null,
        //     and a priced item has both non-null (the two nullability states stay in lock-step).
        for (const item of [...result.top, ...(result.other ? [result.other] : [])]) {
          expect(item.usdValue === null).toBe(item.percentage === null);
        }

        // (6) An ERC-20 valued < $1 is never its own top entry (it is folded into "Other"):
        //     any priced ERC-20 in "top" has usdValue >= 1. The native token may be < 1.
        for (const item of result.top) {
          if (item.token !== "NATIVE" && item.usdValue !== null) {
            expect(item.usdValue).toBeGreaterThanOrEqual(1);
          }
        }

        // (7) The result always carries unit "USD", a non-empty priceSource, and a pricedAt string.
        expect(result.unit).toBe("USD");
        expect(typeof result.priceSource).toBe("string");
        expect(result.priceSource.length).toBeGreaterThan(0);
        expect(typeof result.pricedAt).toBe("string");
        expect(result.pricedAt.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Unit tests: requirement 9.4 / 9.5 / 9.6 edge cases ──────────────

const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;

describe("Asset_Analyzer — edge cases", () => {
  // EDGE_CASE (requirement 9.6): every asset is either unpriced or an ERC-20 valued < $1,
  // so there is nothing displayable -> empty result rather than a blank list.
  it("no displayable assets -> empty result (requirement 9.6)", async () => {
    const balances: RawBalance[] = [
      // ERC-20 valued at $0.50 (< $1) -> junk, not displayable on its own.
      { token: TOKEN_A, symbol: "DUST", balance: "1", decimals: 18 },
      // ERC-20 the price source cannot value -> not displayable.
      { token: TOKEN_B, symbol: "NOPX", balance: "100", decimals: 18 },
    ];
    const source = new MockPriceDataSource({ [TOKEN_A.toLowerCase()]: 0.5 }, "MockPrice");
    const result = await analyzeAssets(balances, source, { now: NOW });

    expect(result.empty).toBe(true);
    expect(result.top).toEqual([]);
    expect(result.other).toBeNull();
    expect(result.unit).toBe("USD");
    expect(result.pricedAt).toBe(NOW);
  });

  // EDGE_CASE (requirement 9.4): an unavailable valuation is listed but excluded from totals
  // and percentages; the single priced asset therefore holds 100.00% of the value.
  it("valuation unavailable is excluded from totals/percentages (requirement 9.4)", async () => {
    const balances: RawBalance[] = [
      // Priced asset worth $100.
      { token: TOKEN_A, symbol: "USDC", balance: "100", decimals: 6 },
      // Unpriced asset (price source returns nothing).
      { token: TOKEN_B, symbol: "MYST", balance: "5", decimals: 18 },
    ];
    const source = new MockPriceDataSource({ [TOKEN_A.toLowerCase()]: 1 }, "MockPrice");
    const result = await analyzeAssets(balances, source, { now: NOW });

    expect(result.empty).toBe(false);

    const priced = result.top.find((i) => i.symbol === "USDC");
    expect(priced).toBeDefined();
    expect(priced?.usdValue).toBe(100);
    expect(priced?.percentage).toBe(100);

    const unpriced = result.top.find((i) => i.symbol === "MYST");
    expect(unpriced).toBeDefined();
    expect(unpriced?.usdValue).toBeNull();
    expect(unpriced?.percentage).toBeNull();

    // No overflow and no junk, so there is no "Other" bucket.
    expect(result.other).toBeNull();
  });

  // EDGE_CASE (requirement 9.5): a dust ERC-20 (< $1) is folded into the "Other" aggregate
  // and never appears as its own top entry.
  it('a dust ERC-20 (< $1) is folded into "Other" (requirement 9.5)', async () => {
    const balances: RawBalance[] = [
      // Main asset worth $1000.
      { token: TOKEN_A, symbol: "USDC", balance: "1000", decimals: 6 },
      // Dust ERC-20 worth $0.01 (< $1) -> folded into "Other".
      { token: TOKEN_B, symbol: "SCAM", balance: "1", decimals: 18 },
    ];
    const source = new MockPriceDataSource(
      { [TOKEN_A.toLowerCase()]: 1, [TOKEN_B.toLowerCase()]: 0.01 },
      "MockPrice",
    );
    const result = await analyzeAssets(balances, source, { now: NOW });

    expect(result.empty).toBe(false);

    // The dust token is not a standalone top entry.
    expect(result.top.some((i) => i.token === TOKEN_B)).toBe(false);
    expect(result.top.some((i) => i.symbol === "SCAM")).toBe(false);

    // The main asset is present.
    const main = result.top.find((i) => i.symbol === "USDC");
    expect(main).toBeDefined();
    expect(main?.usdValue).toBe(1000);

    // The dust value lives in the "Other" aggregate.
    expect(result.other).not.toBeNull();
    expect(result.other?.token).toBe(OTHER_SENTINEL);
    expect(result.other?.symbol).toBe("Other");
    expect(result.other?.balance).toBe("1"); // one merged contributor
    expect(result.other?.usdValue).toBe(0.01);

    // Displayed percentages still sum to exactly 100.00.
    const main2 = main?.percentage ?? 0;
    const other2 = result.other?.percentage ?? 0;
    expect(Math.abs(main2 + other2 - 100)).toBeLessThanOrEqual(0.001);
  });
});
