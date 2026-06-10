/**
 * Report_Generator (tasks 11.1 / 11.2, per the "Report_Generator" row of design.md and
 * requirement 14, plus 5.1/5.2, 13.4, 17.3 and 15 for multi-wallet).
 *
 * Responsibility: aggregate the per-module results of a single audited wallet into a dual-form
 * Audit_Report — a human-readable Markdown document AND a machine-readable structured object
 * (AuditReportStructured). Both forms are produced from the same trimmed data so they always
 * agree.
 *
 * Pure logic: every exported function is deterministic given its inputs. The only non-pure
 * detail is the default `generatedAt` (the current UTC time) used when the caller does not
 * supply one; callers that need full determinism (e.g. property tests) pass `generatedAt`
 * explicitly.
 *
 * Security constraint (requirement 13.2 / 13.4 / H5): the structured model carries no private
 * key / mnemonic / signed-transaction fields (it only re-exports the read-only module results
 * and a read-only declaration), and the human-readable form embeds the READ_ONLY_DECLARATION.
 *
 * Tier trimming (requirement 14.3 / 14.4): the QUICK tier deliberately emits a SUBSET of the
 * FULL tier's fields — only the Health_Score, Unlimited_Approval entries and High_Risk_Contract
 * entries. See {@link applyTierTrimming} for the exact, documented trimming rules.
 *
 * Single-chain scope (requirement 17.3): `auditedChain` is always "Ethereum Mainnet" and the
 * human-readable form always names the audited chain, even when there is nothing else to show.
 */

import type {
  Address,
  ApprovalRecord,
  AssetDistribution,
  AuditReport,
  AuditReportStructured,
  AddressStanding,
  ContractRisk,
  HealthScoreResult,
  ModuleStatus,
  MultiWalletReport,
  RevokeAdvice,
  RiskLevel,
  Tier,
  TxFinding,
} from "../models.js";
import { READ_ONLY_DECLARATION, RISK_LEVEL_ORDER, SCHEMA_VERSION } from "../models.js";
import { DEFAULT_CHAIN, type ChainDescriptor } from "../chains.js";

// ── Input aggregate ─────────────────────────────────────────────────────────────

/**
 * The per-module audit results for ONE wallet, assembled by the orchestrator (task 13) and fed
 * into {@link generateReport}. Every field is a plain, serializable value produced by an
 * analysis module:
 *  - `healthScore`   — the Health_Score_Engine result (score / grade / deductions / incomplete flag).
 *  - `approvals`     — Approval_Scanner records (the `isUnlimited` flag drives QUICK trimming).
 *  - `contractRisks` — Risk_Classifier results (Suspicious + High_Risk contracts).
 *  - `assets`        — Asset_Analyzer distribution, or null when unavailable / not in scope.
 *  - `txFindings`    — Transaction_Analyzer findings (high-risk interactions + failed/abnormal txs).
 *  - `revokeAdvice`  — Revoke_Advisor advice (links only; no signing path).
 *  - `moduleStatuses`— per-module OK / INCOMPLETE / FAILED status for incompleteness propagation.
 *  - `generatedAt`   — optional UTC ISO string; defaults to the current time when omitted.
 */
export interface AuditInputs {
  walletAddress: Address;
  tier: Tier;
  healthScore: HealthScoreResult;
  approvals: ApprovalRecord[];
  contractRisks: ContractRisk[];
  assets: AssetDistribution | null;
  txFindings: TxFinding[];
  revokeAdvice: RevokeAdvice[];
  moduleStatuses: ModuleStatus[];
  /** Report generation time as a UTC ISO-8601 string; defaults to `new Date().toISOString()`. */
  generatedAt?: string;
  /** The audited chain. Defaults to Ethereum Mainnet (backward-compatible). */
  chain?: ChainDescriptor;
  /** Deterministic address standing summary embedded into API JSON and A2A delivery. */
  addressStanding?: AddressStanding;
}

// ── Risk level summary (requirement 14.7 / 5.2) ─────────────────────────────────

/**
 * The default machine-readable risk summary when no risk carries a Risk_Level. We report "LOW"
 * (the least severe valid level) rather than a special "none" value, so that consumers always
 * receive a valid RiskLevel and can compare summaries uniformly. Since LOW has the lowest order
 * weight, the fold below also naturally yields "LOW" for an empty input.
 */
