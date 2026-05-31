/**
 * Core data models and type definitions (task 2.1, per design.md "Data Models").
 *
 * Security constraint (requirement 13.2 / H5): the public interfaces and
 * persisted models defined here contain NO private key / mnemonic / signed
 * transaction fields. Revocation advice only emits clickable links.
 */

import type { Tier } from "./config.js";

export type { Tier };

/** EVM address (0x + 40 hex). Carried as a string; validation is the Address_Validator's job. */
export type Address = string;

/** Machine-readable risk level enum (glossary term Risk_Level). */
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Risk level ordering weight (higher = more severe); used for sorting and scoring. */
export const RISK_LEVEL_ORDER: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** Approval kind. */
export type ApprovalKind =
  | "ERC20"
  | "ERC721_OPERATOR"
  | "ERC1155_OPERATOR"
  | "PERMIT2";

/** Structured report schema version (requirement 14.7). */
export const SCHEMA_VERSION = "1.0.0";

/** Health score qualitative grade (requirement 12.6). Values are user-facing labels. */
export type HealthGrade = "EXCELLENT" | "GOOD" | "FAIR" | "POOR";

/** Module completion state (requirement 18.3). */
export type ModuleState = "OK" | "INCOMPLETE" | "FAILED";

// ── Approvals ──────────────────────────────────────────────────────

/** A single approval record (requirement 6.4). */
export interface ApprovalRecord {
  /** Token / NFT contract address. */
  tokenContract: Address;
  /** Approved party (spender / operator). */
  spender: Address;
  /** Human-readable label of the spender; "Unknown" when unlabeled. */
  spenderLabel: string;
  kind: ApprovalKind;
  /** uint256 decimal string, to avoid precision loss. */
  allowance: string;
  /** ERC20 allowance >= 2^255, or setApprovalForAll == true. */
  isUnlimited: boolean;
  /** Last update time (ISO-8601 UTC). */
  lastUpdated: string;
}

// ── Contract risk ──────────────────────────────────────────────────

export type ContractClassification = "SUSPICIOUS" | "HIGH_RISK";

/** Suspicious feature identifiers (the 6 features a–f in requirement 7.2). */
export type SuspiciousFeature =
  | "UNVERIFIED_SOURCE" // (a) source not verified / not open
  | "RECENTLY_DEPLOYED" // (b) deployed < 30 days ago
  | "LOW_TX_COUNT" // (c) on-chain tx count < 100
  | "NO_AUDIT" // (d) no public audit
  | "BLACKLISTED" // (e) hit a community blacklist
  | "SPENDER_IS_EOA"; // (f) spender is an EOA

export interface ContractRisk {
  contract: Address;
  riskLevel: RiskLevel;
  classification: ContractClassification[];
  /** Matched suspicious features, used as the flagging reason (requirement 7.4). */
  matchedFeatures: SuspiciousFeature[];
}

// ── Asset distribution ─────────────────────────────────────────────

export interface AssetItem {
  /** ERC-20 contract address, or the native token marker "NATIVE". */
  token: Address | "NATIVE";
  symbol: string;
  /** Decimal-string balance. */
  balance: string;
  /** USD valuation; null = valuation unavailable. */
  usdValue: number | null;
  /** Percentage of total value (two decimals); null when valuation unavailable. */
  percentage: number | null;
}

export interface AssetDistribution {
  unit: "USD";
  /** Price source name (requirement 9.3). */
  priceSource: string;
  /** Price fetch time, UTC (requirement 9.3). */
  pricedAt: string;
  /** Top 10 items by value. */
  top: AssetItem[];
  /** The merged "Other" item; null when there are no remaining assets. */
  other: AssetItem | null;
  /** true = "no displayable assets" (requirement 9.6). */
  empty: boolean;
}

// ── Transaction findings ───────────────────────────────────────────

export type TxInteractionType = "DIRECT" | "INTERNAL";

/** Abnormal / failed transaction reason. */
export type TxFindingReason =
  | "FAILED" // on-chain failure / revert
  | "DUST" // dust < $1
  | "ADDRESS_POISONING" // zero-value address-poisoning
  | "RISKY_OUTFLOW" // outflow to a risk-listed address
  | "HIGH_GAS_FAILED" // failed tx with high gas
  | "NEW_CONTRACT" // interaction with a contract deployed < 7 days ago
  | "HIGH_RISK_INTERACTION"; // interaction with a High_Risk_Contract

export interface TxFinding {
  txHash: string;
  /** UTC time. */
  timestamp: string;
  reason: TxFindingReason;
  /** Present only for high-risk interactions. */
  interactionType?: TxInteractionType;
  contract?: Address;
}

// ── Revocation advice ──────────────────────────────────────────────

