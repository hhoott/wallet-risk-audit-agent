/**
 * Unit + property tests for the real data-source Providers (task 17).
 *
 * These tests are network-free: they exercise the pure parsing / mapping helpers exported by the
 * providers (windowDays -> startTimestamp, Etherscan row -> RawTransaction, CoinGecko response ->
 * Map, risk-list lookup), plus the providers' behavior through an injected fake fetch / public
 * client. No real HTTP is performed. A real-network integration test is provided but skipped by
 * default behind the RUN_PROVIDER_INTEGRATION env flag.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  windowDaysToStartTimestamp,
  unixSecondsToIso,
  computeGasFeeWei,
  mapEtherscanTxRow,
  mapEtherscanInternalRow,
  isRowWithinWindow,
  extractTokenContractsFromTransfers,
  isVerifiedSource,
  type EtherscanTxRow,
  type EtherscanInternalRow,
  type EtherscanTokenTxRow,
} from "../src/datasource/providers/chain-etherscan.js";
import {
  splitTokens,
  buildPriceMap,
  CoinGeckoPriceDataSource,
  type TokenPriceResponse,
} from "../src/datasource/providers/price-coingecko.js";
import {
  buildRiskIndex,
  lookupInIndex,
  StaticRiskRuleSource,
  DEFAULT_RISK_LIST,
  type RiskListEntry,
} from "../src/datasource/providers/risk-rules.js";
import type { Address } from "../src/models.js";

// ── Generators ─────────────────────────────────────────────────────

const addressArb: fc.Arbitrary<Address> = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((h) => `0x${h}` as Address);

const WALLET = "0x1111111111111111111111111111111111111111" as Address;

// ── chain-etherscan pure helpers ───────────────────────────────────

describe("chain-etherscan — windowDaysToStartTimestamp", () => {
  const now = new Date("2024-06-01T00:00:00.000Z");

  it("subtracts windowDays worth of seconds from now", () => {
    const nowSec = Math.floor(now.getTime() / 1000);
    expect(windowDaysToStartTimestamp(90, now)).toBe(nowSec - 90 * 86400);
    expect(windowDaysToStartTimestamp(1, now)).toBe(nowSec - 86400);
  });

  it("a non-positive / non-finite window collapses to now (empty window)", () => {
    const nowSec = Math.floor(now.getTime() / 1000);
    expect(windowDaysToStartTimestamp(0, now)).toBe(nowSec);
    expect(windowDaysToStartTimestamp(-5, now)).toBe(nowSec);
    expect(windowDaysToStartTimestamp(Number.NaN, now)).toBe(nowSec);
  });

  it("start timestamp is always <= now for any non-negative window (property)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 3650, noNaN: true }), (days) => {
        const nowSec = Math.floor(now.getTime() / 1000);
        expect(windowDaysToStartTimestamp(days, now)).toBeLessThanOrEqual(nowSec);
      }),
      { numRuns: 200 },
    );
  });
});

describe("chain-etherscan — unixSecondsToIso", () => {
  it("converts unix seconds (string or number) to UTC ISO-8601", () => {
    expect(unixSecondsToIso("0")).toBe("1970-01-01T00:00:00.000Z");
    expect(unixSecondsToIso(1700000000)).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("falls back to the epoch on an unparseable input", () => {
    expect(unixSecondsToIso("not-a-number")).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("chain-etherscan — computeGasFeeWei", () => {
  it("multiplies gasUsed * gasPrice exactly via BigInt", () => {
    expect(computeGasFeeWei("21000", "1000000000")).toBe("21000000000000");
  });

  it("returns 0 on an unparseable operand", () => {
    expect(computeGasFeeWei("abc", "5")).toBe("0");
  });
});

describe("chain-etherscan — isRowWithinWindow", () => {
  it("includes timestamps at or after the start, excludes earlier ones", () => {
    expect(isRowWithinWindow("100", 100)).toBe(true);
    expect(isRowWithinWindow("150", 100)).toBe(true);
    expect(isRowWithinWindow("99", 100)).toBe(false);
    expect(isRowWithinWindow("not-a-number", 100)).toBe(false);
  });
});

describe("chain-etherscan — mapEtherscanTxRow", () => {
  const baseRow: EtherscanTxRow = {
    hash: "0xabc",
    timeStamp: "1700000000",
    from: WALLET,
    to: "0x2222222222222222222222222222222222222222",
    value: "1000000000000000000",
    gasUsed: "21000",
    gasPrice: "1000000000",
    isError: "0",
  };

  it("maps a successful outbound tx (from == wallet) correctly", () => {
    const tx = mapEtherscanTxRow(baseRow, WALLET, true);
    expect(tx.txHash).toBe("0xabc");
    expect(tx.direction).toBe("OUT");
    expect(tx.success).toBe(true);
    expect(tx.valueWei).toBe("1000000000000000000");
    expect(tx.valueUsd).toBeNull();
    expect(tx.gasFeeWei).toBe("21000000000000");
    expect(tx.toIsContract).toBe(true);
    expect(tx.timestamp).toBe(unixSecondsToIso("1700000000"));
  });

  it("maps an inbound tx (from != wallet) with IN direction", () => {
    const row: EtherscanTxRow = { ...baseRow, from: "0x9999999999999999999999999999999999999999" };
    const tx = mapEtherscanTxRow(row, WALLET);
    expect(tx.direction).toBe("IN");
    expect(tx.toIsContract).toBe(false); // default when not resolved
  });

  it("isError === '1' marks the tx as failed", () => {
    const tx = mapEtherscanTxRow({ ...baseRow, isError: "1" }, WALLET);
    expect(tx.success).toBe(false);
  });

  it("an empty `to` maps to null (contract creation)", () => {
    const tx = mapEtherscanTxRow({ ...baseRow, to: "" }, WALLET);
    expect(tx.to).toBeNull();
  });

  it("direction is case-insensitive on the sender address (property)", () => {
    fc.assert(
      fc.property(addressArb, (addr) => {
        const row: EtherscanTxRow = { ...baseRow, from: addr.toUpperCase() };
        const tx = mapEtherscanTxRow(row, addr.toLowerCase() as Address);
        expect(tx.direction).toBe("OUT");
      }),
      { numRuns: 100 },
    );
  });
});

describe("chain-etherscan — mapEtherscanInternalRow", () => {
  it("maps internal tx fields and empty `to` to null", () => {
    const row: EtherscanInternalRow = {
      hash: "0xdef",
      timeStamp: "1700000000",
      to: "0x3333333333333333333333333333333333333333",
      value: "500",
    };
    const itx = mapEtherscanInternalRow(row);
    expect(itx.txHash).toBe("0xdef");
    expect(itx.to).toBe("0x3333333333333333333333333333333333333333");
    expect(itx.valueWei).toBe("500");
    expect(mapEtherscanInternalRow({ ...row, to: "" }).to).toBeNull();
  });
});

describe("chain-etherscan — extractTokenContractsFromTransfers", () => {
  it("dedupes tokens case-insensitively and parses decimals", () => {
    const rows: EtherscanTokenTxRow[] = [
      { contractAddress: "0xAAA0000000000000000000000000000000000001", tokenSymbol: "USDC", tokenDecimal: "6" },
      { contractAddress: "0xaaa0000000000000000000000000000000000001", tokenSymbol: "USDC", tokenDecimal: "6" },
      { contractAddress: "0xBBB0000000000000000000000000000000000002", tokenSymbol: "DAI", tokenDecimal: "18" },
    ];
    const tokens = extractTokenContractsFromTransfers(rows);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].symbol).toBe("USDC");
    expect(tokens[0].decimals).toBe(6);
    expect(tokens[1].decimals).toBe(18);
  });

  it("skips rows with an unparseable decimals field or empty address", () => {
    const rows: EtherscanTokenTxRow[] = [
      { contractAddress: "", tokenSymbol: "X", tokenDecimal: "18" },
      { contractAddress: "0xCCC0000000000000000000000000000000000003", tokenSymbol: "Y", tokenDecimal: "n/a" },
    ];
    expect(extractTokenContractsFromTransfers(rows)).toHaveLength(0);
  });
});

describe("chain-etherscan — isVerifiedSource", () => {
  it("treats non-empty SourceCode as verified", () => {
    expect(isVerifiedSource("contract A {}")).toBe(true);
    expect(isVerifiedSource("")).toBe(false);
    expect(isVerifiedSource("   ")).toBe(false);
    expect(isVerifiedSource(undefined)).toBe(false);
    expect(isVerifiedSource(null)).toBe(false);
  });
});

// ── price-coingecko pure helpers ───────────────────────────────────

describe("price-coingecko — splitTokens", () => {
  it("separates the native marker from unique ERC-20 contracts", () => {
    const { hasNative, contracts } = splitTokens([
      "NATIVE",
      "0xAAA0000000000000000000000000000000000001" as Address,
      "0xaaa0000000000000000000000000000000000001" as Address, // dup (different case)
    ]);
    expect(hasNative).toBe(true);
    expect(contracts).toHaveLength(1);
  });

  it("hasNative is false when NATIVE is absent", () => {
    const { hasNative, contracts } = splitTokens([
      "0xBBB0000000000000000000000000000000000002" as Address,
    ]);
    expect(hasNative).toBe(false);
    expect(contracts).toHaveLength(1);
  });
});

describe("price-coingecko — buildPriceMap", () => {
  const tokenA = "0xAAA0000000000000000000000000000000000001" as Address;
  const tokenB = "0xBBB0000000000000000000000000000000000002" as Address;

  it("keys NATIVE and addresses by the exact input values, omitting unpriced tokens", () => {
    const tokenPrices: TokenPriceResponse = {
      [tokenA.toLowerCase()]: { usd: 1.0 },
      // tokenB intentionally absent
    };
    const map = buildPriceMap(["NATIVE", tokenA, tokenB], 3000, tokenPrices);
    expect(map.get("NATIVE")).toEqual({ token: "NATIVE", usd: 3000 });
    expect(map.get(tokenA)).toEqual({ token: tokenA, usd: 1.0 });
    expect(map.has(tokenB)).toBe(false); // unpriced -> absent (callers treat as unvalued)
  });

  it("preserves the caller's original address casing as the map key", () => {
    const mixed = "0xAbCdef0000000000000000000000000000000099" as Address;
    const tokenPrices: TokenPriceResponse = { [mixed.toLowerCase()]: { usd: 42 } };
    const map = buildPriceMap([mixed], undefined, tokenPrices);
    expect(map.has(mixed)).toBe(true);
    expect([...map.keys()][0]).toBe(mixed);
  });

  it("omits NATIVE when the native price is unavailable / non-finite", () => {
    expect(buildPriceMap(["NATIVE"], undefined, {}).has("NATIVE")).toBe(false);
    expect(buildPriceMap(["NATIVE"], Number.NaN, {}).has("NATIVE")).toBe(false);
  });
});

describe("price-coingecko — CoinGeckoPriceDataSource (injected fetch)", () => {
  const tokenA = "0xAAA0000000000000000000000000000000000001" as Address;

  function fakeFetch(routes: Record<string, unknown>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const [needle, body] of Object.entries(routes)) {
        if (url.includes(needle)) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("sourceName is CoinGecko", () => {
    const ds = new CoinGeckoPriceDataSource();
    expect(ds.sourceName).toBe("CoinGecko");
  });

  it("maps native + token responses into the result map", async () => {
    const ds = new CoinGeckoPriceDataSource({
      fetchImpl: fakeFetch({
        "/simple/price": { ethereum: { usd: 3500 } },
        "/simple/token_price/ethereum": { [tokenA.toLowerCase()]: { usd: 2.5 } },
      }),
    });
    const map = await ds.getUsdPrices(["NATIVE", tokenA]);
    expect(map.get("NATIVE")?.usd).toBe(3500);
    expect(map.get(tokenA)?.usd).toBe(2.5);
  });

  it("returns an empty map for an empty token list without fetching", async () => {
    let called = false;
    const ds = new CoinGeckoPriceDataSource({
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const map = await ds.getUsdPrices([]);
    expect(map.size).toBe(0);
    expect(called).toBe(false);
  });

  it("absent tokens are simply not in the map (unvalued)", async () => {
    const ds = new CoinGeckoPriceDataSource({
      fetchImpl: fakeFetch({ "/simple/token_price/ethereum": {} }),
    });
    const map = await ds.getUsdPrices([tokenA]);
    expect(map.has(tokenA)).toBe(false);
  });
});

// ── risk-rules pure helpers ────────────────────────────────────────

describe("risk-rules — buildRiskIndex / lookupInIndex", () => {
  const list: RiskListEntry[] = [
    { address: "0xDEADbeef00000000000000000000000000000001", blacklisted: true, label: "Drainer" },
    { address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", blacklisted: false, label: "Uniswap V2 Router" },
  ];
  const index = buildRiskIndex(list);

  it("finds a blacklisted entry case-insensitively and preserves the queried casing", () => {
    const upper = "0xDEADBEEF00000000000000000000000000000001" as Address;
    const entry = lookupInIndex(index, upper);
    expect(entry.blacklisted).toBe(true);
    expect(entry.label).toBe("Drainer");
    expect(entry.contract).toBe(upper); // queried address preserved for correlation
  });

  it("returns a clean not-found entry for unknown addresses", () => {
    const unknown = "0x0000000000000000000000000000000000000abc" as Address;
    const entry = lookupInIndex(index, unknown);
    expect(entry).toEqual({ contract: unknown, blacklisted: false });
    expect(entry.label).toBeUndefined();
  });

  it("a later entry overrides an earlier one for the same address", () => {
    const overridden = buildRiskIndex([
      { address: "0xabc0000000000000000000000000000000000001", blacklisted: false, label: "old" },
      { address: "0xABC0000000000000000000000000000000000001", blacklisted: true, label: "new" },
    ]);
    const entry = lookupInIndex(overridden, "0xabc0000000000000000000000000000000000001" as Address);
    expect(entry.blacklisted).toBe(true);
    expect(entry.label).toBe("new");
  });

  // Property: a lookup is invariant to the casing of the queried address.
  it("Property: risk lookup is case-insensitive", () => {
    fc.assert(
      fc.property(addressArb, fc.boolean(), (addr, blacklisted) => {
        const idx = buildRiskIndex([{ address: addr, blacklisted, label: "L" }]);
        const lo = lookupInIndex(idx, addr.toLowerCase() as Address);
        const hi = lookupInIndex(idx, addr.toUpperCase() as Address);
        expect(lo.blacklisted).toBe(blacklisted);
        expect(hi.blacklisted).toBe(blacklisted);
        expect(lo.label).toBe("L");
        expect(hi.label).toBe("L");
      }),
      { numRuns: 200 },
    );
  });
});

describe("risk-rules — StaticRiskRuleSource", () => {
  it("uses the default curated list when none is injected", async () => {
    const rules = new StaticRiskRuleSource();
    const uni = await rules.lookup("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address);
    expect(uni.label).toBe("Uniswap V2 Router");
    expect(uni.blacklisted).toBe(false);
  });

  it("the default list contains at least one blacklisted seed entry", () => {
    expect(DEFAULT_RISK_LIST.some((e) => e.blacklisted)).toBe(true);
  });

  it("an injected list replaces the default (live-feed swap)", async () => {
    const rules = new StaticRiskRuleSource({
      entries: [{ address: "0xfeed000000000000000000000000000000000001", blacklisted: true, label: "Feed" }],
    });
    const hit = await rules.lookup("0xFEED000000000000000000000000000000000001" as Address);
    expect(hit.blacklisted).toBe(true);
    expect(hit.label).toBe("Feed");
    // A default-list address is no longer present once the list is replaced.
    const miss = await rules.lookup("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address);
    expect(miss.blacklisted).toBe(false);
    expect(miss.label).toBeUndefined();
  });

  it("never throws and returns a not-found entry for unknown addresses", async () => {
    const rules = new StaticRiskRuleSource();
    const entry = await rules.lookup("0x0000000000000000000000000000000000000000" as Address);
    expect(entry.blacklisted).toBe(false);
  });
});

// ── Integration (skipped by default; needs real network + keys) ────

const runIntegration = process.env.RUN_PROVIDER_INTEGRATION === "true";

describe.skipIf(!runIntegration)("providers — live network integration", () => {
  it("CoinGecko returns a positive ETH price", async () => {
    const ds = new CoinGeckoPriceDataSource({ apiKey: process.env.COINGECKO_API_KEY });
    const map = await ds.getUsdPrices(["NATIVE"]);
    const native = map.get("NATIVE");
    expect(native).toBeDefined();
    expect(native!.usd).toBeGreaterThan(0);
  });
});
