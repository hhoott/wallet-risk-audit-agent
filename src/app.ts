/**
 * Combined demo entry point: start the CAP Provider and the web ordering Portal in one process.
 *
 * This is the default `npm start` path for local demos. The separate Provider/Portal entry points
 * remain available for debugging and production-style deployments.
 */

import { pathToFileURL } from "node:url";

import { MissingConfigError } from "./config.js";
import { startProvider, type StartedProvider } from "./main.js";
import { MissingPortalConfigError } from "./portal/config.js";
import { startPortal, type StartedPortal } from "./portal/main.js";

/** Stop both services, tolerating partially-started state. */
function stopAll(provider: StartedProvider | undefined, portal: StartedPortal | undefined): void {
  portal?.stop();
  provider?.stop();
}

/** Start Provider + Portal together and keep the process alive. */
export async function main(): Promise<void> {
  let provider: StartedProvider | undefined;
  let portal: StartedPortal | undefined;

  try {
    provider = await startProvider();
    portal = await startPortal();
    console.info("[app] Provider + Portal are running in one process.");
    console.info(`[app] Open the frontend: ${portal.urls.frontend}`);

    const shutdown = (): void => {
      console.info("[app] Shutting down Provider + Portal...");
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
      console.error(`[app] Failed to start: ${error instanceof Error ? error.message : String(error)}`);
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
