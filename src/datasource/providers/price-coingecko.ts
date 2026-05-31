/**
 * Real PriceDataSource Provider backed by CoinGecko (READ-ONLY).
 *
 * Implements {@link PriceDataSource}: the native token ("NATIVE") is priced via CoinGecko's simple
 * price endpoint (coin id "ethereum"); ERC-20 contracts are priced via the token-price endpoint
 * (/simple/token_price/ethereum). Tokens CoinGecko cannot price are simply absent from the returned
 * map — callers treat an absent entry as "unvalued" (requirement 9.4).
 *
 * Security constraint (requirement 13.1): read-only HTTP GETs only; no signer, no write path.
 *
 * The API key (Demo / Pro) and base URL are injected via the constructor (sourced from env-backed
 * RuntimeConfig); they are NEVER hard-coded. See providers/index.ts (MANUAL(H7-12)).
 */

import type { Address } from "../../models.js";
import type { PriceDataSource, UsdPrice } from "../types.js";
import type { RetryPolicy } from "../retry.js";

/** CoinGecko coin id for the audited chain's native token. */
export const ETHEREUM_COIN_ID = "ethereum";

/** CoinGecko asset-platform id for Ethereum Mainnet ERC-20 tokens. */
export const ETHEREUM_PLATFORM_ID = "ethereum";

/** Default public CoinGecko base URL (the Pro base differs and is injected when a Pro key is used). */
export const DEFAULT_COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

/** Default Pro CoinGecko base URL (used automatically when a Pro key is supplied). */
export const PRO_COINGECKO_BASE_URL = "https://pro-api.coingecko.com/api/v3";

// ── Pure mapping helpers (network-free, unit-tested) ────────────────────────────────────────

/** Shape of CoinGecko's /simple/price?ids=ethereum&vs_currencies=usd response. */
export type SimplePriceResponse = Record<string, { usd?: number } | undefined>;

/** Shape of CoinGecko's /simple/token_price/ethereum response (keys are lowercased addresses). */
export type TokenPriceResponse = Record<string, { usd?: number } | undefined>;

/** Split the requested tokens into the native marker and the unique ERC-20 contract set. */
export function splitTokens(tokens: readonly (Address | "NATIVE")[]): {
  hasNative: boolean;
  contracts: Address[];
} {
  let hasNative = false;
  const seen = new Set<string>();
  const contracts: Address[] = [];
  for (const t of tokens) {
    if (t === "NATIVE") {
      hasNative = true;
      continue;
    }
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    contracts.push(t);
  }
  return { hasNative, contracts };
}

/**
 * Build the result map from the CoinGecko responses, keyed EXACTLY by the original input token
 * values (preserving "NATIVE" and the caller's original address casing as the map key, per the
 * {@link PriceDataSource} contract). Tokens without a usable usd price are omitted.
 */
export function buildPriceMap(
  tokens: readonly (Address | "NATIVE")[],
  nativeUsd: number | undefined,
  tokenPrices: TokenPriceResponse,
): Map<Address | "NATIVE", UsdPrice> {
  const out = new Map<Address | "NATIVE", UsdPrice>();
  for (const t of tokens) {
    if (out.has(t)) continue; // preserve the first occurrence's casing as the key
    if (t === "NATIVE") {
      if (typeof nativeUsd === "number" && Number.isFinite(nativeUsd)) {
        out.set("NATIVE", { token: "NATIVE", usd: nativeUsd });
      }
      continue;
    }
    const entry = tokenPrices[t.toLowerCase()];
    const usd = entry?.usd;
    if (typeof usd === "number" && Number.isFinite(usd)) {
      out.set(t, { token: t, usd });
    }
  }
  return out;
}

// ── Provider ─────────────────────────────────────────────────────────────────────────────────

