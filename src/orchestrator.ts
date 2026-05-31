/**
 * Audit Orchestrator (task 13.1, per design.md "Audit Orchestrator" and requirements
 * 2.3 / 14.1 / 15.1 / 15.2 / 18.3 / 18.4 / 18.5).
 *
 * Responsibility: coordinate a single-wallet audit and the multi-wallet fan-out. The orchestrator
 * is the only place that knows the dependency graph between analysis modules; the modules
 * themselves stay pure and data-source-agnostic. Concretely it:
 *
 *  - Tier routing (req 2.3 / 14.1): QUICK runs Approval_Scanner + Risk_Classifier (high-risk among
 *    approvals) + Health_Score only — it does NOT run Asset_Analyzer or Transaction_Analyzer. FULL
 *    runs all modules. MULTI is FULL per-wallet but with the longer history window.
 *  - History window (req 15.2): QUICK/FULL use DEFAULT_TX_WINDOW_DAYS (90); MULTI uses
 *    MULTI_TX_WINDOW_DAYS (365), which is strictly greater. The chosen window is returned so callers
 *    (and tests) can observe it.
 *  - Concurrency: independent modules run concurrently. Approval_Scanner, Asset_Analyzer and
 *    Transaction_Analyzer have no data dependency on each other and are launched together;
 *    Risk_Classifier depends on the scanned approvals, Revoke_Advisor depends on approvals +
 *    contractRisks, and Health_Score depends on the collected RiskItems.
 *  - Partial-success aggregation (req 18.3 / 18.4 / 18.5): a ModuleStatus (OK / INCOMPLETE / FAILED)
 *    is collected per module. When a data source is unavailable (a DataSourceUnavailable or a module
 *    FAILED result) the affected module is marked FAILED (its own source failed) or INCOMPLETE
 *    (blocked by an upstream failure) with the offending `unavailableSource` recorded, and the audit
 *    continues with the remaining modules (degrade, don't abort). Health_Score is computed with
 *    `scoredOnIncompleteData = true` whenever any module did not complete.
 *
 * Security constraint (requirement 13.1): the orchestrator only consumes the injected read-only
 * data sources and pure analysis modules; it has no write-chain / send-transaction path.
 */

import {
  DEFAULT_TX_WINDOW_DAYS,
  MULTI_TX_WINDOW_DAYS,
  type Tier,
} from "./config.js";
import type {
  Address,
  ApprovalRecord,
  AssetDistribution,
  AuditReport,
  ContractRisk,
  HealthScoreResult,
  ModuleStatus,
  MultiWalletReport,
  RiskItem,
  TxFinding,
} from "./models.js";
import type {
  ChainDataSource,
  PriceDataSource,
  RawBalance,
  RiskRuleSource,
} from "./datasource/types.js";
import type { RetryPolicy } from "./datasource/retry.js";

import { validateAddresses } from "./modules/address-validator.js";
import { ApprovalScanner } from "./modules/approval-scanner.js";
import { RiskClassifier } from "./modules/risk-classifier.js";
import { analyzeAssets } from "./modules/asset-analyzer.js";
import { TransactionAnalyzer } from "./modules/transaction-analyzer.js";
import { generateRevokeAdvice } from "./modules/revoke-advisor.js";
import { computeHealthScore } from "./modules/health-score-engine.js";
import {
  generateReport,
  generateMultiWalletReport,
  type AuditInputs,
} from "./modules/report-generator.js";
import { someModuleSucceeded } from "./modules/payment-gateway.js";

// Re-exported so the CAP / Payment layer can decide settle vs refund from the collected statuses
// without re-importing the gateway (requirement 18.4 / 18.5).
export { someModuleSucceeded } from "./modules/payment-gateway.js";

// ── Module names (used as ModuleStatus.module identifiers) ─────────────────────────────

