/**
 * Revoke_Advisor (revocation advice, pure logic) — Task 9, per the "Revoke_Advisor" row
 * of design.md and requirement 11 (and the read-only constraint 13.3).
 *
 * Responsibility: given a wallet's approval records (ApprovalRecord[] from Approval_Scanner)
 * and the contract risk classifications (ContractRisk[] from Risk_Classifier), produce one
 * revocation advice (RevokeAdvice) per risky authorization. An authorization is "risky" when
 * it is an Unlimited_Approval, or its spender is classified as a Suspicious_Contract or a
 * High_Risk_Contract. Each advice carries a clickable Revoke_Link pointing at the audited
 * chain (Ethereum Mainnet); advice is sorted by Risk_Level then by allowance.
 *
 * Security constraint (requirement 13.3 / H5): this module ONLY emits revocation links. It
 * never produces signed transactions, never touches private keys / mnemonics, and nothing in
 * its output triggers a broadcast. By design there is no write-chain path here whatsoever.
 *
 * Determinism: every exported function is pure — the same inputs always produce the same
 * output (including a fully deterministic sort), so the logic is exercised by property tests.
 */

import type {
  Address,
  ApprovalKind,
  ApprovalRecord,
  ContractRisk,
  RevokeAdvice,
  RevokeCategory,
  RevokeLink,
  RiskLevel,
} from "../models.js";
import { RISK_LEVEL_ORDER } from "../models.js";
import { AUDITED_CHAIN_ID } from "../config.js";

// ── Constants ──────────────────────────────────────────────────────

/** Audited-chain parameter carried by every Revoke_Link (requirement 11.2). */
export const REVOKE_CHAIN_PARAM = "ethereum-mainnet" as const;

/** Message returned when there is nothing to revoke (requirement 11.6). */
export const NO_REVOKE_NEEDED_MESSAGE = "No approvals need revoking";

/**
 * Baseline Risk_Level assigned to a pure Unlimited_Approval that has no contract-risk entry
 * (requirement 11.4). An unlimited allowance grants full spending power, so it is treated as
 * HIGH severity by default; when the spender also has a ContractRisk entry, that entry's
 * riskLevel is used instead (see {@link categorize}).
 */
export const UNLIMITED_BASELINE_RISK_LEVEL: RiskLevel = "HIGH";

/**
 * Sort-key sentinel for operator approvals (ERC-721 / ERC-1155 setApprovalForAll), which have
 * no allowance amount (requirement 11.5). setApprovalForAll grants control over the entire
 * collection, so it is treated as the maximum possible allowance for sorting purposes: the
 * sentinel is 2^256 (strictly greater than any real uint256 allowance), so operator approvals
 * sort ahead of finite ERC-20 / Permit2 allowances within the same Risk_Level.
 */
export const OPERATOR_ALLOWANCE_SENTINEL = (2n ** 256n).toString();

// ── Result type (requirement 11.6) ─────────────────────────────────

/** There is at least one risky authorization; `advice` is the sorted, non-empty list. */
export interface RevokeAdviceOk {
  status: "OK";
  advice: RevokeAdvice[];
}

/** No risky authorizations: "No approvals need revoking", and no links are generated. */
export interface RevokeAdviceNone {
  status: "NONE";
  /** Always empty so callers can handle both cases uniformly. */
  advice: [];
  message: string;
}

/** Revocation advice result (discriminated union, judge by `status`). */
export type RevokeAdviceResult = RevokeAdviceOk | RevokeAdviceNone;

// ── Pure helpers ───────────────────────────────────────────────────

const lower = (addr: Address): string => addr.toLowerCase();

/** Whether an approval kind is an NFT/multi-token operator approval (setApprovalForAll). */
export function isOperatorKind(kind: ApprovalKind): boolean {
  return kind === "ERC721_OPERATOR" || kind === "ERC1155_OPERATOR";
}

/**
 * Build the clickable revocation URL (requirement 11.2 / 11.5).
 *
 * Format (revoke.cash-style deep link):
 *   https://revoke.cash/address/<spenderOrOperator>?chainId=<id>&token=<tokenContract>
 *
 * `chainId=1` is Ethereum Mainnet (the audited chain). The same shape serves both ERC-20 /
 * Permit2 allowances and ERC-721 / ERC-1155 operator approvals — for operator approvals the
 * address is the operator and `token` is the NFT contract (no allowance amount is encoded).
 */
export function buildRevokeUrl(spenderOrOperator: Address, tokenContract: Address): string {
  return `https://revoke.cash/address/${spenderOrOperator}?chainId=${AUDITED_CHAIN_ID}&token=${tokenContract}`;
}

/**
 * Build the Revoke_Link for an approval record (requirement 11.2 / 11.5).
 * The link targets the spender/operator and the token/NFT contract on the audited chain; it
 * contains no key / signature / transaction fields — only addresses and a clickable URL.
 */
export function buildRevokeLink(record: ApprovalRecord): RevokeLink {
  return {
    chain: REVOKE_CHAIN_PARAM,
    tokenContract: record.tokenContract,
    spenderOrOperator: record.spender,
    approvalKind: record.kind,
    url: buildRevokeUrl(record.spender, record.tokenContract),
  };
}

/** Human-readable reason stating the category and its Risk_Level (requirement 11.4). */
function buildReason(category: RevokeCategory, riskLevel: RiskLevel): string {
  return `Classified as ${category} with risk level ${riskLevel}; revoking this approval is recommended.`;
}

