/**
 * Portal HTTP server (framework-free, Node's built-in http + static file serving).
 *
 * Endpoints:
 *   GET  /                 → the single-page portal (responsive: phone + desktop).
 *   GET  /assets/*         → static CSS / JS for the page.
 *   GET  /api/tiers        → the tiers (name, price, what-you-get) + the payment mode.
 *   POST /api/orders       → place an order. Two ways to call it (same core logic):
 *                              • JSON (API):   returns the final JSON result in one response.
 *                              • SSE (web UI): set { stream: true } to receive step-by-step progress
 *                                              events, then a final "result" / "error" event.
 *   GET  /api/health       → liveness probe.
 *
 * Payment: the caller supplies their OWN CROO key at pay time (field `crooKey`). With a key, the
 * server runs a REAL CAP checkout as that Requester (negotiate → pay USDC → deliver) against our
 * Provider, via {@link runCapCheckout}. The `paymentMode` gate decides what happens on failure:
 *   - "free": fall back to the in-process local audit and still return a report.
 *   - "paid": surface the payment error (e.g. 402) and ask the user to fix the key / top up.
 * With no key, "free" runs a local audit and "paid" refuses with 402.
 *
 * Security: NO authentication / rate limiting. The user's CROO key is used only for that one
 * checkout and is never persisted or logged. Keep the server on localhost or behind your own auth.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

import type { Tier } from "../config.js";
import { TIER_PRICE_USDC } from "../config.js";
import { SERVICE_CATALOG } from "../services.js";
import { validateAddresses } from "../modules/address-validator.js";
import { CHAIN_ORDER, SUPPORTED_CHAINS, resolveChainKey, type ChainKey } from "../chains.js";
import type { PortalConfig } from "./config.js";
import type { LocalAuditor } from "./local-auditor.js";
import {
  runCapCheckout,
  createCheckoutClient,
  CheckoutError,
  type CheckoutCapClient,
  type CheckoutProgress,
} from "./cap-checkout.js";
import { MetaMaskPaymentVerifier, BASE_USDC_ADDRESS } from "./metamask-payment.js";

const TIER_ORDER: readonly Tier[] = ["QUICK", "FULL", "MULTI"];

/**
 * A short, user-facing summary of what each tier delivers (shown on the cards). These mirror the
 * actual tier routing in the orchestrator + report trimming: QUICK is a lean subset (no AI, no
 * transaction history); FULL adds the full analysis + annotated history; MULTI adds the multi-wallet
 * fan-out + counterparty deep-dive. AI lines are added separately only when an LLM is configured.
 */
const TIER_HIGHLIGHTS: Record<Tier, string[]> = {
  QUICK: [
    "Address type detection (wallet / token / NFT / contract)",
    "Wallet Health Score (0–100) + risk level",
    "Unlimited (infinite) approval detection",
    "Known high-risk contract interactions",
  ],
  FULL: [
    "Everything in Quick",
    "Full approval scan + suspicious / high-risk contract classification",
    "Asset distribution & USD valuation",
    "Failed / abnormal transaction detection",
    "Annotated transaction history (each counterparty labelled official / risky / contract)",
    "Prioritized revocation links",
  ],
  MULTI: [
    "Everything in Full, per wallet",
    "Up to 50 wallets in one order",
    "Longer history window (365 days)",
    "Combined multi-wallet summary",
    "Counterparty deep-dive (top peers each typed & risk-rated; token/contract owner profiled)",
  ],
};

/** AI-powered highlights, appended per tier ONLY when an LLM is configured (otherwise omitted). */
const TIER_AI_HIGHLIGHTS: Partial<Record<Tier, string[]>> = {
  FULL: ["AI risk explanation + remediation plan", "Type-specific AI assessment of the address"],
  MULTI: ["AI assessment of each analyzed counterparty"],
};

/** The directory holding the static frontend assets (resolved relative to this module). */
function assetsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "public");
}

// ── Response helpers ─────────────────────────────────────────────────────────────────────