export const DEFAULT_RISK_LEVEL_SUMMARY: RiskLevel = "LOW";

/**
 * Compute the highest Risk_Level among all findings that carry one (requirement 14.7).
 *
 * The summary aggregates the Risk_Level of contract risks and revocation advice — the findings
 * that expose an explicit Risk_Level. Unlimited approvals (which have no Risk_Level field of
 * their own) are reflected through their revocation advice entries. Transaction findings carry
 * no Risk_Level and therefore do not influence the summary.
 *
 * Ordering follows CRITICAL > HIGH > MEDIUM > LOW (via RISK_LEVEL_ORDER). When there are no
 * risks at all the result is {@link DEFAULT_RISK_LEVEL_SUMMARY} ("LOW").
 */
export function computeRiskLevelSummary(
  contractRisks: readonly ContractRisk[],
  revokeAdvice: readonly RevokeAdvice[],
): RiskLevel {
  let best: RiskLevel = DEFAULT_RISK_LEVEL_SUMMARY;
  const consider = (level: RiskLevel): void => {
    if (RISK_LEVEL_ORDER[level] > RISK_LEVEL_ORDER[best]) best = level;
  };
  for (const risk of contractRisks) consider(risk.riskLevel);
  for (const advice of revokeAdvice) consider(advice.riskLevel);
  return best;
}

// ── Tier trimming (requirements 14.3 / 14.4) ────────────────────────────────────

/** Whether a contract risk is classified as a High_Risk_Contract (requirement 14.3). */
export function isHighRiskContract(risk: ContractRisk): boolean {
  return risk.classification.includes("HIGH_RISK");
}

/** The subset of module data that actually appears in the report after tier trimming. */
export interface TrimmedModuleData {
  approvals: ApprovalRecord[];
  contractRisks: ContractRisk[];
  assets: AssetDistribution | null;
  txFindings: TxFinding[];
  revokeAdvice: RevokeAdvice[];
}

/**
 * Apply tier trimming to the raw module data (requirements 14.3 / 14.4).
 *
 * QUICK (requirement 14.3): the report is a strict SUBSET of the FULL report — it contains only
 * the Health_Score plus Unlimited_Approval and High_Risk_Contract entries. Concretely:
 *   - `assets`        → null   (asset distribution is omitted)
 *   - `txFindings`    → []     (transaction findings are omitted)
 *   - `approvals`     → only entries with `isUnlimited === true`
 *   - `contractRisks` → only entries classified as HIGH_RISK
 *   - `revokeAdvice`  → only UNLIMITED_APPROVAL and HIGH_RISK_CONTRACT advice (Suspicious dropped)
 * Because every QUICK field is obtained by filtering the corresponding FULL field, the QUICK
 * approvals and contractRisks are guaranteed subsets of the FULL ones.
 *
 * FULL / MULTI (requirement 14.4): all module results are included unchanged. MULTI is treated
 * per-wallet exactly like FULL here; the orchestrator (task 13) decides the wallet set and the
 * longer history window, then assembles the per-wallet reports via {@link generateMultiWalletReport}.
 */
export function applyTierTrimming(inputs: AuditInputs): TrimmedModuleData {
  if (inputs.tier === "QUICK") {
    return {
      approvals: inputs.approvals.filter((a) => a.isUnlimited),
      contractRisks: inputs.contractRisks.filter(isHighRiskContract),
      assets: null,
      txFindings: [],
      revokeAdvice: inputs.revokeAdvice.filter(
        (r) => r.category === "UNLIMITED_APPROVAL" || r.category === "HIGH_RISK_CONTRACT",
      ),
    };
  }
  // FULL / MULTI: include every module result as provided (requirement 14.4).
  return {
    approvals: inputs.approvals,
    contractRisks: inputs.contractRisks,
    assets: inputs.assets,
    txFindings: inputs.txFindings,
    revokeAdvice: inputs.revokeAdvice,
  };
}

// ── Structured form (requirements 14.5 / 14.7 / 5.1 / 5.2 / 13.4 / 17.3) ─────────

