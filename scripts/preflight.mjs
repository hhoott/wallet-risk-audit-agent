#!/usr/bin/env node
/**
 * Preflight check for a live Provider run.
 *
 * Validates that the environment is configured before `npm start`, and prints clear,
 * actionable guidance (with the manual hackathon step each variable comes from) for anything
 * missing. Run after copying `.env.example` to `.env`:
 *
 *   npm run preflight                 # reads .env via node --env-file
 *
 * Exit code 0 = ready to start; non-zero = configuration incomplete.
 * This script performs NO network calls and reveals no secret values (only presence + length).
 */

/** A required/optional variable spec, with the manual step it originates from. */
const VARS = [
  { name: "CROO_SDK_KEY", required: true, manual: "H1-1 (register the Agent; shown once)", secret: true },
  { name: "SERVICE_ID", required: true, manual: "H1-2 (configure the single Address Intel Service)" },
  { name: "ETHERSCAN_API_KEY", required: true, manual: "H7-12 (Etherscan API key)", secret: true },
  { name: "ETH_RPC_URL", required: false, manual: "H7-12 (Ethereum viem RPC URL; falls back to ALCHEMY_RPC_URL/public RPC)", secret: true },
  { name: "BASE_RPC_URL", required: false, manual: "H7-12 (Base viem RPC URL; falls back to public RPC)", secret: true },
  { name: "ARBITRUM_RPC_URL", required: false, manual: "H7-12 (Arbitrum viem RPC URL; falls back to public RPC)", secret: true },
  { name: "OPTIMISM_RPC_URL", required: false, manual: "H7-12 (Optimism viem RPC URL; falls back to public RPC)", secret: true },
  { name: "POLYGON_RPC_URL", required: false, manual: "H7-12 (Polygon viem RPC URL; falls back to public RPC)", secret: true },
  { name: "ALCHEMY_RPC_URL", required: false, manual: "legacy Ethereum RPC alias; prefer ETH_RPC_URL", secret: true },
  { name: "COINGECKO_API_KEY", required: false, manual: "H7-12 (CoinGecko key; optional, raises limits)", secret: true },
  { name: "CROO_API_URL", required: false, manual: "default https://api.croo.network" },
  { name: "CROO_WS_URL", required: false, manual: "default wss://api.croo.network/ws" },
  { name: "PORTAL_PAYMENT_MODE", required: false, manual: "web/API payment gate: free (default) or paid" },
  { name: "PORTAL_ALLOW_CROO_KEY", required: false, manual: "demo only: allow a user CROO key in the web UI (default off)" },
  { name: "PORTAL_PAYEE_ADDRESS", required: false, manual: "enables the MetaMask USDC (Base) payment tab" },
  { name: "CROO_REQUESTER_SDK_KEY", required: false, manual: "optional A2A requester demo key; keep separate from the Provider key", secret: true },
  { name: "CROO_TARGET_SERVICE_ID", required: false, manual: "optional A2A requester target Service_ID" },
  { name: "LLM_API_KEY", required: false, manual: "optional AI insight (OpenAI-compatible); audit works without it", secret: true },
  { name: "LLM_BASE_URL", required: false, manual: "LLM endpoint base URL (e.g. https://api.deepseek.com)" },
  { name: "LLM_MODEL", required: false, manual: "LLM model name (e.g. deepseek-chat)" },
];

/** Mask a value for display: never print secrets, only confirm presence + length. */
function display(name, value, secret) {
  if (value === undefined || value === "") return "(not set)";
  if (secret) return `set (${value.length} chars, hidden)`;
  return value;
}

let missingRequired = 0;
const lines = [];

for (const spec of VARS) {
  const value = process.env[spec.name];
  const present = value !== undefined && value.trim() !== "";
  let mark;
  if (present) {
    mark = "ok ";
  } else if (spec.required) {
    mark = "MISSING";
    missingRequired += 1;
  } else {
    mark = "—  ";
  }
  const tag = spec.required ? "required" : "optional";
  lines.push(
    `  [${mark}] ${spec.name} (${tag}) — ${display(spec.name, value, spec.secret)}\n` +
      `         source: ${spec.manual}`,
  );
}

console.log("Web3 Address Intel & Risk Agent — preflight\n");
console.log("Audited chains: Ethereum, Base, Arbitrum, Optimism, Polygon (read-only). Settlement: USDC on Base via CAP.\n");
console.log(lines.join("\n"));
console.log("");

if (missingRequired > 0) {
  console.error(
    `Preflight FAILED: ${missingRequired} required variable(s) missing.\n` +
      "Copy .env.example to .env and fill in the values, then re-run `npm run preflight`.\n" +
      "See docs/hackathon-requirements.md for the manual registration / Service-config steps.",
  );
  process.exit(1);
}

console.log(
  "Preflight OK — required configuration present. Start the Provider with `npm start`.\n" +
    "(A real end-to-end run still needs the Agent + Services registered on the CROO Agent Store,\n" +
    " and a funded Requester to pay an order. See docs/hackathon-requirements.md.)",
);
