/**
 * Wallet_Activity — annotated transaction records for a personal wallet (EOA).
 *
 * Where the Transaction_Analyzer flags *abnormal* / *high-risk* transactions, this module produces
 * the wallet's recent transaction history with EACH record's counterparty annotated ("who is the
 * other side, and is it official / risky / a contract?"). It also ranks the unique counterparties
 * the wallet interacted with, which the portal uses (at the MULTI tier) to drive a deeper,
 * per-counterparty assessment.
 *
 * Security constraint (requirement 13.1): strictly read-only. It only consumes the injected
 * read-only ChainDataSource + RiskRuleSource (optionally via a RetryPolicy). No signing / send path.
 *
 * The annotation logic is expressed as a pure exported function ({@link annotateTransactions}) so it
 * can be verified deterministically without any data source.
 */

import type {
  Address,
  CounterpartyFlag,
  CounterpartySummary,
  TxRecord,
  WalletActivity,
} from "../models.js";
import type { ChainDataSource, RawTransaction, RiskRuleSource } from "../datasource/types.js";
import type { RetryPolicy } from "../datasource/retry.js";
import { selectWindowedTransactions, counterpartyOf } from "./transaction-analyzer.js";

/** Default number of annotated records surfaced for display (the rest stay in the raw window). */
export const DEFAULT_MAX_RECORDS = 50;
/** Default number of ranked counterparties surfaced. */
export const DEFAULT_MAX_COUNTERPARTIES = 25;
/** Wei per ETH (10^18). */
const WEI_PER_ETH = 10n ** 18n;

const norm = (addr: Address): string => addr.toLowerCase();

/** Parse a wei decimal string to BigInt; returns null when unparseable. */
function safeBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Format a wei decimal string as a trimmed ETH decimal string (up to 6 fractional digits). Returns
 * "0" for zero / unparseable input. Pure and dependency-free (no viem) so it stays unit-testable.
 */
export function formatWeiToEth(valueWei: string): string {
  const wei = safeBigInt(valueWei);
  if (wei === null || wei === 0n) return "0";
  const whole = wei / WEI_PER_ETH;
  const frac = wei % WEI_PER_ETH;
  if (frac === 0n) return whole.toString();
  // Build a 18-digit fractional part, then trim to 6 significant fractional digits.
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
}

/** The curated facts about a counterparty used for annotation (rule-derived). */
export interface CounterpartyFacts {
  official: boolean;
  blacklisted: boolean;
  label?: string;
}

/**
 * Annotate a windowed set of transactions with their counterparty situation. Pure given inputs.
 *
 * `factsOf` resolves the curated facts (official / blacklisted / label) for a counterparty address;
 * callers pre-resolve these from the RiskRuleSource so this function performs no I/O.
 */
export function annotateTransactions(
  txs: readonly RawTransaction[],
  factsOf: (addr: Address) => CounterpartyFacts,
  maxRecords: number = DEFAULT_MAX_RECORDS,
): TxRecord[] {
  const records: TxRecord[] = [];
  for (const tx of txs.slice(0, Math.max(0, maxRecords))) {
    const counterparty = counterpartyOf(tx);
    const isCreation = tx.to === null && tx.direction === "OUT";
    // For an outbound tx we know whether the recipient is a contract; for inbound the sender's
    // contract-ness is not provided by the list endpoint, so we conservatively report false.
    const counterpartyIsContract = tx.direction === "OUT" ? tx.toIsContract : false;
    const facts =
      counterparty !== null ? factsOf(counterparty) : { official: false, blacklisted: false };

    const flags: CounterpartyFlag[] = [];
    if (isCreation) flags.push("CREATION");
    if (facts.blacklisted) flags.push("RISKY");
    if (facts.official) flags.push("OFFICIAL");
    if (counterpartyIsContract) flags.push("CONTRACT");

    records.push({
      txHash: tx.txHash,
      timestamp: tx.timestamp,
      direction: tx.direction,
      counterparty,
      counterpartyIsContract,
      counterpartyLabel: facts.label,
      success: tx.success,
      valueEth: formatWeiToEth(tx.valueWei),
      valueUsd: tx.valueUsd,
      flags,
    });
  }
  return records;
}

/**
 * Rank the unique counterparties of a windowed transaction set by interaction count (descending),
 * keeping the first occurrence's spelling. Pure given inputs.
 */
