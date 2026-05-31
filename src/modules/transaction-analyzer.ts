/**
 * Transaction_Analyzer (task 8.1 / 8.2, per the "Transaction_Analyzer" row in design.md and
 * requirements 8 and 10).
 *
 * Responsibilities:
 *  - Retrieve the most recent up-to-1,000 transactions of the audited Wallet_Address on the
 *    Audited_Chain (Ethereum) within a configurable time window (default 90 days, range 1–365).
 *  - Detect High_Risk_Contract interactions (direct counterparty and internal-call counterparty),
 *    list at most 100 newest-first, each carrying txHash / contract / UTC time / interaction type.
 *  - Detect failed and abnormal transactions (5 abnormal features), list newest-first, each
 *    carrying txHash / UTC time / reason.
 *
 * Security constraint (requirement 13.1): the module never accesses the network directly; it only
 * consumes the injected read-only ChainDataSource + RiskRuleSource (optionally via RetryPolicy).
 * There is no write-chain / send-tx path, and no private key / mnemonic is ever touched.
 *
 * The core decision logic is expressed as pure exported functions (window clamping / windowing /
 * median gas / abnormal-feature detection / address-poisoning detection) so it can be exhaustively
 * verified with property-based testing without any data source.
 */

import {
  DEFAULT_TX_WINDOW_DAYS,
  MIN_TX_WINDOW_DAYS,
  MAX_TX_WINDOW_DAYS,
} from "../config.js";
import type {
  Address,
  TxFinding,
  TxFindingReason,
  TxInteractionType,
} from "../models.js";
import type {
  ChainDataSource,
  ContractMeta,
  RawInternalTx,
  RawTransaction,
  RiskRuleSource,
} from "../datasource/types.js";
import { DataSourceUnavailable, type RetryPolicy } from "../datasource/retry.js";
import { isHighRiskContract } from "./risk-classifier.js";
import {
  validateAddress,
  type AddressValidationErrorKind,
} from "./address-validator.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Thresholds and limits ──────────────────────────────────────────

/** Maximum number of transactions retrieved within the window (requirement 8.1). */
export const MAX_RETRIEVED_TX = 1000;
/** Maximum number of high-risk interactions listed (requirement 8.4). */
export const MAX_HIGH_RISK_INTERACTIONS = 100;
/** Dust threshold: an inbound value below this many USD is treated as a dust attack (requirement 10.2 a). */
export const DUST_USD_THRESHOLD = 1;
/** A contract deployed fewer than this many days ago counts as a "new contract" (requirement 10.2 e). */
export const NEW_CONTRACT_MAX_AGE_DAYS = 7;
/** Failed-tx high-gas multiplier: gas exceeding median × this factor is flagged (requirement 10.2 d). */
export const HIGH_GAS_MULTIPLIER = 3n;

// ── User-facing result messages ────────────────────────────────────

/** No high-risk interaction within the window (requirement 8.6). */
export const NO_HIGH_RISK_INTERACTIONS_MESSAGE =
  "No high-risk contract interactions found";
/** No failed or abnormal transaction within the window (requirement 10.4). */
export const NO_FAILED_OR_ABNORMAL_TX_MESSAGE =
  "No failed or abnormal transactions found";
/** Transaction data source unavailable after retries (requirement 10.6). */
export const RETRIEVAL_FAILED_MESSAGE =
  "Transaction retrieval failed: transaction data source unavailable, please try again later";

/**
 * Fixed detection order of the 5 abnormal features (requirement 10.2 a→e), guaranteeing
 * deterministic ordering of the reasons emitted for a single transaction.
 */
export const ABNORMAL_FEATURE_ORDER: readonly TxFindingReason[] = [
  "DUST", // (a) inbound value < $1
  "ADDRESS_POISONING", // (b) zero-value look-alike address poisoning
  "RISKY_OUTFLOW", // (c) outflow to a risk-listed address
  "HIGH_GAS_FAILED", // (d) failed tx with gas > 3× median
  "NEW_CONTRACT", // (e) interaction with a contract deployed < 7 days ago
] as const;

// ── Result types (discriminated union) ─────────────────────────────

export type TxAnalysisStatus = "OK" | "INVALID_ADDRESS" | "RETRIEVAL_FAILED";

