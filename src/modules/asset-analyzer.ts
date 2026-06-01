/**
 * Asset_Analyzer — asset distribution summary (task 7.1, pure logic, aligned with
 * requirement 9 and the design.md "Asset_Analyzer" rows).
 *
 * Input: native + ERC-20 balances (`RawBalance[]`, no NFTs) + an injected `PriceDataSource`.
 * Output: an `AssetDistribution` conforming to models.ts.
 *
 * Security constraint (requirement 13.1): consumes only the injected read-only data source;
 * there is no write-chain / send-transaction path.
 *
 * Key rules (requirements 9.1–9.6):
 *  - 9.1 Summarize only native token + ERC-20, no NFTs (guaranteed by the input type).
 *  - 9.2 Take the top 10 main assets by USD valuation in descending order, and merge the rest
 *        into a single "Other" item; each item and "Other" report a percentage of the total
 *        value, kept to two decimals, summing to exactly 100.00%.
 *  - 9.3 Tag unit="USD", priceSource (taken from PriceDataSource.sourceName), pricedAt (price
 *        fetch time, UTC).
 *  - 9.4 An item whose valuation cannot be obtained -> usdValue=null, percentage=null; it is
 *        still listed with its balance, but excluded from the total value and percentages.
 *  - 9.5 An **ERC-20** valued < 1 USD is treated as a suspected airdrop / junk token, excluded
 *        from the top 10 main assets and folded into "Other"; the native token is not subject to
 *        this rule (it is always a main-asset candidate; the gas token is always meaningful).
 *  - 9.6 A wallet with no asset valued >= 1 USD -> return a "no displayable assets" result with
 *        empty=true, rather than a blank list.
 *
 * ── Percentage rounding strategy (guarantees the sum is exactly 100.00%) ─────────────
 * Uses the **Largest-Remainder method (Hamilton)**, allocating over integer "hundredths of a
 * percentage point" (i.e. units of 0.01%, with the total split into 10000 shares):
 *   1. For each displayed priced item (top 10 main assets + "Other") compute raw = usdValue/total*10000;
 *   2. Take floor as the initial share, and count the unallocated remainder remaining = 10000 - Σfloor;
 *   3. By fractional remainder from largest to smallest, hand out the `remaining` "+1" increments to
 *      the items with the largest remainders (ties broken by index, stably).
 * This method guarantees Σ shares == 10000 (i.e. the percentages always sum to 100.00%), and each item
 * is exactly the standard rounding to two decimals; the rounding error is fairly distributed to the
 * item that most deserves the increment, with no need to artificially fold it into the "largest item / Other".
 */

import type { Address, AssetDistribution, AssetItem } from "../models.js";
import type { PriceDataSource, RawBalance } from "../datasource/types.js";

/** Main-asset display threshold: an ERC-20 valued < 1 USD is treated as a junk token (requirement 9.5);
 *  "no asset >= 1 USD" triggers empty (requirement 9.6). */
const MIN_DISPLAY_USD = 1;

/** Upper bound on the top N main assets (requirement 9.2). */
const MAX_TOP_ITEMS = 10;

/** Token sentinel value for the "Other" aggregate item (not a real token address). */
const OTHER_TOKEN_SENTINEL = "OTHER";

/** Display name of the "Other" aggregate item. */
const OTHER_SYMBOL = "Other";

/** Asset_Analyzer options. */
export interface AssetAnalyzerOptions {
  /** Price fetch time (UTC ISO-8601). Defaults to `new Date().toISOString()` (requirement 9.3). */
  now?: string;
}

interface PricedAsset {
  balance: RawBalance;
  /** Exact USD valuation (balance × price). Used for threshold checks, sorting, and as the percentage base. */
  usdValue: number;
}

/**
 * Summarize the wallet's asset distribution.
 *
 * @param balances    native + ERC-20 balances (no NFTs).
 * @param priceSource injected price data source (provides USD valuations and the source name).
 * @param options     options (injected price fetch time).
 */
