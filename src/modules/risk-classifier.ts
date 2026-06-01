/**
 * Risk_Classifier (task 6.1, per the "Risk_Classifier" row in design.md and requirements 7, 8.2/8.3).
 *
 * Pure logic component: classifies each authorized contract (spender) based on 6 suspicious
 * features and assigns a Risk_Level. Data is obtained through the injected RiskRuleSource
 * (blacklist/labels) and ChainDataSource.getContractMeta (verified/open-source, deployment time,
 * historical transaction count, audit status, whether it is a contract). The module never accesses
 * the network directly, so it can be driven by in-memory mock data sources in property tests.
 *
 * Security constraint (requirement 13.1): consumes only read-only lookup / getContractMeta,
 * with no write-chain path whatsoever.
 */

import type {
  Address,
  ApprovalRecord,
  ContractClassification,
  ContractRisk,
  RiskLevel,
  SuspiciousFeature,
} from "../models.js";
import type {
  ChainDataSource,
  ContractMeta,
  RiskRuleEntry,
  RiskRuleSource,
} from "../datasource/types.js";

// ── Decision thresholds (the 6 suspicious features of requirement 7.2) ─────────────────────────────

/** (b) A deployment age below this many days is considered "recently deployed". */
export const RECENTLY_DEPLOYED_DAYS = 30;
/** (c) Fewer on-chain historical transactions than this count is considered "too few transactions". */
export const LOW_TX_COUNT_THRESHOLD = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Fixed detection order of suspicious features (a→f), guaranteeing deterministic matchedFeatures output.
 * (a) UNVERIFIED_SOURCE source code not verified / not open-source
 * (b) RECENTLY_DEPLOYED deployed < 30 days ago
 * (c) LOW_TX_COUNT historical transactions < 100
 * (d) NO_AUDIT no public audit
 * (e) BLACKLISTED matches the blacklist
 * (f) SPENDER_IS_EOA the authorized party is an EOA
 */
export const SUSPICIOUS_FEATURE_ORDER: readonly SuspiciousFeature[] = [
  "UNVERIFIED_SOURCE",
  "RECENTLY_DEPLOYED",
  "LOW_TX_COUNT",
  "NO_AUDIT",
  "BLACKLISTED",
  "SPENDER_IS_EOA",
] as const;

// ── Result types ───────────────────────────────────────────────────────

/** Identifier of the data source that triggered a classification failure (requirement 7.6). */
export type ClassifierUnavailableSource = "RiskRuleSource" | "ChainDataSource";

/**
 * Result of a single contract classification.
 * On success, outputs the ContractRisk list for this classification;
 * on failure (rule library / chain data source unreachable), it does not output this classification
 * and preserves the previous successful result without overwriting it (requirement 7.6).
 */
export type RiskClassificationResult =
  | { ok: true; contractRisks: ContractRisk[] }
  | { ok: false; reason: string; unavailableSource: ClassifierUnavailableSource };

// ── Pure functions: feature detection and grading ─────────────────────────────

/** Whether the deployment time is "recent" (less than RECENTLY_DEPLOYED_DAYS days from now). */
function isRecentlyDeployed(deployedAt: string | null, now: Date): boolean {
  // A null deployedAt is treated as unknown and handled as "no match" (the conservative judgment of requirement 7.2(b)).
  if (deployedAt === null) return false;
  const t = Date.parse(deployedAt);
  if (Number.isNaN(t)) return false;
  const ageMs = now.getTime() - t;
  // A deployment time in the future (age < 0) is treated as unknown and handled as no match; exactly 30 days is no match (strictly less than).
  if (ageMs < 0) return false;
  return ageMs < RECENTLY_DEPLOYED_DAYS * MS_PER_DAY;
}

/**
 * Detects the matched suspicious features (6 in total) based on contract metadata and the risk rule entry.
 * Returned in a fixed order (a→f) to guarantee determinism.
 */
export function detectSuspiciousFeatures(
  meta: ContractMeta,
  rule: RiskRuleEntry,
  now: Date = new Date(),
): SuspiciousFeature[] {
  const features: SuspiciousFeature[] = [];
  if (meta.verified === false) features.push("UNVERIFIED_SOURCE"); // (a)
  if (isRecentlyDeployed(meta.deployedAt, now)) features.push("RECENTLY_DEPLOYED"); // (b)
  if (meta.txCount < LOW_TX_COUNT_THRESHOLD) features.push("LOW_TX_COUNT"); // (c)
  if (meta.audited === false) features.push("NO_AUDIT"); // (d)
  if (rule.blacklisted === true) features.push("BLACKLISTED"); // (e)
  if (meta.isContract === false) features.push("SPENDER_IS_EOA"); // (f)
  return features;
}

/**
 * Derives the classification labels from the number of matched features (requirements 7.2/7.3):
 *  - 0 matches → not labeled (empty array, does not enter the ContractRisk list)
 *  - exactly 1 match → Suspicious_Contract
 *  - ≥2 matches → escalated to High_Risk_Contract (no longer merely suspicious)
 */
export function classificationForFeatures(matched: SuspiciousFeature[]): ContractClassification[] {
  if (matched.length === 0) return [];
  if (matched.length === 1) return ["SUSPICIOUS"];
  return ["HIGH_RISK"];
}

/**
 * Deterministic Risk_Level mapping (requirement 7.1 requires every authorized contract to receive a valid Risk_Level):
 *  - BLACKLISTED matched ⇒ CRITICAL (blacklist takes priority, regardless of match count)
 *  - ≥2 matches         ⇒ HIGH
 *  - exactly 1 match     ⇒ MEDIUM
 *  - 0 matches           ⇒ LOW (unlabeled contracts do not enter the list; this value exists only for total-function completeness)
 */
