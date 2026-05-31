import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  applyTierTrimming,
  buildStructuredReport,
  computeRiskLevelSummary,
  DEFAULT_RISK_LEVEL_SUMMARY,
  generateMultiWalletReport,
  generateReport,
  isHighRiskContract,
  type AuditInputs,
} from "../src/modules/report-generator.js";
import type {
  Address,
  ApprovalKind,
  ApprovalRecord,
  AssetDistribution,
  AssetItem,
  AuditReportStructured,
  ContractClassification,
  ContractRisk,
  HealthGrade,
  HealthScoreResult,
  ModuleStatus,
  RevokeAdvice,
  RevokeCategory,
  RiskLevel,
  Tier,
  TxFinding,
} from "../src/models.js";
import { READ_ONLY_DECLARATION, RISK_LEVEL_ORDER, SCHEMA_VERSION } from "../src/models.js";
import { AUDITED_CHAIN } from "../src/config.js";

// ── Generators & helpers ───────────────────────────────────────────

const VALID_RISK_LEVELS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const VALID_GRADES: HealthGrade[] = ["EXCELLENT", "GOOD", "FAIR", "POOR"];
const TIERS: Tier[] = ["QUICK", "FULL", "MULTI"];

/** Build a deterministic lowercase EVM address from an index. */
function addrFromIndex(i: number): Address {
  return ("0x" + i.toString(16).padStart(40, "0")) as Address;
}

const addressArb: fc.Arbitrary<Address> = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((h) => `0x${h}` as Address);

const riskLevelArb: fc.Arbitrary<RiskLevel> = fc.constantFrom(...VALID_RISK_LEVELS);
const gradeArb: fc.Arbitrary<HealthGrade> = fc.constantFrom(...VALID_GRADES);
const tierArb: fc.Arbitrary<Tier> = fc.constantFrom(...TIERS);

const approvalKindArb: fc.Arbitrary<ApprovalKind> = fc.constantFrom(
  "ERC20",
  "ERC721_OPERATOR",
  "ERC1155_OPERATOR",
  "PERMIT2",
);

const approvalArb: fc.Arbitrary<ApprovalRecord> = fc.record({
  tokenContract: addressArb,
  spender: addressArb,
  spenderLabel: fc.constantFrom("Unknown", "Uniswap V3 Router", "Unknown Operator"),
  kind: approvalKindArb,
  allowance: fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }).map((v) => v.toString()),
  isUnlimited: fc.boolean(),
  lastUpdated: fc.constant("2024-01-01T00:00:00.000Z"),
});

const classificationArb: fc.Arbitrary<ContractClassification[]> = fc.constantFrom<
  ContractClassification[]
>(["SUSPICIOUS"], ["HIGH_RISK"], ["SUSPICIOUS", "HIGH_RISK"]);

const contractRiskArb: fc.Arbitrary<ContractRisk> = fc.record({
  contract: addressArb,
  riskLevel: riskLevelArb,
  classification: classificationArb,
  matchedFeatures: fc.constant([]),
});

const assetItemArb: fc.Arbitrary<AssetItem> = fc.record({
  token: fc.oneof(addressArb, fc.constant("NATIVE" as const)),
  symbol: fc.constantFrom("ETH", "USDC", "DAI", "WBTC"),
  balance: fc.bigInt({ min: 0n, max: 10n ** 24n }).map((v) => v.toString()),
  usdValue: fc.oneof(fc.constant(null), fc.double({ min: 0, max: 1e7, noNaN: true })),
  percentage: fc.oneof(fc.constant(null), fc.double({ min: 0, max: 100, noNaN: true })),
});

const assetDistributionArb: fc.Arbitrary<AssetDistribution> = fc.record({
  unit: fc.constant("USD" as const),
  priceSource: fc.constantFrom("CoinGecko", "Chainlink"),
  pricedAt: fc.constant("2024-01-01T00:00:00.000Z"),
  top: fc.array(assetItemArb, { maxLength: 10 }),
  other: fc.oneof(fc.constant(null), assetItemArb),
  empty: fc.boolean(),
});

const txFindingReasonArb = fc.constantFrom(
  "FAILED",
  "DUST",
  "ADDRESS_POISONING",
  "RISKY_OUTFLOW",
  "HIGH_GAS_FAILED",
  "NEW_CONTRACT",
  "HIGH_RISK_INTERACTION",
);

