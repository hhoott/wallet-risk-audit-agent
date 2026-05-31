import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  RiskClassifier,
  classifyContract,
  detectSuspiciousFeatures,
  classificationForFeatures,
  riskLevelForFeatures,
  isHighRiskContract,
  RECENTLY_DEPLOYED_DAYS,
  LOW_TX_COUNT_THRESHOLD,
} from "../src/modules/risk-classifier.js";
import type { RiskClassificationResult } from "../src/modules/risk-classifier.js";
import type { Address, RiskLevel, SuspiciousFeature } from "../src/models.js";
import type { ContractMeta } from "../src/datasource/types.js";
import { MockChainDataSource, MockRiskRuleSource } from "../src/datasource/mock.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FIXED_NOW = new Date("2024-06-01T00:00:00.000Z");
const VALID_RISK_LEVELS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** Vector of 6 boolean features (corresponding to a–f of requirement 7.2). */
interface FeatureVec {
  unverified: boolean; // (a) UNVERIFIED_SOURCE
  recentlyDeployed: boolean; // (b) RECENTLY_DEPLOYED
  lowTx: boolean; // (c) LOW_TX_COUNT
  noAudit: boolean; // (d) NO_AUDIT
  blacklisted: boolean; // (e) BLACKLISTED
  eoa: boolean; // (f) SPENDER_IS_EOA
}

/** Builds a deterministic lowercase EVM address from an index. */
function addrFromIndex(i: number): Address {
  return "0x" + i.toString(16).padStart(40, "0");
}

/** Builds a ContractMeta that matches the corresponding features from a feature vector (now is fixed to guarantee determinism). */
function metaFromVec(contract: Address, vec: FeatureVec, now: Date): ContractMeta {
  return {
    contract,
    verified: !vec.unverified, // verified===false matches (a)
    // 1 day ago → recently deployed, matches (b); 60 days ago → no match
    deployedAt: vec.recentlyDeployed
      ? new Date(now.getTime() - 1 * MS_PER_DAY).toISOString()
      : new Date(now.getTime() - 60 * MS_PER_DAY).toISOString(),
    txCount: vec.lowTx ? 50 : 200, // <100 matches (c)
    audited: !vec.noAudit, // audited===false matches (d)
    isContract: !vec.eoa, // isContract===false matches (f)
  };
}

/** The set of features expected to match, in detection order a→f. */
function expectedFeatures(vec: FeatureVec): SuspiciousFeature[] {
  const f: SuspiciousFeature[] = [];
  if (vec.unverified) f.push("UNVERIFIED_SOURCE");
  if (vec.recentlyDeployed) f.push("RECENTLY_DEPLOYED");
  if (vec.lowTx) f.push("LOW_TX_COUNT");
  if (vec.noAudit) f.push("NO_AUDIT");
  if (vec.blacklisted) f.push("BLACKLISTED");
  if (vec.eoa) f.push("SPENDER_IS_EOA");
  return f;
}

const featureVecArb = fc.record<FeatureVec>({
  unverified: fc.boolean(),
  recentlyDeployed: fc.boolean(),
  lowTx: fc.boolean(),
  noAudit: fc.boolean(),
  blacklisted: fc.boolean(),
  eoa: fc.boolean(),
});

