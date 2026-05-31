/**
 * Address_Validator — wallet address validation (pure logic, no network/IO).
 *
 * Aligns with Requirement 1 (wallet address input and validation) and 17.2
 * (non-Ethereum network detection), as well as the design.md
 * "Components and Interfaces — Address_Validator" section:
 *  - Format: `^0x[0-9a-fA-F]{40}$` (case-insensitive; all-lowercase / all-uppercase /
 *    EIP-55 checksum forms are all valid).
 *  - Empty / whitespace-only / missing → reject, indicating "address must not be empty"
 *    (distinct from a general format error).
 *  - Invalid format (length ≠ 42, missing 0x, contains non-hex, ENS domain, etc.) → reject
 *    and indicate the specific reason; no pending-analysis record is created.
 *  - Passes validation → marked as a pending-analysis address, outputting a normalized
 *    (all-lowercase) address.
 *  - Batch: validate each address independently, deduplicate repeated addresses (keep one,
 *    validate only once), reject the entire request when a single batch exceeds 50.
 *  - Network: when the caller explicitly declares a non-Ethereum mainnet → return
 *    "this network is not supported yet".
 *
 * This module is purely functional: identical inputs always produce identical outputs,
 * which makes it convenient to verify with property-based testing.
 */

import { AUDITED_CHAIN, MAX_ADDRESSES_PER_REQUEST } from "../config.js";
import type { Address } from "../models.js";

/** Error category for a single-address validation failure (helps callers distinguish programmatically between empty and general format errors). */
export type AddressValidationErrorKind =
  | "EMPTY" // empty string / whitespace-only / missing (requirement 1.3)
  | "INVALID_FORMAT" // length ≠ 42 / missing 0x / contains non-hex / ENS, etc. (requirement 1.2)
  | "UNSUPPORTED_NETWORK"; // caller declared a non-Ethereum mainnet (requirement 17.2)

/** Error category for when the entire batch request is rejected (request-level, not single-address-level). */
export type BatchRejectKind = "TOO_MANY_ADDRESSES"; // a single batch exceeds 50 (requirement 1.6)

/** Single-address validation options. */
export interface ValidateOptions {
  /**
   * The network the caller explicitly declares the address(es) belong to.
   * Note: EVM addresses share the same form across chains, so this only handles the case
   * where the caller "explicitly declares a network" — when declared as a non-Ethereum
   * mainnet, return "this network is not supported yet" (requirement 17.2).
   * Omitted / blank is treated as undeclared and handled as the audited chain (Ethereum mainnet).
   */
  network?: string;
}

/** Single-address validation result. */
export interface AddressValidationResult {
  /** The original input (kept so the caller can correlate). */
  input: string;
  /** Whether it passes format (and network) validation. */
  valid: boolean;
  /**
   * Whether it was marked as a pending-analysis address (requirement 1.4).
   * true when validation passes; false otherwise — reflecting "no pending-analysis record
   * is created" (requirements 1.2/1.3).
   */
  pendingAnalysis: boolean;
  /** Normalized address (all-lowercase); present only when valid is true. */
  normalized?: Address;
  /** Human-readable failure reason; present only when valid is false. */
  error?: string;
  /** Machine-readable failure category; present only when valid is false. */
  errorKind?: AddressValidationErrorKind;
}

/** Batch validation result. */
export interface BatchValidationResult {
  /** Whether the entire request was rejected (e.g., exceeding the per-batch limit). */
  rejected: boolean;
  /** Reason the request was rejected (present only when rejected is true). */
  error?: string;
  /** Category of the request rejection (present only when rejected is true). */
  errorKind?: BatchRejectKind;
  /** Per-address validation results after deduplication (in order of first appearance; empty when rejected). */
  results: AddressValidationResult[];
  /** Validated, pending-analysis normalized addresses (deduplicated, mutually distinct, all-lowercase). */
  pendingAddresses: Address[];
}

/** Valid address format: `0x` + exactly 40 hexadecimal characters, total length 42. */
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/**
 * The set of acceptable aliases for the supported network (= the audited chain, Ethereum mainnet).
 * Compared after trimming whitespace and lowercasing; kept in sync with the AUDITED_CHAIN constant.
 */
const ETHEREUM_NETWORK_ALIASES: ReadonlySet<string> = new Set([
  AUDITED_CHAIN.toLowerCase(), // "ethereum mainnet"
  "ethereum",
  "eth",
  "mainnet",
  "ethereum-mainnet",
  "ethereum_mainnet",
  "homestead", // viem / ethers internal network name
  "1", // chainId
  "eip155:1", // CAIP-2
]);

