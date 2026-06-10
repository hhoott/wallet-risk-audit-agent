import { AgentClient } from "@croo-network/sdk";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

import { extractResultPageUrl } from "./requester.js";
import { latestResultFileName, readStoredReport, RESULT_DIR_NAME } from "../result-store.js";

const REQUESTER_KEY = process.env.CROO_REQUESTER_SDK_KEY ?? "";
const PROVIDER_SERVICE_ID = process.env.CROO_TARGET_SERVICE_ID ?? process.env.SERVICE_ID ?? "";
const ORDER_CREATION_ATTEMPTS = 30;
const DELIVERY_ATTEMPTS = 120;

interface CliArgs {
  dryRun: boolean;
  resultFile: string | undefined;
  wallet: string;
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let resultFile: string | undefined;
  let wallet: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--result-file") {
      resultFile = argv[++i];
    } else if (arg.startsWith("--result-file=")) {
      resultFile = arg.slice("--result-file=".length);
    } else if (!arg.startsWith("--") && wallet === undefined) {
      wallet = arg;
    }
  }

  return {
    dryRun,
    resultFile,
    wallet:
      wallet ??
      process.env.CROO_AUDIT_WALLET ??
      "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  };
}

function requireEnv(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`Missing required environment variable: ${name}`);
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function setupRequesterLog(dryRun: boolean): { path: string; close(): void } {
  const dir = join(process.cwd(), RESULT_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `requester-${dryRun ? "dry-run" : "live"}-${stamp}.log`);
  const stream = createWriteStream(path, { flags: "a" });

  const format = (args: unknown[]): string =>
    args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 8, colors: false }))).join(" ");
  const wrap = <T extends (...args: unknown[]) => void>(fn: T, level: string): T =>
    ((...args: unknown[]) => {
      stream.write(`[${new Date().toISOString()}] [${level}] ${format(args)}\n`);
      fn(...args);
    }) as T;

  console.info = wrap(console.info.bind(console), "info");
  console.warn = wrap(console.warn.bind(console), "warn");
  console.error = wrap(console.error.bind(console), "error");

  return {
    path,
    close: () => stream.end(),
  };
}

function printReportUrl(resultPageUrl: string | undefined): void {
  if (resultPageUrl) {
    console.info("\n==================== REPORT URL ====================");
    console.info(resultPageUrl);
    console.info("====================================================\n");
  } else {
    console.warn("[requester] Provider did not include resultPageUrl in the delivery schema.");
  }
}

async function runDryRun(args: CliArgs): Promise<void> {
  const fileName = args.resultFile ?? (await latestResultFileName());
  if (fileName === undefined) {
    throw new Error("No saved result found. Run one live A2A test first, or pass --result-file <file>.json.");
  }
  const saved = await readStoredReport(fileName);
  const waitMs = Number.parseInt(process.env.CROO_A2A_DRY_RUN_DELAY_MS ?? "450", 10);

  console.info("[requester:dry-run] Replaying a saved successful A2A exchange.");
  console.info(`[requester:dry-run] Source file: result/${fileName}`);
  console.info(`[requester:dry-run] Order ID: ${saved.orderId}`);

  const log =
    saved.communicationLog && saved.communicationLog.length > 0
      ? saved.communicationLog
      : [
          {
            step: "order_paid",
            message: `CAP order ${saved.orderId} is paid; escrow is locked and the Provider can audit.`,
            at: new Date().toISOString(),
          },
          {
            step: "delivered",
            message: "Provider delivered the saved report JSON and result page URL.",
            at: new Date().toISOString(),
          },
        ];

  console.info("[requester:dry-run] Step 1: Initiating negotiation on CAP network...");
  await delay(waitMs);
  console.info("[requester:dry-run] Negotiation created successfully. ID: dryrun-negotiation");
  await delay(waitMs);
  console.info("[requester:dry-run] Step 2: Provider accepted negotiation and created order.");
  await delay(waitMs);
  console.info(`[requester:dry-run] Order found! orderId: ${saved.orderId}, status: created`);
  await delay(waitMs);
  console.info("[requester:dry-run] Step 3: Paying order (simulated from saved successful run)...");
  await delay(waitMs);
  console.info("[requester:dry-run] Payment successful. payTxHash: dryrun-pay-tx");
  await delay(waitMs);
  console.info("[requester:dry-run] Step 4: Replaying Provider communication log...");
  for (const item of log) {
    console.info(`[requester:dry-run] ${item.step}: ${item.message}`);
    await delay(waitMs);
  }

  const structured = {
    ...(saved.structured as Record<string, unknown>),
    ...(saved.addressIntel !== undefined ? { addressIntel: saved.addressIntel } : {}),
    resultPageUrl: saved.resultPageUrl,
    resultJsonUrl: saved.resultJsonUrl,
  };
  console.info("\n==================== AUDIT DELIVERABLE TEXT ====================");
  console.info(saved.humanReadable);
  console.info("================================================================\n");
  console.info("[requester:dry-run] Structured delivery JSON data:");
  console.info(JSON.stringify(structured, null, 2));
  console.info("[requester:dry-run] Offline A2A replay completed successfully.");
  printReportUrl(saved.resultPageUrl);
}

