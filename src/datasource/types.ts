/**
 * Data source abstraction interfaces and raw data types
 * (task 3.1, per design.md "Data source abstraction interfaces").
 *
 * Security constraint (requirement 13.1): all interfaces expose only read-only
 * get* / lookup methods; architecturally there is no write-chain / send-tx path.
 * The audited chain is fixed to Ethereum Mainnet.
 */

import type { Address, ApprovalKind } from "../models.js";

/** Raw approval record (from the on-chain data source, before classification). */
export interface RawApproval {
  tokenContract: Address;
  spender: Address;
  spenderLabel?: string;
  kind: ApprovalKind;
  /** uint256 decimal string; for operator approvals (setApprovalForAll) this is "0", expressed via operatorApproved. */
  allowance: string;
  /** ERC721/ERC1155 setApprovalForAll value; undefined for non-operator approvals. */
  operatorApproved?: boolean;
  lastUpdated: string;
}

/** Raw transaction (external transaction). */
export interface RawTransaction {
  txHash: string;
  /** UTC ISO-8601. */
  timestamp: string;
  from: Address;
  to: Address | null;
  /** Value in wei (decimal string). */
  valueWei: string;
  /** USD valuation of the value if the source can provide it, otherwise null. */
  valueUsd: number | null;
  /** Whether on-chain execution succeeded (false = failed / reverted). */
  success: boolean;
  /** Gas fee actually spent (wei decimal string). */
  gasFeeWei: string;
  /** Whether the counterparty is a contract. */
  toIsContract: boolean;
  /** Direction: inbound to this wallet / outbound from this wallet. */
  direction: "IN" | "OUT";
}

/** Raw internal transaction (contract-internal call). */
export interface RawInternalTx {
  txHash: string;
  timestamp: string;
  to: Address | null;
  valueWei: string;
}

/** Raw balance (native or ERC-20). */
export interface RawBalance {
  token: Address | "NATIVE";
  symbol: string;
  /** Decimal-string balance (already normalized by decimals to a human-readable amount). */
  balance: string;
  decimals: number;
}

/** Contract metadata (used for risk classification). */
export interface ContractMeta {
  contract: Address;
  /** Explorer-reported contract name when available. */
  name?: string | null;
  /** Whether source is verified / open on a block explorer. */
  verified: boolean;
  /** Deployment time UTC ISO-8601; null when unknown. */
  deployedAt: string | null;
  /** On-chain historical transaction count. */
  txCount: number;
  /** Whether there is a public audit record. */
  audited: boolean;
  /** Whether the address is a contract (false = EOA). */
  isContract: boolean;
}

/** Price information. */
export interface UsdPrice {
  token: Address | "NATIVE";
  usd: number;
}

/** Risk rule library lookup result. */
export interface RiskRuleEntry {
  contract: Address;
  /** Whether it hits a blacklist (phishing / drainer, etc.). */
  blacklisted: boolean;
  /** Human-readable label (e.g. "Uniswap V3 Router"); undefined if none. */
  label?: string;
  /**
   * Whether the curated list marks this as an official / known-good address (e.g. a well-known
   * router, token, or project treasury). Used by Address_Intel's vetting verdict. Optional and
   * defaults to false when absent, so existing rule sources stay backward-compatible.
   */
  official?: boolean;
}

/** Token-contract security signals (best-effort; fields are null when not determinable). */
export interface TokenContractInfo {
  /** ERC-20 metadata when readable. */
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  /** Total supply (decimal string) when readable. */
  totalSupply: string | null;
  /** Whether the contract exposes an owner()/getOwner() that is a non-zero address. */
  hasOwner: boolean;
  /** The owner address when readable (null otherwise). */
  owner: Address | null;
  /** Whether a mint-like function is present in the verified ABI (possible inflation risk). */
  mintable: boolean;
  /** Whether a pause-like function is present (transfers can be frozen). */
  pausable: boolean;
  /** Whether a blacklist-like function is present (addresses can be blocked). */
  hasBlacklist: boolean;
}

/**
 * Audited chain (Ethereum Mainnet) read-only data source.
 */
export interface ChainDataSource {
  getApprovals(addr: Address): Promise<RawApproval[]>;
  getTransactions(addr: Address, windowDays: number): Promise<RawTransaction[]>;
  getInternalTxs(addr: Address, windowDays: number): Promise<RawInternalTx[]>;
  getBalances(addr: Address): Promise<RawBalance[]>;
  getContractMeta(contract: Address): Promise<ContractMeta>;
  /**
   * Detect the on-chain type of an address (EOA / ERC20 / ERC721 / ERC1155 / CONTRACT). Optional so
   * existing mock sources stay compatible; when absent, callers treat the type as UNKNOWN.
   */
  detectAddressType?(addr: Address): Promise<import("../models.js").AddressType>;
  /**
   * Read best-effort token-contract security signals (owner / mintable / pausable / blacklist).
   * Optional; used by the token-specific analysis. Only meaningful for token contracts.
   */
  getTokenContractInfo?(contract: Address): Promise<TokenContractInfo>;
}

/** Price data source (USD valuation), with source name. */
export interface PriceDataSource {
  /** Price source name (used for requirement 9.3 attribution). */
  readonly sourceName: string;
  getUsdPrices(tokens: (Address | "NATIVE")[]): Promise<Map<Address | "NATIVE", UsdPrice>>;
}

/** Risk rule library data source. */
export interface RiskRuleSource {
  lookup(contract: Address): Promise<RiskRuleEntry>;
}
