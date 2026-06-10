/**
 * Real data-source Providers (Ethereum Mainnet, READ-ONLY) and a factory that wires them from the
 * runtime configuration (task 17).
 *
 * The three providers replace the development-time mocks for production:
 *  - {@link EtherscanChainDataSource}   → real ChainDataSource (Etherscan v2 + viem).
 *  - {@link CoinGeckoPriceDataSource}   → real PriceDataSource (CoinGecko).
 *  - {@link StaticRiskRuleSource}       → real RiskRuleSource (curated, injectable risk list).
 *
 * Security constraint (requirement 13.1): all three are strictly read-only; no signer / send-tx path.
 *
 * Key injection: API keys and the audited-chain RPC URL are read from the environment (never
 * hard-coded). The expected environment variable names are:
 *   - ETHERSCAN_API_KEY  → Etherscan v2 API key.
 *   - ETHERSCAN_BASE_URL → Optional Etherscan-compatible API base URL / proxy.
 *   - SOURCIFY_BASE_URL  → Optional Sourcify repository base URL.
 *   - ALCHEMY_RPC_URL    → HTTP RPC URL for viem reads (Alchemy or any provider). Falls back to a
 *                          public keyless RPC when absent.
 *   - COINGECKO_API_KEY  → CoinGecko Demo/Pro key (optional; raises rate limits).
 *   - COINGECKO_PRO      → "true" to use the Pro base URL + header with COINGECKO_API_KEY.
 * MANUAL(H7-12): these data/price-source API keys are obtained externally and injected via env;
 * they are NEVER hard-coded here.
 */

import type { RuntimeConfig } from "../../config.js";
import type { ChainDataSource, PriceDataSource, RiskRuleSource } from "../types.js";
import type { RetryPolicy } from "../retry.js";
import type { RiskListEntry } from "./risk-rules.js";
import { DEFAULT_CHAIN, resolveRpcUrl, type ChainDescriptor } from "../../chains.js";

import { EtherscanChainDataSource } from "./chain-etherscan.js";
import { CoinGeckoPriceDataSource } from "./price-coingecko.js";
import { StaticRiskRuleSource } from "./risk-rules.js";

export {
  EtherscanChainDataSource,
  type EtherscanChainOptions,
  PERMIT2_ADDRESS,
  DEFAULT_ETH_RPC_URL,
  DEFAULT_ETHERSCAN_BASE_URL,
  DEFAULT_SOURCIFY_BASE_URL,
} from "./chain-etherscan.js";
export {
  CoinGeckoPriceDataSource,
  type CoinGeckoPriceOptions,
  DEFAULT_COINGECKO_BASE_URL,
  PRO_COINGECKO_BASE_URL,
} from "./price-coingecko.js";
export {
  StaticRiskRuleSource,
  type StaticRiskRuleSourceOptions,
  type RiskListEntry,
  DEFAULT_RISK_LIST,
} from "./risk-rules.js";

/** A wired bundle of the three read-only data sources used by the orchestrator. */
export interface DataProviders {
  chain: ChainDataSource;
  price: PriceDataSource;
  rules: RiskRuleSource;
}

/**
 * Keys/overrides that are not part of {@link RuntimeConfig} (which models the CAP settlement side).
 * The audited-chain data/price API keys are injected here, sourced from env at the call site.
 * MANUAL(H7-12): values come from environment variables, never hard-coded.
 */
export interface ProviderApiKeys {
  /** Etherscan v2 API key (env: ETHERSCAN_API_KEY). */
  etherscanApiKey?: string;
  /** Optional Etherscan-compatible API base URL / proxy (env: ETHERSCAN_BASE_URL). */
  etherscanBaseUrl?: string;
  /** Optional Sourcify repository base URL (env: SOURCIFY_BASE_URL). */
  sourcifyBaseUrl?: string;
  /** HTTP RPC URL for viem reads (env: ALCHEMY_RPC_URL). */
  ethRpcUrl?: string;
  /** CoinGecko API key (env: COINGECKO_API_KEY). */
  coingeckoApiKey?: string;
  /** Whether the CoinGecko key is a Pro key (env: COINGECKO_PRO === "true"). */
  coingeckoPro?: boolean;
  /** Optional override of the curated risk list (e.g. a loaded live feed). */
  riskList?: readonly RiskListEntry[];
}

