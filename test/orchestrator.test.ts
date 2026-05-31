import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  AuditOrchestrator,
  buildRiskItems,
  windowForTier,
  MODULE_APPROVAL_SCANNER,
  MODULE_RISK_CLASSIFIER,
  MODULE_ASSET_ANALYZER,
  MODULE_TRANSACTION_ANALYZER,
  SOURCE_CHAIN,
  SOURCE_PRICE,
  SOURCE_RULE,
} from "../src/orchestrator.js";
import {
  MockChainDataSource,
  MockPriceDataSource,
  MockRiskRuleSource,
  type MockChainData,
} from "../src/datasource/mock.js";
import type {
  ChainDataSource,
  RawApproval,
  RawBalance,
  RawInternalTx,
  RawTransaction,
  ContractMeta,
} from "../src/datasource/types.js";
import type { Address, ModuleState, ModuleStatus, Tier } from "../src/models.js";
import { DEFAULT_TX_WINDOW_DAYS, MULTI_TX_WINDOW_DAYS } from "../src/config.js";

// ── Helpers & fixtures ──────────────────────────────────────────────

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const ISO = "2024-01-01T00:00:00.000Z";

/** Build a deterministic lowercase EVM address from an index. */
function addrFromIndex(i: number): Address {
  return ("0x" + i.toString(16).padStart(40, "0")) as Address;
}

/** Uppercase only the 40-hex body, keeping the lowercase "0x" prefix (a still-valid form). */
function bodyUpper(addr: string): string {
  return "0x" + addr.trim().slice(2).toUpperCase();
}

/** Find a module status by module name. */
function statusOf(statuses: ModuleStatus[], module: string): ModuleStatus | undefined {
  return statuses.find((s) => s.module === module);
}

/**
 * A ChainDataSource wrapper that records which methods were called (and the windowDays passed to
 * the transaction methods), delegating to an inner MockChainDataSource. Used to observe which
 * modules the orchestrator triggered and which history window it chose.
 */
class RecordingChainDataSource implements ChainDataSource {
  public calls: { method: string; windowDays?: number }[] = [];
  constructor(private readonly inner: MockChainDataSource) {}

  async getApprovals(addr: Address): Promise<RawApproval[]> {
    this.calls.push({ method: "getApprovals" });
    return this.inner.getApprovals(addr);
  }
  async getTransactions(addr: Address, windowDays: number): Promise<RawTransaction[]> {
    this.calls.push({ method: "getTransactions", windowDays });
    return this.inner.getTransactions(addr, windowDays);
  }
  async getInternalTxs(addr: Address, windowDays: number): Promise<RawInternalTx[]> {
    this.calls.push({ method: "getInternalTxs", windowDays });
    return this.inner.getInternalTxs(addr, windowDays);
  }
  async getBalances(addr: Address): Promise<RawBalance[]> {
    this.calls.push({ method: "getBalances" });
    return this.inner.getBalances(addr);
  }
  async getContractMeta(contract: Address): Promise<ContractMeta> {
    this.calls.push({ method: "getContractMeta" });
    return this.inner.getContractMeta(contract);
  }
}

/** Build an orchestrator over fresh, empty mock data sources (all OK by default). */
function makeOrchestrator(data: MockChainData = {}): {
  orchestrator: AuditOrchestrator;
  chain: MockChainDataSource;
  price: MockPriceDataSource;
  rules: MockRiskRuleSource;
} {
  const chain = new MockChainDataSource(data);
  const price = new MockPriceDataSource({ native: 2000 }, "MockPrice");
  const rules = new MockRiskRuleSource();
  const orchestrator = new AuditOrchestrator({ chain, price, rules, now: () => new Date(ISO) });
  return { orchestrator, chain, price, rules };
}

// ── Generators ──────────────────────────────────────────────────────

/** Valid 0x + 40-hex address, sometimes with an uppercased body (still valid). */
const validAddrArb: fc.Arbitrary<string> = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .chain((body) => fc.constantFrom(`0x${body}`, `0x${body.toUpperCase()}`));