/**
 * The sort-key allowance stored on the advice (requirement 11.3): the record's decimal
 * allowance for ERC-20 / Permit2, or the operator sentinel for setApprovalForAll approvals.
 */
function sortAllowance(record: ApprovalRecord): string {
  return isOperatorKind(record.kind) ? OPERATOR_ALLOWANCE_SENTINEL : record.allowance;
}

/** Index contract risks by lowercase contract address (first occurrence wins; spenders are unique upstream). */
function indexContractRisks(contractRisks: readonly ContractRisk[]): Map<string, ContractRisk> {
  const map = new Map<string, ContractRisk>();
  for (const risk of contractRisks) {
    const key = lower(risk.contract);
    if (!map.has(key)) map.set(key, risk);
  }
  return map;
}

/**
 * Decide whether an authorization is risky and, if so, its category + Risk_Level
 * (requirements 11.1 / 11.4). Returns null when the authorization is not risky.
 *
 * Category precedence when a spender is both unlimited and risk-classified
 * (documented, deterministic): HIGH_RISK_CONTRACT > SUSPICIOUS_CONTRACT > UNLIMITED_APPROVAL.
 * Exactly ONE advice is produced per authorization regardless of how many labels apply.
 *
 * Risk_Level: use the ContractRisk.riskLevel when a contract-risk entry exists for the
 * spender; for a pure Unlimited_Approval with no contract-risk entry, use the documented
 * baseline {@link UNLIMITED_BASELINE_RISK_LEVEL} (HIGH).
 */
export function categorize(
  record: ApprovalRecord,
  riskByContract: ReadonlyMap<string, ContractRisk>,
): { category: RevokeCategory; riskLevel: RiskLevel } | null {
  const risk = riskByContract.get(lower(record.spender));
  if (risk && risk.classification.includes("HIGH_RISK")) {
    return { category: "HIGH_RISK_CONTRACT", riskLevel: risk.riskLevel };
  }
  if (risk && risk.classification.includes("SUSPICIOUS")) {
    return { category: "SUSPICIOUS_CONTRACT", riskLevel: risk.riskLevel };
  }
  if (record.isUnlimited) {
    return { category: "UNLIMITED_APPROVAL", riskLevel: UNLIMITED_BASELINE_RISK_LEVEL };
  }
  return null;
}

/** Parse a decimal allowance string into a BigInt, treating invalid input as 0 (defensive). */
function allowanceToBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Deterministic comparator implementing requirement 11.3:
 *  1. Risk_Level fixed order CRITICAL → HIGH → MEDIUM → LOW (descending severity).
 *  2. Within the same Risk_Level, allowance descending (BigInt comparison of the decimal string;
 *     operator approvals use {@link OPERATOR_ALLOWANCE_SENTINEL}, sorting as maximum).
 *  3. Stable tie-breakers (spender then token, lexicographic) so the order is fully deterministic.
 */
function compareAdvice(a: RevokeAdvice, b: RevokeAdvice): number {
  const byLevel = RISK_LEVEL_ORDER[b.riskLevel] - RISK_LEVEL_ORDER[a.riskLevel];
  if (byLevel !== 0) return byLevel;

  const aw = allowanceToBigInt(a.allowance);
  const bw = allowanceToBigInt(b.allowance);
  if (aw > bw) return -1;
  if (aw < bw) return 1;

  const bySpender = lower(a.revokeLink.spenderOrOperator).localeCompare(
    lower(b.revokeLink.spenderOrOperator),
  );
  if (bySpender !== 0) return bySpender;
  return lower(a.revokeLink.tokenContract).localeCompare(lower(b.revokeLink.tokenContract));
}

/**
 * Sort revocation advice by the fixed Risk_Level order then by allowance descending
 * (requirement 11.3). Returns a new array; the input is not mutated.
 */
export function sortAdvice(advice: readonly RevokeAdvice[]): RevokeAdvice[] {
  return [...advice].sort(compareAdvice);
}

/**
 * Generate the sorted list of revocation advice (requirements 11.1–11.5).
 *
 * For each risky authorization (Unlimited_Approval / Suspicious_Contract / High_Risk_Contract)
 * exactly one advice is produced, so `advice.length` equals the number of risky authorizations.
 * Non-risky authorizations are skipped. The result is sorted per {@link sortAdvice}.
 */
export function generateRevokeAdvice(
  approvals: readonly ApprovalRecord[],
  contractRisks: readonly ContractRisk[],
): RevokeAdvice[] {
  const riskByContract = indexContractRisks(contractRisks);
  const advice: RevokeAdvice[] = [];
  for (const record of approvals) {
    const cat = categorize(record, riskByContract);
    if (cat === null) continue;
    advice.push({
      category: cat.category,
      riskLevel: cat.riskLevel,
      reason: buildReason(cat.category, cat.riskLevel),
      revokeLink: buildRevokeLink(record),
      allowance: sortAllowance(record),
    });
  }
  return sortAdvice(advice);
}

/**
 * Module entry point: produce the revocation advice result (requirement 11.6).
 * Returns a "No approvals need revoking" result (with no links) when there are no risky
 * authorizations; otherwise returns the sorted advice list.
 */
export function buildRevokeAdviceResult(
  approvals: readonly ApprovalRecord[],
  contractRisks: readonly ContractRisk[],
): RevokeAdviceResult {
  const advice = generateRevokeAdvice(approvals, contractRisks);
  if (advice.length === 0) {
    return { status: "NONE", advice: [], message: NO_REVOKE_NEEDED_MESSAGE };
  }
  return { status: "OK", advice };
}