/** Successful analysis: high-risk interactions + failed/abnormal transactions + applied window. */
export interface TxAnalysisOk {
  status: "OK";
  /** Normalized (all-lowercase) audited address. */
  address: Address;
  /** Applied analysis window length in days (requirement 8.5). */
  appliedWindowDays: number;
  /** Number of transactions actually analyzed after windowing + the 1,000 cap (requirement 8.1). */
  analyzedTxCount: number;
  /** High-risk interactions, newest-first, at most 100 (requirements 8.2/8.3/8.4). */
  highRiskInteractions: TxFinding[];
  /** Failed and abnormal transactions, newest-first (requirements 10.1/10.2/10.3). */
  failedAbnormal: TxFinding[];
  /** Present (and the list empty) when no high-risk interaction is found (requirement 8.6). */
  highRiskMessage?: string;
  /** Present (and the list empty) when no failed/abnormal transaction is found (requirement 10.4). */
  failedAbnormalMessage?: string;
}

/** Invalid address: rejected, returns no transaction data (requirement 10.5). */
export interface TxAnalysisInvalidAddress {
  status: "INVALID_ADDRESS";
  /** The original input (kept for caller correlation; intentionally not normalized). */
  address: string;
  error: string;
  errorKind: AddressValidationErrorKind;
}

/** Retrieval failed: transaction data source unavailable after retries (requirement 10.6). */
export interface TxAnalysisRetrievalFailed {
  status: "RETRIEVAL_FAILED";
  /** Normalized address (the address passed validation; only data retrieval failed). */
  address: Address;
  message: string;
  /** Underlying error description (from the data source / RetryPolicy). */
  error: string;
  /** Identifier of the data source that triggered the failure. */
  unavailableSource: string;
}

export type TxAnalysisResult =
  | TxAnalysisOk
  | TxAnalysisInvalidAddress
  | TxAnalysisRetrievalFailed;

// ── Pure helpers: window clamping / windowing ──────────────────────

/**
 * Clamp / validate the analysis window to the inclusive range [1, 365] days (requirement 8.1).
 * Undefined / non-finite falls back to the default 90 days; fractional days are floored.
 */
export function clampWindowDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return DEFAULT_TX_WINDOW_DAYS;
  const floored = Math.floor(days);
  if (floored < MIN_TX_WINDOW_DAYS) return MIN_TX_WINDOW_DAYS;
  if (floored > MAX_TX_WINDOW_DAYS) return MAX_TX_WINDOW_DAYS;
  return floored;
}

/**
 * Whether a timestamp falls within the window of `windowDays` ending at `now`,
 * i.e. now − windowDays·1d ≤ t ≤ now. Unparseable or future timestamps are excluded.
 */
export function isWithinWindow(timestamp: string, now: Date, windowDays: number): boolean {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return false;
  const ageMs = now.getTime() - t;
  if (ageMs < 0) return false; // future timestamp → out of window
  return ageMs <= windowDays * MS_PER_DAY;
}

/**
 * Select the most recent up-to-`cap` items within the window, sorted newest-first.
 * Generic over any timestamped record (RawTransaction / RawInternalTx).
 */
export function selectWindowedTransactions<T extends { timestamp: string }>(
  items: readonly T[],
  now: Date,
  windowDays: number,
  cap: number = MAX_RETRIEVED_TX,
): T[] {
  const within = items.filter((it) => isWithinWindow(it.timestamp, now, windowDays));
  // Stable newest-first sort (equal timestamps keep their original relative order).
  within.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return cap >= 0 && cap < within.length ? within.slice(0, cap) : within;
}

// ── Pure helpers: median gas, address poisoning, abnormal features ──

/** Parse a wei decimal string to BigInt; returns null when unparseable. */
function safeBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Median gasFeeWei (BigInt) among the given failed transactions in the window (requirement 10.2 d).
 * Returns null when there is no failed transaction with a parseable gas fee.
 * For an even count, returns the floor of the average of the two middle values.
 */
