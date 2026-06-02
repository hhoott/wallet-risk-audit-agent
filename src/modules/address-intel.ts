/**
 * Address_Intel — extended audit targets that broaden the service beyond "check my own wallet".
 *
 * Two new, read-only analyses that reuse the existing data sources (ChainDataSource.getContractMeta,
 * RiskRuleSource.lookup) and the Risk_Classifier's feature/level logic:
 *
 *  1. vetAddress(addr)        — "Is this address legitimate / official, or risky?" Useful before
 *                               sending funds to a token/contract, or trusting a "support" address.
 *  2. assessCounterparty(addr)— "Is this counterparty safe to interact with?" A pre-transaction
 *                               risk check on a target address (recipient / dApp contract).
 *
 * Both are pure given their inputs; the network only happens inside the injected data sources, so
 * they are unit/property-testable with in-memory mocks. Strictly read-only — no signing path.
 */

import type {
  Address,
  AddressBadge,
  AddressStanding,
  AddressType,
  AddressVerdict,
  RiskLevel,
} from "../models.js";
import type {
  ChainDataSource,
  ContractMeta,
  RiskRuleEntry,
  RiskRuleSource,
} from "../datasource/types.js";
import {
  detectSuspiciousFeatures,
  riskLevelForFeatures,
  RECENTLY_DEPLOYED_DAYS,
} from "./risk-classifier.js";
import type { SuspiciousFeature } from "../models.js";

export type { AddressVerdict } from "../models.js";

/** Structured result of vetting a single address. */
export interface AddressIntelResult {
  address: Address;
  /** EOA vs contract. */
  isContract: boolean;
  /** Curated label when known (e.g. "Uniswap V3 Router"); undefined otherwise. */
  label?: string;
  /** Whether the curated rule list marks it as an official / known-good entry. */
  official: boolean;
  /** Whether it hit the blacklist (phishing / drainer / scam). */
  blacklisted: boolean;
  /** Machine-readable verdict. */
  verdict: AddressVerdict;
  /** Risk level derived from the suspicious-feature analysis. */
  riskLevel: RiskLevel;
  /** Stable UI/API/A2A badge derived from verdict + official/blacklist status. */
  badge: AddressBadge;
  /** The suspicious features detected (subset of the 6 standard features). */
  matchedFeatures: SuspiciousFeature[];
  /** Human-readable reasons backing the verdict. */
  reasons: string[];
  /** Contract metadata used (verified/audited/age/txCount), echoed for transparency. */
  meta: ContractMeta;
}

// ── Pure verdict logic ──────────────────────────────────────────────────────────────────

/** Human-readable reason strings for matched suspicious features. */
const FEATURE_REASONS: Record<SuspiciousFeature, string> = {
  UNVERIFIED_SOURCE: "Contract source code is not verified / not open.",
  RECENTLY_DEPLOYED: `Contract was deployed less than ${RECENTLY_DEPLOYED_DAYS} days ago.`,
  LOW_TX_COUNT: "Contract has very few historical transactions.",
  NO_AUDIT: "No public audit record was found.",
  BLACKLISTED: "Address matches a community blacklist (phishing / drainer / scam).",
  SPENDER_IS_EOA: "Target is an externally-owned account (EOA), not a contract.",
};

/**
 * Derive a vetting verdict from the curated rule + on-chain features.
 *
 * Priority: blacklisted → DANGEROUS; official label → OFFICIAL; otherwise grade by how many
 * suspicious features matched (CRITICAL/HIGH → DANGEROUS, MEDIUM → CAUTION, none → LIKELY_SAFE).
 */
export function deriveVerdict(
  rule: RiskRuleEntry,
  matched: SuspiciousFeature[],
  riskLevel: RiskLevel,
): AddressVerdict {
  if (rule.blacklisted === true) return "DANGEROUS";
  if (rule.official === true) return "OFFICIAL";
  if (riskLevel === "CRITICAL" || riskLevel === "HIGH") return "DANGEROUS";
  if (riskLevel === "MEDIUM") return "CAUTION";
  if (matched.length === 0) return "LIKELY_SAFE";
  return "CAUTION";
}

/** Build the stable badge shown in the result page and exported in JSON/A2A deliverables. */
export function badgeForVerdict(
  verdict: AddressVerdict,
  official: boolean,
  blacklisted: boolean,
): AddressBadge {
  if (blacklisted || verdict === "DANGEROUS") {
    return {
      level: "DANGEROUS",
      label: "Dangerous",
      description:
        "Blacklisted or high-risk signals were found; do not interact unless independently verified.",
    };
  }
  if (official || verdict === "OFFICIAL") {
    return {
      level: "OFFICIAL",
      label: "Official verified",
      description: "Matched the curated official / known-good address list.",
    };
  }
  if (verdict === "LIKELY_SAFE") {
    return {
      level: "SAFE",
      label: "Likely safe",
      description: "No risk signals were found in the available deterministic data.",
    };
  }
  if (verdict === "CAUTION") {
    return {
      level: "CAUTION",
      label: "Use caution",
      description:
        "Some suspicious or incomplete signals were found; review the reasons before interacting.",
    };
  }
  return {
    level: "UNKNOWN",
    label: "Unknown",
    description: "The available data is not enough to make a confident legitimacy claim.",
  };
}