export const MODULE_APPROVAL_SCANNER = "Approval_Scanner";
export const MODULE_RISK_CLASSIFIER = "Risk_Classifier";
export const MODULE_ASSET_ANALYZER = "Asset_Analyzer";
export const MODULE_TRANSACTION_ANALYZER = "Transaction_Analyzer";

// ── Data source identifiers (recorded as ModuleStatus.unavailableSource, requirement 18.3) ──

export const SOURCE_CHAIN = "ChainDataSource";
export const SOURCE_PRICE = "PriceDataSource";
export const SOURCE_RULE = "RiskRuleSource";

// ── Risk item baseline levels (documented mapping, see buildRiskItems) ──────────────────

/** An Unlimited_Approval grants full spending power, so it is treated as HIGH severity. */
export const UNLIMITED_APPROVAL_RISK_LEVEL = "HIGH" as const;
/** A high-risk interaction (interaction with a High_Risk_Contract) is treated as HIGH severity. */
export const HIGH_RISK_INTERACTION_RISK_LEVEL = "HIGH" as const;

// ── Result types ───────────────────────────────────────────────────────────────────────

/** Options for a single-wallet audit. */
export interface AuditWalletOptions {
  /**
   * Override the transaction analysis window in days. When omitted it is derived from the tier
   * via {@link windowForTier} (QUICK/FULL = 90, MULTI = 365).
   */
  windowDays?: number;
  /** Report generation time (UTC ISO-8601); defaults to the injected clock. For deterministic tests. */
  generatedAt?: string;
}

/** Result of auditing a single wallet. The chosen window is exposed so callers can observe it. */
export interface AuditWalletResult {
  report: AuditReport;
  statuses: ModuleStatus[];
  tier: Tier;
  /** The history window actually applied (days). MULTI > QUICK/FULL (requirement 15.2). */
  windowDays: number;
  healthScore: HealthScoreResult;
}

/** Per-wallet entry of a multi-wallet audit. */
export interface PerWalletAuditResult {
  address: Address;
  report: AuditReport;
  statuses: ModuleStatus[];
  windowDays: number;
  tier: Tier;
}

/** Result of a multi-wallet audit. */
export interface MultiWalletAuditResult {
  multi: MultiWalletReport;
  perWallet: PerWalletAuditResult[];
}

/** Injected dependencies for the orchestrator. */
export interface AuditOrchestratorDeps {
  chain: ChainDataSource;
  price: PriceDataSource;
  rules: RiskRuleSource;
  /** Optional unified retry/timeout policy (requirements 18.1 / 18.2). */
  retry?: RetryPolicy;
  /** Injected "current time" for determinism; defaults to () => new Date(). */
  now?: () => Date;
}

// Internal sub-results for the data-fetching modules (ok flag + the offending source on failure).
type AssetOutcome =
  | { ok: true; assets: AssetDistribution }
  | { ok: false; unavailableSource: string };

type TxOutcome =
  | { ok: true; highRiskInteractions: TxFinding[]; failedAbnormal: TxFinding[] }
  | { ok: false; unavailableSource: string };

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────

/**
 * The history window (days) for a tier (requirement 15.2). MULTI uses the longer
 * MULTI_TX_WINDOW_DAYS (365), strictly greater than the QUICK/FULL default DEFAULT_TX_WINDOW_DAYS (90).
 */
export function windowForTier(tier: Tier): number {
  return tier === "MULTI" ? MULTI_TX_WINDOW_DAYS : DEFAULT_TX_WINDOW_DAYS;
}

/**
 * Normalize the collected per-module outputs into the RiskItem set fed to the Health_Score_Engine.
 *
 * Documented mapping (design.md "Health score model" inputs):
 *  - Each Unlimited_Approval        → one RiskItem { category "UNLIMITED_APPROVAL", riskLevel HIGH }.
 *  - Each ContractRisk              → one RiskItem { category "HIGH_RISK_CONTRACT" when classified
 *                                     HIGH_RISK else "SUSPICIOUS_CONTRACT", riskLevel = the contract
 *                                     risk's own riskLevel }.
 *  - Each high-risk interaction     → one RiskItem { category "HIGH_RISK_INTERACTION", riskLevel HIGH }.
 *
 * An unlimited approval whose spender is also flagged as a risky contract contributes two distinct
 * risk items (one approval-side, one contract-side); these are independent risk dimensions.
 */
