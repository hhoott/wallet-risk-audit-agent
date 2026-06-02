/**
 * Supported audited chains (read-only, multi-chain).
 *
 * Etherscan V2 is a single-key, multi-chain API: the same `ETHERSCAN_API_KEY` queries 60+ EVM
 * chains by switching the `chainid` query parameter. This registry is the single source of truth
 * for every chain-specific value the audit pipeline needs:
 *   - `etherscanChainId`     → Etherscan V2 `chainid` parameter.
 *   - viem `Chain`           → the viem network object for read-only RPC calls.
 *   - `defaultRpcUrl`        → a public RPC used when no per-chain RPC env var is set.
 *   - `coingeckoPlatformId`  → CoinGecko asset-platform id for ERC-20 USD valuation.
 *   - `coingeckoNativeId`    → CoinGecko coin id for the native token's USD price.
 *   - `nativeSymbol`         → display symbol of the native token (ETH / POL …).
 *   - `explorerTxUrl`        → block-explorer base for transaction deep links (UI).
 *   - `revokeChainId`        → chainId used in revoke.cash deep links.
 *
 * Adding a chain is one entry here — no other file hard-codes a chain. The audited chain is still a
 * single chain *per request*; the settlement chain (Base, USDC via CAP) is unrelated and unchanged.
 *
 * Security constraint (requirement 13.1): every chain is read-only; there is no signer / send path.
 */

import { mainnet, base, arbitrum, optimism, polygon, type Chain } from "viem/chains";

/** Stable, URL-safe chain key used in API requests and the UI (lowercase slug). */
export type ChainKey = "ethereum" | "base" | "arbitrum" | "optimism" | "polygon";

/** All read-only configuration the audit pipeline needs for one audited chain. */
export interface ChainDescriptor {
  /** Stable slug used in API requests / UI selection. */
  key: ChainKey;
  /** Human-readable display name (also stamped on the report as `auditedChain`). */
  name: string;
  /** Canonical EVM chain id (also the Etherscan V2 chainid and the revoke.cash chainId). */
  chainId: number;
  /** viem network object for read-only RPC calls. */
  viemChain: Chain;
  /** Public RPC used when no per-chain RPC env var is configured. */
  defaultRpcUrl: string;
  /** Environment variable name that overrides this chain's RPC URL. */
  rpcEnvVar: string;
  /** CoinGecko asset-platform id for ERC-20 token USD prices. */
  coingeckoPlatformId: string;
  /** CoinGecko coin id for the native token USD price. */
  coingeckoNativeId: string;
  /** Native token display symbol. */
  nativeSymbol: string;
  /** Block-explorer base for transaction deep links (no trailing slash). */
  explorerTxUrl: string;
  /** Stable slug stamped on a RevokeLink.chain (kept as "ethereum-mainnet" for Ethereum). */
  revokeChainSlug: string;
  /** Short, human label of the native token + chain, used in LLM prompts. */
  promptLabel: string;
}

/** The default audited chain when a request does not specify one (backward-compatible). */
export const DEFAULT_CHAIN_KEY: ChainKey = "ethereum";

/** The supported audited chains, keyed by {@link ChainKey}. */
export const SUPPORTED_CHAINS: Record<ChainKey, ChainDescriptor> = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum Mainnet",
    chainId: 1,
    viemChain: mainnet,
    defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
    rpcEnvVar: "ETH_RPC_URL",
    coingeckoPlatformId: "ethereum",
    coingeckoNativeId: "ethereum",
    nativeSymbol: "ETH",
    explorerTxUrl: "https://etherscan.io/tx",
    revokeChainSlug: "ethereum-mainnet",
    promptLabel: "Ethereum Mainnet (native token ETH)",
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    viemChain: base,
    defaultRpcUrl: "https://base-rpc.publicnode.com",
    rpcEnvVar: "BASE_RPC_URL",
    coingeckoPlatformId: "base",
    coingeckoNativeId: "ethereum",
    nativeSymbol: "ETH",
    explorerTxUrl: "https://basescan.org/tx",
    revokeChainSlug: "base",
    promptLabel: "Base (an Ethereum L2; native token ETH)",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    viemChain: arbitrum,
    defaultRpcUrl: "https://arbitrum-one-rpc.publicnode.com",
    rpcEnvVar: "ARBITRUM_RPC_URL",
    coingeckoPlatformId: "arbitrum-one",
    coingeckoNativeId: "ethereum",
    nativeSymbol: "ETH",
    explorerTxUrl: "https://arbiscan.io/tx",
    revokeChainSlug: "arbitrum",
    promptLabel: "Arbitrum One (an Ethereum L2; native token ETH)",
  },
  optimism: {
    key: "optimism",
    name: "OP Mainnet",
    chainId: 10,
    viemChain: optimism,
    defaultRpcUrl: "https://optimism-rpc.publicnode.com",
    rpcEnvVar: "OPTIMISM_RPC_URL",
    coingeckoPlatformId: "optimistic-ethereum",
    coingeckoNativeId: "ethereum",
    nativeSymbol: "ETH",
    explorerTxUrl: "https://optimistic.etherscan.io/tx",
    revokeChainSlug: "optimism",
    promptLabel: "OP Mainnet / Optimism (an Ethereum L2; native token ETH)",
  },
  polygon: {
    key: "polygon",
    name: "Polygon PoS",
    chainId: 137,
    viemChain: polygon,
    defaultRpcUrl: "https://polygon-bor-rpc.publicnode.com",
    rpcEnvVar: "POLYGON_RPC_URL",
    coingeckoPlatformId: "polygon-pos",
    coingeckoNativeId: "matic-network",
    nativeSymbol: "POL",
    explorerTxUrl: "https://polygonscan.com/tx",
    revokeChainSlug: "polygon",
    promptLabel: "Polygon PoS (native token POL, formerly MATIC)",
  },
};