/** Strings that never match the valid address format. */
const invalidAddrArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("vitalik.eth"),
  fc.constant("not-an-address"),
  // "0x" + wrong-length hex (too short / too long).
  fc.hexaString({ minLength: 1, maxLength: 39 }).map((h) => `0x${h}`),
  fc.hexaString({ minLength: 41, maxLength: 60 }).map((h) => `0x${h}`),
  // 40 hex but missing the 0x prefix.
  fc.hexaString({ minLength: 40, maxLength: 40 }),
  // Right length but contains a non-hex character.
  fc.hexaString({ minLength: 39, maxLength: 39 }).map((h) => `0x${h}z`),
);

/**
 * A submitted address list mixing valid and invalid entries, with forced duplicates (including a
 * case-variant of the first valid-looking entry) to exercise deduplication.
 */
const submittedListArb: fc.Arbitrary<string[]> = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: validAddrArb },
      { weight: 2, arbitrary: invalidAddrArb },
    ),
    { minLength: 0, maxLength: 18 },
  )
  .map((list) => {
    if (list.length === 0) return list;
    const extra: string[] = [list[0]!]; // exact duplicate
    if (ADDRESS_REGEX.test(list[0]!.trim())) extra.push(bodyUpper(list[0]!)); // case-variant duplicate
    return [...list, ...extra];
  });

/**
 * Reference implementation of the validator's dedup + format rules: the deduped (case-insensitive),
 * valid, normalized (lowercase) address list, in order of first appearance.
 */
function expectedDedupedValid(raws: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
    const key = (raw ?? "").trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const trimmed = (raw ?? "").trim();
    if (ADDRESS_REGEX.test(trimmed)) out.push(trimmed.toLowerCase());
  }
  return out;
}

// ── Property 25: multi-wallet coverage & count ──────────────────────

