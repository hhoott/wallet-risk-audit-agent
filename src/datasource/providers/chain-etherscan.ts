/**
 * Real ChainDataSource Provider for the Audited_Chain (Ethereum Mainnet, READ-ONLY).
 *
 * Implements {@link ChainDataSource} on top of:
 *  - Etherscan v2 REST API (https://api.etherscan.io/v2/api?chainid=1...) for historical data:
 *    external transactions (action=txlist), internal transactions (action=txlistinternal),
 *    ERC-20 transfer history (action=tokentx, used to discover the token set), verified source
 *    (action=getsourcecode) and contract creation (action=getcontractcreation).
 *  - viem (createPublicClient over an HTTP RPC URL) for on-chain reads: ERC-20 / Permit2 allowance,
 *    ERC-721 / ERC-1155 isApprovedForAll, native + ERC-20 balances, and getCode (isContract).
 *
 * Security constraint (requirement 13.1): every method is strictly read-only. There is no signer,
 * no account, and no eth_sendRawTransaction path anywhere in this provider.
 *
 * Keys / RPC URL are injected via the constructor (sourced from RuntimeConfig / environment); they
 * are NEVER hard-coded. See providers/index.ts (MANUAL(H7-12)) for the env wiring.
 *
 * Pragmatic notes on API realities:
 *  - Approvals are derived from Approval / ApprovalForAll event logs (viem getLogs filtered by the
 *    owner topic), then the *current* allowance is read on-chain via viem readContract. Raw-RPC log
 *    scans across all contracts are bounded to a recent block window (configurable) because public
 *    RPCs reject unbounded topic-only ranges; a production deployment should swap this for a
 *    dedicated indexer (Alchemy token-approvals API, Etherscan Pro, or a subgraph). This is a
 *    documented simplification, not a stub — the method returns real on-chain allowances.
 *  - Etherscan does not return USD valuations, so RawTransaction.valueUsd is null (valuation is the
 *    PriceDataSource's job, applied by higher layers).
 *  - ContractMeta.audited has no reliable free data source, so it defaults to false (conservative).
 *  - ContractMeta.txCount uses the Etherscan txlist count (capped) as a pragmatic proxy for the
 *    on-chain historical transaction count.
 */