/** The supported chains in display order (Ethereum first). */
export const CHAIN_ORDER: readonly ChainKey[] = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
];

/**
 * Aliases accepted when resolving a caller-supplied chain identifier (slug / name / chainId /
 * CAIP-2). Compared after trimming + lowercasing. Lets the API and validator accept loose input.
 */
const CHAIN_ALIASES: ReadonlyMap<string, ChainKey> = new Map([
  // Ethereum
  ["ethereum", "ethereum"],
  ["eth", "ethereum"],
  ["mainnet", "ethereum"],
  ["ethereum mainnet", "ethereum"],
  ["ethereum-mainnet", "ethereum"],
  ["homestead", "ethereum"],
  ["1", "ethereum"],
  ["eip155:1", "ethereum"],
  // Base
  ["base", "base"],
  ["base mainnet", "base"],
  ["8453", "base"],
  ["eip155:8453", "base"],
  // Arbitrum
  ["arbitrum", "arbitrum"],
  ["arbitrum one", "arbitrum"],
  ["arbitrum-one", "arbitrum"],
  ["arb", "arbitrum"],
  ["42161", "arbitrum"],
  ["eip155:42161", "arbitrum"],
  // Optimism
  ["optimism", "optimism"],
  ["op", "optimism"],
  ["op mainnet", "optimism"],
  ["optimistic-ethereum", "optimism"],
  ["10", "optimism"],
  ["eip155:10", "optimism"],
  // Polygon
  ["polygon", "polygon"],
  ["polygon pos", "polygon"],
  ["polygon-pos", "polygon"],
  ["matic", "polygon"],
  ["137", "polygon"],
  ["eip155:137", "polygon"],
]);

/** Whether a chain key is one of the supported audited chains. */
export function isChainKey(value: unknown): value is ChainKey {
  return typeof value === "string" && value in SUPPORTED_CHAINS;
}

/**
 * Resolve a caller-supplied chain identifier (slug / display name / chainId / CAIP-2) to a
 * {@link ChainKey}, or undefined when it is not a supported chain. Undefined/blank resolves to the
 * default chain so existing single-chain callers keep working.
 */
export function resolveChainKey(value: string | undefined | null): ChainKey | undefined {
  if (value === undefined || value === null) return DEFAULT_CHAIN_KEY;
  const key = value.trim().toLowerCase();
  if (key === "") return DEFAULT_CHAIN_KEY;
  return CHAIN_ALIASES.get(key);
}

/** Resolve a chain descriptor by key (or alias). Throws on an unsupported chain. */
export function getChain(key: string | undefined | null): ChainDescriptor {
  const resolved = resolveChainKey(key);
  if (resolved === undefined) {
    throw new Error(`Unsupported chain: "${key ?? ""}".`);
  }
  return SUPPORTED_CHAINS[resolved];
}

/** The default chain descriptor (Ethereum Mainnet). */
export const DEFAULT_CHAIN: ChainDescriptor = SUPPORTED_CHAINS[DEFAULT_CHAIN_KEY];

/**
 * Resolve the RPC URL for a chain: an explicit per-chain env var wins, else a shared override
 * (ALCHEMY_RPC_URL, kept for backward compatibility on Ethereum), else the chain's public default.
 */
export function resolveRpcUrl(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const perChain = env[chain.rpcEnvVar];
  if (perChain !== undefined && perChain.trim() !== "") return perChain.trim();
  // Backward compatibility: ALCHEMY_RPC_URL historically configured the Ethereum RPC.
  if (chain.key === "ethereum") {
    const legacy = env.ALCHEMY_RPC_URL;
    if (legacy !== undefined && legacy.trim() !== "") return legacy.trim();
  }
  return chain.defaultRpcUrl;
}