describe("Audit Orchestrator — multi-wallet coverage and count", () => {
  // Feature: wallet-risk-audit-agent, Property 25: for any set of submitted wallet addresses
  // (including duplicates and some invalid ones), the multi-wallet audit produces exactly one
  // sub-report per deduped VALID address, and the report's walletCount equals the number of
  // sub-reports equals the number of deduped valid addresses.
  it("Property 25: one sub-report per deduped valid address; walletCount matches", async () => {
    await fc.assert(
      fc.asyncProperty(submittedListArb, async (submitted) => {
        const { orchestrator } = makeOrchestrator();
        const { multi, perWallet } = await orchestrator.auditMultipleWallets(submitted);

        const expected = expectedDedupedValid(submitted);

        // Exactly one sub-report per deduped valid address (coverage).
        expect(perWallet.map((w) => w.address)).toEqual(expected);
        // walletCount === reports.length === number of deduped valid addresses (req 15.4).
        expect(multi.walletCount).toBe(expected.length);
        expect(multi.reports.length).toBe(multi.walletCount);
        expect(perWallet.length).toBe(expected.length);

        // No duplicate audited addresses.
        expect(new Set(perWallet.map((w) => w.address)).size).toBe(perWallet.length);

        // Every sub-report is for its wallet and is a real report.
        for (const w of perWallet) {
          expect(w.report.structured.walletAddress).toBe(w.address);
          expect(w.report.structured.tier).toBe("MULTI");
          expect(w.tier).toBe("MULTI");
        }
        // The assembled report carries exactly the per-wallet structured reports.
        expect(multi.reports).toEqual(perWallet.map((w) => w.report.structured));
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 26: multi-wallet history window is longer ──────────────

describe("Audit Orchestrator — multi-wallet history window is longer", () => {
  // Feature: wallet-risk-audit-agent, Property 26: for any Multi_Wallet_Tier analysis, the history
  // time window (in days) it uses is strictly greater than the default window used by the
  // Quick/Full tiers.
  it("Property 26: MULTI window strictly greater than FULL/QUICK default window", async () => {
    await fc.assert(
      fc.asyncProperty(validAddrArb, async (raw) => {
        const address = raw.trim().toLowerCase() as Address;

        // Separate recording chains so getTransactions windowDays can be inspected per tier.
        const recFull = new RecordingChainDataSource(new MockChainDataSource());
        const recMulti = new RecordingChainDataSource(new MockChainDataSource());
        const price = new MockPriceDataSource({ native: 2000 });
        const rules = new MockRiskRuleSource();

        const orchFull = new AuditOrchestrator({
          chain: recFull,
          price,
          rules,
          now: () => new Date(ISO),
        });
        const orchMulti = new AuditOrchestrator({
          chain: recMulti,
          price,
          rules,
          now: () => new Date(ISO),
        });

        const full = await orchFull.auditWallet(address, "FULL");
        const multi = await orchMulti.auditWallet(address, "MULTI");

        // The chosen window is observable on the result.
        expect(full.windowDays).toBe(DEFAULT_TX_WINDOW_DAYS);
        expect(multi.windowDays).toBe(MULTI_TX_WINDOW_DAYS);
        expect(multi.windowDays).toBeGreaterThan(full.windowDays);

        // And the window actually passed through to the data source matches.
        const fullTxCalls = recFull.calls.filter((c) => c.method === "getTransactions");
        const multiTxCalls = recMulti.calls.filter((c) => c.method === "getTransactions");
        expect(fullTxCalls.length).toBeGreaterThan(0);
        expect(multiTxCalls.length).toBeGreaterThan(0);
        for (const c of fullTxCalls) expect(c.windowDays).toBe(DEFAULT_TX_WINDOW_DAYS);
        for (const c of multiTxCalls) expect(c.windowDays).toBe(MULTI_TX_WINDOW_DAYS);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 28: module-incomplete status propagation ───────────────

describe("Audit Orchestrator — module-incomplete status propagation", () => {
  const WALLET = ("0x" + "1".repeat(40)) as Address;
  const SPENDER = ("0x" + "2".repeat(40)) as Address;
  const TOKEN = ("0x" + "3".repeat(40)) as Address;

  // Preset data so every module has real work: one approval (drives Risk_Classifier over a spender)
  // and one balance (drives Asset_Analyzer through the price source). Transactions stay empty so the
  // Transaction_Analyzer depends only on the transactions / internalTxs fetch.
  const presetData: MockChainData = {
    approvals: {
      [WALLET.toLowerCase()]: [
        {
          tokenContract: TOKEN,
          spender: SPENDER,
          kind: "ERC20",
          allowance: (2n ** 255n).toString(),
          lastUpdated: ISO,
        },
      ],
    },
    balances: {
      [WALLET.toLowerCase()]: [{ token: "NATIVE", symbol: "ETH", balance: "1", decimals: 18 }],
    },
  };

  const failArb = fc.record({
    approvals: fc.boolean(),
    balances: fc.boolean(),
    transactions: fc.boolean(),
    internalTxs: fc.boolean(),
    price: fc.boolean(),
    rules: fc.boolean(),
    contractMeta: fc.boolean(),
  });

  interface ExpectedStatus {
    status: ModuleState;
    unavailableSource?: string;
  }

  /** Reference mapping from the failing-source subset to the expected module statuses (FULL tier). */
  function expectedStatuses(fail: {
    approvals: boolean;
    balances: boolean;
    transactions: boolean;
    internalTxs: boolean;
    price: boolean;
    rules: boolean;
    contractMeta: boolean;
  }): Record<string, ExpectedStatus> {
    const approvalScanner: ExpectedStatus = fail.approvals
      ? { status: "FAILED", unavailableSource: SOURCE_CHAIN }
      : { status: "OK" };

    let riskClassifier: ExpectedStatus;
    if (fail.approvals) {
      riskClassifier = { status: "INCOMPLETE", unavailableSource: SOURCE_CHAIN };
    } else if (fail.rules) {
      riskClassifier = { status: "FAILED", unavailableSource: SOURCE_RULE };
    } else if (fail.contractMeta) {
      riskClassifier = { status: "FAILED", unavailableSource: SOURCE_CHAIN };
    } else {
      riskClassifier = { status: "OK" };
    }

    let assetAnalyzer: ExpectedStatus;
    if (fail.balances) {
      assetAnalyzer = { status: "FAILED", unavailableSource: SOURCE_CHAIN };
    } else if (fail.price) {
      assetAnalyzer = { status: "FAILED", unavailableSource: SOURCE_PRICE };
    } else {
      assetAnalyzer = { status: "OK" };
    }

    let txAnalyzer: ExpectedStatus;
    if (fail.transactions || fail.internalTxs) {
      txAnalyzer = { status: "FAILED", unavailableSource: SOURCE_CHAIN };
    } else {
      txAnalyzer = { status: "OK" };
    }

    return {
      [MODULE_APPROVAL_SCANNER]: approvalScanner,
      [MODULE_RISK_CLASSIFIER]: riskClassifier,
      [MODULE_ASSET_ANALYZER]: assetAnalyzer,
      [MODULE_TRANSACTION_ANALYZER]: txAnalyzer,
    };
  }

  // Feature: wallet-risk-audit-agent, Property 28: for any data source(s) made unavailable, the
  // analysis modules that depend on them are marked INCOMPLETE/FAILED in the report (with the
  // offending data source named); the audit still returns a report, and the Health_Score is flagged
  // as computed on incomplete data whenever any module did not complete.
  it("Property 28: failing sources propagate to module statuses; audit still reports", async () => {
    await fc.assert(
      fc.asyncProperty(failArb, async (fail) => {
        const chain = new MockChainDataSource(presetData);
        chain.fail.approvals = fail.approvals;
        chain.fail.balances = fail.balances;
        chain.fail.transactions = fail.transactions;
        chain.fail.internalTxs = fail.internalTxs;
        chain.fail.contractMeta = fail.contractMeta;
        const price = new MockPriceDataSource({ native: 2000 });
        price.fail = fail.price;
        const rules = new MockRiskRuleSource();
        rules.fail = fail.rules;

        const orchestrator = new AuditOrchestrator({
          chain,
          price,
          rules,
          now: () => new Date(ISO),
        });

        const { report, statuses, healthScore } = await orchestrator.auditWallet(WALLET, "FULL");

        // The audit still returns a report (degrade, don't abort).
        expect(report).toBeDefined();
        expect(report.structured).toBeDefined();
        expect(report.structured.walletAddress).toBe(WALLET);

        const expected = expectedStatuses(fail);
        for (const module of [
          MODULE_APPROVAL_SCANNER,
          MODULE_RISK_CLASSIFIER,
          MODULE_ASSET_ANALYZER,
          MODULE_TRANSACTION_ANALYZER,
        ]) {
          const actual = statusOf(statuses, module);
          expect(actual).toBeDefined();
          expect(actual!.status).toBe(expected[module]!.status);
          if (expected[module]!.unavailableSource === undefined) {
            expect(actual!.unavailableSource).toBeUndefined();
          } else {
            expect(actual!.unavailableSource).toBe(expected[module]!.unavailableSource);
          }
        }

        // Any non-OK module must name the data source that caused incompleteness (req 18.3).
        for (const s of statuses) {
          if (s.status !== "OK") {
            expect(typeof s.unavailableSource).toBe("string");
            expect(s.unavailableSource!.length).toBeGreaterThan(0);
          }
        }

        // Health_Score is flagged on incomplete data exactly when something did not complete.
        const anyIncomplete = statuses.some((s) => s.status !== "OK");
        expect(healthScore.scoredOnIncompleteData).toBe(anyIncomplete);
        expect(report.structured.scoredOnIncompleteData).toBe(anyIncomplete);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Unit tests: tier routing & all-OK ───────────────────────────────

describe("Audit Orchestrator — tier routing", () => {
  const WALLET = addrFromIndex(0xa11ce);

  it("QUICK triggers only Approval_Scanner + Risk_Classifier (no assets / no transactions)", async () => {
    const rec = new RecordingChainDataSource(new MockChainDataSource());
    const price = new MockPriceDataSource({ native: 2000 });
    const rules = new MockRiskRuleSource();
    const orchestrator = new AuditOrchestrator({ chain: rec, price, rules, now: () => new Date(ISO) });

    const { report, statuses } = await orchestrator.auditWallet(WALLET, "QUICK");

    expect(statuses.map((s) => s.module).sort()).toEqual(
      [MODULE_APPROVAL_SCANNER, MODULE_RISK_CLASSIFIER].sort(),
    );
    expect(statusOf(statuses, MODULE_ASSET_ANALYZER)).toBeUndefined();
    expect(statusOf(statuses, MODULE_TRANSACTION_ANALYZER)).toBeUndefined();

    // The asset / transaction data sources were never touched for QUICK.
    const methods = rec.calls.map((c) => c.method);
    expect(methods).not.toContain("getBalances");
    expect(methods).not.toContain("getTransactions");
    expect(methods).not.toContain("getInternalTxs");

    // QUICK report omits the asset distribution.
    expect(report.structured.assets).toBeNull();
  });

  it("FULL triggers all four modules and populates assets", async () => {
    const rec = new RecordingChainDataSource(new MockChainDataSource());
    const price = new MockPriceDataSource({ native: 2000 });
    const rules = new MockRiskRuleSource();
    const orchestrator = new AuditOrchestrator({ chain: rec, price, rules, now: () => new Date(ISO) });

    const { report, statuses } = await orchestrator.auditWallet(WALLET, "FULL");

    expect(statuses.map((s) => s.module).sort()).toEqual(
      [
        MODULE_APPROVAL_SCANNER,
        MODULE_RISK_CLASSIFIER,
        MODULE_ASSET_ANALYZER,
        MODULE_TRANSACTION_ANALYZER,
      ].sort(),
    );

    const methods = rec.calls.map((c) => c.method);
    expect(methods).toContain("getBalances");
    expect(methods).toContain("getTransactions");

    // FULL report includes the asset distribution (non-null), even if empty.
    expect(report.structured.assets).not.toBeNull();
  });

  it("all sources OK yields all statuses OK and scoredOnIncompleteData=false", async () => {
    const { orchestrator } = makeOrchestrator();
    const { report, statuses, healthScore } = await orchestrator.auditWallet(WALLET, "FULL");

    expect(statuses.every((s) => s.status === "OK")).toBe(true);
    expect(statuses.every((s) => s.unavailableSource === undefined)).toBe(true);
    expect(healthScore.scoredOnIncompleteData).toBe(false);
    expect(report.structured.scoredOnIncompleteData).toBe(false);
    expect(orchestrator.someModuleSucceeded(statuses)).toBe(true);
  });

  it("windowForTier: MULTI is 365, QUICK/FULL are 90", () => {
    expect(windowForTier("QUICK")).toBe(DEFAULT_TX_WINDOW_DAYS);
    expect(windowForTier("FULL")).toBe(DEFAULT_TX_WINDOW_DAYS);
    expect(windowForTier("MULTI")).toBe(MULTI_TX_WINDOW_DAYS);
    expect(windowForTier("MULTI")).toBeGreaterThan(windowForTier("FULL"));
  });
});

// ── Unit tests: buildRiskItems mapping ──────────────────────────────

describe("Audit Orchestrator — buildRiskItems mapping", () => {
  it("maps unlimited approvals, contract risks and high-risk interactions to risk items", () => {
    const items = buildRiskItems(
      [
        {
          tokenContract: addrFromIndex(1),
          spender: addrFromIndex(2),
          spenderLabel: "Unknown",
          kind: "ERC20",
          allowance: (2n ** 255n).toString(),
          isUnlimited: true,
          lastUpdated: ISO,
        },
        {
          tokenContract: addrFromIndex(3),
          spender: addrFromIndex(4),
          spenderLabel: "Unknown",
          kind: "ERC20",
          allowance: "1000",
          isUnlimited: false,
          lastUpdated: ISO,
        },
      ],
      [
        { contract: addrFromIndex(2), riskLevel: "HIGH", classification: ["HIGH_RISK"], matchedFeatures: ["BLACKLISTED", "NO_AUDIT"] },
        { contract: addrFromIndex(5), riskLevel: "MEDIUM", classification: ["SUSPICIOUS"], matchedFeatures: ["NO_AUDIT"] },
      ],
      [{ txHash: "0xdeadbeef", timestamp: ISO, reason: "HIGH_RISK_INTERACTION", contract: addrFromIndex(2) }],
    );

    const categories = items.map((i) => i.category).sort();
    expect(categories).toEqual(
      ["HIGH_RISK_CONTRACT", "HIGH_RISK_INTERACTION", "SUSPICIOUS_CONTRACT", "UNLIMITED_APPROVAL"].sort(),
    );
    // Only the unlimited approval contributes an UNLIMITED_APPROVAL item.
    expect(items.filter((i) => i.category === "UNLIMITED_APPROVAL")).toHaveLength(1);
    // Contract risk preserves its own riskLevel.
    const highRiskContract = items.find((i) => i.category === "HIGH_RISK_CONTRACT");
    expect(highRiskContract?.riskLevel).toBe("HIGH");
  });

  it("produces no risk items for an empty, clean wallet", () => {
    expect(buildRiskItems([], [], [])).toEqual([]);
  });
});
