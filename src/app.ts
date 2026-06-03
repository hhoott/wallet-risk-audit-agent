/**
 * Unified entry point: ONE process, ONE CAP identity, ONE WebSocket.
 *
 * This is the default `npm start` path. It:
 *  1. Builds and starts the CAP Provider (the agent) — it owns the single CAP WebSocket and serves
 *     inbound paid orders from other agents.
 *  2. Starts the web UI + local API in the SAME process, reusing the Provider's audit engine (the
 *     same orchestrator) so a web/API order runs the identical read-only audit WITHOUT opening a
 *     second CAP connection or self-hiring over CAP.
 *
 * Two ways in, one engine:
 *  - Inbound CAP  : other agents hire us, pay USDC, we deliver (handled by the Provider).
 *  - Web + API    : our own users call POST /api/orders (or use the web page); the payment gate is
 *                   `PORTAL_PAYMENT_MODE` (free = ignore payment result; paid = require it).
 *
 * The separate `npm run portal` entry point remains for running the web/API standalone (it builds
 * its own audit engine from the data providers).
 */

import { pathToFileURL } from "node:url";

import { MissingConfigError } from "./config.js";
import { startProvider, type StartedProvider } from "./main.js";
import { MissingPortalConfigError } from "./portal/config.js";
import { startPortal, type StartedPortal } from "./portal/main.js";
import { OrchestratorLocalAuditor } from "./portal/local-auditor.js";
import { loadLlmConfig } from "./llm/config.js";
import { createChatModel, AuditSkillSet } from "./llm/skills.js";

/** Stop both services, tolerating partially-started state. */
function stopAll(provider: StartedProvider | undefined, portal: StartedPortal | undefined): void {
  portal?.stop();
  provider?.stop();
}

/** Start Provider + Portal together (sharing one CAP connection) and keep the process alive. */
export async function main(): Promise<void> {
  let provider: StartedProvider | undefined;
  let portal: StartedPortal | undefined;

  try {
    // 1) The agent: owns the single CAP WebSocket.
    provider = await startProvider();

    // 2) The web UI + API: reuse the Provider's audit engine (same orchestrator, same process).
    //    Add AI insight (FULL/MULTI) when an OpenAI-compatible LLM is configured.
    const llm = loadLlmConfig();
    const model = llm.enabled ? await createChatModel(llm) : undefined;
    const skills = model ? new AuditSkillSet(model) : undefined;
    if (skills) console.info(`[app] AI insight enabled (model: ${llm.model}).`);
    const auditor = new OrchestratorLocalAuditor(provider.provider.auditRunner, skills);
    portal = await startPortal({ auditor, capClient: provider.provider.capClient });

    console.info("[app] Agent + Web/API are running in one process, sharing one CAP connection.");
    console.info(`[app] Open the web page: ${portal.urls.frontend}`);
    console.info(`[app] Or call the API:   POST ${portal.urls.api}/orders`);

    const shutdown = (): void => {
      console.info("[app] Shutting down...");
      stopAll(provider, portal);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.info("[app] Press Ctrl+C to stop.");

    await new Promise<never>(() => {
      /* run until the process is terminated */
    });
  } catch (error) {
    stopAll(provider, portal);
    if (error instanceof MissingConfigError || error instanceof MissingPortalConfigError) {
      console.error(`[app] Cannot start: ${error.message}`);
    } else {
      console.error(
        `[app] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
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
