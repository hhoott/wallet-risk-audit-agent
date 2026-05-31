import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildRevokeAdviceResult,
  buildRevokeLink,
  buildRevokeUrl,
  categorize,
  generateRevokeAdvice,
  isOperatorKind,
  sortAdvice,
  NO_REVOKE_NEEDED_MESSAGE,
  REVOKE_CHAIN_PARAM,
  OPERATOR_ALLOWANCE_SENTINEL,
  UNLIMITED_BASELINE_RISK_LEVEL,
} from "../src/modules/revoke-advisor.js";
import type {
  Address,
  ApprovalKind,
  ApprovalRecord,
  ContractClassification,
  ContractRisk,
  RevokeAdvice,
  RiskLevel,
} from "../src/models.js";
import { RISK_LEVEL_ORDER } from "../src/models.js";
import { UNLIMITED_ERC20_THRESHOLD } from "../src/modules/approval-scanner.js";

// ── Generators & helpers ───────────────────────────────────────────

const UINT256_MAX = 2n ** 256n - 1n;
const VALID_RISK_LEVELS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const REVOKE_CATEGORIES = [
  "UNLIMITED_APPROVAL",
  "SUSPICIOUS_CONTRACT",
  "HIGH_RISK_CONTRACT",
] as const;

/** Build a deterministic lowercase EVM address from an index. */
function addrFromIndex(i: number): Address {
  return ("0x" + i.toString(16).padStart(40, "0")) as Address;
}

/** 40-hex address generator. */
const addressArb: fc.Arbitrary<Address> = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((h) => `0x${h}` as Address);

/** allowance generator focusing sampling around the 2^255 unlimited boundary and the endpoints. */
const allowanceArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("0"),
  fc.constant((UNLIMITED_ERC20_THRESHOLD - 1n).toString()),
  fc.constant(UNLIMITED_ERC20_THRESHOLD.toString()),
  fc.constant(UINT256_MAX.toString()),
  fc.bigInt({ min: 0n, max: UINT256_MAX }).map((v) => v.toString()),
);

const fungibleKindArb: fc.Arbitrary<ApprovalKind> = fc.constantFrom("ERC20", "PERMIT2");
const operatorKindArb: fc.Arbitrary<ApprovalKind> = fc.constantFrom(
  "ERC721_OPERATOR",
  "ERC1155_OPERATOR",
);
const anyKindArb: fc.Arbitrary<ApprovalKind> = fc.oneof(fungibleKindArb, operatorKindArb);

/**
 * Approval generator. For operator kinds, isUnlimited reflects setApprovalForAll==true; for
 * fungible kinds, isUnlimited reflects allowance >= 2^255 (mirroring Approval_Scanner output).
 */
const approvalArb: fc.Arbitrary<ApprovalRecord> = fc
  .record({
    tokenContract: addressArb,
    spender: addressArb,
    spenderLabel: fc.constantFrom("Unknown", "Uniswap V3 Router", "Unknown Operator"),
    kind: anyKindArb,
    allowance: allowanceArb,
    operatorApproved: fc.boolean(),
    lastUpdated: fc.constant("2024-01-01T00:00:00.000Z"),
  })
  .map((r): ApprovalRecord => {
    const operator = isOperatorKind(r.kind);
    const isUnlimited = operator
      ? r.operatorApproved
      : BigInt(r.allowance) >= UNLIMITED_ERC20_THRESHOLD;
    return {
      tokenContract: r.tokenContract,
      spender: r.spender,
      spenderLabel: r.spenderLabel,
      kind: r.kind,
      // Operator approvals carry "0" allowance; the unlimited semantics live in isUnlimited.
      allowance: operator ? "0" : r.allowance,
      isUnlimited,
      lastUpdated: r.lastUpdated,
    };
  });

const classificationArb: fc.Arbitrary<ContractClassification[]> = fc.constantFrom<
  ContractClassification[]
>(["SUSPICIOUS"], ["HIGH_RISK"]);

const riskLevelArb: fc.Arbitrary<RiskLevel> = fc.constantFrom(...VALID_RISK_LEVELS);

/** Is the given spender risky given the contract-risk index? Mirrors categorize() semantics. */
function isRisky(record: ApprovalRecord, risks: ContractRisk[]): boolean {
  const risk = risks.find((r) => r.contract.toLowerCase() === record.spender.toLowerCase());
  const classifiedRisky =
    risk !== undefined &&
    (risk.classification.includes("HIGH_RISK") || risk.classification.includes("SUSPICIOUS"));
  return record.isUnlimited || classifiedRisky;
}

/**
 * Build a scenario: a set of approvals plus contract risks for (a subset of) their spenders.
 * `riskFlag` decides, per approval, whether a ContractRisk entry is generated for its spender.
 */