/**
 * Build the machine-readable structured report (AuditReportStructured).
 *
 * Always sets `schemaVersion` (14.7), `walletAddress` + `auditedChain` = "Ethereum Mainnet" +
 * UTC `generatedAt` (14.5 / 17.3), the `readOnlyDeclaration` (13.4), the Health_Score fields,
 * and `riskLevelSummary` (5.2 / 14.7). Module results are tier-trimmed via
 * {@link applyTierTrimming} so the structured form already reflects the tier's scope; the risk
 * summary is computed from the trimmed data so it is consistent with what the report contains.
 */
export function buildStructuredReport(inputs: AuditInputs): AuditReportStructured {
  const generatedAt = inputs.generatedAt ?? new Date().toISOString();
  const chain = inputs.chain ?? DEFAULT_CHAIN;
  const trimmed = applyTierTrimming(inputs);
  const riskLevelSummary = computeRiskLevelSummary(trimmed.contractRisks, trimmed.revokeAdvice);

  const structured: AuditReportStructured = {
    schemaVersion: SCHEMA_VERSION,
    walletAddress: inputs.walletAddress,
    auditedChain: chain.name,
    auditedChainKey: chain.key,
    generatedAt,
    tier: inputs.tier,
    readOnlyDeclaration: READ_ONLY_DECLARATION,
    healthScore: inputs.healthScore.score,
    healthGrade: inputs.healthScore.grade,
    riskLevelSummary,
    scoredOnIncompleteData: inputs.healthScore.scoredOnIncompleteData,
    approvals: trimmed.approvals,
    contractRisks: trimmed.contractRisks,
    assets: trimmed.assets,
    txFindings: trimmed.txFindings,
    revokeAdvice: trimmed.revokeAdvice,
    moduleStatuses: inputs.moduleStatuses,
  };
  if (inputs.addressStanding !== undefined) structured.addressStanding = inputs.addressStanding;
  return structured;
}

// ── Human-readable form (requirement 14.6 / 13.4 / 17.3) ─────────────────────────

/**
 * Render the human-readable Markdown form from a structured report (requirement 14.6).
 *
 * The header always names the audited chain (requirement 17.3) and the document always embeds
 * the read-only declaration (requirement 13.4), so even a report with no findings still states
 * the supported chain and the read-only guarantee. Sections mirror the structured fields after
 * tier trimming, with explicit "nothing found / not in scope" messages for empty sections.
 */