export function riskLevelForFeatures(matched: SuspiciousFeature[]): RiskLevel {
  if (matched.includes("BLACKLISTED")) return "CRITICAL";
  if (matched.length >= 2) return "HIGH";
  if (matched.length === 1) return "MEDIUM";
  return "LOW";
}

/**
 * Classifies a single authorized contract. Returns null on 0 matches (not labeled, not added to the list).
 * Pure function: the same (meta, rule, now) always produces the same result.
 */
export function classifyContract(
  contract: Address,
  meta: ContractMeta,
  rule: RiskRuleEntry,
  now: Date = new Date(),
): ContractRisk | null {
  const matched = detectSuspiciousFeatures(meta, rule, now);
  if (matched.length === 0) return null;
  return {
    contract,
    riskLevel: riskLevelForFeatures(matched),
    classification: classificationForFeatures(matched),
    matchedFeatures: matched,
  };
}

// ── High-risk interaction helpers (the classification part of requirements 8.2/8.3) ───────────────────

/**
 * Determines whether an interaction target is a High_Risk_Contract, based on RiskRuleEntry.blacklisted.
 * Reused by Transaction_Analyzer / the orchestrator to flag high-risk interactions.
 */
export function isHighRiskContract(entry: RiskRuleEntry): boolean {
  return entry.blacklisted === true;
}

/**
 * Queries via the injected RiskRuleSource whether a given address is a High_Risk_Contract (requirements 8.2/8.3).
 */
export async function isHighRiskContractAddress(
  addr: Address,
  rules: RiskRuleSource,
): Promise<boolean> {
  const entry = await rules.lookup(addr);
  return isHighRiskContract(entry);
}

// ── Stateful classifier: injected data sources + per-wallet cache (requirement 7.6) ──────────

export interface RiskClassifierDeps {
  /** Provides getContractMeta (verified/open-source, deployment time, historical transactions, audit, whether a contract). */
  chain: ChainDataSource;
  /** Provides lookup (blacklist/labels). */
  rules: RiskRuleSource;
  /** The "current time" used for the RECENTLY_DEPLOYED decision, defaults to new Date(); tests may inject a fixed value to guarantee determinism. */
  now?: () => Date;
}

const cacheKey = (addr: Address): string => addr.toLowerCase();

/** Deduplicates authorized contract addresses (normalized to lowercase), keeping the original spelling of the first occurrence. */
function uniqueAddresses(addrs: Address[]): Address[] {
  const seen = new Set<string>();
  const result: Address[] = [];
  for (const a of addrs) {
    const k = cacheKey(a);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(a);
    }
  }
  return result;
}

/**
 * Risk_Classifier component. Maintains a "last successful classification" cache per wallet:
 *  - successful classification → updates that wallet's cache and returns the success result;
 *  - rule library / chain data source unreachable → returns a failure result without overwriting that wallet's last successful classification (requirement 7.6).
 */
export class RiskClassifier {
  private readonly chain: ChainDataSource;
  private readonly rules: RiskRuleSource;
  private readonly now: () => Date;
  /** Each wallet address (lowercase) → the ContractRisk list of the last successful classification. */
  private readonly lastSuccessful = new Map<string, ContractRisk[]>();

  constructor(deps: RiskClassifierDeps) {
    this.chain = deps.chain;
    this.rules = deps.rules;
    this.now = deps.now ?? (() => new Date());
  }

  /** Gets a wallet's last successful classification result (undefined if none). Returns a defensive copy so external code cannot tamper with the cache. */
  getLastSuccessful(wallet: Address): ContractRisk[] | undefined {
    const cached = this.lastSuccessful.get(cacheKey(wallet));
    return cached ? cached.map((r) => ({ ...r })) : undefined;
  }

  /**
   * Classifies a set of authorized contracts (spenders) for a wallet.
   * On success, updates the cache and returns { ok: true, contractRisks };
   * if any data source is unreachable, returns { ok: false, ... } and preserves the last successful result without overwriting it.
   */
  async classifyForWallet(wallet: Address, spenders: Address[]): Promise<RiskClassificationResult> {
    const now = this.now();
    const targets = uniqueAddresses(spenders);
    const risks: ContractRisk[] = [];

    for (const spender of targets) {
      // Rule library lookup (requirement 7.6: rule library unreachable → unavailable result, does not overwrite the previous one).
      let rule: RiskRuleEntry;
      try {
        rule = await this.rules.lookup(spender);
      } catch (err) {
        return {
          ok: false,
          reason: `Suspicious contract classification unavailable: risk rule library unreachable (${describeError(err)})`,
          unavailableSource: "RiskRuleSource",
        };
      }

      // Contract metadata lookup.
      let meta: ContractMeta;
      try {
        meta = await this.chain.getContractMeta(spender);
      } catch (err) {
        return {
          ok: false,
          reason: `Suspicious contract classification unavailable: contract metadata data source unreachable (${describeError(err)})`,
          unavailableSource: "ChainDataSource",
        };
      }

      const risk = classifyContract(spender, meta, rule, now);
      if (risk !== null) risks.push(risk); // 0 matches do not enter the list
    }

    // Success: update this wallet's cache (storing an internal copy to avoid tampering via external references).
    this.lastSuccessful.set(
      cacheKey(wallet),
      risks.map((r) => ({ ...r })),
    );
    return { ok: true, contractRisks: risks };
  }

  /**
   * Convenience entry point: extracts the authorized parties (spenders) from approval records, deduplicates them, and classifies.
   * The spender is the "authorized contract" (requirement 7.1).
   */
  async classifyApprovals(
    wallet: Address,
    approvals: ApprovalRecord[],
  ): Promise<RiskClassificationResult> {
    return this.classifyForWallet(
      wallet,
      approvals.map((a) => a.spender),
    );
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