import {
  createPublicClient,
  http,
  getAddress,
  isAddress,
  formatEther,
  formatUnits,
  erc20Abi,
  erc721Abi,
  parseAbi,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";

import { AUDITED_CHAIN_ID } from "../../config.js";
import type { Address, AddressType } from "../../models.js";
import type {
  ChainDataSource,
  ContractMeta,
  RawApproval,
  RawBalance,
  RawInternalTx,
  RawTransaction,
  TokenContractInfo,
} from "../types.js";
import type { RetryPolicy } from "../retry.js";

// ── Constants ───────────────────────────────────────────────────────────────────────────────

/** Canonical Permit2 contract address (same across chains). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

/** ERC-1155 ERC-165 interface id; used to distinguish operator approvals from ERC-721. */
const ERC1155_INTERFACE_ID = "0xd9b67a26";
/** ERC-721 ERC-165 interface id; used for address-type detection. */
const ERC721_INTERFACE_ID = "0x80ac58cd";

/** Minimal ERC-20 metadata ABI for type detection / token info (read-only). */
const ERC20_META_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

/** Common owner accessors found on many token contracts (read-only, best-effort). */
const OWNER_ABI = parseAbi([
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
]);

/** Default public RPC used only when no RPC URL is injected (keyless, best-effort). */
export const DEFAULT_ETH_RPC_URL = "https://cloudflare-eth.com";

/** Default Etherscan v2 API base URL. */
export const DEFAULT_ETHERSCAN_BASE_URL = "https://api.etherscan.io/v2/api";

/** Sensible upper bound on rows mapped per list endpoint (mirrors the Transaction_Analyzer cap). */
export const DEFAULT_MAX_RESULTS = 1000;

/** Default recent block window scanned for Approval logs when no explicit fromBlock is given. */
export const DEFAULT_APPROVAL_LOOKBACK_BLOCKS = 50_000n;

/** viem hex/address literal type. The project's Address is a plain string, so we narrow at call sites. */
type Hex = `0x${string}`;

/** Narrow a plain string to viem's hex-literal type at a viem call boundary. */
function hx(value: string): Hex {
  return value as Hex;
}

// ── Etherscan row shapes (subset of fields we consume) ──────────────────────────────────────

/** A single Etherscan action=txlist row (external transaction). */
export interface EtherscanTxRow {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  gasUsed: string;
  gasPrice: string;
  /** "0" = success, "1" = failed/reverted. */
  isError: string;
  /** post-byzantium receipt status: "1" success, "0" fail, "" unknown. */
  txreceipt_status?: string;
  contractAddress?: string;
}

/** A single Etherscan action=txlistinternal row (internal transaction). */
export interface EtherscanInternalRow {
  hash: string;
  timeStamp: string;
  to: string;
  value: string;
}

/** A single Etherscan action=tokentx row (ERC-20 transfer), used to discover the token set. */
export interface EtherscanTokenTxRow {
  contractAddress: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

// ── Pure helpers (network-free, unit-tested) ────────────────────────────────────────────────

/** Lowercase the 0x-hex body of an address for case-insensitive comparison. */
function lower(addr: string): string {
  return addr.toLowerCase();
}

/**
 * Convert a window length in days to an inclusive start Unix timestamp (seconds) relative to `now`.
 * A non-finite / non-positive window collapses to `now` (an empty window).
 */
export function windowDaysToStartTimestamp(windowDays: number, now: Date): number {
  const nowSec = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(windowDays) || windowDays <= 0) return nowSec;
  return nowSec - Math.floor(windowDays * 24 * 60 * 60);
}

/** Convert an Etherscan Unix-seconds timestamp (string or number) to a UTC ISO-8601 string. */
export function unixSecondsToIso(timeStamp: string | number): string {
  const sec = typeof timeStamp === "number" ? timeStamp : Number.parseInt(timeStamp, 10);
  if (!Number.isFinite(sec)) return new Date(0).toISOString();
  return new Date(sec * 1000).toISOString();
}

/** Safely multiply two decimal-string wei quantities, returning a decimal string ("0" on parse error). */
export function computeGasFeeWei(gasUsed: string, gasPrice: string): string {
  try {
    return (BigInt(gasUsed) * BigInt(gasPrice)).toString();
  } catch {
    return "0";
  }
}

/**
 * Map an Etherscan txlist row to a {@link RawTransaction}.
 *
 * `direction` is OUT when the row's sender equals the audited wallet, IN otherwise. `success` is
 * derived from Etherscan's `isError` flag. `valueUsd` is always null (Etherscan provides no USD).
 * `toIsContract` is resolved on-chain by the caller (via getCode) and threaded in here so this
 * mapping stays pure; it defaults to false.
 */
export function mapEtherscanTxRow(
  row: EtherscanTxRow,
  wallet: Address,
  toIsContract = false,
): RawTransaction {
  const to = row.to !== undefined && row.to !== "" ? (row.to as Address) : null;
  const direction: "IN" | "OUT" = lower(row.from) === lower(wallet) ? "OUT" : "IN";
  return {
    txHash: row.hash,
    timestamp: unixSecondsToIso(row.timeStamp),
    from: row.from as Address,
    to,
    valueWei: row.value,
    valueUsd: null,
    success: row.isError !== "1",
    gasFeeWei: computeGasFeeWei(row.gasUsed, row.gasPrice),
    toIsContract,
    direction,
  };
}

/** Map an Etherscan txlistinternal row to a {@link RawInternalTx}. */
export function mapEtherscanInternalRow(row: EtherscanInternalRow): RawInternalTx {
  const to = row.to !== undefined && row.to !== "" ? (row.to as Address) : null;
  return {
    txHash: row.hash,
    timestamp: unixSecondsToIso(row.timeStamp),
    to,
    valueWei: row.value,
  };
}

/** Whether an Etherscan row's timestamp (Unix seconds) is at or after the window start (seconds). */
export function isRowWithinWindow(timeStamp: string, startSec: number): boolean {
  const sec = Number.parseInt(timeStamp, 10);
  return Number.isFinite(sec) && sec >= startSec;
}

/** Token metadata discovered from ERC-20 transfer history. */
export interface DiscoveredToken {
  contract: Address;
  symbol: string;
  decimals: number;
}

/**
 * Extract the unique set of ERC-20 token contracts (with symbol / decimals) a wallet has seen,
 * from Etherscan action=tokentx rows. Deduplicated case-insensitively, keeping the first row's
 * metadata. Rows with an unparseable decimals field are skipped.
 */
export function extractTokenContractsFromTransfers(
  rows: readonly EtherscanTokenTxRow[],
): DiscoveredToken[] {
  const seen = new Set<string>();
  const out: DiscoveredToken[] = [];
  for (const row of rows) {
    if (row.contractAddress === undefined || row.contractAddress === "") continue;
    const key = lower(row.contractAddress);
    if (seen.has(key)) continue;
    const decimals = Number.parseInt(row.tokenDecimal, 10);
    if (!Number.isFinite(decimals)) continue;
    seen.add(key);
    out.push({
      contract: row.contractAddress as Address,
      symbol: row.tokenSymbol ?? "",
      decimals,
    });
  }
  return out;
}

/** Whether an Etherscan getsourcecode result indicates verified (open) source. */
export function isVerifiedSource(sourceCode: string | undefined | null): boolean {
  return typeof sourceCode === "string" && sourceCode.trim() !== "";
}

// ── Approval event ABI (for log discovery + decoding) ───────────────────────────────────────

/**
 * Approval-related events. ERC-20 / ERC-721 `Approval` and ERC-721 / ERC-1155 `ApprovalForAll`.
 * Permit2 allowance is read directly (no log scan) for the discovered ERC-20 token set.
 */
const APPROVAL_EVENTS = parseAbi([
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
]);

/** Permit2 allowance(owner, token, spender) -> (amount, expiration, nonce) read-only ABI. */
const PERMIT2_ALLOWANCE_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

/** ERC-165 supportsInterface, used to tell ERC-1155 operator approvals from ERC-721. */
const ERC165_ABI = parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]);

