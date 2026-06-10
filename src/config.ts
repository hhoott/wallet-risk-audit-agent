/**
 * Global constants and configuration loading (tasks 1.3 / 2.1 foundation).
 *
 * Key fact: this service spans two independent chains —
 *  - Audited Chain = Ethereum Mainnet: all on-chain data reads are read-only and happen here.
 *  - Settlement Chain = Base: CAP order USDC payment / escrow / settlement happen here,
 *    handled by the CAP SDK + CAPVault. This service never operates the settlement chain directly.
 */

/** Audited chain: Ethereum Mainnet (read-only). */
export const AUDITED_CHAIN = "Ethereum Mainnet" as const;
export type AuditedChain = typeof AUDITED_CHAIN;

/** Audited chain id (Ethereum Mainnet). */
export const AUDITED_CHAIN_ID = 1 as const;

/** Settlement chain: Base Mainnet (CAP / CAPVault settlement in USDC). */
export const SETTLEMENT_CHAIN = "Base Mainnet" as const;
export const SETTLEMENT_CHAIN_ID = 8453 as const;

/** Internal analysis-depth enum. Externally, the Agent now exposes one CROO Service. */
export type Tier = "QUICK" | "FULL" | "MULTI";

/** The single externally bookable service uses the full analysis depth by default. */
export const DEFAULT_SERVICE_TIER: Tier = "FULL";

/** Per-tier USDC pricing. Only FULL is exposed externally by the single CROO service. */
export const TIER_PRICE_USDC: Record<Tier, number> = {
  QUICK: 0.5,
  FULL: 5,
  MULTI: 5,
};

/** Default transaction analysis time window (days), requirements 8 / 10. */
export const DEFAULT_TX_WINDOW_DAYS = 90;
/** Configurable window bounds (days). */
export const MIN_TX_WINDOW_DAYS = 1;
export const MAX_TX_WINDOW_DAYS = 365;
/** Longer history window used by the MULTI tier (days), requirement 15.2; strictly greater than default. */
export const MULTI_TX_WINDOW_DAYS = 365;

/** Maximum addresses per request (requirement 1.6). */
export const MAX_ADDRESSES_PER_REQUEST = 50;

/** Per-request data source timeout (ms) and max attempts (requirements 18.1 / 18.2). */
export const DATA_SOURCE_TIMEOUT_MS = 10_000;
export const DATA_SOURCE_MAX_ATTEMPTS = 4; // including the first try: at most 4 attempts (1 initial + 3 retries)

/**
 * Runtime configuration. Injected from environment variables only — never
 * hard-coded, never persisted, never logged.
 *
 * MANUAL(H1-1): CROO_SDK_KEY is produced when registering the Agent (shown once); inject via env.
 * MANUAL(H1-2): SERVICE_ID is produced after configuring the Service in the Dashboard; inject via env.
 * MANUAL(H7-12): data/price source API keys (Alchemy/Etherscan/CoinGecko) are obtained externally; inject via env.
 */
export interface RuntimeConfig {
  /** CAP API base URL, defaults to https://api.croo.network */
  crooApiUrl: string;
  /** CAP WebSocket URL, defaults to wss://api.croo.network/ws */
  crooWsUrl: string;
  /** CAP SDK key (MANUAL(H1-1)). */
  crooSdkKey: string;
  /** Optional custom RPC (SDK settlement-side balance checks), defaults to Base mainnet. */
  rpcUrl?: string;
  /** Single CROO Service ID produced by the Dashboard (MANUAL(H1-2)). */
  serviceId?: string;
}

/** Thrown when a required environment variable is missing. */
export class MissingConfigError extends Error {
  constructor(key: string) {
    super(`Missing required environment variable: ${key}`);
    this.name = "MissingConfigError";
  }
}

/**
 * Load runtime configuration from environment variables. CROO_SDK_KEY is required.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const crooSdkKey = env.CROO_SDK_KEY;
  if (!crooSdkKey) {
    throw new MissingConfigError("CROO_SDK_KEY");
  }
  return {
    crooApiUrl: env.CROO_API_URL ?? "https://api.croo.network",
    crooWsUrl: env.CROO_WS_URL ?? "wss://api.croo.network/ws",
    crooSdkKey,
    rpcUrl: env.RPC_URL,
    // SERVICE_ID is the current single-service config. SERVICE_ID_FULL is accepted as a legacy
    // fallback so old demo env files continue to start while the dashboard is migrated.
    serviceId:
      env.SERVICE_ID ?? env.SERVICE_ID_FULL ?? env.SERVICE_ID_QUICK ?? env.SERVICE_ID_MULTI,
  };
}

/**
 * Build the Service_ID -> analysis-depth map.
 * The external CROO Agent Store now registers one Service; internally it runs at FULL depth.
 */
export function buildServiceTierMap(config: RuntimeConfig): Map<string, Tier> {
  const map = new Map<string, Tier>();
  if (config.serviceId) map.set(config.serviceId, DEFAULT_SERVICE_TIER);
  return map;
}