/** Convert a full Address_Intel result into the compact standing summary embedded in reports. */
export function buildAddressStanding(
  address: Address,
  type: AddressType,
  intel: AddressIntelResult,
): AddressStanding {
  const standing: AddressStanding = {
    address,
    type,
    verdict: intel.verdict,
    riskLevel: intel.riskLevel,
    official: intel.official,
    blacklisted: intel.blacklisted,
    badge: badgeForVerdict(intel.verdict, intel.official, intel.blacklisted),
    reasons: intel.reasons,
  };
  if (intel.label !== undefined) standing.label = intel.label;
  return standing;
}

/**
 * Build the full Address_Intel result from the rule entry + contract metadata. Pure given inputs.
 */
export function analyzeAddress(
  address: Address,
  rule: RiskRuleEntry,
  meta: ContractMeta,
  now: Date = new Date(),
): AddressIntelResult {
  const matched = detectSuspiciousFeatures(meta, rule, now);
  const riskLevel = riskLevelForFeatures(matched);
  const verdict = deriveVerdict(rule, matched, riskLevel);

  const reasons: string[] = [];
  if (rule.official === true) {
    reasons.push(
      `Recognized as an official / known address${rule.label ? ` (${rule.label})` : ""}.`,
    );
  }
  for (const f of matched) reasons.push(FEATURE_REASONS[f]);
  if (reasons.length === 0) {
    reasons.push(
      "No risk signals found in the available data. Always double-check before sending funds.",
    );
  }

  return {
    address,
    isContract: meta.isContract,
    label: rule.label,
    official: rule.official === true,
    blacklisted: rule.blacklisted === true,
    verdict,
    riskLevel,
    matchedFeatures: matched,
    badge: badgeForVerdict(verdict, rule.official === true, rule.blacklisted === true),
    reasons,
    meta,
  };
}

// ── Stateful analyzer (injected read-only data sources) ──────────────────────────────────

/**
 * Identifier of the data source that caused a hard lookup failure. Only the risk-rule source can
 * fail hard; a missing on-chain metadata source degrades gracefully to a rule-only verdict instead.
 */
export type AddressIntelUnavailableSource = "RiskRuleSource";

/** Result of an Address_Intel run: ok with data, or a classified failure. */
export type AddressIntelOutcome =
  | { ok: true; result: AddressIntelResult }
  | { ok: false; reason: string; unavailableSource: AddressIntelUnavailableSource };

export interface AddressIntelDeps {
  chain: ChainDataSource;
  rules: RiskRuleSource;
  now?: () => Date;
}

/**
 * Address_Intel analyzer: vet an address's legitimacy and assess counterparty risk. Both methods
 * share the same underlying lookup; the difference is framing (the report layer chooses wording).
 */
export class AddressIntel {
  private readonly chain: ChainDataSource;
  private readonly rules: RiskRuleSource;
  private readonly now: () => Date;

  constructor(deps: AddressIntelDeps) {
    this.chain = deps.chain;
    this.rules = deps.rules;
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Look up the rule + metadata and analyze. Returns a classified failure if a source is down. */
  async analyze(address: Address): Promise<AddressIntelOutcome> {
    let rule: RiskRuleEntry;
    try {
      rule = await this.rules.lookup(address);
    } catch (err) {
      return {
        ok: false,
        reason: `Address vetting unavailable: risk rule source unreachable (${describeError(err)})`,
        unavailableSource: "RiskRuleSource",
      };
    }
    let meta: ContractMeta;
    try {
      meta = await this.chain.getContractMeta(address);
    } catch {
      // On-chain metadata is unavailable (e.g. no/over-rate-limited RPC). Degrade gracefully: still
      // return a rule-based verdict (blacklist / official / label) using neutral metadata, so the
      // curated list alone can flag dangerous or vouch for official addresses.
      const neutral: ContractMeta = {
        contract: address,
        verified: true,
        deployedAt: null,
        txCount: Number.MAX_SAFE_INTEGER,
        audited: true,
        isContract: true,
      };
      const degraded = analyzeAddress(address, rule, neutral, this.now());
      degraded.reasons.push(
        "On-chain metadata was unavailable; verdict is based on the curated list only.",
      );
      return { ok: true, result: degraded };
    }
    return { ok: true, result: analyzeAddress(address, rule, meta, this.now()) };
  }

  /** Vet an address's legitimacy (alias of analyze; the report frames it as "is this official?"). */
  vetAddress(address: Address): Promise<AddressIntelOutcome> {
    return this.analyze(address);
  }

  /** Assess a counterparty address's risk (alias of analyze; framed as "safe to interact?"). */
  assessCounterparty(address: Address): Promise<AddressIntelOutcome> {
    return this.analyze(address);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