async function runTest(args: CliArgs): Promise<void> {
  requireEnv("CROO_REQUESTER_SDK_KEY", REQUESTER_KEY);
  requireEnv("CROO_TARGET_SERVICE_ID or SERVICE_ID", PROVIDER_SERVICE_ID);

  console.info(`[requester] Starting live A2A checkout test...`);
  console.info(`[requester] Service ID: ${PROVIDER_SERVICE_ID}`);
  console.info(`[requester] Auditing wallet: ${args.wallet}`);

  const sdkLogger = {
    info: (msg: string, ...args: unknown[]) => {
      if (
        msg.startsWith("websocket:") ||
        msg.startsWith("got negotiation") ||
        msg.startsWith("got order") ||
        msg.startsWith("listed ") ||
        msg.startsWith("websocket connecting") ||
        msg.startsWith("websocket connected") ||
        msg.startsWith("websocket reconnected") ||
        msg.startsWith("websocket reconnecting")
      ) {
        return;
      }
      console.info(`[sdk] ${msg}`, ...args);
    },
    warn: (msg: string, ...args: unknown[]) => console.warn(`[sdk:warn] ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(`[sdk:error] ${msg}`, ...args),
    debug: () => {}, // silence http request logging
  };
  const client = new AgentClient(
    {
      baseURL: "https://api.croo.network",
      wsURL: "wss://api.croo.network/ws",
      logger: sdkLogger,
    },
    REQUESTER_KEY,
  );

  // Step 1: Initiate negotiation
  console.info(`[requester] Step 1: Initiating negotiation on CAP network...`);
  const requirements = JSON.stringify({ walletAddresses: [args.wallet] });
  const negotiation = await client.negotiateOrder({
    serviceId: PROVIDER_SERVICE_ID,
    requirements,
  });

  const negId = negotiation.negotiationId;
  console.info(`[requester] Negotiation created successfully. ID: ${negId}`);

  // Step 2: Poll for order creation (Provider accepts it in the background)
  console.info(
    `[requester] Step 2: Waiting for Provider to accept negotiation and create order...`,
  );
  let orderId: string | undefined;

  for (let attempt = 1; attempt <= ORDER_CREATION_ATTEMPTS; attempt++) {
    await delay(2000);
    console.info(`[requester] Polling for order (attempt ${attempt}/${ORDER_CREATION_ATTEMPTS})...`);
    const orders = await client.listOrders({ role: "buyer", pageSize: 20 });
    const match = orders.find((o) => o.negotiationId === negId);
    if (match) {
      console.info(`[requester] Order found! orderId: ${match.orderId}, status: ${match.status}`);
      if (match.status === "created") {
        orderId = match.orderId;
        break;
      }
      if (["rejected", "expired", "create_failed"].includes(match.status)) {
        throw new Error(`Order creation failed with status: ${match.status}`);
      }
    }
  }

  if (!orderId) {
    throw new Error("Timeout waiting for order creation on CAP network.");
  }

  // Step 3: Pay the order
  console.info(`[requester] Step 3: Paying order ${orderId} (price comes from the CROO service config)...`);
  const payResult = await client.payOrder(orderId);
  console.info(`[requester] Payment successful. payTxHash: ${payResult.txHash}`);

  // Step 4: Wait for completion (Provider audits and delivers)
  console.info(`[requester] Step 4: Waiting for Provider to audit and deliver report...`);
  let completed = false;

  for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
    await delay(3000);
    console.info(`[requester] Checking order status (attempt ${attempt}/${DELIVERY_ATTEMPTS})...`);
    const order = await client.getOrder(orderId);
    console.info(`[requester] Order status: ${order.status}`);
    if (order.status === "completed") {
      completed = true;
      break;
    }
    if (order.status === "rejected" || order.status === "expired") {
      throw new Error(
        `Order ended in failed state: ${order.status}. Reason: ${order.rejectReason}`,
      );
    }
  }

  if (!completed) {
    throw new Error("Timeout waiting for audit delivery.");
  }

  // Step 5: Get delivery report
  console.info(`[requester] Step 5: Fetching deliverable from CAP network...`);
  const delivery = await client.getDelivery(orderId);

  console.info("\n==================== AUDIT DELIVERABLE TEXT ====================");
  console.info(delivery.deliverableText);
  console.info("================================================================\n");

  console.info("[requester] Structured delivery JSON data:");
  const structured = JSON.parse(delivery.deliverableSchema || "{}");
  console.info(JSON.stringify(structured, null, 2));

  console.info(`[requester] A2A checkout test completed successfully!`);
  printReportUrl(extractResultPageUrl(structured));
}

const args = parseArgs(process.argv.slice(2));
const log = setupRequesterLog(args.dryRun);
console.info(`[requester] Run log file: ${log.path}`);
const runner = args.dryRun ? runDryRun(args) : runTest(args);
runner
  .then(() => {
    console.info(`[requester] Run log saved: ${log.path}`);
  })
  .catch((err) => {
    console.error(`[requester] Test failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    log.close();
  });