const txFindingArb: fc.Arbitrary<TxFinding> = fc
  .record({
    txHash: addressArb,
    timestamp: fc.constant("2024-01-01T00:00:00.000Z"),
    reason: txFindingReasonArb,
    interactionType: fc.oneof(
      fc.constant(undefined),
      fc.constantFrom("DIRECT" as const, "INTERNAL" as const),
    ),
    contract: fc.oneof(fc.constant(undefined), addressArb),
  })
  .map((r) => {
    const f: TxFinding = { txHash: r.txHash, timestamp: r.timestamp, reason: r.reason };
    if (r.interactionType !== undefined) f.interactionType = r.interactionType;
    if (r.contract !== undefined) f.contract = r.contract;
    return f;
  });

const revokeCategoryArb: fc.Arbitrary<RevokeCategory> = fc.constantFrom(
  "UNLIMITED_APPROVAL",
  "SUSPICIOUS_CONTRACT",
  "HIGH_RISK_CONTRACT",
);

const revokeAdviceArb: fc.Arbitrary<RevokeAdvice> = fc
  .record({
    category: revokeCategoryArb,
    riskLevel: riskLevelArb,
    spender: addressArb,
    token: addressArb,
    kind: approvalKindArb,
    allowance: fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }).map((v) => v.toString()),
  })
  .map(
    (r): RevokeAdvice => ({
      category: r.category,
      riskLevel: r.riskLevel,
      reason: `Classified as ${r.category} with risk level ${r.riskLevel}.`,
      revokeLink: {
        chain: "ethereum-mainnet",
        tokenContract: r.token,
        spenderOrOperator: r.spender,
        approvalKind: r.kind,
        url: `https://revoke.cash/address/${r.spender}?chainId=1&token=${r.token}`,
      },
      allowance: r.allowance,
    }),
  );

const moduleStatusArb: fc.Arbitrary<ModuleStatus> = fc
  .record({
    module: fc.constantFrom(
      "Approval_Scanner",
      "Risk_Classifier",
      "Asset_Analyzer",
      "Transaction_Analyzer",
    ),
    status: fc.constantFrom("OK" as const, "INCOMPLETE" as const, "FAILED" as const),
    unavailableSource: fc.oneof(fc.constant(undefined), fc.constantFrom("Alchemy", "Etherscan")),
  })
  .map((m) => {
    const s: ModuleStatus = { module: m.module, status: m.status };
    if (m.unavailableSource !== undefined) s.unavailableSource = m.unavailableSource;
    return s;
  });

const healthScoreArb: fc.Arbitrary<HealthScoreResult> = fc.record({
  score: fc.integer({ min: 0, max: 100 }),
  grade: gradeArb,
  deductions: fc.constant([]),
  scoredOnIncompleteData: fc.boolean(),
});

const auditInputsArb: fc.Arbitrary<AuditInputs> = fc.record({
  walletAddress: addressArb,
  tier: tierArb,
  healthScore: healthScoreArb,
  approvals: fc.array(approvalArb, { maxLength: 12 }),
  contractRisks: fc.array(contractRiskArb, { maxLength: 10 }),
  assets: fc.oneof(fc.constant(null), assetDistributionArb),
  txFindings: fc.array(txFindingArb, { maxLength: 12 }),
  revokeAdvice: fc.array(revokeAdviceArb, { maxLength: 12 }),
  moduleStatuses: fc.array(moduleStatusArb, { maxLength: 6 }),
  generatedAt: fc.constant("2024-06-15T12:30:00.000Z"),
});