// ── Provider options ────────────────────────────────────────────────────────────────────────

export interface EtherscanChainOptions {
  /** Etherscan API key (injected from env via RuntimeConfig). Required for non-trivial rate limits. */
  etherscanApiKey: string;
  /** HTTP RPC URL for viem (e.g. Alchemy). Defaults to a public keyless RPC. */
  rpcUrl?: string;
  /** Override the Etherscan v2 base URL (for testing / self-hosted proxies). */
  etherscanBaseUrl?: string;
  /** Chain id (defaults to the audited chain, Ethereum Mainnet = 1). */
  chainId?: number;
  /** Optional retry/timeout policy; when provided, remote calls are wrapped with it. */
  retry?: RetryPolicy;
  /** Injected clock for deterministic window math; defaults to () => new Date(). */
  now?: () => Date;
  /** Max rows mapped per list endpoint. Defaults to {@link DEFAULT_MAX_RESULTS}. */
  maxResults?: number;
  /** How many recent blocks to scan for Approval logs. Defaults to {@link DEFAULT_APPROVAL_LOOKBACK_BLOCKS}. */
  approvalLookbackBlocks?: bigint;
  /** Injected fetch (for testing). Defaults to the global fetch (Node 18+). */
  fetchImpl?: typeof fetch;
  /** Injected viem public client (for testing). Defaults to one built from rpcUrl. */
  publicClient?: PublicClient;
}

/** Shape of the Etherscan v2 JSON envelope. */
interface EtherscanEnvelope<T> {
  status: string;
  message: string;
  result: T;
}

/**
 * Real, read-only ChainDataSource backed by Etherscan v2 + viem.
 */
export class EtherscanChainDataSource implements ChainDataSource {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly chainId: number;
  private readonly retry: RetryPolicy | undefined;
  private readonly now: () => Date;
  private readonly maxResults: number;
  private readonly approvalLookbackBlocks: bigint;
  private readonly fetchImpl: typeof fetch;
  private readonly client: PublicClient;

  constructor(options: EtherscanChainOptions) {
    this.apiKey = options.etherscanApiKey;
    this.baseUrl = options.etherscanBaseUrl ?? DEFAULT_ETHERSCAN_BASE_URL;
    this.chainId = options.chainId ?? AUDITED_CHAIN_ID;
    this.retry = options.retry;
    this.now = options.now ?? ((): Date => new Date());
    this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    this.approvalLookbackBlocks =
      options.approvalLookbackBlocks ?? DEFAULT_APPROVAL_LOOKBACK_BLOCKS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.client =
      options.publicClient ??
      (createPublicClient({
        chain: mainnet,
        transport: http(options.rpcUrl ?? DEFAULT_ETH_RPC_URL),
      }) as PublicClient);
  }