/**
 * Determine whether the network declared by the caller is the supported audited chain (Ethereum mainnet).
 * Undeclared (undefined / blank) is treated as the default audited chain and returns true.
 */
export function isSupportedNetwork(network: string | undefined | null): boolean {
  if (network === undefined || network === null) return true;
  const key = network.trim().toLowerCase();
  if (key === "") return true;
  return ETHEREUM_NETWORK_ALIASES.has(key);
}

/** Produce a specific format-error description (requirement 1.2: indicate the specific reason). */
function describeFormatError(value: string): string {
  const hasHexPrefix = value.slice(0, 2).toLowerCase() === "0x";
  if (!hasHexPrefix) {
    if (value.includes(".")) {
      return `ENS domains or non-hexadecimal addresses are not supported (“${value}”); please provide an address starting with "0x" followed by exactly 40 hexadecimal characters, for a total length of 42.`;
    }
    return `The address is missing the "0x" prefix; please provide an address starting with "0x" followed by exactly 40 hexadecimal characters, for a total length of 42.`;
  }
  if (value.length !== 42) {
    return `The address length should be 42 characters ("0x" + 40 hexadecimal characters), but it is ${value.length} characters.`;
  }
  return `The address contains non-hexadecimal characters after "0x"; it should be 40 hexadecimal characters (0-9, a-f, A-F).`;
}

/**
 * Validate a single wallet address.
 *
 * Validation order: network check (17.2) → empty check (1.3) → format check (1.1/1.2) →
 * normalize if it passes (1.4).
 */
export function validateAddress(
  raw: string,
  options: ValidateOptions = {},
): AddressValidationResult {
  // Requirement 17.2: the caller explicitly declares a non-Ethereum mainnet → network not supported yet.
  if (!isSupportedNetwork(options.network)) {
    return {
      input: raw,
      valid: false,
      pendingAnalysis: false,
      errorKind: "UNSUPPORTED_NETWORK",
      error: `This network is not supported yet (“${options.network}”). In the MVP stage only the audited chain is supported: ${AUDITED_CHAIN}.`,
    };
  }

  // Requirement 1.3: empty string / whitespace-only / missing.
  if (raw === undefined || raw === null || raw.trim() === "") {
    return {
      input: raw,
      valid: false,
      pendingAnalysis: false,
      errorKind: "EMPTY",
      error: "The address must not be empty: please provide a valid wallet address.",
    };
  }

  const candidate = raw.trim();

  // Requirements 1.1 / 1.2: format validation (case-insensitive).
  if (!ADDRESS_REGEX.test(candidate)) {
    return {
      input: raw,
      valid: false,
      pendingAnalysis: false,
      errorKind: "INVALID_FORMAT",
      error: describeFormatError(candidate),
    };
  }

  // Requirement 1.4: passes validation → mark as pending-analysis address, normalize to all-lowercase.
  return {
    input: raw,
    valid: true,
    pendingAnalysis: true,
    normalized: candidate.toLowerCase(),
  };
}

/**
 * Deduplication key: trim whitespace + lowercase.
 * EVM addresses are case-insensitive, so the same address differing only in case is treated
 * as a duplicate (requirement 1.7).
 */
function dedupKey(raw: string): string {
  return (raw ?? "").trim().toLowerCase();
}

/**
 * Validate a batch of wallet addresses.
 *
 * - Requirement 1.6: a single submission count > 50 → reject the entire request.
 * - Requirement 1.7: deduplicate repeated addresses, keeping only the first occurrence and validating it once.
 * - Requirement 1.5: validate each deduplicated address independently and return individual results.
 */
export function validateAddresses(
  raws: string[],
  options: ValidateOptions = {},
): BatchValidationResult {
  // Requirement 1.6: exceeds the per-batch limit → reject the entire request.
  if (raws.length > MAX_ADDRESSES_PER_REQUEST) {
    return {
      rejected: true,
      errorKind: "TOO_MANY_ADDRESSES",
      error: `The maximum number of addresses per request is ${MAX_ADDRESSES_PER_REQUEST}; this submission contained ${raws.length}. Please reduce the count and try again.`,
      results: [],
      pendingAddresses: [],
    };
  }

  // Requirements 1.7 + 1.5: deduplicate (case-insensitive), then validate each address independently.
  const seen = new Set<string>();
  const results: AddressValidationResult[] = [];
  const pendingAddresses: Address[] = [];

  for (const raw of raws) {
    const key = dedupKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);

    const result = validateAddress(raw, options);
    results.push(result);
    if (result.valid && result.normalized !== undefined) {
      pendingAddresses.push(result.normalized);
    }
  }

  return { rejected: false, results, pendingAddresses };
}