export function rankCounterparties(
  txs: readonly RawTransaction[],
  factsOf: (addr: Address) => CounterpartyFacts,
  isContractOf: (addr: Address) => boolean,
  maxCounterparties: number = DEFAULT_MAX_COUNTERPARTIES,
): CounterpartySummary[] {
  const order: string[] = [];
  const byKey = new Map<string, { address: Address; interactions: number; isContract: boolean }>();
  for (const tx of txs) {
    const cp = counterpartyOf(tx);
    if (cp === null) continue;
    const key = norm(cp);
    const existing = byKey.get(key);
    if (existing === undefined) {
      order.push(key);
      byKey.set(key, {
        address: cp,
        interactions: 1,
        isContract: tx.direction === "OUT" ? tx.toIsContract : false,
      });
    } else {
      existing.interactions += 1;
      if (tx.direction === "OUT" && tx.toIsContract) existing.isContract = true;
    }
  }

  const summaries = order.map((key) => {
    const agg = byKey.get(key)!;
    const facts = factsOf(agg.address);
    return {
      address: agg.address,
      interactions: agg.interactions,
      isContract: agg.isContract || isContractOf(agg.address),
      label: facts.label,
      official: facts.official,
      blacklisted: facts.blacklisted,
    };
  });

  // Stable sort: most interactions first, then preserve discovery order for ties.
  return summaries
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.interactions - a.s.interactions || a.i - b.i)
    .map((x) => x.s)
    .slice(0, Math.max(0, maxCounterparties));
}

export interface WalletActivityDeps {
  chain: ChainDataSource;
  rules: RiskRuleSource;
  retry?: RetryPolicy;
  now?: () => Date;
}

export interface WalletActivityOptions {
  windowDays: number;
  maxRecords?: number;
  maxCounterparties?: number;
}

/**
 * Wallet_Activity analyzer. Fetches the wallet's transactions, windows them, and produces annotated
 * records + ranked counterparties. Never throws on data-source failure: returns an empty activity so
 * the audit degrades gracefully (the deterministic findings remain the Transaction_Analyzer's job).
 */
export class WalletActivityAnalyzer {
  private readonly chain: ChainDataSource;
  private readonly rules: RiskRuleSource;
  private readonly retry: RetryPolicy | undefined;
  private readonly now: () => Date;

  constructor(deps: WalletActivityDeps) {
    this.chain = deps.chain;
    this.rules = deps.rules;
    this.retry = deps.retry;
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Build the wallet's annotated activity for the given window. Read-only; never throws. */
  async analyze(address: Address, options: WalletActivityOptions): Promise<WalletActivity> {
    const windowDays = options.windowDays;
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    const maxCounterparties = options.maxCounterparties ?? DEFAULT_MAX_COUNTERPARTIES;

    let rawTxs: RawTransaction[];
    try {
      rawTxs = await this.fetchTransactions(address, windowDays);
    } catch {
      return { windowDays, analyzedCount: 0, records: [], counterparties: [] };
    }

    const windowed = selectWindowedTransactions(rawTxs, this.now(), windowDays);

    // Resolve curated facts for every unique counterparty once (read-only rule lookups).
    const factsCache = new Map<string, CounterpartyFacts>();
    const contractCache = new Map<string, boolean>();
    for (const tx of windowed) {
      const cp = counterpartyOf(tx);
      if (cp === null) continue;
      const key = norm(cp);
      if (!factsCache.has(key)) {
        factsCache.set(key, await this.lookupFacts(cp));
      }
      // Remember any observed contract-ness from outbound transactions.
      if (tx.direction === "OUT" && tx.toIsContract) contractCache.set(key, true);
    }

    const factsOf = (addr: Address): CounterpartyFacts =>
      factsCache.get(norm(addr)) ?? { official: false, blacklisted: false };
    const isContractOf = (addr: Address): boolean => contractCache.get(norm(addr)) === true;

    return {
      windowDays,
      analyzedCount: windowed.length,
      records: annotateTransactions(windowed, factsOf, maxRecords),
      counterparties: rankCounterparties(windowed, factsOf, isContractOf, maxCounterparties),
    };
  }

  private fetchTransactions(addr: Address, windowDays: number): Promise<RawTransaction[]> {
    const op = (): Promise<RawTransaction[]> => this.chain.getTransactions(addr, windowDays);
    return this.retry ? this.retry.run(op, "ChainDataSource.getTransactions") : op();
  }

  private async lookupFacts(addr: Address): Promise<CounterpartyFacts> {
    try {
      const entry = await this.rules.lookup(addr);
      return {
        official: entry.official === true,
        blacklisted: entry.blacklisted === true,
        label: entry.label,
      };
    } catch {
      return { official: false, blacklisted: false };
    }
  }
}
