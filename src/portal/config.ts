/**
 * Portal configuration (unified single-process model).
 *
 * The web UI and the agent run in ONE process and share ONE CAP WebSocket (owned by the Provider).
 * The portal does NOT open its own CAP connection and does NOT need its own SDK key — when a user
 * places an order through the web page or the local API, the same in-process audit engine runs the
 * read-only audit directly.
 *
 * `PORTAL_PAYMENT_MODE` is only the payment-callback gate:
 *   - "free": attempt the payment callback but IGNORE its result — always return the report
 *             (development / testing).
 *   - "paid": the payment callback must succeed before the report is returned, otherwise the order
 *             is refused with 402 Payment Required.
 *
 * All values are injected from the environment — never hard-coded, never logged.
 */

import type { Tier } from "../config.js";

/** Payment-callback gate. See module docs. */
export type PaymentMode = "paid" | "free";

/** Portal runtime configuration. */
export interface PortalConfig {
  /** TCP port the portal HTTP server listens on. */
  port: number;
  /** CAP API base URL (defaults to https://api.croo.network). */
  crooApiUrl: string;
  /** CAP WebSocket URL (defaults to wss://api.croo.network/ws). */
  crooWsUrl: string;
  /** Optional settlement-side RPC (Base); defaults inside the SDK. */
  rpcUrl?: string;
  /** Our USDC payee address on Base for the MetaMask direct-transfer payment path (optional). */
  payeeAddress?: string;
  /** Base RPC URL used to verify MetaMask USDC payments (defaults to the public Base RPC). */
  baseRpcUrl?: string;
  /**
   * Target Service_IDs of the agent's tiers. Used to map a tier → the CAP Service the user's
   * Requester key negotiates against when paying. Surfaced in /api/tiers too.
   */
  serviceIds: Partial<Record<Tier, string>>;
  /** Per-audit / per-checkout timeout (ms). */
  orderTimeoutMs: number;
  /** Payment-callback gate: "free" (ignore payment result) or "paid" (require payment success). */
  paymentMode: PaymentMode;
  /**
   * Whether the web UI / API may accept a user-supplied CROO agent key to pay over CAP. This is a
   * DEMO capability (it lets anyone drive the CAP negotiate→pay→deliver flow from the browser);
   * real deployments should keep it OFF so the key field never appears. Default: false (off).
   */
  allowCrooKey: boolean;
}

/** Thrown when a portal environment variable is malformed. */
export class MissingPortalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingPortalConfigError";
  }
}

/** Parse a port from the environment, falling back to the default. */
function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65_535) {
    throw new MissingPortalConfigError(`Invalid PORTAL_PORT: "${raw}" (must be 1-65535).`);
  }
  return n;
}

/**
 * Load the portal configuration from environment variables. Defaults to demo-friendly "free" mode;
 * set PORTAL_PAYMENT_MODE=paid for strict payment gating.
 */
export function loadPortalConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  const paymentMode: PaymentMode =
    (env.PORTAL_PAYMENT_MODE ?? "").trim().toLowerCase() === "paid" ? "paid" : "free";

  const serviceIds: Partial<Record<Tier, string>> = {};
  if (env.SERVICE_ID_QUICK) serviceIds.QUICK = env.SERVICE_ID_QUICK;
  if (env.SERVICE_ID_FULL) serviceIds.FULL = env.SERVICE_ID_FULL;
  if (env.SERVICE_ID_MULTI) serviceIds.MULTI = env.SERVICE_ID_MULTI;

  const orderTimeoutMs = Number.parseInt(env.PORTAL_ORDER_TIMEOUT_MS ?? "", 10);

  // The CROO-key payment path is a demo capability, OFF unless explicitly enabled.
  const allowCrooKey = (env.PORTAL_ALLOW_CROO_KEY ?? "").trim().toLowerCase() === "true";

  return {
    port: parsePort(env.PORTAL_PORT, 8787),
    crooApiUrl: env.CROO_API_URL ?? "https://api.croo.network",
    crooWsUrl: env.CROO_WS_URL ?? "wss://api.croo.network/ws",
    rpcUrl: env.RPC_URL,
    payeeAddress: env.PORTAL_PAYEE_ADDRESS,
    baseRpcUrl: env.PORTAL_BASE_RPC_URL,
    serviceIds,
    orderTimeoutMs:
      Number.isInteger(orderTimeoutMs) && orderTimeoutMs > 0 ? orderTimeoutMs : 120_000,
    paymentMode,
    allowCrooKey,
  };
}
