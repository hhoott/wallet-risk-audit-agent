/**
 * Service metadata and single-service configuration.
 *
 * This file is the code-side, in-repo source of truth for the paid CAP Service.
 * The description, skill tags, input parameters and the structured
 * deliverable schema are maintained here so they can be copied verbatim into the CROO Agent
 * Store Dashboard when registering Services (task H1-2, a manual step).
 *
 * The actual Service_IDs are produced by the Dashboard at registration time and injected at
 * runtime via environment variables — they are NOT hard-coded here.
 * MANUAL(H1-2): SERVICE_ID is injected via env.
 */

import type { Tier, RuntimeConfig } from "./config.js";
import { DEFAULT_SERVICE_TIER, TIER_PRICE_USDC, buildServiceTierMap } from "./config.js";

/** Static, human-authored metadata describing one paid Service tier. */
export interface ServiceMetadata {
  tier: Tier;
  /** Display name for the Agent Store listing. */
  name: string;
  /** Service description (what this tier does). */
  description: string;
  /** 1–5 skill tags selected from the CROO standard library (requirement 3.2). */
  skillTags: string[];
  /** USDC price for this tier (requirement 4.1; mirrors TIER_PRICE_USDC). */
  priceUsdc: number;
  /** Human-readable description of the input parameters callers must supply. */
  inputParameters: string;
  /** Human-readable audited-chain scope for this Service. */
  auditedChain: string;
}

/**
 * The single Service definition. Fill this into the Dashboard "Add Service" wizard.
 * Price is sourced from the default tier price so it cannot drift from the rest of the system.
 */
export const SERVICE_CATALOG: Partial<Record<Tier, ServiceMetadata>> = {
  [DEFAULT_SERVICE_TIER]: {
    tier: DEFAULT_SERVICE_TIER,
    name: "Web3 Address Intel Report",
    description:
      "Read-only multi-chain address and counterparty risk report for any EVM wallet, token, NFT collection, smart contract, sender, recipient, router, bridge, or other transaction counterparty. Uses Etherscan V2 plus per-chain RPC to collect an evidence log: address type, explorer contract name, source verification, creation metadata, source labels, blacklist hints, approval exposure, asset distribution, failed/abnormal transaction findings, and recent interactive counterparties. When configured, an LLM extracts the final official/safe/caution/dangerous badge, approval risks, transaction risks, and reasons from that evidence log. The delivered JSON includes addressStanding.badge, aiVerdict/evidenceLog in saved result files, riskLevelSummary, healthScore, and remediation suggestions. The agent is strictly read-only and never handles private keys or sends transactions.",
    skillTags: ["DeFi", "Security", "On-chain Analysis", "Risk Assessment"],
    priceUsdc: TIER_PRICE_USDC[DEFAULT_SERVICE_TIER],
    inputParameters:
      'One or more EVM address targets, passed in the negotiation requirements as JSON: {"walletAddress":"0x...", "chain":"ethereum"} or {"walletAddresses":["0x...","0x..."], "chain":"ethereum"}. Supported chain values: ethereum, base, arbitrum, optimism, polygon. Maximum 50 addresses per request.',
    auditedChain: "EVM multi-chain: Ethereum, Base, Arbitrum, Optimism, Polygon",
  },
};

/**
 * The machine-readable structured deliverable schema fields, documented for the Dashboard
 * "Schema" deliverable builder. Mirrors AuditReportStructured in models.ts.
 */
export const DELIVERABLE_SCHEMA_FIELDS: { name: string; type: string; description: string }[] = [
  { name: "schemaVersion", type: "string", description: "Structured report schema version." },
  { name: "walletAddress", type: "address", description: "The audited address / counterparty address." },
  { name: "auditedChain", type: "string", description: "Audited chain display name." },
  { name: "generatedAt", type: "string", description: "Report generation time (UTC ISO-8601)." },
  { name: "tier", type: "string", description: "Internal analysis depth for the single Service." },
  { name: "healthScore", type: "number", description: "Address risk health score 0-100." },
  {
    name: "healthGrade",
    type: "string",
    description: "Qualitative grade (EXCELLENT/GOOD/FAIR/POOR).",
  },
  { name: "riskLevelSummary", type: "string", description: "Machine-readable overall risk level." },
  {
    name: "addressStanding",
    type: "object",
    description:
      "Final audited-address standing: { address, type, verdict, riskLevel, official, blacklisted, label?, badge, reasons[] }. With LLM enabled, these fields are applied from the LLM's evidence-log classification. badge.level is OFFICIAL / SAFE / CAUTION / DANGEROUS / UNKNOWN and badge.label is shown as the result-page corner/status badge.",
  },
  { name: "approvals", type: "array", description: "Approval records." },
  { name: "contractRisks", type: "array", description: "Suspicious / high-risk contracts." },
  { name: "assets", type: "object", description: "Asset distribution (null when not in scope)." },
  { name: "txFindings", type: "array", description: "Failed / abnormal / high-risk interactions." },
  {
    name: "revokeAdvice",
    type: "array",
    description: "Prioritized revocation suggestions with links.",
  },
  { name: "moduleStatuses", type: "array", description: "Per-module completion status." },
];

/** Resolve a tier's metadata (description, skill tags, price, input params). */
export function getServiceMetadata(tier: Tier): ServiceMetadata {
  return SERVICE_CATALOG[tier] ?? SERVICE_CATALOG[DEFAULT_SERVICE_TIER]!;
}

/**
 * Resolve the configured Service_ID for a tier (injected via env at runtime).
 * Returns undefined when the tier's Service_ID has not been configured yet.
 * MANUAL(H1-2): the value is produced by the Dashboard and injected via env.
 */
export function serviceIdForTier(tier: Tier, config: RuntimeConfig): string | undefined {
  return tier === DEFAULT_SERVICE_TIER ? config.serviceId : undefined;
}

/**
 * Build the Service_ID -> Tier lookup used by the negotiation decision (task 14.2).
 * Re-exported from config for convenience so the adapter layer has a single import site.
 */
export function resolveServiceTierMap(config: RuntimeConfig): Map<string, Tier> {
  return buildServiceTierMap(config);
}
