/**
 * Address_Inspector — type-aware address inspection (task 3, "smart routing").
 *
 * Step 1: detect the on-chain TYPE of the submitted address (EOA / ERC20 / ERC721 / ERC1155 /
 *         CONTRACT) using the read-only ChainDataSource.
 * Step 2: gather TYPE-SPECIFIC facts:
 *           - EOA      → defer to the full wallet audit (handled by the orchestrator).
 *           - ERC20    → token security signals (owner, mintable, pausable, blacklist) + rule/meta.
 *           - ERC721/1155 → collection legitimacy (official label, verified, age) + meta.
 *           - CONTRACT → protocol meta + curated label + rule.
 * Step 3: the caller routes those facts to a TYPE-SPECIFIC LLM skill (analyzeByType) for a focused
 *         assessment.
 *
 * This module produces the deterministic, structured facts; the LLM layer is added on top by the
 * portal auditor. Strictly read-only.
 */

import type { Address, AddressType } from "../models.js";
import { analyzeAddress, badgeForVerdict, type AddressIntelResult } from "./address-intel.js";
import type {
  ChainDataSource,
  ContractMeta,
  RiskRuleEntry,
  RiskRuleSource,
  TokenContractInfo,
} from "../datasource/types.js"; /** The structured, type-aware inspection result (deterministic; pre-LLM). */
export interface AddressInspection {
  address: Address;
  /** Detected on-chain type. */
  type: AddressType;
  /** Base legitimacy / risk verdict (always present, reuses Address_Intel). */
  intel: AddressIntelResult;
  /** Token security signals — present only for ERC-20 token contracts. */
  token?: TokenContractInfo;
  /**
   * The fact bundle handed to the type-specific LLM skill. Shape varies by type but is always a
   * plain JSON object the model can read.
   */
  facts: Record<string, unknown>;
}

/** Neutral metadata used when on-chain metadata is unavailable (degrade gracefully). */
function neutralMeta(address: Address): ContractMeta {
  return {
    contract: address,
    verified: true,
    deployedAt: null,
    txCount: Number.MAX_SAFE_INTEGER,
    audited: true,
    isContract: true,
  };
}

/**
 * Re-derive a wallet-appropriate verdict for an EOA. The base Address_Intel analysis grades an
 * address like a contract (verified source / audit / age / tx-count), which is meaningless for a
 * personal wallet and would mislabel ordinary wallets as "dangerous". For an EOA only two signals
 * matter: a blacklist hit (→ DANGEROUS) or an official/known standing (→ OFFICIAL); otherwise it is
 * simply an unlabeled wallet (LIKELY_SAFE) — always with the reminder to double-check before sending.
 */
function eoaVerdict(base: AddressIntelResult, rule: RiskRuleEntry): AddressIntelResult {
  if (rule.blacklisted === true) {
    return {
      ...base,
      verdict: "DANGEROUS",
      riskLevel: "CRITICAL",
      matchedFeatures: base.matchedFeatures.includes("BLACKLISTED") ? ["BLACKLISTED"] : [],
      badge: badgeForVerdict("DANGEROUS", false, true),
      reasons: ["Address matches a community blacklist (phishing / drainer / scam)."],
    };
  }
  if (rule.official === true) {
    return {
      ...base,
      verdict: "OFFICIAL",
      riskLevel: "LOW",
      matchedFeatures: [],
      badge: badgeForVerdict("OFFICIAL", true, false),
      reasons: [`Recognized as an official / known wallet${base.label ? ` (${base.label})` : ""}.`],
    };
  }
  return {
    ...base,
    verdict: "LIKELY_SAFE",
    riskLevel: "LOW",
    matchedFeatures: [],
    badge: badgeForVerdict("LIKELY_SAFE", false, false),
    reasons: [
      "Externally-owned wallet (EOA). No blacklist or official-list match. Always double-check the address before sending funds.",
    ],
  };
}

export interface AddressInspectorDeps {
  chain: ChainDataSource;
  rules: RiskRuleSource;
  now?: () => Date;
}

/**
 * Inspects an address: detects its type and assembles type-specific facts. The EOA case is left to
 * the wallet audit (the orchestrator runs the full audit and only uses this for non-EOA targets, or
 * to label an EOA), so here EOA simply yields the base intel + type.
 */
export class AddressInspector {
  private readonly chain: ChainDataSource;
  private readonly rules: RiskRuleSource;
  private readonly now: () => Date;

  constructor(deps: AddressInspectorDeps) {
    this.chain = deps.chain;
    this.rules = deps.rules;
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Detect type + gather type-specific facts. Never throws; degrades to UNKNOWN/neutral on errors. */
  async inspect(address: Address): Promise<AddressInspection> {
    const type = await this.detectType(address);
    const rule = await this.safeLookup(address);
    const meta = await this.safeMeta(address);
    const baseIntel = analyzeAddress(address, rule, meta, this.now());
    // For an EOA (a personal wallet), the contract-quality suspicious features (unverified source,
    // no audit, low tx count) do not apply — only blacklist / official standing is meaningful. So
    // recompute a wallet-appropriate verdict instead of grading a wallet like a risky contract.
    const intel = type === "EOA" ? eoaVerdict(baseIntel, rule) : baseIntel;

    const facts: Record<string, unknown> = {
      address,
      type,
      verdict: intel.verdict,
      official: intel.official,
      blacklisted: intel.blacklisted,
      label: intel.label,
      verified: meta.verified,
      deployedAt: meta.deployedAt,
      txCount: meta.txCount === Number.MAX_SAFE_INTEGER ? null : meta.txCount,
      matchedFeatures: intel.matchedFeatures,
    };

    const inspection: AddressInspection = { address, type, intel, facts };

    // Token-specific enrichment.
    if (type === "ERC20" && typeof this.chain.getTokenContractInfo === "function") {
      try {
        const token = await this.chain.getTokenContractInfo(address);
        inspection.token = token;
        facts.token = token;
      } catch {
        /* token info unavailable; keep base facts */
      }
    }

    return inspection;
  }

  /** Detect the address type, degrading to UNKNOWN when the data source lacks the capability. */
  private async detectType(address: Address): Promise<AddressType> {
    if (typeof this.chain.detectAddressType !== "function") return "UNKNOWN";
    try {
      return await this.chain.detectAddressType(address);
    } catch {
      return "UNKNOWN";
    }
  }

  private async safeLookup(address: Address): Promise<RiskRuleEntry> {
    try {
      return await this.rules.lookup(address);
    } catch {
      return { contract: address, blacklisted: false };
    }
  }

  private async safeMeta(address: Address): Promise<ContractMeta> {
    try {
      return await this.chain.getContractMeta(address);
    } catch {
      return neutralMeta(address);
    }
  }
}