export function buildRiskItems(
  approvals: readonly ApprovalRecord[],
  contractRisks: readonly ContractRisk[],
  highRiskInteractions: readonly TxFinding[],
): RiskItem[] {
  const items: RiskItem[] = [];

  for (const approval of approvals) {
    if (approval.isUnlimited) {
      items.push({
        category: "UNLIMITED_APPROVAL",
        riskLevel: UNLIMITED_APPROVAL_RISK_LEVEL,
        detail: `Unlimited approval to ${approval.spender} for token ${approval.tokenContract}`,
      });
    }
  }

  for (const risk of contractRisks) {
    const category = risk.classification.includes("HIGH_RISK")
      ? "HIGH_RISK_CONTRACT"
      : "SUSPICIOUS_CONTRACT";
    const features =
      risk.matchedFeatures.length > 0 ? risk.matchedFeatures.join(", ") : "none";
    items.push({
      category,
      riskLevel: risk.riskLevel,
      detail: `${category} ${risk.contract} (features: ${features})`,
    });
  }

  for (const finding of highRiskInteractions) {
    const contract = finding.contract !== undefined ? ` with ${finding.contract}` : "";
    items.push({
      category: "HIGH_RISK_INTERACTION",
      riskLevel: HIGH_RISK_INTERACTION_RISK_LEVEL,
      detail: `High-risk interaction ${finding.txHash}${contract}`,
    });
  }

  return items;
}

// ── Orchestrator ───────────────────────────────────────────────────────────────────────────

/**
 * Audit Orchestrator. Builds the analysis modules from injected data sources and coordinates a
 * single audit (tier routing + concurrency + partial-success aggregation) and the multi-wallet
 * fan-out.
 */
export class AuditOrchestrator {
  private readonly chain: ChainDataSource;
  private readonly price: PriceDataSource;
  private readonly retry: RetryPolicy | undefined;
  private readonly now: () => Date;

  private readonly scanner: ApprovalScanner;
  private readonly classifier: RiskClassifier;
  private readonly txAnalyzer: TransactionAnalyzer;

  constructor(deps: AuditOrchestratorDeps) {
    this.chain = deps.chain;
    this.price = deps.price;
    this.retry = deps.retry;
    this.now = deps.now ?? ((): Date => new Date());

    this.scanner = new ApprovalScanner(deps.chain, deps.retry);
    this.classifier = new RiskClassifier({ chain: deps.chain, rules: deps.rules, now: this.now });
    this.txAnalyzer = new TransactionAnalyzer({
      chain: deps.chain,
      rules: deps.rules,
      retry: deps.retry,
      now: this.now,
    });
  }