/**
 * Read the provider API keys from a process environment map (defaults to process.env). This is the
 * single place that maps env var names to provider options; values are NEVER hard-coded.
 * MANUAL(H7-12).
 */
export function loadProviderApiKeys(env: NodeJS.ProcessEnv = process.env): ProviderApiKeys {
  const keys: ProviderApiKeys = {
    coingeckoPro: env.COINGECKO_PRO === "true",
  };
  if (env.ETHERSCAN_API_KEY !== undefined) keys.etherscanApiKey = env.ETHERSCAN_API_KEY;
  if (env.ETHERSCAN_BASE_URL !== undefined) keys.etherscanBaseUrl = env.ETHERSCAN_BASE_URL;
  if (env.SOURCIFY_BASE_URL !== undefined) keys.sourcifyBaseUrl = env.SOURCIFY_BASE_URL;
  if (env.ALCHEMY_RPC_URL !== undefined) keys.ethRpcUrl = env.ALCHEMY_RPC_URL;
  if (env.COINGECKO_API_KEY !== undefined) keys.coingeckoApiKey = env.COINGECKO_API_KEY;
  return keys;
}

/** Extra wiring options for {@link buildProvidersFromConfig}. */
export interface BuildProvidersOptions {
  /** Explicit API keys/overrides; when omitted they are loaded from the environment. */
  extraKeys?: ProviderApiKeys;
  /** Shared retry/timeout policy applied to the chain + price providers. */
  retry?: RetryPolicy;
  /** Injected clock for deterministic window math. */
  now?: () => Date;
  /** Environment used by {@link loadProviderApiKeys} when extraKeys is omitted. */
  env?: NodeJS.ProcessEnv;
  /** The audited chain to build providers for. Defaults to Ethereum Mainnet. */
  chain?: ChainDescriptor;
}

/**
 * Build the three real providers for one audited chain, wiring API keys from env-backed config.
 *
 * The {@link RuntimeConfig} carries the CAP/settlement-side configuration; the audited-chain data
 * and price API keys are injected separately (via `extraKeys` or the environment) since they are
 * not part of the CAP config surface. The chain descriptor selects the Etherscan chainid, the viem
 * RPC + network, and the CoinGecko platform / native coin ids. MANUAL(H7-12): keys are injected,
 * never hard-coded.
 */
export function buildProvidersFromConfig(
  _config: RuntimeConfig,
  options: BuildProvidersOptions = {},
): DataProviders {
  const keys = options.extraKeys ?? loadProviderApiKeys(options.env);
  const chain = options.chain ?? DEFAULT_CHAIN;
  const env = options.env ?? process.env;

  // Per-chain RPC: an explicit per-chain env var wins, else the shared key override, else the
  // chain's public default. A globally-injected ethRpcUrl (extraKeys) still applies to Ethereum.
  const rpcUrl =
    chain.key === "ethereum" && keys.ethRpcUrl !== undefined && keys.ethRpcUrl !== ""
      ? keys.ethRpcUrl
      : resolveRpcUrl(chain, env);

  const chainSource = new EtherscanChainDataSource({
    etherscanApiKey: keys.etherscanApiKey ?? "",
    etherscanBaseUrl: keys.etherscanBaseUrl,
    sourcifyBaseUrl: keys.sourcifyBaseUrl,
    rpcUrl,
    chainId: chain.chainId,
    viemChain: chain.viemChain,
    retry: options.retry,
    now: options.now,
  });

  const price = new CoinGeckoPriceDataSource({
    apiKey: keys.coingeckoApiKey,
    pro: keys.coingeckoPro ?? false,
    nativeCoinId: chain.coingeckoNativeId,
    platformId: chain.coingeckoPlatformId,
    retry: options.retry,
    now: options.now,
  });

  const rules = new StaticRiskRuleSource({ entries: keys.riskList });

  return { chain: chainSource, price, rules };
}
