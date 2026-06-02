/**
 * Portal entry point — unified single-process model.
 *
 * The web UI + local API and the CAP agent run in ONE process and share ONE CAP WebSocket (owned by
 * the Provider). The portal does NOT open its own CAP connection: when a user places an order via
 * the web page or `POST /api/orders`, the SAME in-process audit engine runs the read-only audit
 * directly. `PORTAL_PAYMENT_MODE` only gates whether the payment callback's result is enforced.
 *
 * `startPortal` accepts an injected {@link LocalAuditor} (the audit engine, normally the agent's own
 * orchestrator) and an optional {@link PaymentConfirmer}. When no auditor is injected it builds one
 * from the real read-only data providers, so the portal can also run standalone for local testing.
 *
 * Security: the portal has NO built-in auth / rate limiting. Keep it on localhost or behind your own
 * auth for a demo. This is logged at startup.
 */

import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { loadPortalConfig, MissingPortalConfigError, type PortalConfig } from "./config.js";
import { createPortalServer, type CheckoutClientFactory } from "./server.js";
import { OrchestratorLocalAuditor, type LocalAuditor } from "./local-auditor.js";
import { MultiChainAuditor } from "./multichain-auditor.js";
import { loadConfig } from "../config.js";
import { buildProvidersFromConfig } from "../datasource/providers/index.js";
import { RetryPolicy } from "../datasource/retry.js";
import { AuditOrchestrator } from "../orchestrator.js";
import { getChain, type ChainKey } from "../chains.js";
import { loadLlmConfig } from "../llm/config.js";
import { createChatModel, AuditSkillSet } from "../llm/skills.js";

/** Injection points for {@link buildPortal} / {@link startPortal}. */
export interface BuildPortalOptions {
  config?: PortalConfig;
  /** The in-process audit engine; built from real data providers when omitted. */
  auditor?: LocalAuditor;
  /** Builds a Requester CAP client from a user key; defaults to the real SDK-backed factory. */
  checkoutClientFactory?: CheckoutClientFactory;
}

/**
 * Build the optional AI skill set from the env-configured LLM. Returns undefined when no LLM is
 * configured (the audit then runs without AI enrichment). Logs whether AI is on at startup so you
 * can see it in the console.
 */
async function buildSkills(): Promise<AuditSkillSet | undefined> {
  const llm = loadLlmConfig();
  if (!llm.enabled) {
    console.info(
      "[portal] AI insight: DISABLED (set LLM_API_KEY to enable LLM analysis on FULL/MULTI tiers).",
    );
    return undefined;
  }
  const model = await createChatModel(llm);
  if (model) {
    console.info(
      `[portal] AI insight: ENABLED on FULL/MULTI tiers (model=${llm.model}, endpoint=${llm.baseUrl}).`,
    );
    return new AuditSkillSet(model);
  }
  console.warn("[portal] AI insight: could not initialize the LLM client; continuing without AI.");
  return undefined;
}

/**
 * Build a multi-chain audit engine from the real read-only data providers. Used when the portal
 * runs standalone (no auditor injected). Each supported chain gets its own engine, built lazily on
 * first use (providers target that chain's Etherscan chainid + RPC + CoinGecko platform). Read-only.
 * Adds AI insight when an LLM is configured.
 */
async function buildAuditor(): Promise<LocalAuditor> {
  // The Provider-side RuntimeConfig only needs CROO_SDK_KEY to load; the data providers ignore the
  // CAP fields, so synthesize a minimal config when CROO_SDK_KEY is absent.
  const runtimeConfig = (() => {
    try {
      return loadConfig();
    } catch {
      return {
        crooApiUrl: "https://api.croo.network",
        crooWsUrl: "wss://api.croo.network/ws",
        crooSdkKey: "portal-standalone",
      };
    }
  })();
  // The AI skill set is chain-agnostic and shared across chains; the chain context is injected into
  // each prompt at call time (so the model knows which chain the facts belong to).
  const skills = await buildSkills();

  return new MultiChainAuditor((chainKey: ChainKey) => {
    const chain = getChain(chainKey);
    const retry = new RetryPolicy();
    const providers = buildProvidersFromConfig(runtimeConfig, { retry, chain });
    const orchestrator = new AuditOrchestrator({
      chain: providers.chain,
      price: providers.price,
      rules: providers.rules,
      retry,
      auditedChain: chain,
    });
    return new OrchestratorLocalAuditor(orchestrator, skills, chain);
  });
}

/** Build (but do not start) the portal HTTP server. */
export async function buildPortal(options: BuildPortalOptions = {}) {
  const config = options.config ?? loadPortalConfig();
  const auditor = options.auditor ?? (await buildAuditor());
  const server = createPortalServer({
    config,
    auditor,
    checkoutClientFactory: options.checkoutClientFactory,
  });
  return { config, server };
}

/** Local URLs surfaced at startup so users know where to open the browser. */
function localPortalUrls(config: PortalConfig): { frontend: string; api: string; health: string } {
  const base = `http://localhost:${config.port}`;
  return { frontend: base, api: `${base}/api`, health: `${base}/api/health` };
}

/** A started Portal plus useful URLs and a shutdown hook. */
export interface StartedPortal {
  config: PortalConfig;
  server: Server;
  urls: { frontend: string; api: string; health: string };
  stop(done?: () => void): void;
}

/**
 * Build and start the portal HTTP server without taking over process lifetime. Rejects (instead of
 * crashing the process) when the port is already in use, so the caller can handle it.
 */
export async function startPortal(options: BuildPortalOptions = {}): Promise<StartedPortal> {
  const { config, server } = await buildPortal(options);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off("error", onError);
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${config.port} is already in use. Set PORTAL_PORT to a free port.`)
          : err,
      );
    };
    server.on("error", onError);
    server.listen(config.port, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const urls = localPortalUrls(config);
  console.info(`[portal] Frontend URL: ${urls.frontend}`);
  console.info(`[portal] API base URL: ${urls.api}  (POST ${urls.api}/orders)`);
  console.info(`[portal] Health check: ${urls.health}`);
  console.info(`[portal] Payment mode: ${config.paymentMode.toUpperCase()}`);
  if (config.paymentMode === "free") {
    console.warn(
      "[portal] FREE MODE: if a CAP payment can't complete (no key / bad key / empty wallet), the " +
        "portal still returns a local read-only audit. For development/testing only; set " +
        "PORTAL_PAYMENT_MODE=paid to require a successful CAP payment.",
    );
  } else {
    console.info(
      "[portal] PAID MODE: orders require the caller's CROO key and a successful CAP USDC payment " +
        "(402 otherwise).",
    );
  }
  console.warn(
    "[portal] SECURITY: the portal has NO authentication / rate limiting. Keep it on localhost or " +
      "behind your own auth — do not expose it publicly as-is.",
  );

  return {
    config,
    server,
    urls,
    stop: (done) => server.close(done),
  };
}

/** Build and start the portal, listening for HTTP requests (standalone process). */
export async function main(): Promise<void> {
  try {
    const portal = await startPortal();
    const shutdown = (): void => {
      console.info("[portal] Shutting down...");
      portal.stop(() => process.exit(0));
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