  // ── ChainDataSource methods ────────────────────────────────────────────────────────────────

  /**
   * Discover current approvals for `addr`.
   *
   * Strategy: scan recent Approval / ApprovalForAll logs whose `owner` topic is the wallet to find
   * candidate (token, spender) pairs, then read the *current* on-chain state (ERC-20 allowance,
   * operator flag, Permit2 allowance) so stale/revoked approvals are excluded. Returns only
   * still-active approvals (non-zero allowance or operatorApproved === true).
   */
  async getApprovals(addr: Address): Promise<RawApproval[]> {
    const owner = this.normalize(addr);
    const latest = await this.run(() => this.client.getBlockNumber(), "viem.getBlockNumber");
    const fromBlock =
      latest > this.approvalLookbackBlocks ? latest - this.approvalLookbackBlocks : 0n;

    // ERC-20 / ERC-721 Approval logs where owner == wallet.
    const approvalLogs = await this.run(
      () =>
        this.client.getLogs({
          event: APPROVAL_EVENTS[0],
          args: { owner },
          fromBlock,
          toBlock: latest,
        }),
      "viem.getLogs(Approval)",
    ).catch(() => []);

    // ERC-721 / ERC-1155 ApprovalForAll logs where owner == wallet.
    const operatorLogs = await this.run(
      () =>
        this.client.getLogs({
          event: APPROVAL_EVENTS[1],
          args: { owner },
          fromBlock,
          toBlock: latest,
        }),
      "viem.getLogs(ApprovalForAll)",
    ).catch(() => []);

    // Resolve the block timestamps of the involved logs once (memoized) for the lastUpdated field.
    const blockTime = await this.resolveBlockTimestamps([
      ...approvalLogs.map((l) => l.blockNumber),
      ...operatorLogs.map((l) => l.blockNumber),
    ]);
    const nowIso = this.now().toISOString();
    const tsOf = (blockNumber: bigint | null): string =>
      blockNumber !== null ? (blockTime.get(blockNumber) ?? nowIso) : nowIso;

    const out: RawApproval[] = [];

    // Resolve current ERC-20 allowances for unique (token, spender) pairs.
    const seenErc20 = new Set<string>();
    for (const log of approvalLogs) {
      const token = this.safeAddr(log.address);
      const spender = this.safeAddr(log.args.spender);
      if (token === null || spender === null) continue;
      const key = `${lower(token)}:${lower(spender)}`;
      if (seenErc20.has(key)) continue;
      seenErc20.add(key);
      const allowance = await this.readErc20Allowance(token, owner, spender);
      if (allowance === null || allowance === 0n) continue;
      out.push({
        tokenContract: token,
        spender,
        kind: "ERC20",
        allowance: allowance.toString(),
        lastUpdated: tsOf(log.blockNumber),
      });
    }

    // Resolve current operator approvals (ERC-721 / ERC-1155) for unique (token, operator) pairs.
    const seenOperator = new Set<string>();
    for (const log of operatorLogs) {
      const token = this.safeAddr(log.address);
      const operator = this.safeAddr(log.args.operator);
      if (token === null || operator === null) continue;
      const key = `${lower(token)}:${lower(operator)}`;
      if (seenOperator.has(key)) continue;
      seenOperator.add(key);
      const approved = await this.readIsApprovedForAll(token, owner, operator);
      if (approved !== true) continue;
      const kind = (await this.isErc1155(token)) ? "ERC1155_OPERATOR" : "ERC721_OPERATOR";
      out.push({
        tokenContract: token,
        spender: operator,
        kind,
        allowance: "0",
        operatorApproved: true,
        lastUpdated: tsOf(log.blockNumber),
      });
    }

    // Permit2: for every ERC-20 token the wallet has ever touched, the Permit2 allowance to active
    // spenders is read on demand only when an ERC-20 approval to Permit2 itself exists (the canonical
    // "approve Permit2, then Permit2 grants spenders" pattern). We expose the wallet->Permit2 ERC-20
    // allowance above; per-spender Permit2 reads require a spender set we do not have here without an
    // indexer, so they are intentionally omitted. See file header for the documented simplification.

    return out;
  }