export function medianGasFeeWei(failedTxs: readonly RawTransaction[]): bigint | null {
  const fees: bigint[] = [];
  for (const tx of failedTxs) {
    const fee = safeBigInt(tx.gasFeeWei);
    if (fee !== null) fees.push(fee);
  }
  if (fees.length === 0) return null;
  fees.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(fees.length / 2);
  if (fees.length % 2 === 1) return fees[mid];
  return (fees[mid - 1] + fees[mid]) / 2n;
}

/** Lowercased hex body of an address (the 40 hex chars after an optional "0x"). */
function hexBody(addr: Address): string {
  const lower = addr.toLowerCase();
  return lower.startsWith("0x") ? lower.slice(2) : lower;
}

/** Whether two addresses share both their first 4 and last 4 hex chars (after 0x). */
function sharesEndpoints(a: Address, b: Address): boolean {
  const ba = hexBody(a);
  const bb = hexBody(b);
  if (ba.length < 4 || bb.length < 4) return false;
  return ba.slice(0, 4) === bb.slice(0, 4) && ba.slice(-4) === bb.slice(-4);
}

/**
 * Address-poisoning detection (requirement 10.2 b): a counterparty address looks like a wallet's
 * legitimate counterparty when it shares BOTH the first 4 and last 4 hex chars with some OTHER
 * historical interaction address (a different address than the counterparty itself).
 */
export function isAddressPoisoning(
  counterparty: Address,
  historical: readonly Address[],
): boolean {
  const cNorm = counterparty.toLowerCase();
  for (const h of historical) {
    if (h.toLowerCase() === cNorm) continue; // must be a different address
    if (sharesEndpoints(counterparty, h)) return true;
  }
  return false;
}

/** The counterparty of a transaction: the sender for inbound, the recipient for outbound. */
export function counterpartyOf(tx: RawTransaction): Address | null {
  return tx.direction === "IN" ? tx.from : tx.to;
}

/** Whether a transaction is a failed (on-chain reverted / unsuccessful) transaction (requirement 10.1). */
export function isFailedTx(tx: RawTransaction): boolean {
  return tx.success === false;
}

/** Whether a value (wei decimal string) equals zero (robust to leading zeros / formatting). */
function isZeroWei(valueWei: string): boolean {
  const v = safeBigInt(valueWei);
  return v !== null && v === 0n;
}

/**
 * Whether contract metadata describes a contract deployed fewer than NEW_CONTRACT_MAX_AGE_DAYS days
 * ago (requirement 10.2 e). A null / unparseable / future deployedAt is treated as unknown → no match.
 */
export function isNewContractMeta(meta: ContractMeta, now: Date): boolean {
  if (meta.deployedAt === null) return false;
  const t = Date.parse(meta.deployedAt);
  if (Number.isNaN(t)) return false;
  const ageMs = now.getTime() - t;
  if (ageMs < 0) return false; // future deployment → unknown
  return ageMs < NEW_CONTRACT_MAX_AGE_DAYS * MS_PER_DAY;
}

/**
 * Context required to detect abnormal features of a single transaction. Provided as plain data /
 * predicates so the detection function stays pure and deterministic.
 */
export interface AbnormalDetectionContext {
  /** Median gasFeeWei among failed txs in the window; null when there is none. */
  failedGasMedianWei: bigint | null;
  /** Whether a counterparty address is risk-listed (blacklisted). */
  isRiskListed: (addr: Address) => boolean;
  /** Whether a counterparty is a contract deployed < 7 days ago. */
  isNewContract: (addr: Address) => boolean;
  /** All historical interaction addresses of the wallet (for address-poisoning comparison). */
  historicalAddresses: readonly Address[];
  /** Dust threshold in USD; defaults to DUST_USD_THRESHOLD. */
  dustUsdThreshold?: number;
}

/**
 * Detect the abnormal features matched by a single transaction (requirement 10.2), returned in the
 * fixed order a→e. Does NOT include FAILED (see detectTxReasons); HIGH_GAS_FAILED is included only
 * for failed transactions.
 */