export async function analyzeAssets(
  balances: RawBalance[],
  priceSource: PriceDataSource,
  options: AssetAnalyzerOptions = {},
): Promise<AssetDistribution> {
  const pricedAt = options.now ?? new Date().toISOString();
  const unit = "USD" as const;
  const priceSourceName = priceSource.sourceName;

  // Fetch prices: deduplicate tokens then batch-query, building a case-insensitive valuation lookup table.
  const uniqueTokens = dedupeTokens(balances.map((b) => b.token));
  const priceMap = await priceSource.getUsdPrices(uniqueTokens);
  const usdByToken = new Map<string, number>();
  for (const [token, price] of priceMap) {
    usdByToken.set(normalizeToken(token), price.usd);
  }

  // Value each item: valuable -> priced; not returned by the price source -> unvalued (requirement 9.4).
  const priced: PricedAsset[] = [];
  const unvalued: RawBalance[] = [];
  for (const b of balances) {
    const price = usdByToken.get(normalizeToken(b.token));
    if (price === undefined) {
      unvalued.push(b);
      continue;
    }
    const qty = toFinite(Number(b.balance));
    priced.push({ balance: b, usdValue: qty * price });
  }

  // Requirement 9.6: no asset valued >= 1 USD -> "no displayable assets".
  const anyDisplayable = priced.some((p) => p.usdValue >= MIN_DISPLAY_USD);
  if (!anyDisplayable) {
    return { unit, priceSource: priceSourceName, pricedAt, top: [], other: null, empty: true };
  }

  // Main-asset candidates = native token (any valuation) + ERC-20 valued >= 1 USD.
  // Junk tokens = ERC-20 valued < 1 USD (requirement 9.5; the native token is not in this class).
  const isNative = (b: RawBalance): boolean => b.token === "NATIVE";
  const mainCandidates = priced.filter((p) => isNative(p.balance) || p.usdValue >= MIN_DISPLAY_USD);
  const junk = priced.filter((p) => !isNative(p.balance) && p.usdValue < MIN_DISPLAY_USD);

  // Descending by USD (ties broken by token for a stable, deterministic order).
  mainCandidates.sort(
    (a, b) =>
      b.usdValue - a.usdValue ||
      normalizeToken(a.balance.token).localeCompare(normalizeToken(b.balance.token)),
  );

  const topMain = mainCandidates.slice(0, MAX_TOP_ITEMS);
  const overflow = mainCandidates.slice(MAX_TOP_ITEMS);

  // "Other" = overflow main assets (from the 11th item on) + junk tokens (requirements 9.2 / 9.5).
  const otherContributors = [...overflow, ...junk];
  const hasOther = otherContributors.length > 0;
  const otherValue = otherContributors.reduce((sum, p) => sum + p.usdValue, 0);

  // Total value (priced items only) = top 10 main assets + "Other" = sum of all priced items
  // (unvalued items are excluded, requirement 9.4).
  const total = topMain.reduce((sum, p) => sum + p.usdValue, 0) + otherValue;

  // Percentages: Largest-Remainder method, summing to exactly 100.00% (see the file-header strategy).
  const displayedValues = [...topMain.map((p) => p.usdValue), ...(hasOther ? [otherValue] : [])];
  const percentages = hamiltonPercentages(displayedValues, total);

  // Top 10 main assets (with percentages).
  const top: AssetItem[] = topMain.map((p, i) => ({
    token: p.balance.token,
    symbol: p.balance.symbol,
    balance: p.balance.balance,
    usdValue: round2(p.usdValue),
    percentage: percentages[i],
  }));

  // Items with unavailable valuation: still listed with their balance, usdValue / percentage = null (requirement 9.4).
  for (const b of unvalued) {
    top.push({
      token: b.token,
      symbol: b.symbol,
      balance: b.balance,
      usdValue: null,
      percentage: null,
    });
  }

  // "Other" aggregate item: the balance field carries the count of merged assets (the aggregate has no single token balance).
  const other: AssetItem | null = hasOther
    ? {
        token: OTHER_TOKEN_SENTINEL,
        symbol: OTHER_SYMBOL,
        balance: String(otherContributors.length),
        usdValue: round2(otherValue),
        percentage: percentages[percentages.length - 1],
      }
    : null;

  return { unit, priceSource: priceSourceName, pricedAt, top, other, empty: false };
}

/**
 * Allocate percentages (two decimals) with the Largest-Remainder method. Allocates over integer
 * 0.01% units (10000 shares in total), and returns a percentage array in the same order as `values`,
 * always summing to 100.00.
 */
function hamiltonPercentages(values: number[], total: number): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (total <= 0) return values.map(() => 0);

  const scaled = values.map((v) => (v / total) * 10000);
  const units = scaled.map((s) => Math.floor(s));
  const used = units.reduce((a, b) => a + b, 0);
  let remaining = 10000 - used; // in theory lands in [0, n]

  // Hand out the +1 increments by fractional remainder from largest to smallest (ties broken by index, stably, for determinism).
  const byRemainder = scaled
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byRemainder.length && remaining > 0; k++) {
    units[byRemainder[k].i] += 1;
    remaining -= 1;
  }
  return units.map((u) => u / 100);
}

/** Round to two decimals (with EPSILON correction to avoid binary floating-point edge cases). */
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** Coerce non-finite numbers (NaN / Infinity) to zero to avoid polluting valuation math. */
function toFinite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

/** token normalization key: NATIVE is its own key; addresses are lowercased (case-insensitive matching). */
function normalizeToken(token: Address | "NATIVE"): string {
  return token === "NATIVE" ? "NATIVE" : token.toLowerCase();
}

/** Deduplicate the token list (case-insensitive, preserving the original spelling of the first occurrence). */
function dedupeTokens(tokens: (Address | "NATIVE")[]): (Address | "NATIVE")[] {
  const seen = new Set<string>();
  const out: (Address | "NATIVE")[] = [];
  for (const t of tokens) {
    const key = normalizeToken(t);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}