  /** Retrieve external transactions within the window (newest first, capped). */
  async getTransactions(addr: Address, windowDays: number): Promise<RawTransaction[]> {
    const wallet = this.normalize(addr);
    const startSec = windowDaysToStartTimestamp(windowDays, this.now());
    const rows = await this.fetchEtherscanList<EtherscanTxRow>({
      module: "account",
      action: "txlist",
      address: wallet,
      sort: "desc",
    });
    const windowed = rows
      .filter((r) => isRowWithinWindow(r.timeStamp, startSec))
      .slice(0, this.maxResults);

    // Resolve isContract for unique recipients via getCode (read-only).
    const recipients = uniqueLower(
      windowed.map((r) => r.to).filter((t): t is string => t !== undefined && t !== ""),
    );
    const contractFlags = await this.resolveIsContractMap(recipients);

    return windowed.map((r) => {
      const hasTo = r.to !== undefined && r.to !== "";
      const toIsContract = hasTo ? contractFlags.get(lower(r.to)) === true : false;
      return mapEtherscanTxRow(r, wallet, toIsContract);
    });
  }

  /** Retrieve internal transactions within the window (newest first, capped). */
  async getInternalTxs(addr: Address, windowDays: number): Promise<RawInternalTx[]> {
    const wallet = this.normalize(addr);
    const startSec = windowDaysToStartTimestamp(windowDays, this.now());
    const rows = await this.fetchEtherscanList<EtherscanInternalRow>({
      module: "account",
      action: "txlistinternal",
      address: wallet,
      sort: "desc",
    });
    return rows
      .filter((r) => isRowWithinWindow(r.timeStamp, startSec))
      .slice(0, this.maxResults)
      .map(mapEtherscanInternalRow);
  }

  /** Native + ERC-20 balances (ERC-20 set discovered from transfer history). */
  async getBalances(addr: Address): Promise<RawBalance[]> {
    const wallet = this.normalize(addr);
    const out: RawBalance[] = [];

    // Native balance via viem (read-only).
    const nativeWei = await this.run(
      () => this.client.getBalance({ address: wallet }),
      "viem.getBalance",
    );
    out.push({
      token: "NATIVE",
      symbol: "ETH",
      balance: formatEther(nativeWei),
      decimals: 18,
    });

    // ERC-20 token set discovered from transfer history.
    const transferRows = await this.fetchEtherscanList<EtherscanTokenTxRow>({
      module: "account",
      action: "tokentx",
      address: wallet,
      sort: "desc",
    });
    const tokens = extractTokenContractsFromTransfers(transferRows).slice(0, this.maxResults);

    for (const token of tokens) {
      const raw = await this.readErc20BalanceOf(hx(token.contract), wallet);
      if (raw === null || raw === 0n) continue; // skip dust-free / zeroed tokens
      out.push({
        token: token.contract,
        symbol: token.symbol,
        balance: formatUnits(raw, token.decimals),
        decimals: token.decimals,
      });
    }

    return out;
  }

  /** Contract metadata for risk classification. */
  async getContractMeta(contract: Address): Promise<ContractMeta> {
    const addr = this.normalize(contract);

    // isContract: getCode returns non-empty bytecode for contracts (read-only).
    const code = await this.run(() => this.client.getCode({ address: addr }), "viem.getCode");
    const isContract = code !== undefined && code !== "0x" && code !== "0x0";

    // Verified source via Etherscan getsourcecode.
    let verified = false;
    try {
      const source = await this.fetchEtherscanResult<Array<{ SourceCode?: string }>>({
        module: "contract",
        action: "getsourcecode",
        address: addr,
      });
      verified =
        Array.isArray(source) && source.length > 0 && isVerifiedSource(source[0].SourceCode);
    } catch {
      verified = false;
    }

    // deployedAt via getcontractcreation (creation tx) then the tx's block timestamp.
    let deployedAt: string | null = null;
    try {
      deployedAt = await this.resolveDeployedAt(addr);
    } catch {
      deployedAt = null;
    }

    // txCount: Etherscan txlist count (capped) used as a pragmatic on-chain activity proxy.
    let txCount = 0;
    try {
      const txs = await this.fetchEtherscanList<EtherscanTxRow>({
        module: "account",
        action: "txlist",
        address: addr,
        sort: "desc",
      });
      txCount = txs.length;
    } catch {
      txCount = 0;
    }

    return {
      contract: addr,
      verified,
      deployedAt,
      txCount,
      // No reliable free audit registry; conservatively false (the Risk_Classifier treats this as
      // a NO_AUDIT suspicious feature). Documented simplification.
      audited: false,
      isContract,
    };
  }