export function detectAbnormalFeatures(
  tx: RawTransaction,
  ctx: AbnormalDetectionContext,
): TxFindingReason[] {
  const reasons: TxFindingReason[] = [];
  const dustThreshold = ctx.dustUsdThreshold ?? DUST_USD_THRESHOLD;

  // (a) DUST: inbound value below the dust threshold; null valueUsd is treated as not-dust.
  if (tx.direction === "IN" && tx.valueUsd !== null && tx.valueUsd < dustThreshold) {
    reasons.push("DUST");
  }

  // (b) ADDRESS_POISONING: zero-value transfer (in or out) whose counterparty looks like a
  //     different historical interaction address (first4 + last4 both match).
  const counterparty = counterpartyOf(tx);
  if (
    isZeroWei(tx.valueWei) &&
    counterparty !== null &&
    isAddressPoisoning(counterparty, ctx.historicalAddresses)
  ) {
    reasons.push("ADDRESS_POISONING");
  }

  // (c) RISKY_OUTFLOW: an outbound transaction to a risk-listed address.
  if (tx.direction === "OUT" && tx.to !== null && ctx.isRiskListed(tx.to)) {
    reasons.push("RISKY_OUTFLOW");
  }

  // (d) HIGH_GAS_FAILED: a failed transaction whose gas exceeds 3× the failed-tx gas median.
  if (isFailedTx(tx) && ctx.failedGasMedianWei !== null) {
    const fee = safeBigInt(tx.gasFeeWei);
    if (fee !== null && fee > HIGH_GAS_MULTIPLIER * ctx.failedGasMedianWei) {
      reasons.push("HIGH_GAS_FAILED");
    }
  }

  // (e) NEW_CONTRACT: interaction with a contract deployed < 7 days ago (the recipient contract).
  if (tx.to !== null && ctx.isNewContract(tx.to)) {
    reasons.push("NEW_CONTRACT");
  }

  return reasons;
}

/**
 * Detect all reasons a transaction should be listed: FAILED (if reverted) followed by the abnormal
 * features in fixed order (requirements 10.1 / 10.2). An empty result means the transaction is
 * neither failed nor abnormal.
 */
export function detectTxReasons(
  tx: RawTransaction,
  ctx: AbnormalDetectionContext,
): TxFindingReason[] {
  const reasons: TxFindingReason[] = [];
  if (isFailedTx(tx)) reasons.push("FAILED");
  reasons.push(...detectAbnormalFeatures(tx, ctx));
  return reasons;
}

// ── Internal utilities ─────────────────────────────────────────────

const norm = (addr: Address): string => addr.toLowerCase();

/** Normalize a timestamp to a UTC ISO-8601 string (requirements 8.4 / 10.3). */
function toUtcIso(timestamp: string): string {
  return new Date(Date.parse(timestamp)).toISOString();
}

/** Deduplicate addresses (case-insensitive), keeping the first occurrence's original spelling. */
function uniqueAddresses(addrs: readonly Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of addrs) {
    const k = norm(a);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(a);
    }
  }
  return out;
}

