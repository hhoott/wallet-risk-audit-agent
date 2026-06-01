/**
 * Service metadata and tier configuration (task 15.1 / 15.2, requirements 2.5, 3.2, 3.3, 4.1).
 *
 * This file is the code-side, in-repo source of truth for the three paid CAP Services
 * (Quick / Full / Multi). The descriptions, skill tags, input parameters and the structured
 * deliverable schema are maintained here so they can be copied verbatim into the CROO Agent
 * Store Dashboard when registering Services (task H1-2, a manual step).
 *
 * The actual Service_IDs are produced by the Dashboard at registration time and injected at
 * runtime via environment variables — they are NOT hard-coded here.
 * MANUAL(H1-2): SERVICE_ID_QUICK / SERVICE_ID_FULL / SERVICE_ID_MULTI are injected via env.
 */

import type { Tier, RuntimeConfig } from "./config.js";
import { TIER_PRICE_USDC, buildServiceTierMap } from "./config.js";

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
  /** The audited chain this Service operates on (single-chain MVP). */
  auditedChain: "Ethereum Mainnet";
}

/**
 * The three Service definitions. These are filled into the Dashboard "Add Service" wizard.
 * Prices are sourced from TIER_PRICE_USDC so they cannot drift from the rest of the system.
 */
export const SERVICE_CATALOG: Record<Tier, ServiceMetadata> = {
  QUICK: {
    tier: "QUICK",
    name: "Wallet Quick Check-up",
    description:
      "Read-only quick safety check for a single wallet: returns a Wallet Health Score plus the wallet's unlimited (infinite) token approvals and any interactions with known high-risk contracts. Never touches private keys; never sends transactions.",
    skillTags: ["DeFi", "Security", "On-chain Analysis", "Monitoring"],
    priceUsdc: TIER_PRICE_USDC.QUICK,
    inputParameters:
      'A single Ethereum wallet address, passed in the negotiation requirements as JSON: {"walletAddress":"0x..."} or {"walletAddresses":["0x..."]}.',
    auditedChain: "Ethereum Mainnet",
  },
  FULL: {
    tier: "FULL",
    name: "Wallet Full Risk Report",
    description:
      "Read-only full risk report for a single wallet: Health Score, complete approval scan (incl. unlimited approvals), suspicious & high-risk contract classification, asset distribution, failed/abnormal transactions, and prioritized revocation suggestions with links. Read-only; never touches private keys.",
    skillTags: ["DeFi", "Security", "On-chain Analysis", "Risk Assessment"],
    priceUsdc: TIER_PRICE_USDC.FULL,
    inputParameters:
      'A single Ethereum wallet address, passed in the negotiation requirements as JSON: {"walletAddress":"0x..."}.',
    auditedChain: "Ethereum Mainnet",
  },
  MULTI: {
    tier: "MULTI",
    name: "Multi-Wallet & History Analysis",
    description:
      "Read-only risk analysis across multiple wallets with a longer historical window: a full risk report per wallet plus a combined summary. Read-only; never touches private keys.",
    skillTags: ["DeFi", "Security", "On-chain Analysis", "Portfolio"],
    priceUsdc: TIER_PRICE_USDC.MULTI,
    inputParameters:
      'A list of Ethereum wallet addresses, passed in the negotiation requirements as JSON: {"walletAddresses":["0x...","0x..."]}.',
    auditedChain: "Ethereum Mainnet",
  },
};

/**
 * The machine-readable structured deliverable schema fields, documented for the Dashboard
 * "Schema" deliverable builder. Mirrors AuditReportStructured in models.ts.
 */
export const DELIVERABLE_SCHEMA_FIELDS: { name: string; type: string; description: string }[] = [
  { name: "schemaVersion", type: "string", description: "Structured report schema version." },
  { name: "walletAddress", type: "address", description: "The audited wallet address." },
  { name: "auditedChain", type: "string", description: 'Audited chain name ("Ethereum Mainnet").' },
  { name: "generatedAt", type: "string", description: "Report generation time (UTC ISO-8601)." },
  { name: "tier", type: "string", description: "Purchased tier (QUICK / FULL / MULTI)." },
  { name: "healthScore", type: "number", description: "Wallet health score 0-100." },
  {
    name: "healthGrade",
    type: "string",
    description: "Qualitative grade (EXCELLENT/GOOD/FAIR/POOR).",
  },
  { name: "riskLevelSummary", type: "string", description: "Machine-readable overall risk level." },
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
  return SERVICE_CATALOG[tier];
}

/**
 * Resolve the configured Service_ID for a tier (injected via env at runtime).
 * Returns undefined when the tier's Service_ID has not been configured yet.
 * MANUAL(H1-2): the value is produced by the Dashboard and injected via env.
 */
export function serviceIdForTier(tier: Tier, config: RuntimeConfig): string | undefined {
  switch (tier) {
    case "QUICK":
      return config.serviceIdQuick;
    case "FULL":
      return config.serviceIdFull;
    case "MULTI":
      return config.serviceIdMulti;
  }
}

/**
 * Build the Service_ID -> Tier lookup used by the negotiation decision (task 14.2).
 * Re-exported from config for convenience so the adapter layer has a single import site.
 */
export function resolveServiceTierMap(config: RuntimeConfig): Map<string, Tier> {
  return buildServiceTierMap(config);
}