  /**
   * Audit a single wallet at the given tier.
   *
   * QUICK runs Approval_Scanner + Risk_Classifier + Health_Score only; FULL/MULTI additionally run
   * Asset_Analyzer and Transaction_Analyzer. The report is always generated from the modules that
   * succeeded; failed modules are recorded in `statuses` and the Health_Score is flagged as computed
   * on incomplete data when anything did not complete.
   */
  async auditWallet(
    address: Address,
    tier: Tier,
    options: AuditWalletOptions = {},
  ): Promise<AuditWalletResult> {
    const windowDays = options.windowDays ?? windowForTier(tier);
    const generatedAt = options.generatedAt ?? this.now().toISOString();
    const isQuick = tier === "QUICK";

    const statuses: ModuleStatus[] = [];

    // Launch independent modules concurrently: approval scan always; assets + transactions only for
    // FULL/MULTI. None of these three depend on each other.
    const approvalScanPromise = this.scanner.scan(address);
    const assetPromise: Promise<AssetOutcome> | null = isQuick
      ? null
      : this.runAssetAnalysis(address);
    const txPromise: Promise<TxOutcome> | null = isQuick
      ? null
      : this.runTransactionAnalysis(address, windowDays);

    // Approval_Scanner (requirement 6.5 / 6.6): EMPTY and OK are both "succeeded"; FAILED means the
    // approval data source was unavailable.
    const approvalScan = await approvalScanPromise;
    let approvals: ApprovalRecord[] = [];
    if (approvalScan.status === "FAILED") {
      statuses.push({
        module: MODULE_APPROVAL_SCANNER,
        status: "FAILED",
        unavailableSource: SOURCE_CHAIN,
      });
    } else {
      approvals = approvalScan.approvals;
      statuses.push({ module: MODULE_APPROVAL_SCANNER, status: "OK" });
    }

    // Risk_Classifier depends on the scanned approvals. If the approval scan failed there is no input
    // to classify, so the classifier is INCOMPLETE (blocked upstream); otherwise it runs and may fail
    // on its own data sources (requirement 7.6 / 18.3).
    let contractRisks: ContractRisk[] = [];
    if (approvalScan.status === "FAILED") {
      statuses.push({
        module: MODULE_RISK_CLASSIFIER,
        status: "INCOMPLETE",
        unavailableSource: SOURCE_CHAIN,
      });
    } else {
      const classification = await this.classifier.classifyApprovals(address, approvals);
      if (classification.ok) {
        contractRisks = classification.contractRisks;
        statuses.push({ module: MODULE_RISK_CLASSIFIER, status: "OK" });
      } else {
        statuses.push({
          module: MODULE_RISK_CLASSIFIER,
          status: "FAILED",
          unavailableSource:
            classification.unavailableSource === "RiskRuleSource" ? SOURCE_RULE : SOURCE_CHAIN,
        });
      }
    }

    // Asset_Analyzer (FULL/MULTI only).
    let assets: AssetDistribution | null = null;
    if (assetPromise !== null) {
      const assetOutcome = await assetPromise;
      if (assetOutcome.ok) {
        assets = assetOutcome.assets;
        statuses.push({ module: MODULE_ASSET_ANALYZER, status: "OK" });
      } else {
        statuses.push({
          module: MODULE_ASSET_ANALYZER,
          status: "FAILED",
          unavailableSource: assetOutcome.unavailableSource,
        });
      }
    }

    // Transaction_Analyzer (FULL/MULTI only).
    let txFindings: TxFinding[] = [];
    let highRiskInteractions: TxFinding[] = [];
    if (txPromise !== null) {
      const txOutcome = await txPromise;
      if (txOutcome.ok) {
        highRiskInteractions = txOutcome.highRiskInteractions;
        // The report's tx findings combine high-risk interactions and failed/abnormal transactions.
        txFindings = [...txOutcome.highRiskInteractions, ...txOutcome.failedAbnormal];
        statuses.push({ module: MODULE_TRANSACTION_ANALYZER, status: "OK" });
      } else {
        statuses.push({
          module: MODULE_TRANSACTION_ANALYZER,
          status: "FAILED",
          unavailableSource: txOutcome.unavailableSource,
        });
      }
    }

    // Partial-success: the score is flagged as computed on incomplete data whenever any module did
    // not complete (requirement 12.7 / 18.3).
    const scoredOnIncompleteData = statuses.some((s) => s.status !== "OK");

    // Health_Score is computed from the risk items contributed by the modules that succeeded.
    const riskItems = buildRiskItems(approvals, contractRisks, highRiskInteractions);
    const healthScore = computeHealthScore(riskItems, { scoredOnIncompleteData });

    // Revoke_Advisor is pure (links only, no data source); the report trims it per tier.
    const revokeAdvice = generateRevokeAdvice(approvals, contractRisks);

    const inputs: AuditInputs = {
      walletAddress: address,
      tier,
      healthScore,
      approvals,
      contractRisks,
      assets,
      txFindings,
      revokeAdvice,
      moduleStatuses: statuses,
      generatedAt,
    };
    const report = generateReport(inputs);

    return { report, statuses, tier, windowDays, healthScore };
  }