const scenarioArb = fc
  .array(
    fc.record({
      approval: approvalArb,
      attachRisk: fc.boolean(),
      classification: classificationArb,
      riskLevel: riskLevelArb,
    }),
    { minLength: 0, maxLength: 14 },
  )
  .map((entries) => {
    // Force unique spenders so each authorization maps to at most one ContractRisk entry,
    // matching the upstream invariant (Risk_Classifier deduplicates spenders).
    const approvals: ApprovalRecord[] = entries.map((e, i) => ({
      ...e.approval,
      spender: addrFromIndex(i + 1),
    }));
    const contractRisks: ContractRisk[] = [];
    entries.forEach((e, i) => {
      if (e.attachRisk) {
        contractRisks.push({
          contract: addrFromIndex(i + 1),
          riskLevel: e.riskLevel,
          classification: e.classification,
          matchedFeatures: [],
        });
      }
    });
    return { approvals, contractRisks };
  });

// ── Property 13: one-to-one correspondence & link completeness ──────

describe("Revoke_Advisor — advice/authorization correspondence and link completeness", () => {
  // Feature: wallet-risk-audit-agent, Property 13: for any classified authorization set,
  // Revoke_Advisor produces exactly one revocation advice for each authorization marked as
  // Unlimited_Approval, Suspicious_Contract, or High_Risk_Contract (advice count == risky
  // authorization count); each advice carries a reason identifying its category and Risk_Level,
  // and a Revoke_Link containing the target spender/operator address, token contract address,
  // and chain parameter (ethereum-mainnet).
  it("Property 13: revocation advice is one-to-one with risky authorizations and links are complete", () => {
    fc.assert(
      fc.property(scenarioArb, ({ approvals, contractRisks }) => {
        const advice = generateRevokeAdvice(approvals, contractRisks);

        // advice count == number of risky authorizations
        const riskyCount = approvals.filter((a) => isRisky(a, contractRisks)).length;
        expect(advice.length).toBe(riskyCount);

        // Each advice corresponds to exactly one risky authorization (by spender) and is complete.
        const riskySpenders = new Set(
          approvals.filter((a) => isRisky(a, contractRisks)).map((a) => a.spender.toLowerCase()),
        );
        const adviceSpenders = new Set<string>();
        for (const adv of advice) {
          const spender = adv.revokeLink.spenderOrOperator.toLowerCase();
          adviceSpenders.add(spender);
          expect(riskySpenders.has(spender)).toBe(true);

          // Reason mentions both the category and the Risk_Level.
          expect(REVOKE_CATEGORIES).toContain(adv.category);
          expect(VALID_RISK_LEVELS).toContain(adv.riskLevel);
          expect(adv.reason).toContain(adv.category);
          expect(adv.reason).toContain(adv.riskLevel);

          // Link completeness: spender/operator, token contract, chain param.
          expect(adv.revokeLink.chain).toBe(REVOKE_CHAIN_PARAM);
          expect(adv.revokeLink.spenderOrOperator.length).toBeGreaterThan(0);
          expect(adv.revokeLink.tokenContract.length).toBeGreaterThan(0);
          expect(adv.revokeLink.url).toContain(adv.revokeLink.spenderOrOperator);
          expect(adv.revokeLink.url).toContain(adv.revokeLink.tokenContract);
        }
        // One advice per unique risky spender (no duplicates, full coverage).
        expect(adviceSpenders.size).toBe(advice.length);
        expect(adviceSpenders.size).toBe(riskySpenders.size);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Property 14: sorting ────────────────────────────────────────────

describe("Revoke_Advisor — sorting", () => {
  // Feature: wallet-risk-audit-agent, Property 14: for any set of revocation advice, the output
  // is ordered by Risk_Level in the fixed order CRITICAL → HIGH → MEDIUM → LOW, and advice with
  // the same Risk_Level is ordered by allowance from high to low.
  it("Property 14: revocation advice ordering by Risk_Level then allowance descending", () => {
    fc.assert(
      fc.property(scenarioArb, ({ approvals, contractRisks }) => {
        const advice = generateRevokeAdvice(approvals, contractRisks);
        for (let i = 1; i < advice.length; i++) {
          const prev = advice[i - 1]!;
          const cur = advice[i]!;
          const prevRank = RISK_LEVEL_ORDER[prev.riskLevel];
          const curRank = RISK_LEVEL_ORDER[cur.riskLevel];
          // Risk_Level descending severity (higher RISK_LEVEL_ORDER comes first).
          expect(prevRank).toBeGreaterThanOrEqual(curRank);
          // Within the same Risk_Level, allowance is non-increasing.
          if (prevRank === curRank) {
            expect(BigInt(prev.allowance) >= BigInt(cur.allowance)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ── Property 15: ERC-721 operator approval link ─────────────────────

describe("Revoke_Advisor — NFT operator approval link", () => {
  // Feature: wallet-risk-audit-agent, Property 15: for any ERC-721 setApprovalForAll operator
  // approval, the generated Revoke_Link uses the approved operator address and the NFT contract
  // address (not a token allowance amount) as its parameters.
  it("Property 15: ERC-721 setApprovalForAll link uses operator + NFT contract, not allowance", () => {
    fc.assert(
      fc.property(
        addressArb,
        addressArb,
        addressArb,
        riskLevelArb,
        (nftContract, operator, spenderForRisk, riskLevel) => {
          // An ERC-721 operator approval (setApprovalForAll == true).
          const record: ApprovalRecord = {
            tokenContract: nftContract,
            spender: operator,
            spenderLabel: "Unknown",
            kind: "ERC721_OPERATOR",
            allowance: "0",
            isUnlimited: true,
            lastUpdated: "2024-01-01T00:00:00.000Z",
          };

          // Make this risky deterministically via a HIGH_RISK classification on the operator,
          // and add an unrelated spender to ensure indexing does not leak across entries.
          const contractRisks: ContractRisk[] = [
            {
              contract: operator,
              riskLevel,
              classification: ["HIGH_RISK"],
              matchedFeatures: [],
            },
            {
              contract: spenderForRisk,
              riskLevel: "LOW",
              classification: ["SUSPICIOUS"],
              matchedFeatures: [],
            },
          ];

          const advice = generateRevokeAdvice([record], contractRisks);
          expect(advice.length).toBe(1);
          const link = advice[0]!.revokeLink;

          // Link uses operator address + NFT contract, kind is the operator kind.
          expect(link.spenderOrOperator).toBe(operator);
          expect(link.tokenContract).toBe(nftContract);
          expect(link.approvalKind).toBe("ERC721_OPERATOR");

          // URL targets the operator approval; it encodes addresses, not an allowance amount.
          expect(link.url).toContain(operator);
          expect(link.url).toContain(nftContract);
          expect(link.url).not.toContain("amount");
          expect(link.url).not.toContain("allowance");

          // Sort key uses the operator sentinel (no real allowance amount).
          expect(advice[0]!.allowance).toBe(OPERATOR_ALLOWANCE_SENTINEL);
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ── Property 24: read-only, no sensitive fields ─────────────────────

const FORBIDDEN_KEY_RE = /privateKey|mnemonic|signedTx|signature|rawTransaction/i;

/** Recursively collect every object key appearing anywhere in a value. */
function collectKeys(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys((value as Record<string, unknown>)[key], out);
    }
  }
}

describe("Revoke_Advisor — read-only without sensitive fields", () => {
  // Feature: wallet-risk-audit-agent, Property 24: for any revocation advice, its output only
  // contains a Revoke_Link (for the user to confirm in their own wallet); it contains no signed
  // transaction, private key, or mnemonic fields, and nothing triggers a transaction broadcast.
  it("Property 24: advice output contains only revoke links and no sensitive fields", () => {
    fc.assert(
      fc.property(scenarioArb, ({ approvals, contractRisks }) => {
        const result = buildRevokeAdviceResult(approvals, contractRisks);

        // Serialize the whole result to JSON and assert no forbidden key appears anywhere.
        const serialized = JSON.stringify(result);
        const roundTripped = JSON.parse(serialized);
        const keys: string[] = [];
        collectKeys(roundTripped, keys);
        for (const key of keys) {
          expect(FORBIDDEN_KEY_RE.test(key)).toBe(false);
        }

        // Each advice exposes exactly the expected, key-free shape: revokeLink present and the
        // link's own keys are limited to the read-only link fields.
        for (const adv of result.advice) {
          expect(adv.revokeLink).toBeDefined();
          expect(Object.keys(adv).sort()).toEqual(
            ["allowance", "category", "reason", "revokeLink", "riskLevel"].sort(),
          );
          expect(Object.keys(adv.revokeLink).sort()).toEqual(
            ["approvalKind", "chain", "spenderOrOperator", "tokenContract", "url"].sort(),
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ── Unit tests ──────────────────────────────────────────────────────

describe("Revoke_Advisor — unit tests", () => {
  it("returns \"No approvals need revoking\" with no links when there are no risky authorizations (requirement 11.6)", () => {
    // A finite (non-unlimited) ERC-20 approval whose spender has no contract-risk entry.
    const approvals: ApprovalRecord[] = [
      {
        tokenContract: addrFromIndex(10),
        spender: addrFromIndex(11),
        spenderLabel: "Uniswap V3 Router",
        kind: "ERC20",
        allowance: "1000",
        isUnlimited: false,
        lastUpdated: "2024-01-01T00:00:00.000Z",
      },
    ];
    const result = buildRevokeAdviceResult(approvals, []);
    expect(result.status).toBe("NONE");
    if (result.status !== "NONE") return;
    expect(result.advice).toEqual([]);
    expect(result.message).toBe(NO_REVOKE_NEEDED_MESSAGE);
  });

  it("empty inputs produce a NONE result", () => {
    const result = buildRevokeAdviceResult([], []);
    expect(result.status).toBe("NONE");
  });

  it("category precedence: HIGH_RISK > SUSPICIOUS > UNLIMITED for a spender carrying multiple labels", () => {
    const spender = addrFromIndex(20);
    const record: ApprovalRecord = {
      tokenContract: addrFromIndex(21),
      spender,
      spenderLabel: "Unknown",
      kind: "ERC20",
      // Unlimited as well, but the HIGH_RISK classification must win.
      allowance: UNLIMITED_ERC20_THRESHOLD.toString(),
      isUnlimited: true,
      lastUpdated: "2024-01-01T00:00:00.000Z",
    };
    const risks: ContractRisk[] = [
      {
        contract: spender,
        riskLevel: "CRITICAL",
        classification: ["HIGH_RISK"],
        matchedFeatures: [],
      },
    ];
    const cat = categorize(record, new Map([[spender.toLowerCase(), risks[0]!]]));
    expect(cat).not.toBeNull();
    expect(cat!.category).toBe("HIGH_RISK_CONTRACT");
    expect(cat!.riskLevel).toBe("CRITICAL");
  });

  it("a pure unlimited approval without a contract-risk entry uses the HIGH baseline Risk_Level", () => {
    const record: ApprovalRecord = {
      tokenContract: addrFromIndex(30),
      spender: addrFromIndex(31),
      spenderLabel: "Unknown",
      kind: "ERC20",
      allowance: UNLIMITED_ERC20_THRESHOLD.toString(),
      isUnlimited: true,
      lastUpdated: "2024-01-01T00:00:00.000Z",
    };
    const cat = categorize(record, new Map());
    expect(cat).not.toBeNull();
    expect(cat!.category).toBe("UNLIMITED_APPROVAL");
    expect(cat!.riskLevel).toBe(UNLIMITED_BASELINE_RISK_LEVEL);
    expect(cat!.riskLevel).toBe("HIGH");
  });

  it("buildRevokeUrl produces a revoke.cash deep link with chainId=1 (Ethereum Mainnet)", () => {
    const url = buildRevokeUrl(addrFromIndex(40), addrFromIndex(41));
    expect(url).toBe(
      `https://revoke.cash/address/${addrFromIndex(40)}?chainId=1&token=${addrFromIndex(41)}`,
    );
  });

  it("buildRevokeLink fills all read-only link fields for an ERC-20 approval", () => {
    const record: ApprovalRecord = {
      tokenContract: addrFromIndex(50),
      spender: addrFromIndex(51),
      spenderLabel: "Unknown",
      kind: "ERC20",
      allowance: "12345",
      isUnlimited: false,
      lastUpdated: "2024-01-01T00:00:00.000Z",
    };
    const link = buildRevokeLink(record);
    expect(link.chain).toBe("ethereum-mainnet");
    expect(link.tokenContract).toBe(addrFromIndex(50));
    expect(link.spenderOrOperator).toBe(addrFromIndex(51));
    expect(link.approvalKind).toBe("ERC20");
  });

  it("sortAdvice places CRITICAL before HIGH, and higher allowance first within a level", () => {
    const mk = (riskLevel: RiskLevel, allowance: string, spenderIdx: number): RevokeAdvice => ({
      category: "SUSPICIOUS_CONTRACT",
      riskLevel,
      reason: "test",
      revokeLink: {
        chain: "ethereum-mainnet",
        tokenContract: addrFromIndex(100),
        spenderOrOperator: addrFromIndex(spenderIdx),
        approvalKind: "ERC20",
        url: "https://revoke.cash/",
      },
      allowance,
    });
    const sorted = sortAdvice([
      mk("HIGH", "5", 1),
      mk("CRITICAL", "1", 2),
      mk("HIGH", "10", 3),
    ]);
    expect(sorted.map((a) => a.riskLevel)).toEqual(["CRITICAL", "HIGH", "HIGH"]);
    // Within HIGH: allowance 10 before 5.
    expect(sorted[1]!.allowance).toBe("10");
    expect(sorted[2]!.allowance).toBe("5");
  });
});