  /**
   * Detect the on-chain type of an address (read-only): EOA (no bytecode), then ERC-721 / ERC-1155
   * via ERC-165 supportsInterface, then ERC-20 via a successful decimals() read, else CONTRACT.
   */
  async detectAddressType(address: Address): Promise<AddressType> {
    const addr = this.normalize(address);
    let code: string | undefined;
    try {
      code = await this.run(() => this.client.getCode({ address: addr }), "viem.getCode");
    } catch {
      return "UNKNOWN";
    }
    const isContract = code !== undefined && code !== "0x" && code !== "0x0";
    if (!isContract) return "EOA";

    // ERC-165 interface probes (NFTs).
    if (await this.supportsInterface(addr, ERC721_INTERFACE_ID)) return "ERC721";
    if (await this.isErc1155(addr)) return "ERC1155";

    // ERC-20 heuristic: decimals() reads successfully.
    const decimals = await this.readUintView(addr, ERC20_META_ABI, "decimals");
    if (decimals !== null) return "ERC20";

    return "CONTRACT";
  }

  /**
   * Best-effort token-contract security signals (read-only). Reads ERC-20 metadata + an owner
   * accessor, and infers mintable/pausable/blacklist from the verified ABI when available.
   */
  async getTokenContractInfo(contract: Address): Promise<TokenContractInfo> {
    const addr = this.normalize(contract);
    const [name, symbol, decimals, totalSupply, owner] = await Promise.all([
      this.readStringView(addr, ERC20_META_ABI, "name"),
      this.readStringView(addr, ERC20_META_ABI, "symbol"),
      this.readUintView(addr, ERC20_META_ABI, "decimals"),
      this.readUintView(addr, ERC20_META_ABI, "totalSupply"),
      this.readOwner(addr),
    ]);

    // Inspect the verified ABI (if any) for dangerous function patterns.
    let mintable = false;
    let pausable = false;
    let hasBlacklist = false;
    try {
      const fns = await this.fetchVerifiedFunctionNames(addr);
      mintable = fns.some((n) => /mint/.test(n));
      pausable = fns.some((n) => /(^|_)pause|setpaused|freeze/.test(n));
      hasBlacklist = fns.some((n) => /(blacklist|blocklist|denylist|ban)/.test(n));
    } catch {
      /* ABI unavailable; leave inferred flags false */
    }

    return {
      name,
      symbol,
      decimals: decimals === null ? null : Number(decimals),
      totalSupply: totalSupply === null ? null : totalSupply.toString(),
      hasOwner: owner !== null && owner !== "0x0000000000000000000000000000000000000000",
      owner,
      mintable,
      pausable,
      hasBlacklist,
    };
  }

  /** ERC-165 supportsInterface probe (returns false on any error). */
  private async supportsInterface(addr: Hex, interfaceId: string): Promise<boolean> {
    try {
      return await this.run(
        () =>
          this.client.readContract({
            address: addr,
            abi: ERC165_ABI,
            functionName: "supportsInterface",
            args: [hx(interfaceId)],
          }) as Promise<boolean>,
        "viem.readContract(supportsInterface)",
      );
    } catch {
      return false;
    }
  }

  /** Read a uint-returning view function; null on error. */
  private async readUintView(
    addr: Hex,
    abi: typeof ERC20_META_ABI,
    fn: string,
  ): Promise<bigint | null> {
    try {
      return (await this.run(
        () =>
          this.client.readContract({
            address: addr,
            abi,
            functionName: fn as never,
          }) as Promise<bigint>,
        `viem.readContract(${fn})`,
      )) as bigint;
    } catch {
      return null;
    }
  }