/** Stable newest-first sort of findings by their UTC timestamp. */
function sortFindingsNewestFirst(findings: TxFinding[]): TxFinding[] {
  return findings
    .map((f, i) => ({ f, i, t: Date.parse(f.timestamp) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.f);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Analyzer ───────────────────────────────────────────────────────

export interface TransactionAnalyzerDeps {
  /** Provides getTransactions / getInternalTxs / getContractMeta (read-only). */
  chain: ChainDataSource;
  /** Provides lookup (blacklist / High_Risk_Contract). */
  rules: RiskRuleSource;
  /** Optional unified retry/timeout policy (requirements 18.1/18.2). */
  retry?: RetryPolicy;
  /** Injected "current time" for determinism; defaults to () => new Date(). */
  now?: () => Date;
}

/** Per-call analysis options. */
export interface AnalyzeOptions {
  /** Analysis window in days; clamped to [1, 365], defaults to 90 (requirement 8.1). */
  windowDays?: number;
  /** Dust threshold in USD; defaults to DUST_USD_THRESHOLD (requirement 10.2 a). */
  dustUsdThreshold?: number;
}

/**
 * Transaction_Analyzer component. Pure-logic over injected read-only data sources: identical inputs
 * (same data, same injected now) always produce identical results.
 */
export class TransactionAnalyzer {
  private readonly chain: ChainDataSource;
  private readonly rules: RiskRuleSource;
  private readonly retry: RetryPolicy | undefined;
  private readonly now: () => Date;

  constructor(deps: TransactionAnalyzerDeps) {
    this.chain = deps.chain;
    this.rules = deps.rules;
    this.retry = deps.retry;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Analyze a wallet's transactions for high-risk interactions and failed/abnormal transactions.
   * Returns one of three cases: OK / INVALID_ADDRESS / RETRIEVAL_FAILED.
   */
  async analyze(address: string, options: AnalyzeOptions = {}): Promise<TxAnalysisResult> {
    // Requirement 10.5: reject an invalid address format and return no transaction data.
    const validation = validateAddress(address);
    if (!validation.valid || validation.normalized === undefined) {
      return {
        status: "INVALID_ADDRESS",
        address,
        error: validation.error ?? "Invalid wallet address",
        errorKind: validation.errorKind ?? "INVALID_FORMAT",
      };
    }

    const addr = validation.normalized;
    const now = this.now();
    const windowDays = clampWindowDays(options.windowDays);

    try {
      // Retrieve transactions and internal calls (requirement 8.1) through the retry policy.
      const rawTxs = await this.fetchTransactions(addr, windowDays);
      const rawInternal = await this.fetchInternalTxs(addr, windowDays);

      // Window + newest-first + the 1,000 cap.
      const windowedTxs = selectWindowedTransactions(rawTxs, now, windowDays, MAX_RETRIEVED_TX);
      const windowedInternal = selectWindowedTransactions(
        rawInternal,
        now,
        windowDays,
        MAX_RETRIEVED_TX,
      );

      // Resolve blacklist (High_Risk_Contract) status for every counterparty / internal target.
      const blacklistAddrs = uniqueAddresses([
        ...windowedTxs.filter((t) => t.to !== null).map((t) => t.to as Address),
        ...windowedInternal.filter((i) => i.to !== null).map((i) => i.to as Address),
      ]);
      const blacklistedMap = new Map<string, boolean>();
      for (const a of blacklistAddrs) {
        const entry = await this.lookupRule(a);
        blacklistedMap.set(norm(a), isHighRiskContract(entry));
      }

      // Resolve "new contract" status for recipient contracts (requirement 10.2 e).
      const contractAddrs = uniqueAddresses(
        windowedTxs.filter((t) => t.to !== null && t.toIsContract).map((t) => t.to as Address),
      );
      const newContractMap = new Map<string, boolean>();
      for (const a of contractAddrs) {
        const meta = await this.fetchContractMeta(a);
        newContractMap.set(norm(a), isNewContractMeta(meta, now));
      }

      const highRiskInteractions = this.buildHighRiskInteractions(
        windowedTxs,
        windowedInternal,
        blacklistedMap,
      );
      const failedAbnormal = this.buildFailedAbnormal(
        windowedTxs,
        windowedInternal,
        blacklistedMap,
        newContractMap,
        options.dustUsdThreshold,
      );

      const result: TxAnalysisOk = {
        status: "OK",
        address: addr,
        appliedWindowDays: windowDays,
        analyzedTxCount: windowedTxs.length,
        highRiskInteractions,
        failedAbnormal,
      };
      // Requirement 8.6 / 10.4: explicit "none found" messages.
      if (highRiskInteractions.length === 0) {
        result.highRiskMessage = NO_HIGH_RISK_INTERACTIONS_MESSAGE;
      }
      if (failedAbnormal.length === 0) {
        result.failedAbnormalMessage = NO_FAILED_OR_ABNORMAL_TX_MESSAGE;
      }
      return result;
    } catch (err) {
      // Requirement 10.6: transaction data source unavailable after retries → retrieval-failed.
      const unavailableSource =
        err instanceof DataSourceUnavailable ? err.sourceName : "ChainDataSource";
      return {
        status: "RETRIEVAL_FAILED",
        address: addr,
        message: RETRIEVAL_FAILED_MESSAGE,
        error: describeError(err),
        unavailableSource,
      };
    }
  }

  /**
   * Build the high-risk interaction list (requirements 8.2/8.3/8.4): direct counterparties and
   * internal-call counterparties that hit a High_Risk_Contract, newest-first, at most 100.
   */
  private buildHighRiskInteractions(
    txs: readonly RawTransaction[],
    internalTxs: readonly RawInternalTx[],
    blacklistedMap: ReadonlyMap<string, boolean>,
  ): TxFinding[] {
    const findings: TxFinding[] = [];

    for (const tx of txs) {
      if (tx.to !== null && blacklistedMap.get(norm(tx.to)) === true) {
        findings.push(this.highRiskFinding(tx.txHash, tx.timestamp, tx.to, "DIRECT"));
      }
    }
    for (const itx of internalTxs) {
      if (itx.to !== null && blacklistedMap.get(norm(itx.to)) === true) {
        findings.push(this.highRiskFinding(itx.txHash, itx.timestamp, itx.to, "INTERNAL"));
      }
    }

    return sortFindingsNewestFirst(findings).slice(0, MAX_HIGH_RISK_INTERACTIONS);
  }

  private highRiskFinding(
    txHash: string,
    timestamp: string,
    contract: Address,
    interactionType: TxInteractionType,
  ): TxFinding {
    return {
      txHash,
      timestamp: toUtcIso(timestamp),
      reason: "HIGH_RISK_INTERACTION",
      interactionType,
      contract,
    };
  }

  /**
   * Build the failed/abnormal transaction list (requirements 10.1/10.2/10.3): one finding per matched
   * reason, newest-first.
   */
  private buildFailedAbnormal(
    txs: readonly RawTransaction[],
    internalTxs: readonly RawInternalTx[],
    blacklistedMap: ReadonlyMap<string, boolean>,
    newContractMap: ReadonlyMap<string, boolean>,
    dustUsdThreshold: number | undefined,
  ): TxFinding[] {
    const failedTxs = txs.filter(isFailedTx);
    const ctx: AbnormalDetectionContext = {
      failedGasMedianWei: medianGasFeeWei(failedTxs),
      isRiskListed: (a) => blacklistedMap.get(norm(a)) === true,
      isNewContract: (a) => newContractMap.get(norm(a)) === true,
      historicalAddresses: collectHistoricalAddresses(txs, internalTxs),
      dustUsdThreshold,
    };

    const findings: TxFinding[] = [];
    for (const tx of txs) {
      for (const reason of detectTxReasons(tx, ctx)) {
        findings.push({ txHash: tx.txHash, timestamp: toUtcIso(tx.timestamp), reason });
      }
    }
    return sortFindingsNewestFirst(findings);
  }

  // ── Data source access (through the retry policy when injected) ──

  private fetchTransactions(addr: Address, windowDays: number): Promise<RawTransaction[]> {
    const op = (): Promise<RawTransaction[]> => this.chain.getTransactions(addr, windowDays);
    return this.retry ? this.retry.run(op, "ChainDataSource.getTransactions") : op();
  }

  private fetchInternalTxs(addr: Address, windowDays: number): Promise<RawInternalTx[]> {
    const op = (): Promise<RawInternalTx[]> => this.chain.getInternalTxs(addr, windowDays);
    return this.retry ? this.retry.run(op, "ChainDataSource.getInternalTxs") : op();
  }

  private fetchContractMeta(contract: Address): Promise<ContractMeta> {
    const op = (): Promise<ContractMeta> => this.chain.getContractMeta(contract);
    return this.retry ? this.retry.run(op, "ChainDataSource.getContractMeta") : op();
  }

  private lookupRule(contract: Address): ReturnType<RiskRuleSource["lookup"]> {
    const op = (): ReturnType<RiskRuleSource["lookup"]> => this.rules.lookup(contract);
    return this.retry ? this.retry.run(op, "RiskRuleSource.lookup") : op();
  }
}

/**
 * Collect all historical interaction addresses of the wallet (counterparties of external txs +
 * internal-call targets), used as the comparison set for address-poisoning detection.
 */
function collectHistoricalAddresses(
  txs: readonly RawTransaction[],
  internalTxs: readonly RawInternalTx[],
): Address[] {
  const out: Address[] = [];
  for (const tx of txs) {
    const cp = counterpartyOf(tx);
    if (cp !== null) out.push(cp);
  }
  for (const itx of internalTxs) {
    if (itx.to !== null) out.push(itx.to);
  }
  return out;
}