/** Send a JSON response with the given status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** Content types for the small set of static assets the portal serves. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

/** Serve a static file from the assets directory, guarding against path traversal. */
async function sendStatic(res: ServerResponse, relativePath: string): Promise<void> {
  const dir = assetsDir();
  // Normalize and confine the resolved path to the assets directory.
  const safeRelative = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(dir, safeRelative);
  if (!filePath.startsWith(dir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

/** Read and parse a JSON request body with a hard size cap. */
async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── API handlers ─────────────────────────────────────────────────────────────────────────

/** Build the tier catalog payload: pricing, highlights, and the payment mode. */
function buildTiersPayload(config: PortalConfig, aiEnabled: boolean): unknown {
  const tiers = TIER_ORDER.map((tier) => {
    const meta = SERVICE_CATALOG[tier];
    // Only advertise AI lines when an LLM is actually configured (don't promise what we can't do).
    const aiLines = aiEnabled ? (TIER_AI_HIGHLIGHTS[tier] ?? []) : [];
    return {
      tier,
      name: meta.name,
      description: meta.description,
      priceUsdc: TIER_PRICE_USDC[tier],
      highlights: [...TIER_HIGHLIGHTS[tier], ...aiLines],
      multi: tier === "MULTI",
      // The agent audits in-process, so every tier is always bookable from the web/API.
      available: true,
      serviceId: config.serviceIds[tier],
    };
  });
  return {
    tiers,
    auditedChain: "Ethereum Mainnet",
    settlementChain: "Base (USDC)",
    // Whether AI insight is active (LLM configured). The UI uses this to avoid promising AI it
    // cannot deliver.
    aiEnabled,
    // The audited chains the user can pick from (read-only, multi-chain via Etherscan V2).
    chains: CHAIN_ORDER.map((key) => ({
      key,
      name: SUPPORTED_CHAINS[key].name,
      chainId: SUPPORTED_CHAINS[key].chainId,
      nativeSymbol: SUPPORTED_CHAINS[key].nativeSymbol,
    })),
    defaultChain: "ethereum",
    paymentMode: config.paymentMode,
    // Whether the web UI may show the "pay with a CROO agent key" tab (demo capability).
    allowCrooKey: config.allowCrooKey,
    // MetaMask direct-transfer payment info (present only when a payee is configured).
    metamask: config.payeeAddress
      ? {
          enabled: true,
          chain: "base",
          chainId: 8453,
          usdc: BASE_USDC_ADDRESS,
          payee: config.payeeAddress,
        }
      : { enabled: false },
  };
}

/** Validate the POST /api/orders payload into a tier + address list + optional payment fields. */
function parseOrderRequest(body: unknown):
  | {
      tier: Tier;
      addresses: string[];
      chainKey: ChainKey;
      crooKey?: string;
      payTxHash?: string;
      method: "cap" | "metamask" | "none";
      stream: boolean;
    }
  | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be a JSON object." };
  }
  const { tier, walletAddress, walletAddresses, chain, crooKey, payTxHash, method, stream } =
    body as {
      tier?: unknown;
      walletAddress?: unknown;
      walletAddresses?: unknown;
      chain?: unknown;
      crooKey?: unknown;
      payTxHash?: unknown;
      method?: unknown;
      stream?: unknown;
    };

  if (typeof tier !== "string" || !TIER_ORDER.includes(tier as Tier)) {
    return { error: "Field 'tier' must be one of QUICK, FULL, MULTI." };
  }
  const typedTier = tier as Tier;

  // Resolve the audited chain (default ethereum). Reject an explicitly unsupported chain.
  const chainKey = resolveChainKey(typeof chain === "string" ? chain : undefined);
  if (chainKey === undefined) {
    return {
      error: `Unsupported chain '${String(chain)}'. Supported: ${CHAIN_ORDER.join(", ")}.`,
    };
  }

  // Accept either a single address or a list; MULTI expects a list but a single is allowed too.
  let rawAddresses: string[];
  if (Array.isArray(walletAddresses)) {
    rawAddresses = walletAddresses.filter((a): a is string => typeof a === "string");
  } else if (typeof walletAddress === "string") {
    rawAddresses = [walletAddress];
  } else {
    return { error: "Provide 'walletAddress' (string) or 'walletAddresses' (string[])." };
  }

  const validation = validateAddresses(rawAddresses);
  if (validation.rejected) {
    return { error: validation.error ?? "Too many addresses." };
  }
  if (validation.pendingAddresses.length === 0) {
    const firstError = validation.results.find((r) => !r.valid)?.error;
    return { error: firstError ?? "No valid wallet address was provided." };
  }
  const addresses =
    typedTier === "MULTI" ? validation.pendingAddresses : [validation.pendingAddresses[0]!];

  const key = typeof crooKey === "string" && crooKey.trim().length > 0 ? crooKey.trim() : undefined;
  const tx =
    typeof payTxHash === "string" && payTxHash.trim().length > 0 ? payTxHash.trim() : undefined;
  // Resolve the payment method: explicit field wins, else infer from which credential is present.
  let resolvedMethod: "cap" | "metamask" | "none";
  if (method === "metamask" || (method === undefined && tx !== undefined))
    resolvedMethod = "metamask";
  else if (method === "cap" || (method === undefined && key !== undefined)) resolvedMethod = "cap";
  else resolvedMethod = "none";

  return {
    tier: typedTier,
    addresses,
    chainKey,
    crooKey: key,
    payTxHash: tx,
    method: resolvedMethod,
    stream: stream === true,
  };
}

// ── Server assembly ──────────────────────────────────────────────────────────────────────

/**
 * Factory that builds a Requester-side CAP client from a user-supplied key. Injectable so tests can
 * substitute a fake CAP client (no real SDK / network). Defaults to {@link createCheckoutClient}.
 */
export type CheckoutClientFactory = (crooKey: string) => Promise<CheckoutCapClient>;

/** Verifies a MetaMask USDC payment by tx hash. Injectable for tests. */
export interface PaymentVerifier {
  verify(
    txHash: string,
    tier: Tier,
  ): Promise<{ paid: boolean; reason: string; amountUsdc?: number }>;
}

/** Dependencies for {@link createPortalServer}. */
export interface PortalServerDeps {
  config: PortalConfig;
  /** The in-process audit engine used as the free-mode fallback (and the local report source). */
  auditor: LocalAuditor;
  /** Builds a Requester CAP client from a user key; defaults to the real SDK-backed factory. */
  checkoutClientFactory?: CheckoutClientFactory;
  /** MetaMask USDC payment verifier; defaults to one built from config.payeeAddress when present. */
  paymentVerifier?: PaymentVerifier;
  /** Whether AI insight is active (an LLM is configured). Drives the AI tier highlights. */
  aiEnabled?: boolean;
  /** Logger; defaults to console. */
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

/** A minimal console logger prefixed for grepping. */
function defaultLogger(): NonNullable<PortalServerDeps["logger"]> {
  return {
    info: (m: string) => console.info(`[portal] ${m}`),
    warn: (m: string) => console.warn(`[portal] ${m}`),
    error: (m: string) => console.error(`[portal] ${m}`),
  };
}

/** Internal request context bundling everything the handlers need. */
interface ServerCtx {
  config: PortalConfig;
  auditor: LocalAuditor;
  checkoutClientFactory: CheckoutClientFactory;
  paymentVerifier: PaymentVerifier | undefined;
  aiEnabled: boolean;
  logger: NonNullable<PortalServerDeps["logger"]>;
}

/**
 * Create the portal HTTP server (not yet listening). Returns the Node `http.Server` so the caller
 * controls `listen` / `close`.
 */
export function createPortalServer(deps: PortalServerDeps) {
  const cfg = deps.config;
  const verifier =
    deps.paymentVerifier ??
    (cfg.payeeAddress
      ? new MetaMaskPaymentVerifier({ payeeAddress: cfg.payeeAddress, rpcUrl: cfg.baseRpcUrl })
      : undefined);
  const ctx: ServerCtx = {
    config: cfg,
    auditor: deps.auditor,
    checkoutClientFactory:
      deps.checkoutClientFactory ??
      ((crooKey: string) =>
        createCheckoutClient(crooKey, {
          crooApiUrl: cfg.crooApiUrl,
          crooWsUrl: cfg.crooWsUrl,
          rpcUrl: cfg.rpcUrl,
        })),
    paymentVerifier: verifier,
    aiEnabled: deps.aiEnabled ?? false,
    logger: deps.logger ?? defaultLogger(),
  };

  return createServer((req, res) => {
    void handleRequest(req, res, ctx).catch((err: unknown) => {
      ctx.logger.error(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
    });
  });
}

/** Route a single request. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerCtx,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (method === "GET" && path === "/api/tiers") {
    sendJson(res, 200, buildTiersPayload(ctx.config, ctx.aiEnabled));
    return;
  }
  if (method === "POST" && path === "/api/orders") {
    await handlePlaceOrder(req, res, ctx);
    return;
  }
  if (method === "POST" && path === "/api/vet") {
    await handleVet(req, res, ctx);
    return;
  }

  // Static assets + SPA shell.
  if (method === "GET") {
    if (path === "/" || path === "/index.html") {
      await sendStatic(res, "index.html");
      return;
    }
    if (path === "/report" || path === "/report.html") {
      await sendStatic(res, "report.html");
      return;
    }
    if (path.startsWith("/assets/")) {
      await sendStatic(res, path.slice("/assets/".length));
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

/**
 * Handle POST /api/orders. Two response shapes:
 *   • `stream: true`  → Server-Sent Events: a series of `progress` events, then one `result` or
 *                       `error` event (used by the web wizard / progress bar).
 *   • otherwise        → a single JSON response (used by the plain API).
 *
 * Core logic is shared by {@link runOrder}; only the transport differs.
 */
async function handlePlaceOrder(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerCtx,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    return;
  }

  const parsed = parseOrderRequest(body);
  if ("error" in parsed) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  if (parsed.stream) {
    await handleOrderStream(res, ctx, parsed);
  } else {
    await handleOrderJson(res, ctx, parsed);
  }
}

/**
 * Handle POST /api/vet — an extended audit target: vet an address's legitimacy / assess a
 * counterparty's risk. Body: `{ "address": "0x…" }`. Read-only; free in all modes (it's a single
 * cheap lookup — the premium value is the AI explanation when an LLM is configured).
 */
async function handleVet(req: IncomingMessage, res: ServerResponse, ctx: ServerCtx): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    return;
  }
  const address =
    typeof (body as { address?: unknown })?.address === "string"
      ? (body as { address: string }).address.trim()
      : "";
  const chainRaw = (body as { chain?: unknown })?.chain;
  const chainKey = resolveChainKey(typeof chainRaw === "string" ? chainRaw : undefined);
  if (chainKey === undefined) {
    sendJson(res, 400, {
      error: `Unsupported chain '${String(chainRaw)}'. Supported: ${CHAIN_ORDER.join(", ")}.`,
    });
    return;
  }
  const validation = validateAddresses([address]);
  if (validation.rejected || validation.pendingAddresses.length === 0) {
    const firstError = validation.results.find((r) => !r.valid)?.error;
    sendJson(res, 400, { error: firstError ?? "Provide a valid 'address' (0x + 40 hex)." });
    return;
  }
  try {
    const result = await ctx.auditor.vetAddress(validation.pendingAddresses[0]!, chainKey);
    if (!result.ok) {
      sendJson(res, 502, { error: result.reason ?? "Address vetting failed." });
      return;
    }
    sendJson(res, 200, { ok: true, chain: chainKey, intel: result.result, ai: result.ai });
  } catch (err) {
    ctx.logger.error(`Vet failed: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, { error: "Address vetting could not be completed." });
  }
}

/** The outcome of running an order, independent of transport. */
interface OrderOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** Parameters shared by the two transports. */
interface OrderParams {
  tier: Tier;
  addresses: string[];
  chainKey: ChainKey;
  crooKey?: string;
  payTxHash?: string;
  method: "cap" | "metamask" | "none";
}

/**
 * Run an order end to end and return the final outcome, emitting progress via `onProgress`.
 *
 * Flow:
 *  - If a `crooKey` is supplied, attempt a REAL CAP checkout as that Requester (negotiate → pay
 *    USDC → deliver). On success, return the CAP-delivered report (paid: true) with the pay tx hash.
 *  - On CAP failure (bad key, empty wallet, rejection, timeout):
 *      · free mode → fall back to the in-process local audit (paid: false, paymentBypassed).
 *      · paid mode → return the payment error (402) so the user can fix the key / top up.
 *  - If NO `crooKey`:
 *      · free mode → run the local audit (paid: false).
 *      · paid mode → 402 asking for a key.
 */
async function runOrder(
  ctx: ServerCtx,
  params: OrderParams,
  onProgress: (p: CheckoutProgress) => void,
): Promise<OrderOutcome> {
  const { config, logger } = ctx;
  const isFree = config.paymentMode === "free";
  const serviceId = config.serviceIds[params.tier];

  logger.info(
    `Order: ${params.tier} for ${params.addresses.length} wallet(s) ` +
      `(mode=${config.paymentMode}, method=${params.method})`,
  );

  // ── MetaMask direct-transfer path (a Base USDC tx hash was supplied) ─────────────────
  if (params.method === "metamask") {
    onProgress({ step: "paying", message: "Verifying your USDC payment on Base…" });
    if (ctx.paymentVerifier === undefined) {
      if (isFree)
        return localOutcome(
          ctx,
          params,
          "MetaMask payments are not configured; served a free local audit.",
        );
      return {
        status: 503,
        body: {
          error: "MetaMask payment is not configured on this portal (no payee address).",
          code: "METAMASK_DISABLED",
        },
      };
    }
    if (params.payTxHash === undefined) {
      if (isFree) {
        return localOutcome(
          ctx,
          params,
          "MetaMask payments are not configured or no hash was provided; served a free local audit.",
        );
      }
      const paymentDetails: Record<string, unknown> = {
        method: "metamask",
        amountUsdc: TIER_PRICE_USDC[params.tier],
        tier: params.tier,
      };
      if (config.payeeAddress) {
        paymentDetails.payeeAddress = config.payeeAddress;
        paymentDetails.usdcAddress = BASE_USDC_ADDRESS;
        paymentDetails.chainId = 8453;
        paymentDetails.chain = "base";
      }
      return {
        status: 402,
        body: {
          error:
            "Payment required: please transfer USDC on Base to the payee address and provide the transaction hash in 'payTxHash'.",
          code: "PAYMENT_REQUIRED",
          payment: paymentDetails,
        },
      };
    }
    let verified;
    try {
      verified = await ctx.paymentVerifier.verify(params.payTxHash, params.tier);
    } catch (err) {
      verified = {
        paid: false,
        reason: `Could not verify the payment: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!verified.paid) {
      if (isFree)
        return localOutcome(
          ctx,
          params,
          `Payment not verified (${verified.reason}); served a free local audit.`,
        );
      return { status: 402, body: { error: verified.reason, code: "PAYMENT_NOT_VERIFIED" } };
    }
    onProgress({
      step: "paid",
      message: "Payment verified; running the audit…",
      txHash: params.payTxHash,
    });
    const local = await ctx.auditor.audit(params.tier, params.addresses, params.chainKey);
    return {
      status: 200,
      body: {
        orderId: local.orderId,
        tier: params.tier,
        chain: params.chainKey,
        mode: config.paymentMode,
        paid: true,
        paymentMethod: "metamask",
        payTxHash: params.payTxHash,
        structured: local.structured,
        humanReadable: local.humanReadable,
        decision: local.decision,
        ai: local.ai,
        addressIntel: local.addressIntel,
      },
    };
  }

  // ── Paid CAP checkout path (a key was supplied) ──────────────────────────────────────
  if (params.method === "cap" && params.crooKey !== undefined) {
    // Server-side enforcement of the demo-only CROO-key switch.
    if (!config.allowCrooKey) {
      if (isFree)
        return localOutcome(
          ctx,
          params,
          "CROO-key payment is disabled; served a free local audit.",
        );
      return {
        status: 403,
        body: {
          error: "Paying with a CROO agent key is disabled on this deployment.",
          code: "CROO_KEY_DISABLED",
        },
      };
    }
    if (serviceId === undefined) {
      // We cannot negotiate without knowing which CAP Service maps to this tier.
      if (isFree)
        return localOutcome(
          ctx,
          params,
          "No Service_ID configured for this tier; served a free local audit.",
        );
      return {
        status: 503,
        body: {
          error: `The ${params.tier} tier has no configured Service_ID, so a paid CAP order cannot be placed.`,
          code: "SERVICE_NOT_CONFIGURED",
        },
      };
    }
    try {
      const client = await ctx.checkoutClientFactory(params.crooKey);
      const result = await runCapCheckout(
        client,
        { serviceId, walletAddresses: params.addresses, timeoutMs: config.orderTimeoutMs },
        onProgress,
      );
      logger.info(`CAP checkout settled: order ${result.orderId} (tx ${result.payTxHash})`);
      return {
        status: 200,
        body: {
          orderId: result.orderId,
          tier: params.tier,
          chain: params.chainKey,
          mode: config.paymentMode,
          paid: true,
          payTxHash: result.payTxHash,
          structured: result.structured,
          humanReadable: result.humanReadable,
          decision: result.decision,
        },
      };
    } catch (err) {
      const code = err instanceof CheckoutError ? err.code : "ERROR";
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`CAP checkout failed (${code}): ${message}`);
      if (isFree) {
        return localOutcome(
          ctx,
          params,
          `Payment did not complete (${code}); served a free local audit. Detail: ${message}`,
        );
      }
      // Paid mode: surface the payment error so the user can re-enter the key / top up.
      return {
        status: code === "TIMEOUT" ? 504 : 402,
        body: {
          error: message,
          code,
          paymentStep: err instanceof CheckoutError ? err.step : undefined,
        },
      };
    }
  }

  // ── No credential supplied ───────────────────────────────────────────────────────────
  if (isFree) {
    return localOutcome(ctx, params, "Free mode: served a local read-only audit (no payment).");
  }
  const paymentDetails: Record<string, unknown> = {
    method: "metamask",
    amountUsdc: TIER_PRICE_USDC[params.tier],
    tier: params.tier,
  };
  if (config.payeeAddress) {
    paymentDetails.payeeAddress = config.payeeAddress;
    paymentDetails.usdcAddress = BASE_USDC_ADDRESS;
    paymentDetails.chainId = 8453;
    paymentDetails.chain = "base";
  }
  return {
    status: 402,
    body: {
      error:
        "Payment required: pay with a CROO key (crooKey) over CAP, or with MetaMask (method:'metamask' + payTxHash).",
      code: "PAYMENT_REQUIRED",
      payment: paymentDetails,
    },
  };
}