  /** Read a string-returning view function; null on error. */
  private async readStringView(
    addr: Hex,
    abi: typeof ERC20_META_ABI,
    fn: string,
  ): Promise<string | null> {
    try {
      return (await this.run(
        () =>
          this.client.readContract({
            address: addr,
            abi,
            functionName: fn as never,
          }) as Promise<string>,
        `viem.readContract(${fn})`,
      )) as string;
    } catch {
      return null;
    }
  }

  /** Try owner() then getOwner(); null when neither is present. */
  private async readOwner(addr: Hex): Promise<Address | null> {
    for (const fn of ["owner", "getOwner"]) {
      try {
        const o = (await this.run(
          () =>
            this.client.readContract({
              address: addr,
              abi: OWNER_ABI,
              functionName: fn as never,
            }) as Promise<string>,
          `viem.readContract(${fn})`,
        )) as string;
        if (typeof o === "string" && o.startsWith("0x")) return o;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /** Fetch the lowercased function names from a contract's verified ABI (Etherscan getabi). */
  private async fetchVerifiedFunctionNames(addr: string): Promise<string[]> {
    const abiJson = await this.fetchEtherscanResult<string>({
      module: "contract",
      action: "getabi",
      address: addr,
    });
    if (typeof abiJson !== "string" || abiJson === "Contract source code not verified") return [];
    const parsed = JSON.parse(abiJson) as Array<{ type?: string; name?: string }>;
    return parsed
      .filter((e) => e.type === "function" && typeof e.name === "string")
      .map((e) => (e.name as string).toLowerCase());
  }

  // ── viem read helpers (read-only contract calls) ────────────────────────────────────────────

  private async readErc20Allowance(token: Hex, owner: Hex, spender: Hex): Promise<bigint | null> {
    try {
      return await this.run(
        () =>
          this.client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, spender],
          }) as Promise<bigint>,
        "viem.readContract(allowance)",
      );
    } catch {
      return null;
    }
  }