export interface CoinGeckoPriceOptions {
  /** CoinGecko API key (Demo or Pro), injected from env-backed config. Optional for low rate limits. */
  apiKey?: string;
  /** Whether the supplied key is a Pro key (selects the pro base URL + header). */
  pro?: boolean;
  /** Override the base URL (testing / self-hosted proxy). Takes precedence over the pro default. */
  baseUrl?: string;
  /** Optional retry/timeout policy; when provided, remote calls are wrapped with it. */
  retry?: RetryPolicy;
  /** Injected clock for the pricedAt-style needs of callers; not used directly here. */
  now?: () => Date;
  /** Injected fetch (testing). Defaults to the global fetch (Node 18+). */
  fetchImpl?: typeof fetch;
}

/** Real, read-only PriceDataSource backed by CoinGecko. */
export class CoinGeckoPriceDataSource implements PriceDataSource {
  public readonly sourceName = "CoinGecko";

  private readonly apiKey: string | undefined;
  private readonly pro: boolean;
  private readonly baseUrl: string;
  private readonly retry: RetryPolicy | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CoinGeckoPriceOptions = {}) {
    this.apiKey = options.apiKey;
    this.pro = options.pro ?? false;
    this.baseUrl =
      options.baseUrl ?? (this.pro ? PRO_COINGECKO_BASE_URL : DEFAULT_COINGECKO_BASE_URL);
    this.retry = options.retry;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch USD prices for the given tokens. Performs at most two GETs (native simple price + ERC-20
   * token price). Returns a map keyed by the original input token values; unpriceable tokens are
   * absent from the map.
   */
  async getUsdPrices(
    tokens: (Address | "NATIVE")[],
  ): Promise<Map<Address | "NATIVE", UsdPrice>> {
    if (tokens.length === 0) return new Map();

    const { hasNative, contracts } = splitTokens(tokens);

    const nativeUsd = hasNative ? await this.fetchNativeUsd() : undefined;
    const tokenPrices = contracts.length > 0 ? await this.fetchTokenPrices(contracts) : {};

    return buildPriceMap(tokens, nativeUsd, tokenPrices);
  }

  /** Fetch the native token (ETH) USD price via /simple/price. */
  private async fetchNativeUsd(): Promise<number | undefined> {
    const url = this.buildUrl("/simple/price", {
      ids: ETHEREUM_COIN_ID,
      vs_currencies: "usd",
    });
    try {
      const json = await this.run(
        () => this.getJson<SimplePriceResponse>(url),
        "coingecko.simple/price",
      );
      return json[ETHEREUM_COIN_ID]?.usd;
    } catch {
      return undefined;
    }
  }

  /** Fetch ERC-20 USD prices via /simple/token_price/ethereum. */
  private async fetchTokenPrices(contracts: readonly Address[]): Promise<TokenPriceResponse> {
    const url = this.buildUrl(`/simple/token_price/${ETHEREUM_PLATFORM_ID}`, {
      contract_addresses: contracts.join(","),
      vs_currencies: "usd",
    });
    try {
      return await this.run(
        () => this.getJson<TokenPriceResponse>(url),
        "coingecko.simple/token_price",
      );
    } catch {
      return {};
    }
  }

  /** Build a CoinGecko URL, attaching the Demo api key as a query param when not using Pro. */
  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // The Demo key travels as a query param; the Pro key travels as a header (see getJson).
    if (this.apiKey !== undefined && this.apiKey !== "" && !this.pro) {
      url.searchParams.set("x_cg_demo_api_key", this.apiKey);
    }
    return url.toString();
  }

  /** Perform a GET and parse JSON, attaching the Pro key header when configured. */
  private async getJson<T>(url: string): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.pro && this.apiKey !== undefined && this.apiKey !== "") {
      headers["x-cg-pro-api-key"] = this.apiKey;
    }
    const res = await this.fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Wrap a remote operation in the injected RetryPolicy when present. */
  private run<T>(op: () => Promise<T>, label: string): Promise<T> {
    return this.retry ? this.retry.run(op, label) : op();
  }
}