/** Structural deep-equality check (independent of JSON for the round-trip assertion). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ak = Object.keys(a as Record<string, unknown>).sort();
    const bk = Object.keys(b as Record<string, unknown>).sort();
    if (!deepEqual(ak, bk)) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

// ── Property 22: report structure invariants & tier trimming ────────

describe("Report_Generator — report structure invariants and tier trimming", () => {
  // Feature: wallet-risk-audit-agent, Property 22: for any audit result and tier, the generated
  // report produces both a human-readable form and a machine-readable structured form; the
  // structured form always contains schemaVersion, riskLevelSummary, healthScore, walletAddress,
  // auditedChain (Ethereum Mainnet), UTC generatedAt and the read-only declaration; the FULL tier
  // contains all analysis-module results, while the QUICK tier contains only Health_Score,
  // Unlimited_Approval and High_Risk_Contract entries (a subset of the FULL fields); even when an
  // input address fails validation the report still names the supported Audited_Chain.
  it("Property 22: structured invariants always hold and QUICK is a subset of FULL", () => {
    fc.assert(
      fc.property(auditInputsArb, (inputs) => {
        const { humanReadable, structured } = generateReport(inputs);

        // Structured invariants (always present, valid values).
        expect(structured.schemaVersion).toBe(SCHEMA_VERSION);
        expect(VALID_RISK_LEVELS).toContain(structured.riskLevelSummary);
        expect(structured.healthScore).toBe(inputs.healthScore.score);
        expect(structured.walletAddress).toBe(inputs.walletAddress);
        expect(structured.auditedChain).toBe("Ethereum Mainnet");
        expect(structured.auditedChain).toBe(AUDITED_CHAIN);
        // generatedAt is a UTC-parseable ISO timestamp.
        expect(Number.isNaN(Date.parse(structured.generatedAt))).toBe(false);
        expect(structured.readOnlyDeclaration.length).toBeGreaterThan(0);

        // Human-readable form is a non-empty string naming the chain and the read-only declaration.
        expect(typeof humanReadable).toBe("string");
        expect(humanReadable.length).toBeGreaterThan(0);
        expect(humanReadable).toContain("Ethereum Mainnet");
        expect(humanReadable).toContain(READ_ONLY_DECLARATION);

        // What the FULL report would contain from the same inputs.
        const full = buildStructuredReport({ ...inputs, tier: "FULL" });

        if (inputs.tier === "QUICK") {
          // QUICK trimming rules.
          expect(structured.assets).toBeNull();
          expect(structured.txFindings).toEqual([]);
          for (const a of structured.approvals) expect(a.isUnlimited).toBe(true);
          for (const c of structured.contractRisks) {
            expect(c.classification.includes("HIGH_RISK")).toBe(true);
          }

          // Subset relationship: QUICK approvals ⊆ FULL approvals, QUICK contractRisks ⊆ FULL.
          const fullApprovals = new Set(full.approvals);
          for (const a of structured.approvals) expect(fullApprovals.has(a)).toBe(true);
          const fullRisks = new Set(full.contractRisks);
          for (const c of structured.contractRisks) expect(fullRisks.has(c)).toBe(true);
          // The QUICK approval set is exactly the unlimited subset of FULL.
          expect(structured.approvals).toEqual(full.approvals.filter((a) => a.isUnlimited));
          expect(structured.contractRisks).toEqual(
            full.contractRisks.filter(isHighRiskContract),
          );
        } else {
          // FULL / MULTI: all provided module data is present unchanged.
          expect(structured.approvals).toEqual(inputs.approvals);
          expect(structured.contractRisks).toEqual(inputs.contractRisks);
          expect(structured.assets).toEqual(inputs.assets);
          expect(structured.txFindings).toEqual(inputs.txFindings);
          expect(structured.revokeAdvice).toEqual(inputs.revokeAdvice);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ── Property 23: report serialization round-trip ────────────────────

describe("Report_Generator — serialization round-trip", () => {
  // Feature: wallet-risk-audit-agent, Property 23: for any structured audit report object,
  // serializing it to JSON and deserializing it back yields an equivalent report (the round trip
  // preserves data without loss or transformation).
  it("Property 23: JSON.parse(JSON.stringify(structured)) deep-equals structured", () => {
    fc.assert(
      fc.property(auditInputsArb, (inputs) => {
        const structured = buildStructuredReport(inputs);
        const roundTripped = JSON.parse(JSON.stringify(structured)) as AuditReportStructured;
        expect(deepEqual(roundTripped, structured)).toBe(true);
        // Also assert via Vitest's structural matcher as a cross-check.
        expect(roundTripped).toEqual(structured);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Unit tests ──────────────────────────────────────────────────────

describe("Report_Generator — unit tests", () => {
  it("computeRiskLevelSummary picks the maximum Risk_Level across findings", () => {
    const contractRisks: ContractRisk[] = [
      { contract: addrFromIndex(1), riskLevel: "MEDIUM", classification: ["SUSPICIOUS"], matchedFeatures: [] },
      { contract: addrFromIndex(2), riskLevel: "CRITICAL", classification: ["HIGH_RISK"], matchedFeatures: [] },
      { contract: addrFromIndex(3), riskLevel: "LOW", classification: ["SUSPICIOUS"], matchedFeatures: [] },
    ];
    const revokeAdvice: RevokeAdvice[] = [
      {
        category: "HIGH_RISK_CONTRACT",
        riskLevel: "HIGH",
        reason: "test",
        revokeLink: {
          chain: "ethereum-mainnet",
          tokenContract: addrFromIndex(4),
          spenderOrOperator: addrFromIndex(2),
          approvalKind: "ERC20",
          url: "https://revoke.cash/",
        },
        allowance: "0",
      },
    ];
    expect(computeRiskLevelSummary(contractRisks, revokeAdvice)).toBe("CRITICAL");
    // The CRITICAL contributor came from contractRisks; sanity-check the ordering helper.
    expect(RISK_LEVEL_ORDER.CRITICAL).toBeGreaterThan(RISK_LEVEL_ORDER.HIGH);
  });

  it("computeRiskLevelSummary returns LOW when there are no risks", () => {
    expect(computeRiskLevelSummary([], [])).toBe("LOW");
    expect(computeRiskLevelSummary([], [])).toBe(DEFAULT_RISK_LEVEL_SUMMARY);
  });

  it("QUICK tier trimming drops assets, txFindings, non-unlimited approvals and non-high-risk contracts", () => {
    const inputs: AuditInputs = {
      walletAddress: addrFromIndex(1),
      tier: "QUICK",
      healthScore: { score: 70, grade: "GOOD", deductions: [], scoredOnIncompleteData: false },
      approvals: [
        {
          tokenContract: addrFromIndex(2),
          spender: addrFromIndex(3),
          spenderLabel: "Unknown",
          kind: "ERC20",
          allowance: "1000",
          isUnlimited: false,
          lastUpdated: "2024-01-01T00:00:00.000Z",
        },
        {
          tokenContract: addrFromIndex(4),
          spender: addrFromIndex(5),
          spenderLabel: "Unknown",
          kind: "ERC20",
          allowance: (2n ** 255n).toString(),
          isUnlimited: true,
          lastUpdated: "2024-01-01T00:00:00.000Z",
        },
      ],
      contractRisks: [
        { contract: addrFromIndex(6), riskLevel: "MEDIUM", classification: ["SUSPICIOUS"], matchedFeatures: [] },
        { contract: addrFromIndex(7), riskLevel: "CRITICAL", classification: ["HIGH_RISK"], matchedFeatures: [] },
      ],
      assets: { unit: "USD", priceSource: "CoinGecko", pricedAt: "2024-01-01T00:00:00.000Z", top: [], other: null, empty: true },
      txFindings: [{ txHash: addrFromIndex(8), timestamp: "2024-01-01T00:00:00.000Z", reason: "FAILED" }],
      revokeAdvice: [],
      moduleStatuses: [],
    };
    const trimmed = applyTierTrimming(inputs);
    expect(trimmed.assets).toBeNull();
    expect(trimmed.txFindings).toEqual([]);
    expect(trimmed.approvals).toHaveLength(1);
    expect(trimmed.approvals[0]!.isUnlimited).toBe(true);
    expect(trimmed.contractRisks).toHaveLength(1);
    expect(trimmed.contractRisks[0]!.classification).toContain("HIGH_RISK");
  });

  it("generateReport embeds the read-only declaration and chain name in the human-readable form", () => {
    const inputs: AuditInputs = {
      walletAddress: addrFromIndex(1),
      tier: "FULL",
      healthScore: { score: 100, grade: "EXCELLENT", deductions: [], scoredOnIncompleteData: false },
      approvals: [],
      contractRisks: [],
      assets: null,
      txFindings: [],
      revokeAdvice: [],
      moduleStatuses: [],
      generatedAt: "2024-06-15T12:30:00.000Z",
    };
    const { humanReadable, structured } = generateReport(inputs);
    expect(humanReadable).toContain(READ_ONLY_DECLARATION);
    expect(humanReadable).toContain("Ethereum Mainnet");
    expect(structured.readOnlyDeclaration).toBe(READ_ONLY_DECLARATION);
    expect(structured.generatedAt).toBe("2024-06-15T12:30:00.000Z");
  });

  it("generateMultiWalletReport sets walletCount equal to reports.length", () => {
    const mk = (i: number): AuditReportStructured =>
      buildStructuredReport({
        walletAddress: addrFromIndex(i),
        tier: "MULTI",
        healthScore: { score: 90, grade: "EXCELLENT", deductions: [], scoredOnIncompleteData: false },
        approvals: [],
        contractRisks: [],
        assets: null,
        txFindings: [],
        revokeAdvice: [],
        moduleStatuses: [],
        generatedAt: "2024-06-15T12:30:00.000Z",
      });
    for (const n of [0, 1, 3, 5]) {
      const reports = Array.from({ length: n }, (_, i) => mk(i + 1));
      const multi = generateMultiWalletReport(reports);
      expect(multi.schemaVersion).toBe(SCHEMA_VERSION);
      expect(multi.walletCount).toBe(reports.length);
      expect(multi.walletCount).toBe(n);
      expect(multi.reports).toBe(reports);
    }
  });

  it("generateMultiWalletReport walletCount equals reports.length for arbitrary report arrays", () => {
    fc.assert(
      fc.property(fc.array(auditInputsArb, { maxLength: 8 }), (inputsArr) => {
        const reports = inputsArr.map((i) => buildStructuredReport(i));
        const multi = generateMultiWalletReport(reports);
        expect(multi.walletCount).toBe(reports.length);
        expect(multi.reports.length).toBe(multi.walletCount);
      }),
      { numRuns: 100 },
    );
  });
});