export type RevokeCategory =
  | "UNLIMITED_APPROVAL"
  | "SUSPICIOUS_CONTRACT"
  | "HIGH_RISK_CONTRACT";

/** Revocation link, pointing to the audited chain (Ethereum); contains no key/signature (requirements 11.2 / 13.3). */
export interface RevokeLink {
  /** Audited-chain parameter, independent of the settlement chain. */
  chain: "ethereum-mainnet";
  tokenContract: Address;
  spenderOrOperator: Address;
  approvalKind: ApprovalKind;
  /** Clickable revocation link. */
  url: string;
}

export interface RevokeAdvice {
  category: RevokeCategory;
  riskLevel: RiskLevel;
  /** Reason to revoke (category + Risk_Level). */
  reason: string;
  revokeLink: RevokeLink;
  /** Sort key; a sentinel value for operator approvals that have no allowance amount. */
  allowance: string;
}

// ── Health score ───────────────────────────────────────────────────

/**
 * Normalized risk item: risks identified by each analysis module are normalized
 * into this shape as the input contract for the Health_Score_Engine (keeping
 * scoring decoupled from source modules and independently testable).
 */
export interface RiskItem {
  /** Risk category (e.g. UNLIMITED_APPROVAL / SUSPICIOUS_CONTRACT / HIGH_RISK_CONTRACT / HIGH_RISK_INTERACTION / ABNORMAL_TX). */
  category: string;
  riskLevel: RiskLevel;
  /** Human-readable detail, used in the deduction breakdown. */
  detail: string;
}

/** A single score deduction item (requirement 12.2). */
export interface ScoreDeduction {
  category: string;
  riskLevel: RiskLevel;
  /** Point contribution of this item. */
  points: number;
  detail: string;
}

export interface HealthScoreResult {
  /** 0–100 integer. */
  score: number;
  grade: HealthGrade;
  /** Sorted by deduction contribution, descending. */
  deductions: ScoreDeduction[];
  /** Whether computed on incomplete data (requirement 12.7). */
  scoredOnIncompleteData: boolean;
}

// ── Module status ──────────────────────────────────────────────────

export interface ModuleStatus {
  module: string;
  status: ModuleState;
  /** Name of the data source that caused incompleteness (requirement 18.3). */
  unavailableSource?: string;
}

// ── Audit report ───────────────────────────────────────────────────

/** Machine-readable structured report (requirements 5.1/5.2/14.6/14.7). */
export interface AuditReportStructured {
  /** Structure version identifier (requirement 14.7). */
  schemaVersion: string;
  walletAddress: Address;
  /** Audited chain name (requirements 14.5/17). */
  auditedChain: "Ethereum Mainnet";
  /** Report generation time, UTC (requirement 14.5). */
  generatedAt: string;
  tier: Tier;
  /** Read-only & never-touch-private-keys declaration (requirement 13.4). */
  readOnlyDeclaration: string;
  healthScore: number;
  healthGrade: HealthGrade;
  /** Machine-readable risk summary field (requirements 5.2/14.7). */
  riskLevelSummary: RiskLevel;
  scoredOnIncompleteData: boolean;
  approvals: ApprovalRecord[];
  contractRisks: ContractRisk[];
  assets: AssetDistribution | null;
  txFindings: TxFinding[];
  revokeAdvice: RevokeAdvice[];
  moduleStatuses: ModuleStatus[];
}

/** A complete report: dual form, human-readable + machine-readable (requirement 14.6). */
export interface AuditReport {
  /** Human-readable Markdown. */
  humanReadable: string;
  /** Machine-readable structured form. */
  structured: AuditReportStructured;
}

/** Multi-wallet summary report (requirement 15). */
export interface MultiWalletReport {
  schemaVersion: string;
  /** Wallet count (requirement 15.4). */
  walletCount: number;
  reports: AuditReportStructured[];
}

// ── CAP order context and settlement record ────────────────────────

export type OrderContextStatus = "PAID" | "DELIVERED" | "REJECTED";

/** CAP order context (adapter-layer internal, no key fields). */
export interface OrderContext {
  orderId: string;
  serviceId: string;
  tier: Tier;
  /** Payer (AA wallet on Base). */
  payerAddress: Address;
  /** Audited addresses (Ethereum). */
  walletAddresses: Address[];
  status: OrderContextStatus;
}

/** Settlement record (requirement 4.10). */
export interface SettlementRecord {
  orderId: string;
  tier: Tier;
  payerAddress: Address;
  /** Base on-chain transaction hash. */
  settlementTxHash: string;
  amountUsdc: number;
}

/** Read-only declaration constant (requirement 13.4), used uniformly by all reports. */
export const READ_ONLY_DECLARATION =
  "This is a read-only analysis service: it never accesses your private keys or seed phrase and never initiates any transaction on your behalf. Revocation is offered only as a link for you to confirm and execute in your own wallet.";
