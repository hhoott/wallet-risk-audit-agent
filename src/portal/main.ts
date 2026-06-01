/**
 * Portal entry point — wire the portal config, a CAP Requester (the portal's own funded Agent), and
 * the HTTP server into a runnable process that lets users place orders from a browser.
 *
 * Two-chain reminder: the audited chain is Ethereum Mainnet (read-only, done by the Provider); CAP
 * order settlement is USDC on Base, handled by the SDK + CAPVault. The portal Requester's AA wallet
 * funds each order it places on a user's behalf.
 *
 * Security: the portal pays real USDC and has NO built-in auth. Keep it on localhost or behind your
 * own auth / rate limiting for a demo. This is logged at startup.
 *
 * Required env (injected, never hard-coded):
 *  - PORTAL_CROO_SDK_KEY (or CROO_SDK_KEY)  MANUAL(H1-1): the portal Requester's funded Agent key.
 *  - SERVICE_ID_QUICK / _FULL / _MULTI      MANUAL(H1-2): the audit Provider's Service_IDs to hire.
 * Optional: PORTAL_PORT (default 8787), CROO_API_URL, CROO_WS_URL, RPC_URL, PORTAL_ORDER_TIMEOUT_MS,
 * PORTAL_PAYMENT_MODE (defaults to free fallback; set "paid" for strict settlement).
 */

import { pathToFileURL } from "node:url";

import {
  loadPortalConfig,
  MissingPortalConfigError,
  type PortalConfig,
} from "./config.js";
import {
  PortalRequester,
  createPortalCapClient,
  type PortalCapClient,
} from "./cap-requester.js";
import { createPortalServer } from "./server.js";
import {
  OrchestratorLocalAuditor,
  type LocalAuditor,
} from "./local-auditor.js";
import { loadConfig } from "../config.js";
import { buildProvidersFromConfig } from "../datasource/providers/index.js";
import { RetryPolicy } from "../datasource/retry.js";
import { AuditOrchestrator } from "../orchestrator.js";

/** Injection points for {@link buildPortal}; tests override them to avoid real network / SDK. */
export interface BuildPortalOptions {
  config?: PortalConfig;
  capClient?: PortalCapClient;
  /** Local auditor for free-mode fallback; built from real data providers when omitted in free mode. */
  localAuditor?: LocalAuditor;
}

/**
 * Build a local auditor from the real read-only data providers (Ethereum Mainnet). Used as the
 * free-mode fallback so a report can be produced without a paid CAP order. Read-only.
 */
function buildLocalAuditor(): LocalAuditor {
  // The Provider-side RuntimeConfig only needs CROO_SDK_KEY to load; in free mode it may be absent,
  // so synthesize a minimal config (the data providers ignore the CAP fields entirely).
  const runtimeConfig = (() => {
    try {
      return loadConfig();
    } catch {
      return {
        crooApiUrl: "https://api.croo.network",
        crooWsUrl: "wss://api.croo.network/ws",
        crooSdkKey: "free-mode",
      };
    }
  })();
  const retry = new RetryPolicy();
  const providers = buildProvidersFromConfig(runtimeConfig, { retry });
  const orchestrator = new AuditOrchestrator({
    chain: providers.chain,
    price: providers.price,
    rules: providers.rules,
    retry,
  });
  return new OrchestratorLocalAuditor(orchestrator);
}

/** Build (but do not start) the portal: resolve config, construct the Requester + HTTP server. */
export async function buildPortal(options: BuildPortalOptions = {}) {
  const config = options.config ?? loadPortalConfig();
  const client = options.capClient ?? (await createPortalCapClient(config));
  const requester = new PortalRequester(client, {
    timeoutMs: config.orderTimeoutMs,
  });

  // In free mode, the portal follows the normal CAP flow first, then falls back to a local
  // read-only audit when payment/delivery cannot complete.
  const localAuditor =
    config.paymentMode === "free"
      ? (options.localAuditor ?? buildLocalAuditor())
      : options.localAuditor;

  const server = createPortalServer({ config, requester, localAuditor });
  return { config, requester, server };
}

/** Names of the tiers that are bookable given the configured Service_IDs. */
function bookableTiers(config: PortalConfig): string[] {
  return Object.keys(config.serviceIds);
}

/** Build and start the portal, connecting the CAP WebSocket and listening for HTTP requests. */
export async function main(): Promise<void> {
  try {
    const { config, requester, server } = await buildPortal();

    // Connect the CAP WebSocket up front so the first order is fast (and fails fast if misconfigured).
    // In free mode, a missing/invalid key may make this fail — that is tolerated, since orders fall
    // back to a local audit; placeOrder will retry the connection on demand.
    try {
      await requester.connect();
    } catch (err) {
      if (config.paymentMode === "free") {
        console.warn(
          `[portal] CAP connection failed in free mode (will use local audit): ${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        throw err;
      }
    }

    await new Promise<void>((resolve) => {
      server.listen(config.port, () => resolve());
    });

    const tiers = bookableTiers(config);
    console.info(`[portal] Listening on http://localhost:${config.port}`);
    console.info(`[portal] Payment mode: ${config.paymentMode.toUpperCase()}`);
    console.info(
      `[portal] Bookable tiers: ${tiers.length > 0 ? tiers.join(", ") : "(none configured)"}`,
    );
    if (config.paymentMode === "free") {
      console.warn(
        "[portal] FREE MODE is on: the portal tries the normal CAP paid flow first, but if payment " +
          "or delivery can't complete it serves a local read-only audit instead. For demos only — " +
          "set PORTAL_PAYMENT_MODE=paid for production.",
      );
    }
    console.warn(
      "[portal] SECURITY: this portal pays real USDC per order and has NO authentication. " +
        "Keep it on localhost or behind your own auth / rate limiting — do not expose it publicly as-is.",
    );

    const shutdown = (): void => {
      console.info("[portal] Shutting down...");
      requester.close();
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    if (error instanceof MissingPortalConfigError) {
      console.error(`[portal] Cannot start: ${error.message}`);
    } else {
      console.error(
        `[portal] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
  }
}

/** Run main() only when executed directly (not when imported by tests). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  void main();
}
