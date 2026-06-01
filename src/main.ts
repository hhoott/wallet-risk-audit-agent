/**
 * Main entry assembly (task 20.1) — wire the configuration, real read-only data Providers
 * (task 17), the Audit Orchestrator (task 13), the Report_Generator (task 11), the Payment_Gateway
 * decisions (task 14) and the CAP adapter layer (task 16) into a single runnable CAP Provider event
 * loop (requirements 2.1 / 2.3 / 13.5 / 18.4).
 *
 * Two-chain reminder (see config.ts): the AUDITED chain is Ethereum Mainnet and every on-chain read
 * here is strictly READ-ONLY; CAP order settlement happens in USDC on Base and is handled entirely
 * by the CAP SDK + CAPVault. This service never operates the settlement chain directly and never
 * handles private keys / mnemonics / signed transactions — revocation is offered only as links.
 *
 * Outbound-request boundary (task 20.1): the only outbound calls this Provider makes are to the
 * configured CAP endpoints (via the CAP SDK) and the configured read-only data/price/rule Providers
 * (Etherscan / Alchemy RPC / CoinGecko). No request data is forwarded to any other third party.
 *
 * Testability: {@link buildProvider} accepts injected dependencies (config, CAP client, data
 * providers, retry policy, clock, logger) so the whole assembly can be exercised end-to-end with
 * in-memory mocks and a fake CAP client — no real network / SDK. The process bootstrap at the
 * bottom only runs when this module is the entry point, so importing it in tests is side-effect
 * free (it never calls process bootstrap, never connects, never exits).
 *
 * Required runtime environment variables (injected, NEVER hard-coded):
 *  - CROO_SDK_KEY                         MANUAL(H1-1): produced when registering the Agent.
 *  - SERVICE_ID_QUICK / _FULL / _MULTI    MANUAL(H1-2): produced after configuring Services.
 *  - ETHERSCAN_API_KEY / ALCHEMY_RPC_URL  MANUAL(H7-12): audited-chain data source keys.
 *  - COINGECKO_API_KEY                    MANUAL(H7-12): price source key (optional; raises limits).
 */

import { pathToFileURL } from "node:url";

import { loadConfig, MissingConfigError, type RuntimeConfig } from "./config.js";
import { resolveServiceTierMap } from "./services.js";
import { buildProvidersFromConfig, type DataProviders } from "./datasource/providers/index.js";
import { RetryPolicy } from "./datasource/retry.js";
import { AuditOrchestrator } from "./orchestrator.js";
import {
  WalletAuditProvider,
  createCapClient,
  createConsoleLogger,
  type CapClient,
  type CapLogger,
} from "./cap/provider.js";

// ── Provider assembly ──────────────────────────────────────────────────────────────────

/**
 * Injection points for {@link buildProvider}. Every dependency has a real default; tests override
 * them to avoid real network / SDK access.
 */
export interface BuildProviderOptions {
  /** Runtime configuration; defaults to {@link loadConfig} (reads env, throws on missing CROO_SDK_KEY). */
  config?: RuntimeConfig;
  /** CAP client; defaults to {@link createCapClient} (the only path that constructs the real SDK). */
  capClient?: CapClient;
  /** Read-only data providers (chain / price / rules); default built via {@link buildProvidersFromConfig}. */
  providers?: DataProviders;
  /** Shared retry/timeout policy applied to the data providers and orchestrator; defaults to a new {@link RetryPolicy}. */
  retry?: RetryPolicy;
  /** Injected clock for deterministic window / report timestamps; defaults to the orchestrator's `() => new Date()`. */
  now?: () => Date;
  /** Logger for the Provider event loop; defaults to a console-backed logger. */
  logger?: CapLogger;
}

/**
 * Build (but do NOT start) the runnable CAP Provider, wiring all components together.
 *
 * Wiring order:
 *  1. Resolve the {@link RuntimeConfig} (injected, or loaded from the environment).
 *  2. Build the {@link RetryPolicy} (injected, or default 10s timeout / 4 attempts).
 *  3. Build the three read-only data Providers (injected, or {@link buildProvidersFromConfig}).
 *  4. Build the {@link AuditOrchestrator} over those providers (tier routing + partial-success).
 *  5. Resolve the Service_ID → Tier map (only tiers whose Service_ID is configured are included).
 *  6. Build the {@link CapClient} (injected fake in tests, or the real SDK-backed client).
 *  7. Construct the {@link WalletAuditProvider} wired with all of the above.
 *
 * The returned Provider is not started; call {@link WalletAuditProvider.start} to connect the
 * WebSocket and begin handling CAP events.
 */
