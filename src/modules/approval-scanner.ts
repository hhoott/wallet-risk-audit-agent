/**
 * Approval_Scanner (approval scanning, pure logic) — Task 5, per the "Approval_Scanner" section of design.md and requirement 6.
 *
 * Responsibility: scan all approval records of a given Wallet_Address on the audited chain (Ethereum mainnet)
 * through an injected ChainDataSource (ERC-20 allowance, ERC-721 / ERC-1155 setApprovalForAll, Permit2),
 * determine unlimited approvals, and produce a structured ApprovalRecord[].
 *
 * Security constraint (requirement 13.1): this module only consumes the read-only results of the injected data source.
 * It never issues network requests itself, never touches private keys / mnemonics, and has no write path by design.
 *
 * Robustness (requirement 6.6): when the data source is unavailable / times out, it returns a failure result and does
 * **not** overwrite the cached data of that address's last successful scan; the failure result carries the last
 * successful cache (if any) so the caller can degrade gracefully.
 */

import type { Address, ApprovalRecord } from "../models.js";
import type { ChainDataSource, RawApproval } from "../datasource/types.js";
import type { RetryPolicy } from "../datasource/retry.js";

// ── Unlimited approval threshold ───────────────────────────────────

/** Unlimited approval threshold: half of the uint256 maximum = 2^255 (requirement 6.2). */
export const UNLIMITED_ERC20_THRESHOLD = 2n ** 255n;

/** Placeholder used when there is no label (requirement 6.4). */
export const UNKNOWN_LABEL = "Unknown";

/** Message shown when there are no approval records (requirement 6.5). */
export const NO_APPROVALS_MESSAGE = "No approval records";

/** Message shown when the approval scan fails (requirement 6.6). */
export const SCAN_FAILED_MESSAGE = "Approval scan failed: approval data source unavailable";

// ── Return types (discriminated union of three cases) ──────────────

/** Scan result status: normal / no approval records / scan failed. */
export type ApprovalScanStatus = "OK" | "EMPTY" | "FAILED";

/** Normal result: contains one or more approval records (requirements 6.1–6.4). */
export interface ApprovalScanOk {
  status: "OK";
  address: Address;
  approvals: ApprovalRecord[];
}

/** No approval records: the data source returned empty (requirement 6.5). */
export interface ApprovalScanEmpty {
  status: "EMPTY";
  address: Address;
  /** Always an empty array, so callers can handle it uniformly. */
  approvals: [];
  message: string;
}

/**
 * Scan failed: data source unavailable / timed out (requirement 6.6).
 *
 * The data from this address's last successful scan is retained in the internal cache and is not overwritten
 * by this failure, and is returned through the `cached` field (null if it has never succeeded).
 */
export interface ApprovalScanFailed {
  status: "FAILED";
  address: Address;
  message: string;
  /** Underlying error description (from the data source / RetryPolicy). */
  error: string;
  /** Approval data from the last successful scan; null if it has never succeeded. */
  cached: ApprovalRecord[] | null;
}

/** Approval scan result (discriminated union, judge by `status`). */
export type ApprovalScanResult = ApprovalScanOk | ApprovalScanEmpty | ApprovalScanFailed;

// ── Pure determination / mapping functions ────────────────────────

/**
 * Unlimited approval determination (requirements 6.2 / 6.3):
 *  - ERC-721 / ERC-1155 setApprovalForAll == true (RawApproval.operatorApproved === true) → unlimited;
 *  - otherwise compare by allowance: an ERC-20 / Permit2 decimal allowance string ≥ 2^255 → unlimited.
 *
 * allowance is a uint256 decimal string; BigInt is used for exact comparison to avoid precision loss.
 * Invalid / unparseable allowances are treated as not unlimited.
 */
export function isUnlimitedApproval(raw: RawApproval): boolean {
  if (raw.operatorApproved === true) return true;
  try {
    return BigInt(raw.allowance) >= UNLIMITED_ERC20_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Map a raw approval into a structured ApprovalRecord (requirement 6.4).
 * Falls back to "Unknown" when there is no readable label (missing / blank).
 */
export function toApprovalRecord(raw: RawApproval): ApprovalRecord {
  const label =
    raw.spenderLabel !== undefined && raw.spenderLabel.trim() !== ""
      ? raw.spenderLabel
      : UNKNOWN_LABEL;
  return {
    tokenContract: raw.tokenContract,
    spender: raw.spender,
    spenderLabel: label,
    kind: raw.kind,
    allowance: raw.allowance,
    isUnlimited: isUnlimitedApproval(raw),
    lastUpdated: raw.lastUpdated,
  };
}

// ── Scanner ────────────────────────────────────────────────────────

const cacheKey = (addr: Address): string => addr.toLowerCase();

/**
 * Approval scanner.
 *
 * Data is obtained through the ChainDataSource injected via the constructor (this module does not issue network
 * requests directly). A RetryPolicy can be optionally injected to handle timeouts / retries uniformly; when not
 * injected, a direct try/catch is used.
 *
 * Maintains a per-address cache internally: it updates the cache on a successful scan, and on failure it does not
 * overwrite the cache and returns the previous cache instead.
 */
export class ApprovalScanner {
  private readonly dataSource: ChainDataSource;
  private readonly retry: RetryPolicy | undefined;
  /** key = lowercase address; value = approval records from the last successful scan. */
  private readonly cache = new Map<string, ApprovalRecord[]>();

  constructor(dataSource: ChainDataSource, retry?: RetryPolicy) {
    this.dataSource = dataSource;
    this.retry = retry;
  }

  /** Return the cached data from this address's last successful scan; null if it has never succeeded. */
  getCached(addr: Address): ApprovalRecord[] | null {
    return this.cache.get(cacheKey(addr)) ?? null;
  }

  /**
   * Scan the approval records of the given address.
   * Returns one of three cases: OK (has approvals) / EMPTY (no approval records) / FAILED (data source unavailable).
   */
  async scan(addr: Address): Promise<ApprovalScanResult> {
    let raws: RawApproval[];
    try {
      raws = await this.fetch(addr);
    } catch (err) {
      // Requirement 6.6: on failure, keep the last successful cache from being overwritten and return it (if any).
      return {
        status: "FAILED",
        address: addr,
        message: SCAN_FAILED_MESSAGE,
        error: err instanceof Error ? err.message : String(err),
        cached: this.getCached(addr),
      };
    }

    const approvals = raws.map(toApprovalRecord);
    // Success → update the cache.
    this.cache.set(cacheKey(addr), approvals);

    if (approvals.length === 0) {
      return {
        status: "EMPTY",
        address: addr,
        approvals: [],
        message: NO_APPROVALS_MESSAGE,
      };
    }
    return { status: "OK", address: addr, approvals };
  }

  /** Call the data source through the RetryPolicy (if injected); otherwise call directly. */
  private fetch(addr: Address): Promise<RawApproval[]> {
    const op = (): Promise<RawApproval[]> => this.dataSource.getApprovals(addr);
    return this.retry ? this.retry.run(op, "ChainDataSource.getApprovals") : op();
  }
}