describe("Risk_Classifier", () => {
  // Feature: wallet-risk-audit-agent, Property 6: for any authorized contract and its feature set
  // (any subset of the 6 suspicious features), 0 matches are not labeled, exactly 1 match is labeled
  // as Suspicious_Contract, and ≥2 matches are escalated to High_Risk_Contract; the output
  // matchedFeatures exactly equals the actually matched feature set, and every authorized contract
  // receives a valid Risk_Level enum value.
  it("Property 6: suspicious/high-risk contract grading and reasons", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A set of authorized contracts, each with a 6-boolean feature vector (covering all 2^6 subset combinations)
        fc.array(featureVecArb, { minLength: 1, maxLength: 12 }),
        async (vecs) => {
          const contractMeta: Record<string, ContractMeta> = {};
          const ruleEntries: Record<string, { blacklisted: boolean }> = {};
          const spenders: Address[] = [];

          vecs.forEach((vec, i) => {
            const a = addrFromIndex(i + 1);
            spenders.push(a);
            contractMeta[a] = metaFromVec(a, vec, FIXED_NOW);
            ruleEntries[a] = { blacklisted: vec.blacklisted };
          });

          const chain = new MockChainDataSource({ contractMeta });
          const rules = new MockRiskRuleSource(ruleEntries);
          const classifier = new RiskClassifier({ chain, rules, now: () => FIXED_NOW });

          const result = await classifier.classifyForWallet(
            "0x000000000000000000000000000000000000dead",
            spenders,
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const byContract = new Map(
            result.contractRisks.map((r) => [r.contract.toLowerCase(), r]),
          );

          vecs.forEach((vec, i) => {
            const a = addrFromIndex(i + 1);
            const expected = expectedFeatures(vec);
            const risk = byContract.get(a.toLowerCase());

            if (expected.length === 0) {
              // 0 matches → not labeled, not added to the list
              expect(risk).toBeUndefined();
              return;
            }

            expect(risk).toBeDefined();
            if (!risk) return;

            // matchedFeatures exactly equals the actually matched set (both order and content match)
            expect(risk.matchedFeatures).toEqual(expected);

            // Grading: exactly 1 match → SUSPICIOUS; ≥2 matches → escalated to HIGH_RISK
            if (expected.length === 1) {
              expect(risk.classification).toEqual(["SUSPICIOUS"]);
            } else {
              expect(risk.classification).toEqual(["HIGH_RISK"]);
            }

            // Each contract receives a valid Risk_Level enum value
            expect(VALID_RISK_LEVELS).toContain(risk.riskLevel);

            // Deterministic mapping: BLACKLISTED⇒CRITICAL; ≥2⇒HIGH; 1⇒MEDIUM
            if (expected.includes("BLACKLISTED")) {
              expect(risk.riskLevel).toBe("CRITICAL");
            } else if (expected.length >= 2) {
              expect(risk.riskLevel).toBe("HIGH");
            } else {
              expect(risk.riskLevel).toBe("MEDIUM");
            }
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: wallet-risk-audit-agent, Property 7: for any wallet address, if it has a previous
  // successful contract classification result, then when this run's rule library/chain data source
  // is unavailable, a failure result is returned but that address's previous successful data remains
  // unchanged and is not overwritten.
  it("Property 7: data source/rule library failure does not overwrite the last successful result (Risk_Classifier part)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(featureVecArb, { minLength: 1, maxLength: 8 }),
        fc.constantFrom<"rules" | "chain">("rules", "chain"),
        async (vecs, failingSource) => {
          const wallet = "0x000000000000000000000000000000000000beef";
          const contractMeta: Record<string, ContractMeta> = {};
          const ruleEntries: Record<string, { blacklisted: boolean }> = {};
          const spenders: Address[] = [];

          vecs.forEach((vec, i) => {
            const a = addrFromIndex(i + 1);
            spenders.push(a);
            contractMeta[a] = metaFromVec(a, vec, FIXED_NOW);
            ruleEntries[a] = { blacklisted: vec.blacklisted };
          });

          const chain = new MockChainDataSource({ contractMeta });
          const rules = new MockRiskRuleSource(ruleEntries);
          const classifier = new RiskClassifier({ chain, rules, now: () => FIXED_NOW });

          // 1) Classify successfully first to establish a previous successful result
          const first = await classifier.classifyForWallet(wallet, spenders);
          expect(first.ok).toBe(true);
          const snapshot = classifier.getLastSuccessful(wallet);
          expect(snapshot).toBeDefined();

          // 2) Make the data source unreachable
          if (failingSource === "rules") rules.fail = true;
          else chain.fail.contractMeta = true;

          const second: RiskClassificationResult = await classifier.classifyForWallet(
            wallet,
            spenders,
          );

          // Returns a failure result and indicates the unavailable source
          expect(second.ok).toBe(false);
          if (second.ok) return;
          expect(second.unavailableSource).toBe(
            failingSource === "rules" ? "RiskRuleSource" : "ChainDataSource",
          );

          // The previous successful result is not overwritten
          expect(classifier.getLastSuccessful(wallet)).toEqual(snapshot);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── Unit tests: boundaries and deterministic mapping ─────────────────────────────────

  it("0 matches do not enter the list (classifyContract returns null)", () => {
    const meta: ContractMeta = {
      contract: addrFromIndex(1),
      verified: true,
      deployedAt: new Date(FIXED_NOW.getTime() - 60 * MS_PER_DAY).toISOString(),
      txCount: 200,
      audited: true,
      isContract: true,
    };
    const risk = classifyContract(
      addrFromIndex(1),
      meta,
      { contract: addrFromIndex(1), blacklisted: false },
      FIXED_NOW,
    );
    expect(risk).toBeNull();
  });

  it("a blacklist match is always CRITICAL, even if it is the only match", () => {
    const meta: ContractMeta = {
      contract: addrFromIndex(2),
      verified: true,
      deployedAt: new Date(FIXED_NOW.getTime() - 60 * MS_PER_DAY).toISOString(),
      txCount: 200,
      audited: true,
      isContract: true,
    };
    const features = detectSuspiciousFeatures(
      meta,
      { contract: addrFromIndex(2), blacklisted: true },
      FIXED_NOW,
    );
    expect(features).toEqual(["BLACKLISTED"]);
    expect(classificationForFeatures(features)).toEqual(["SUSPICIOUS"]);
    expect(riskLevelForFeatures(features)).toBe("CRITICAL");
  });

  it("deployed exactly 30 days ago does not match RECENTLY_DEPLOYED (strictly less than)", () => {
    const meta: ContractMeta = {
      contract: addrFromIndex(3),
      verified: true,
      deployedAt: new Date(
        FIXED_NOW.getTime() - RECENTLY_DEPLOYED_DAYS * MS_PER_DAY,
      ).toISOString(),
      txCount: 200,
      audited: true,
      isContract: true,
    };
    expect(detectSuspiciousFeatures(meta, { contract: addrFromIndex(3), blacklisted: false }, FIXED_NOW)).toEqual(
      [],
    );
  });

  it("a null deployedAt is treated as unknown and handled as no match", () => {
    const meta: ContractMeta = {
      contract: addrFromIndex(4),
      verified: true,
      deployedAt: null,
      txCount: 200,
      audited: true,
      isContract: true,
    };
    expect(detectSuspiciousFeatures(meta, { contract: addrFromIndex(4), blacklisted: false }, FIXED_NOW)).toEqual(
      [],
    );
  });

  it("txCount exactly 100 does not match LOW_TX_COUNT (strictly less than the threshold)", () => {
    const meta: ContractMeta = {
      contract: addrFromIndex(5),
      verified: true,
      deployedAt: new Date(FIXED_NOW.getTime() - 60 * MS_PER_DAY).toISOString(),
      txCount: LOW_TX_COUNT_THRESHOLD,
      audited: true,
      isContract: true,
    };
    expect(detectSuspiciousFeatures(meta, { contract: addrFromIndex(5), blacklisted: false }, FIXED_NOW)).toEqual(
      [],
    );
  });

  it("2 matches (non-blacklist) are escalated to HIGH_RISK / HIGH", () => {
    const features: SuspiciousFeature[] = ["UNVERIFIED_SOURCE", "NO_AUDIT"];
    expect(classificationForFeatures(features)).toEqual(["HIGH_RISK"]);
    expect(riskLevelForFeatures(features)).toBe("HIGH");
  });

  it("isHighRiskContract is determined by blacklisted", () => {
    expect(isHighRiskContract({ contract: addrFromIndex(6), blacklisted: true })).toBe(true);
    expect(isHighRiskContract({ contract: addrFromIndex(6), blacklisted: false })).toBe(false);
  });
});
