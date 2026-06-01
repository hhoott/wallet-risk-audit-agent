/**
 * Portal HTTP server (framework-free, Node's built-in http + static file serving).
 *
 * Endpoints:
 *   GET  /                 → the single-page portal (responsive: phone + desktop).
 *   GET  /assets/*         → static CSS / JS for the page.
 *   GET  /api/tiers        → the bookable tiers (name, price, what-you-get) + which are configured.
 *   POST /api/orders       → place an order: validate input, hire the Provider over CAP, return
 *                            the structured report (managed-requester model).
 *   GET  /api/health       → liveness probe.
 *
 * The server holds a single {@link PortalRequester} (one CAP WebSocket) and serializes nothing —
 * concurrent orders are correlated by their CAP ids. All audit work happens in the live Provider;
 * this layer only places + pays orders and relays the deliverable.
 *
 * Security: this server has NO authentication. It pays real USDC per order, so it must NOT be
 * exposed to the public internet as-is. Run it behind your own auth / rate limiting, or keep it on
 * localhost for a demo. This is surfaced in the README and logged at startup.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

import type { Tier } from "../config.js";
import { TIER_PRICE_USDC } from "../config.js";
import { SERVICE_CATALOG } from "../services.js";
import { validateAddresses } from "../modules/address-validator.js";
import type { PortalConfig } from "./config.js";
import { PortalRequester, PortalOrderError } from "./cap-requester.js";
import type { LocalAuditor } from "./local-auditor.js";

const TIER_ORDER: readonly Tier[] = ["QUICK", "FULL", "MULTI"];

/** A short, user-facing summary of what each tier delivers (shown on the cards). */
const TIER_HIGHLIGHTS: Record<Tier, string[]> = {
  QUICK: [
    "Wallet Health Score",
    "Unlimited (infinite) approval detection",
    "Known high-risk contract interactions",
  ],
  FULL: [
    "Everything in Quick",
    "Suspicious & high-risk contract classification",
    "Asset distribution & USD valuation",
    "Failed / abnormal transaction analysis",
    "Prioritized revocation suggestions",
  ],
  MULTI: [
    "Everything in Full, per wallet",
    "Up to 50 wallets in one order",
    "Longer history window",
    "Combined multi-wallet summary",
  ],
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

/** Build the tier catalog payload: pricing, highlights, and whether each tier is bookable. */
function buildTiersPayload(config: PortalConfig): unknown {
  const isFree = config.paymentMode === "free";
  const tiers = TIER_ORDER.map((tier) => {
    const meta = SERVICE_CATALOG[tier];
    return {
      tier,
      name: meta.name,
      description: meta.description,
      priceUsdc: TIER_PRICE_USDC[tier],
      highlights: TIER_HIGHLIGHTS[tier],
      multi: tier === "MULTI",
      // A tier is bookable when its target Service_ID is configured. In free mode every tier is
      // bookable too, since orders can fall back to a local read-only audit.
      available: config.serviceIds[tier] !== undefined || isFree,
    };
  });
  return { tiers, auditedChain: "Ethereum Mainnet", settlementChain: "Base (USDC)", paymentMode: config.paymentMode };
}

/** Validate the POST /api/orders payload into a tier + address list, or return an error message. */
function parseOrderRequest(
  body: unknown,
  config: PortalConfig,
): { tier: Tier; addresses: string[] } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be a JSON object." };
  }
  const { tier, walletAddress, walletAddresses } = body as {
    tier?: unknown;
    walletAddress?: unknown;
    walletAddresses?: unknown;
  };

  if (typeof tier !== "string" || !TIER_ORDER.includes(tier as Tier)) {
    return { error: "Field 'tier' must be one of QUICK, FULL, MULTI." };
  }
  const typedTier = tier as Tier;
  // In paid mode a tier needs a configured Service_ID. In free mode a missing Service_ID is fine —
  // the order will run as a local audit.
  if (config.serviceIds[typedTier] === undefined && config.paymentMode !== "free") {
    return { error: `The ${typedTier} tier is not configured on this portal.` };
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
  // Non-MULTI tiers audit a single wallet; use the first valid address.
  const addresses =
    typedTier === "MULTI" ? validation.pendingAddresses : [validation.pendingAddresses[0]!];
  return { tier: typedTier, addresses };
}

/** Map a PortalOrderError code to an HTTP status. */
function statusForOrderError(code: PortalOrderError["code"]): number {
  switch (code) {
    case "TIMEOUT":
      return 504;
    case "NEGOTIATION_REJECTED":
    case "ORDER_REJECTED":
      return 422;
    case "NEGOTIATION_EXPIRED":
    case "ORDER_EXPIRED":
      return 408;
    case "NO_NEGOTIATION_ID":
      return 502;
  }
}

// ── Server assembly ──────────────────────────────────────────────────────────────────────

