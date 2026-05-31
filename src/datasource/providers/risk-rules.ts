/**
 * Real RiskRuleSource Provider — a static, in-repo risk rule library (READ-ONLY).
 *
 * Implements {@link RiskRuleSource}: looks up an address against a curated set of
 *  - blacklisted addresses (known phishing / drainer / scam contracts), and
 *  - labeled addresses (well-known routers / protocols), used to attach a human-readable label.
 *
 * The backing list is INJECTABLE (constructor argument), so this static seed can be swapped for a
 * live community feed (e.g. a hosted blocklist, Chainabuse, ScamSniffer, or an on-chain registry)
 * without touching call sites. The seed below is intentionally small and meant to be EXTENDED — it
 * is a starting point, not an exhaustive list.
 *
 * Security constraint (requirement 13.1): pure read-only lookups; no network, no write path.
 */

import type { Address } from "../../models.js";
import type { RiskRuleEntry, RiskRuleSource } from "../types.js";

/** One entry in the backing risk list (the contract key is matched case-insensitively). */
export interface RiskListEntry {
  /** Address key (any casing; normalized on load). */
  address: Address;
  /** Whether the address is blacklisted (phishing / drainer / scam). */
  blacklisted: boolean;
  /** Optional human-readable label (e.g. "Uniswap V3 Router", "Fake Phishing"). */
  label?: string;
}

/**
 * Curated seed list. Two kinds of entries:
 *  - blacklisted: true  → known-malicious addresses (drainer / phishing). EXTEND with a live feed.
 *  - blacklisted: false → well-known labels, so the report can name a spender instead of "Unknown".
 *
 * NOTE: the blacklisted entries here are illustrative placeholders curated from public phishing
 * tags. For production this should be replaced/augmented by a maintained community blocklist
 * (injectable via the constructor). The labeled (non-blacklisted) router entries are stable,
 * well-known mainnet contract addresses.
 */
export const DEFAULT_RISK_LIST: readonly RiskListEntry[] = [
  // ── Well-known, non-malicious labels (help the Approval_Scanner render a readable spender) ──
  {
    address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    blacklisted: false,
    label: "Uniswap V2 Router",
  },
  {
    address: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    blacklisted: false,
    label: "Uniswap V3 Router",
  },
  {
    address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    blacklisted: false,
    label: "Uniswap V3 Router 2",
  },
  {
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    blacklisted: false,
    label: "Permit2",
  },
  {
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    blacklisted: false,
    label: "1inch Aggregation Router V5",
  },
  {
    address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
    blacklisted: false,
    label: "0x Exchange Proxy",
  },

  // ── Known-malicious examples (drainer / phishing). EXTEND via an injected live feed. ──
  // Etherscan public "Fake_Phishing" tagged example addresses (illustrative seed).
  {
    address: "0x0000000000000000000000000000000000001337",
    blacklisted: true,
    label: "Test Drainer (seed placeholder)",
  },
];

/** Normalization key for an address (lowercased). */
const norm = (addr: string): string => addr.toLowerCase();

/**
 * Build the lookup map from a risk list, keyed by lowercased address. Later entries override
 * earlier ones for the same address (so an injected feed can extend / correct the seed).
 */
export function buildRiskIndex(
  entries: readonly RiskListEntry[],
): Map<string, RiskRuleEntry> {
  const index = new Map<string, RiskRuleEntry>();
  for (const e of entries) {
    const key = norm(e.address);
    const entry: RiskRuleEntry = {
      contract: e.address,
      blacklisted: e.blacklisted,
    };
    if (e.label !== undefined) entry.label = e.label;
    index.set(key, entry);
  }
  return index;
}

/**
 * Pure lookup against a prebuilt index. Returns the indexed entry (with the *queried* contract
 * address preserved for caller correlation), or a clean "not found" entry (blacklisted: false).
 */
export function lookupInIndex(
  index: ReadonlyMap<string, RiskRuleEntry>,
  contract: Address,
): RiskRuleEntry {
  const hit = index.get(norm(contract));
  if (hit === undefined) return { contract, blacklisted: false };
  const result: RiskRuleEntry = { contract, blacklisted: hit.blacklisted };
  if (hit.label !== undefined) result.label = hit.label;
  return result;
}

/** Options for {@link StaticRiskRuleSource}. */
export interface StaticRiskRuleSourceOptions {
  /** Backing risk list. Defaults to {@link DEFAULT_RISK_LIST}; inject a live feed to replace it. */
  entries?: readonly RiskListEntry[];
}

/**
 * Static, in-repo RiskRuleSource. Backed by an injectable list so it can later be swapped for a
 * live blacklist feed without changing the consumers (Risk_Classifier / Transaction_Analyzer).
 */
export class StaticRiskRuleSource implements RiskRuleSource {
  private readonly index: Map<string, RiskRuleEntry>;

  constructor(options: StaticRiskRuleSourceOptions = {}) {
    this.index = buildRiskIndex(options.entries ?? DEFAULT_RISK_LIST);
  }

  /** Look up a contract; case-insensitive. Never throws (a clean "not found" is returned). */
  async lookup(contract: Address): Promise<RiskRuleEntry> {
    return lookupInIndex(this.index, contract);
  }
}