/** Build an outcome from the in-process local audit (free-mode path). */
async function localOutcome(
  ctx: ServerCtx,
  params: OrderParams,
  note: string,
): Promise<OrderOutcome> {
  try {
    const local = await ctx.auditor.audit(params.tier, params.addresses, params.chainKey);
    return {
      status: 200,
      body: {
        orderId: local.orderId,
        tier: params.tier,
        chain: params.chainKey,
        mode: ctx.config.paymentMode,
        paid: false,
        paymentBypassed: true,
        paymentNote: note,
        structured: local.structured,
        humanReadable: local.humanReadable,
        decision: local.decision,
        ai: local.ai,
        addressIntel: local.addressIntel,
      },
    };
  } catch (err) {
    ctx.logger.error(`Local audit failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      status: 500,
      body: { error: "The audit could not be completed. Please check the data-source API keys." },
    };
  }
}

/** JSON transport: run the order and send a single response. */
async function handleOrderJson(
  res: ServerResponse,
  ctx: ServerCtx,
  params: OrderParams,
): Promise<void> {
  // Progress is ignored for the plain API; only the final outcome is returned.
  const outcome = await runOrder(ctx, params, () => {});
  sendJson(res, outcome.status, outcome.body);
}

/** SSE transport: stream progress events, then a final `result` or `error` event. */
async function handleOrderStream(
  res: ServerResponse,
  ctx: ServerCtx,
  params: OrderParams,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const outcome = await runOrder(ctx, params, (p) => send("progress", p));

  if (outcome.status === 200) {
    send("result", outcome.body);
  } else {
    send("error", outcome.body);
  }
  res.end();
}