/** Dependencies for {@link createPortalServer}; the requester is injectable for tests. */
export interface PortalServerDeps {
  config: PortalConfig;
  requester: PortalRequester;
  /**
   * Local auditor used as the free-mode fallback when the CAP flow fails. Required when
   * `config.paymentMode === "free"`; ignored in paid mode.
   */
  localAuditor?: LocalAuditor;
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
  requester: PortalRequester;
  localAuditor: LocalAuditor | undefined;
  logger: NonNullable<PortalServerDeps["logger"]>;
}

/**
 * Create the portal HTTP server (not yet listening). Returns the Node `http.Server` so the caller
 * controls `listen` / `close`. The audit Provider must be running and reachable over CAP.
 */
export function createPortalServer(deps: PortalServerDeps) {
  const ctx: ServerCtx = {
    config: deps.config,
    requester: deps.requester,
    localAuditor: deps.localAuditor,
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
    sendJson(res, 200, buildTiersPayload(ctx.config));
    return;
  }
  if (method === "POST" && path === "/api/orders") {
    await handlePlaceOrder(req, res, ctx);
    return;
  }

  // Static assets + SPA shell.
  if (method === "GET") {
    if (path === "/" || path === "/index.html") {
      await sendStatic(res, "index.html");
      return;
    }
    if (path.startsWith("/assets/")) {
      await sendStatic(res, path.slice("/assets/".length));
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

/** Handle POST /api/orders: validate, place the CAP order, return the report. */
async function handlePlaceOrder(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerCtx,
): Promise<void> {
  const { config, requester, logger } = ctx;
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    return;
  }

  const parsed = parseOrderRequest(body, config);
  if ("error" in parsed) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  const serviceId = config.serviceIds[parsed.tier];
  const isFree = config.paymentMode === "free";
  logger.info(`Placing ${parsed.tier} order for ${parsed.addresses.length} wallet(s) (mode=${config.paymentMode})`);

  // Free mode with no configured Service_ID: there is nothing to hire over CAP, so run a local
  // read-only audit directly (skip the CAP attempt entirely).
  if (isFree && serviceId === undefined) {
    if (ctx.localAuditor === undefined) {
      sendJson(res, 500, { error: "Free mode is on but no local auditor is configured." });
      return;
    }
    logger.info(`[free] No Service_ID for ${parsed.tier}; running a local audit directly.`);
    try {
      const local = await ctx.localAuditor.audit(parsed.tier, parsed.addresses);
      sendJson(res, 200, {
        orderId: local.orderId,
        tier: parsed.tier,
        paid: false,
        mode: config.paymentMode,
        fallbackReason: "Free mode: served a local read-only audit (no CAP payment).",
        structured: local.structured,
        humanReadable: local.humanReadable,
        decision: local.decision,
      });
    } catch (localErr) {
      logger.error(
        `[free] Local audit failed: ${localErr instanceof Error ? localErr.message : String(localErr)}`,
      );
      sendJson(res, 500, { error: "Free-mode local audit failed. Check the data-source API keys." });
    }
    return;
  }

  try {
    const result = await requester.placeOrder({
      serviceId: serviceId!,
      walletAddresses: parsed.addresses,
      timeoutMs: config.orderTimeoutMs,
    });
    sendJson(res, 200, {
      orderId: result.orderId,
      tier: parsed.tier,
      paid: true,
      mode: config.paymentMode,
      structured: result.structured,
      humanReadable: result.humanReadable,
      decision: result.decision,
    });
  } catch (err) {
    // Free mode: when the paid CAP flow cannot complete, fall back to a local read-only audit so
    // development/testing can still see a full report. NEVER enabled in production (paid is default).
    if (isFree && ctx.localAuditor !== undefined) {
      const code = err instanceof PortalOrderError ? err.code : "ERROR";
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(`[free] CAP flow failed (${code}); falling back to a local audit. Detail: ${detail}`);
      try {
        const local = await ctx.localAuditor.audit(parsed.tier, parsed.addresses);
        sendJson(res, 200, {
          orderId: local.orderId,
          tier: parsed.tier,
          paid: false,
          mode: config.paymentMode,
          fallbackReason: `CAP payment/delivery did not complete (${code}); served a free local audit.`,
          structured: local.structured,
          humanReadable: local.humanReadable,
          decision: local.decision,
        });
        return;
      } catch (localErr) {
        logger.error(
          `[free] Local audit fallback failed: ${localErr instanceof Error ? localErr.message : String(localErr)}`,
        );
        sendJson(res, 500, { error: "Free-mode local audit failed. Check the data-source API keys." });
        return;
      }
    }

    if (err instanceof PortalOrderError) {
      logger.warn(`Order failed (${err.code}): ${err.message}`);
      sendJson(res, statusForOrderError(err.code), { error: err.message, code: err.code });
      return;
    }
    logger.error(`Order error: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, { error: "Failed to place the order. Please try again." });
  }
}