export function renderHumanReadable(s: AuditReportStructured): string {
  const lines: string[] = [];

  lines.push("# Web3 Address Intel Report");
  lines.push("");
  lines.push(`- Wallet Address: ${s.walletAddress}`);
  lines.push(`- Audited Chain: ${s.auditedChain}`);
  lines.push(`- Tier: ${s.tier}`);
  lines.push(`- Generated At (UTC): ${s.generatedAt}`);
  lines.push(`- Schema Version: ${s.schemaVersion}`);
  lines.push("");
  // Read-only declaration (requirement 13.4): rendered verbatim so the text is always present.
  lines.push(`> ${s.readOnlyDeclaration}`);
  lines.push("");

  lines.push("## Health Score");
  lines.push(`- Score: ${s.healthScore} / 100`);
  lines.push(`- Grade: ${s.healthGrade}`);
  lines.push(`- Overall Risk Level: ${s.riskLevelSummary}`);
  if (s.addressStanding) {
    lines.push(`- Address Badge: ${s.addressStanding.badge.label}`);
    lines.push(`- Address Verdict: ${s.addressStanding.verdict}`);
    lines.push(`- Address Type: ${s.addressStanding.type}`);
    if (s.addressStanding.label) lines.push(`- Address Label: ${s.addressStanding.label}`);
  }
  if (s.scoredOnIncompleteData) {
    lines.push("- Note: this score was computed on incomplete data.");
  }
  lines.push("");

  if (s.addressStanding) {
    lines.push("## Address Standing");
    lines.push(`- Badge: ${s.addressStanding.badge.label}`);
    lines.push(`- Badge Level: ${s.addressStanding.badge.level}`);
    lines.push(`- Official: ${s.addressStanding.official}`);
    lines.push(`- Blacklisted: ${s.addressStanding.blacklisted}`);
    lines.push(`- Meaning: ${s.addressStanding.badge.description}`);
    if (s.addressStanding.reasons.length === 0) {
      lines.push("- No standing reasons reported.");
    } else {
      for (const reason of s.addressStanding.reasons) lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  lines.push("## Unlimited / Flagged Approvals");
  if (s.approvals.length === 0) {
    lines.push("No approval records in scope.");
  } else {
    for (const a of s.approvals) {
      lines.push(
        `- ${a.kind} | token ${a.tokenContract} | spender ${a.spender} (${a.spenderLabel}) ` +
          `| allowance ${a.allowance} | unlimited: ${a.isUnlimited} | updated ${a.lastUpdated}`,
      );
    }
  }
  lines.push("");

  lines.push("## Contract Risks");
  if (s.contractRisks.length === 0) {
    lines.push("No flagged contracts in scope.");
  } else {
    for (const c of s.contractRisks) {
      const features = c.matchedFeatures.length > 0 ? c.matchedFeatures.join(", ") : "none";
      lines.push(
        `- ${c.contract} | ${c.riskLevel} | ${c.classification.join(", ")} | features: ${features}`,
      );
    }
  }
  lines.push("");

  lines.push("## Asset Distribution");
  if (s.assets === null) {
    lines.push("Asset distribution is not included in this tier.");
  } else if (s.assets.empty) {
    lines.push("No displayable assets.");
  } else {
    lines.push(
      `- Unit: ${s.assets.unit} | Price Source: ${s.assets.priceSource} | Priced At: ${s.assets.pricedAt}`,
    );
    for (const item of s.assets.top) {
      const usd = item.usdValue === null ? "N/A" : String(item.usdValue);
      const pct = item.percentage === null ? "N/A" : `${item.percentage}%`;
      lines.push(
        `- ${item.symbol} (${item.token}) | balance ${item.balance} | usd ${usd} | ${pct}`,
      );
    }
    if (s.assets.other !== null) {
      const o = s.assets.other;
      const usd = o.usdValue === null ? "N/A" : String(o.usdValue);
      const pct = o.percentage === null ? "N/A" : `${o.percentage}%`;
      lines.push(`- Other | balance ${o.balance} | usd ${usd} | ${pct}`);
    }
  }
  lines.push("");

  lines.push("## Transaction Findings");
  if (s.txFindings.length === 0) {
    lines.push("No failed or abnormal transactions in scope.");
  } else {
    for (const t of s.txFindings) {
      const parts = [t.txHash, t.timestamp, t.reason];
      if (t.interactionType !== undefined) parts.push(`type ${t.interactionType}`);
      if (t.contract !== undefined) parts.push(`contract ${t.contract}`);
      lines.push(`- ${parts.join(" | ")}`);
    }
  }
  lines.push("");

  lines.push("## Revocation Advice");
  if (s.revokeAdvice.length === 0) {
    lines.push("No approvals need revoking.");
  } else {
    for (const r of s.revokeAdvice) {
      lines.push(`- ${r.category} | ${r.riskLevel} | ${r.reason} | ${r.revokeLink.url}`);
    }
  }
  lines.push("");

  lines.push("## Module Statuses");
  if (s.moduleStatuses.length === 0) {
    lines.push("No module status reported.");
  } else {
    for (const m of s.moduleStatuses) {
      const src =
        m.unavailableSource !== undefined ? ` (unavailable source: ${m.unavailableSource})` : "";
      lines.push(`- ${m.module}: ${m.status}${src}`);
    }
  }

  return lines.join("\n");
}

// ── Public API ───────────────────────────────────────────────────────────────────

/**
 * Generate a complete dual-form Audit_Report for one wallet (task 11.1, requirement 14.6).
 * Returns both the human-readable Markdown (`humanReadable`) and the machine-readable
 * structured object (`structured`), produced from the same tier-trimmed data.
 */
export function generateReport(inputs: AuditInputs): AuditReport {
  const structured = buildStructuredReport(inputs);
  const humanReadable = renderHumanReadable(structured);
  return { humanReadable, structured };
}

/**
 * Assemble a set of per-wallet structured reports into a MultiWalletReport (task 11.2,
 * requirements 15.3 / 15.4). `walletCount` equals `reports.length` by construction. The
 * orchestrator (task 13) is responsible for choosing the wallet set and the longer history
 * window; this function only assembles the already-produced sub-reports.
 */
export function generateMultiWalletReport(perWallet: AuditReportStructured[]): MultiWalletReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    walletCount: perWallet.length,
    reports: perWallet,
  };
}