export async function buildProvider(
  options: BuildProviderOptions = {},
): Promise<WalletAuditProvider> {
  const config = options.config ?? loadConfig();
  const retry = options.retry ?? new RetryPolicy();

  // Real read-only Providers (Ethereum Mainnet). Injected in tests to avoid the network.
  // MANUAL(H7-12): data/price source API keys are injected from the environment by buildProvidersFromConfig.
  const providers =
    options.providers ?? buildProvidersFromConfig(config, { retry, now: options.now });

  const orchestrator = new AuditOrchestrator({
    chain: providers.chain,
    price: providers.price,
    rules: providers.rules,
    retry,
    now: options.now,
  });

  // Service_ID → Tier map. MANUAL(H1-2): the Service_IDs are injected via env (SERVICE_ID_QUICK/FULL/MULTI).
  const serviceTierMap = resolveServiceTierMap(config);

  // The CAP client is the ONLY component that touches the SDK; tests inject a fake instead.
  // MANUAL(H1-1): CROO_SDK_KEY is injected via env and consumed by createCapClient.
  const client = options.capClient ?? createCapClient(config);

  return new WalletAuditProvider({
    client,
    orchestrator,
    serviceTierMap,
    logger: options.logger ?? createConsoleLogger(),
  });
}

// ── Process bootstrap ──────────────────────────────────────────────────────────────────

/** The required environment variables, surfaced in the startup error message when config is missing. */
const REQUIRED_ENV_VARS: readonly string[] = [
  "CROO_SDK_KEY", // MANUAL(H1-1)
  "SERVICE_ID_QUICK", // MANUAL(H1-2)
  "SERVICE_ID_FULL", // MANUAL(H1-2)
  "SERVICE_ID_MULTI", // MANUAL(H1-2)
  "ETHERSCAN_API_KEY", // MANUAL(H7-12)
  "ALCHEMY_RPC_URL", // MANUAL(H7-12)
  "COINGECKO_API_KEY", // MANUAL(H7-12)
];

/**
 * Print a helpful message naming the environment variables this Provider needs to run. Called when
 * the bootstrap fails to load configuration (e.g. CROO_SDK_KEY is missing).
 */
function printMissingConfigHelp(error: MissingConfigError): void {
  console.error(`[main] Cannot start WalletAuditProvider: ${error.message}`);
  console.error(
    "[main] The following environment variables must be injected before starting " +
      "(never hard-code them):",
  );
  for (const name of REQUIRED_ENV_VARS) {
    console.error(`[main]   - ${name}`);
  }
  console.error(
    "[main] CROO_SDK_KEY comes from registering the Agent (MANUAL H1-1); " +
      "SERVICE_ID_QUICK/FULL/MULTI from configuring Services in the Dashboard (MANUAL H1-2); " +
      "ETHERSCAN_API_KEY / ALCHEMY_RPC_URL / COINGECKO_API_KEY from the data/price providers (MANUAL H7-12).",
  );
}

/** A started Provider plus its shutdown hook. */
export interface StartedProvider {
  provider: WalletAuditProvider;
  stop(): void;
}

/** Build and start the Provider without taking over process lifetime. */
export async function startProvider(options: BuildProviderOptions = {}): Promise<StartedProvider> {
  const provider = await buildProvider(options);
  await provider.start();
  console.info(
    "[main] WalletAuditProvider is listening for CAP events (read-only Ethereum audits; " +
      "settlement via CAP on Base).",
  );
  return {
    provider,
    stop: () => provider.stop(),
  };
}

/**
 * Build and start the Provider, then keep the process alive while the CAP WebSocket loop runs.
 *
 * Surfaces a clear, actionable error if required configuration is missing (loadConfig throws a
 * {@link MissingConfigError}) instead of a raw stack trace. Any other startup error is logged and
 * causes a non-zero exit code.
 */
export async function main(): Promise<void> {
  try {
    const started = await startProvider();
    const shutdown = (): void => {
      console.info("[main] Shutting down WalletAuditProvider...");
      started.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.info("[main] Press Ctrl+C to stop.");
    // Keep the process alive. The CAP SDK's EventStream sustains the connection (auto-reconnect +
    // heartbeats); this never-resolving promise prevents the entry point from exiting.
    await new Promise<never>(() => {
      /* run until the process is terminated */
    });
  } catch (error) {
    if (error instanceof MissingConfigError) {
      printMissingConfigHelp(error);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[main] WalletAuditProvider failed to start: ${message}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Whether this module is being executed directly as the process entry point (as opposed to being
 * imported by a test or another module). Compares the resolved module URL against argv[1].
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

// Only bootstrap the process when run directly (e.g. `node dist/main.js`). Importing this module in
// tests does NOT start the event loop, connect the WebSocket, or call process.exit.
if (isEntryPoint()) {
  void main();
}
