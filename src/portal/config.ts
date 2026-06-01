/**
 * Portal configuration (managed-requester model).
 *
 * The portal backend runs as a CAP *Requester* that pays for the orders it places on a user's
 * behalf, so it needs its OWN funded CROO Agent credentials (separate from the Provider). It also
 * needs to know the three target Service_IDs of the audit Provider it hires.
 *
 * Reuse note: when the portal and the Provider run in the same process / deployment, the same
 * SERVICE_ID_* values identify the tiers. The portal authenticates with PORTAL_CROO_SDK_KEY
 * (its own Requester key), falling back to CROO_SDK_KEY for a single-key local demo.
 *
 * All values are injected from the environment — never hard-coded, never logged.
 * MANUAL(H1-1): PORTAL_CROO_SDK_KEY is produced when registering the portal's Requester Agent
 * (and its AA wallet must hold USDC to pay for orders).
 * MANUAL(H1-2): SERVICE_ID_QUICK/FULL/MULTI are produced after configuring the Provider's Services.
 */

import type { Tier } from "../config.js";

/**
 * Payment mode for the portal.
 *  - "paid"  (default): a CAP order must be negotiated, PAID in USDC, and delivered. If payment or
 *            delivery fails, the order fails — the user gets no report.
 *  - "free": development/testing mode. The portal still ATTEMPTS the full CAP flow, but when it
 *            cannot complete (payment fails, negotiation/order rejected, expired, or times out) it
 *            falls back to running the read-only audit LOCALLY and returns that report instead of
 *            failing. This lets us exercise the end-to-end UX without a funded Requester wallet.
 *            It must NEVER be used in production — it bypasses paid settlement.
 */
export type PaymentMode = "paid" | "free";

/** Portal runtime configuration. */
export interface PortalConfig {
  /** TCP port the portal HTTP server listens on. */
  port: number;
  /** CAP API base URL (defaults to https://api.croo.network). */
  crooApiUrl: string;
  /** CAP WebSocket URL (defaults to wss://api.croo.network/ws). */
  crooWsUrl: string;
  /** The portal Requester's SDK key (its AA wallet pays for orders). */
  crooSdkKey: string;
  /** Optional settlement-side RPC (Base); defaults inside the SDK. */
  rpcUrl?: string;
  /** Target Service_IDs of the audit Provider, per tier (only configured tiers are bookable). */
  serviceIds: Partial<Record<Tier, string>>;
  /** Per-order timeout (ms) for the full negotiate→pay→deliver round trip. */
  orderTimeoutMs: number;
  /** Payment mode: "paid" (default) or "free" (dev/testing local-audit fallback). */
  paymentMode: PaymentMode;
}

/** Thrown when a required portal environment variable is missing. */
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
 * Load the portal configuration from environment variables. The portal's Requester key
 * (PORTAL_CROO_SDK_KEY) is required in "paid" mode; it falls back to CROO_SDK_KEY for a single-key
 * local demo. In "free" mode the key is optional (the portal can fall back to a local audit), so a
 * missing key is tolerated and left blank.
 */
export function loadPortalConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  // Payment mode: anything other than an explicit "free" is treated as the safe default "paid".
  const paymentMode: PaymentMode =
    (env.PORTAL_PAYMENT_MODE ?? "").trim().toLowerCase() === "free" ? "free" : "paid";

  const crooSdkKey = env.PORTAL_CROO_SDK_KEY ?? env.CROO_SDK_KEY ?? "";
  if (crooSdkKey.trim() === "" && paymentMode === "paid") {
    throw new MissingPortalConfigError(
      "Missing required environment variable: PORTAL_CROO_SDK_KEY (or CROO_SDK_KEY). " +
        "The portal acts as a CAP Requester and needs a funded Agent key to pay for orders. " +
        "(Set PORTAL_PAYMENT_MODE=free to run a local-audit fallback without a key, for dev/testing.)",
    );
  }

  const serviceIds: Partial<Record<Tier, string>> = {};
  if (env.SERVICE_ID_QUICK) serviceIds.QUICK = env.SERVICE_ID_QUICK;
  if (env.SERVICE_ID_FULL) serviceIds.FULL = env.SERVICE_ID_FULL;
  if (env.SERVICE_ID_MULTI) serviceIds.MULTI = env.SERVICE_ID_MULTI;

  const orderTimeoutMs = Number.parseInt(env.PORTAL_ORDER_TIMEOUT_MS ?? "", 10);

  return {
    port: parsePort(env.PORTAL_PORT, 8787),
    crooApiUrl: env.CROO_API_URL ?? "https://api.croo.network",
    crooWsUrl: env.CROO_WS_URL ?? "wss://api.croo.network/ws",
    crooSdkKey,
    rpcUrl: env.RPC_URL,
    serviceIds,
    orderTimeoutMs: Number.isInteger(orderTimeoutMs) && orderTimeoutMs > 0 ? orderTimeoutMs : 120_000,
    paymentMode,
  };
}