  /**
   * Audit multiple wallets at the MULTI tier (requirements 15.1 / 15.3 / 15.4).
   *
   * The submitted addresses are deduplicated and validated via the Address_Validator; each VALID,
   * unique (normalized) address is audited at the MULTI tier with the longer history window, and the
   * per-wallet structured reports are assembled into a MultiWalletReport. By construction
   * `multi.walletCount === perWallet.length === number of deduped valid addresses`.
   */
  async auditMultipleWallets(
    addresses: string[],
    options: AuditWalletOptions = {},
  ): Promise<MultiWalletAuditResult> {
    const validation = validateAddresses(addresses);
    // pendingAddresses is already deduplicated, valid and normalized to lowercase. When the batch is
    // rejected (e.g. > 50 addresses) it is empty, yielding an empty multi-wallet report.
    const validAddresses = validation.pendingAddresses;

    const perWallet: PerWalletAuditResult[] = await Promise.all(
      validAddresses.map(async (address) => {
        const result = await this.auditWallet(address, "MULTI", options);
        return {
          address,
          report: result.report,
          statuses: result.statuses,
          windowDays: result.windowDays,
          tier: result.tier,
        };
      }),
    );

    const multi = generateMultiWalletReport(perWallet.map((w) => w.report.structured));
    return { multi, perWallet };
  }

  /** Whether at least one analysis module succeeded among the given statuses (requirement 18.4). */
  someModuleSucceeded(statuses: ModuleStatus[]): boolean {
    return someModuleSucceeded(statuses);
  }

  // ── Internal module runners ─────────────────────────────────────────────────────────────

  /**
   * Run the Asset_Analyzer: fetch balances from the ChainDataSource, then value them via the
   * PriceDataSource. Distinguishes which data source failed so the status can name it.
   */
  private async runAssetAnalysis(address: Address): Promise<AssetOutcome> {
    let balances: RawBalance[];
    try {
      balances = await this.fetchBalances(address);
    } catch {
      return { ok: false, unavailableSource: SOURCE_CHAIN };
    }
    try {
      const assets = await analyzeAssets(balances, this.price, {
        now: this.now().toISOString(),
      });
      return { ok: true, assets };
    } catch {
      // analyzeAssets only touches the PriceDataSource after balances are in hand.
      return { ok: false, unavailableSource: SOURCE_PRICE };
    }
  }

  /** Run the Transaction_Analyzer for the given window, mapping its result to an outcome. */
  private async runTransactionAnalysis(
    address: Address,
    windowDays: number,
  ): Promise<TxOutcome> {
    const result = await this.txAnalyzer.analyze(address, { windowDays });
    if (result.status === "OK") {
      return {
        ok: true,
        highRiskInteractions: result.highRiskInteractions,
        failedAbnormal: result.failedAbnormal,
      };
    }
    if (result.status === "RETRIEVAL_FAILED") {
      return { ok: false, unavailableSource: result.unavailableSource };
    }
    // INVALID_ADDRESS: treated as a chain-side failure for status purposes (the caller validates
    // upstream, so this is defensive).
    return { ok: false, unavailableSource: SOURCE_CHAIN };
  }

  /** Fetch balances through the retry policy when one is injected; otherwise call directly. */
  private fetchBalances(address: Address): Promise<RawBalance[]> {
    const op = (): Promise<RawBalance[]> => this.chain.getBalances(address);
    return this.retry ? this.retry.run(op, "ChainDataSource.getBalances") : op();
  }
}