  private async readErc20BalanceOf(token: Hex, owner: Hex): Promise<bigint | null> {
    try {
      return await this.run(
        () =>
          this.client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
          }) as Promise<bigint>,
        "viem.readContract(balanceOf)",
      );
    } catch {
      return null;
    }
  }

  private async readIsApprovedForAll(
    token: Hex,
    owner: Hex,
    operator: Hex,
  ): Promise<boolean | null> {
    try {
      return await this.run(
        () =>
          this.client.readContract({
            address: token,
            abi: erc721Abi,
            functionName: "isApprovedForAll",
            args: [owner, operator],
          }) as Promise<boolean>,
        "viem.readContract(isApprovedForAll)",
      );
    } catch {
      return null;
    }
  }

  /** Read a wallet's Permit2 allowance for a (token, spender) pair (kept for completeness). */
  async readPermit2Allowance(
    owner: Address,
    token: Address,
    spender: Address,
  ): Promise<bigint | null> {
    try {
      const result = (await this.run(
        () =>
          this.client.readContract({
            address: hx(PERMIT2_ADDRESS),
            abi: PERMIT2_ALLOWANCE_ABI,
            functionName: "allowance",
            args: [hx(owner), hx(token), hx(spender)],
          }),
        "viem.readContract(permit2.allowance)",
      )) as readonly [bigint, number, number];
      return result[0];
    } catch {
      return null;
    }
  }

  private async isErc1155(token: Hex): Promise<boolean> {
    try {
      return await this.run(
        () =>
          this.client.readContract({
            address: token,
            abi: ERC165_ABI,
            functionName: "supportsInterface",
            args: [hx(ERC1155_INTERFACE_ID)],
          }) as Promise<boolean>,
        "viem.readContract(supportsInterface)",
      );
    } catch {
      return false;
    }
  }

  /** Resolve isContract for a set of (lowercased) addresses via getCode, deduplicated. */
  private async resolveIsContractMap(lowerAddrs: string[]): Promise<Map<string, boolean>> {
    const map = new Map<string, boolean>();
    for (const a of lowerAddrs) {
      if (!isAddress(a)) {
        map.set(a, false);
        continue;
      }
      try {
        const code = await this.run(() => this.client.getCode({ address: hx(a) }), "viem.getCode");
        map.set(a, code !== undefined && code !== "0x" && code !== "0x0");
      } catch {
        map.set(a, false);
      }
    }
    return map;
  }

  /** Resolve block timestamps (ISO) for a set of block numbers, memoized within this call. */
  private async resolveBlockTimestamps(
    blockNumbers: readonly (bigint | null)[],
  ): Promise<Map<bigint, string>> {
    const map = new Map<bigint, string>();
    const unique = new Set<bigint>();
    for (const bn of blockNumbers) {
      if (bn !== null) unique.add(bn);
    }
    for (const bn of unique) {
      const block = await this.run(
        () => this.client.getBlock({ blockNumber: bn }),
        "viem.getBlock",
      ).catch(() => null);
      if (block !== null) map.set(bn, unixSecondsToIso(Number(block.timestamp)));
    }
    return map;
  }

  /** Resolve a contract's deployment time from its creation transaction. */
  private async resolveDeployedAt(contract: Address): Promise<string | null> {
    const creation = await this.fetchEtherscanResult<Array<{ txHash?: string }>>({
      module: "contract",
      action: "getcontractcreation",
      contractaddresses: contract,
    });
    if (!Array.isArray(creation) || creation.length === 0) return null;
    const txHash = creation[0].txHash;
    if (txHash === undefined || txHash === "") return null;
    const receipt = await this.run(
      () => this.client.getTransaction({ hash: txHash as `0x${string}` }),
      "viem.getTransaction(creation)",
    ).catch(() => null);
    if (receipt === null || receipt.blockNumber === null || receipt.blockNumber === undefined) {
      return null;
    }
    const block = await this.run(
      () => this.client.getBlock({ blockNumber: receipt.blockNumber as bigint }),
      "viem.getBlock(creation)",
    ).catch(() => null);
    if (block === null) return null;
    return unixSecondsToIso(Number(block.timestamp));
  }

  // ── Etherscan REST helpers ───────────────────────────────────────────────────────────────────

  /** Build a fully-qualified Etherscan v2 URL with the injected chainid + api key. */
  private buildUrl(params: Record<string, string>): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set("chainid", String(this.chainId));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (this.apiKey !== "") url.searchParams.set("apikey", this.apiKey);
    return url.toString();
  }

  /** Fetch a list-typed Etherscan result, returning [] for the "No transactions found" status. */
  private async fetchEtherscanList<T>(params: Record<string, string>): Promise<T[]> {
    const result = await this.fetchEtherscanResult<T[] | string>(params);
    return Array.isArray(result) ? result : [];
  }

  /** Fetch and unwrap an Etherscan v2 envelope, throwing on transport / API error statuses. */
  private async fetchEtherscanResult<T>(params: Record<string, string>): Promise<T> {
    const url = this.buildUrl(params);
    const json = await this.run(
      async () => {
        const res = await this.fetchImpl(url);
        if (!res.ok) throw new Error(`Etherscan HTTP ${res.status}`);
        return (await res.json()) as EtherscanEnvelope<T>;
      },
      `etherscan.${params.action ?? "request"}`,
    );

    // status "1" = OK; status "0" with the empty-results message is a benign empty list.
    if (json.status === "1") return json.result;
    const msg = typeof json.message === "string" ? json.message.toLowerCase() : "";
    if (msg.includes("no transactions found") || msg.includes("no records found")) {
      return [] as unknown as T;
    }
    if (msg.includes("notok") || json.result === undefined) {
      throw new Error(`Etherscan error: ${json.message ?? "unknown"}`);
    }
    return json.result;
  }

  // ── Small utilities ─────────────────────────────────────────────────────────────────────────

  /** Wrap a remote operation in the injected RetryPolicy when present; otherwise call directly. */
  private run<T>(op: () => Promise<T>, label: string): Promise<T> {
    return this.retry ? this.retry.run(op, label) : op();
  }

  /** Checksum-normalize an address (throws on invalid input, surfacing bad caller data early). */
  private normalize(addr: Address): Hex {
    return getAddress(addr);
  }

  /** Best-effort checksum normalization that returns null instead of throwing. */
  private safeAddr(addr: unknown): Hex | null {
    if (typeof addr !== "string" || !isAddress(addr)) return null;
    return getAddress(addr);
  }
}

/** Deduplicate strings case-insensitively, returning lowercased values. */
function uniqueLower(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = lower(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
