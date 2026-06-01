/**
 * In-memory mock data sources (task 3.4).
 *
 * Used to drive analysis modules during development and end-to-end tests.
 * Supports preloaded data and configurable controlled failure / timeout per method,
 * for verifying error handling and retries.
 *
 * These are TEST FIXTURES, not pending production code: the real, read-only Providers live in
 * `src/datasource/providers/` (EtherscanChainDataSource / CoinGeckoPriceDataSource /
 * StaticRiskRuleSource, wired by buildProvidersFromConfig). These in-memory implementations remain
 * solely to drive deterministic unit / property tests without touching the network.
 */

import type { Address, AddressType } from "../models.js";
import type {
  ChainDataSource,
  PriceDataSource,
  RiskRuleSource,
  RawApproval,
  RawTransaction,
  RawInternalTx,
  RawBalance,
  ContractMeta,
  UsdPrice,
  RiskRuleEntry,
  TokenContractInfo,
} from "./types.js";

export interface MockChainData {
  approvals?: Record<string, RawApproval[]>;
  transactions?: Record<string, RawTransaction[]>;
  internalTxs?: Record<string, RawInternalTx[]>;
  balances?: Record<string, RawBalance[]>;
  contractMeta?: Record<string, ContractMeta>;
  addressType?: Record<string, AddressType>;
  tokenInfo?: Record<string, TokenContractInfo>;
}

const key = (addr: Address): string => addr.toLowerCase();

/** In-memory ChainDataSource mock. */
export class MockChainDataSource implements ChainDataSource {
  private data: MockChainData;
  /** When set to true, the corresponding method throws (simulating an unavailable data source). */
  public fail = {
    approvals: false,
    transactions: false,
    internalTxs: false,
    balances: false,
    contractMeta: false,
  };

  constructor(data: MockChainData = {}) {
    this.data = data;
  }

  async getApprovals(addr: Address): Promise<RawApproval[]> {
    if (this.fail.approvals) throw new Error("mock: approvals unavailable");
    return this.data.approvals?.[key(addr)] ?? [];
  }

  async getTransactions(addr: Address, _windowDays: number): Promise<RawTransaction[]> {
    if (this.fail.transactions) throw new Error("mock: transactions unavailable");
    return this.data.transactions?.[key(addr)] ?? [];
  }

  async getInternalTxs(addr: Address, _windowDays: number): Promise<RawInternalTx[]> {
    if (this.fail.internalTxs) throw new Error("mock: internalTxs unavailable");
    return this.data.internalTxs?.[key(addr)] ?? [];
  }

  async getBalances(addr: Address): Promise<RawBalance[]> {
    if (this.fail.balances) throw new Error("mock: balances unavailable");
    return this.data.balances?.[key(addr)] ?? [];
  }

  async getContractMeta(contract: Address): Promise<ContractMeta> {
    if (this.fail.contractMeta) throw new Error("mock: contractMeta unavailable");
    return (
      this.data.contractMeta?.[key(contract)] ?? {
        contract,
        verified: false,
        deployedAt: null,
        txCount: 0,
        audited: false,
        isContract: true,
      }
    );
  }

  async detectAddressType(addr: Address): Promise<AddressType> {
    return this.data.addressType?.[key(addr)] ?? "UNKNOWN";
  }

  async getTokenContractInfo(contract: Address): Promise<TokenContractInfo> {
    return (
      this.data.tokenInfo?.[key(contract)] ?? {
        name: null,
        symbol: null,
        decimals: null,
        totalSupply: null,
        hasOwner: false,
        owner: null,
        mintable: false,
        pausable: false,
        hasBlacklist: false,
      }
    );
  }
}

/** In-memory PriceDataSource mock. */
export class MockPriceDataSource implements PriceDataSource {
  public readonly sourceName: string;
  public fail = false;
  private prices: Map<string, number>;

  constructor(prices: Record<string, number> = {}, sourceName = "MockPrice") {
    this.sourceName = sourceName;
    this.prices = new Map(Object.entries(prices).map(([k, v]) => [k.toLowerCase(), v]));
  }

  async getUsdPrices(tokens: (Address | "NATIVE")[]): Promise<Map<Address | "NATIVE", UsdPrice>> {
    if (this.fail) throw new Error("mock: price unavailable");
    const result = new Map<Address | "NATIVE", UsdPrice>();
    for (const t of tokens) {
      const lk = t === "NATIVE" ? "native" : t.toLowerCase();
      const usd = this.prices.get(lk);
      if (usd !== undefined) result.set(t, { token: t, usd });
    }
    return result;
  }
}

/** In-memory RiskRuleSource mock. */
export class MockRiskRuleSource implements RiskRuleSource {
  public fail = false;
  private entries: Map<string, RiskRuleEntry>;

  constructor(entries: Record<string, Partial<RiskRuleEntry>> = {}) {
    this.entries = new Map(
      Object.entries(entries).map(([k, v]) => [
        k.toLowerCase(),
        { contract: k, blacklisted: false, ...v },
      ]),
    );
  }

  async lookup(contract: Address): Promise<RiskRuleEntry> {
    if (this.fail) throw new Error("mock: rule library unavailable");
    return (
      this.entries.get(contract.toLowerCase()) ?? {
        contract,
        blacklisted: false,
      }
    );
  }
}
