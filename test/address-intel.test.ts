import { describe, it, expect } from "vitest";

import { analyzeAddress, deriveVerdict, AddressIntel } from "../src/modules/address-intel.js";
import { MockChainDataSource, MockRiskRuleSource } from "../src/datasource/mock.js";
import type { ContractMeta, RiskRuleEntry } from "../src/datasource/types.js";

const OFFICIAL = "0x" + "a".repeat(40);
const SCAM = "0x" + "b".repeat(40);
const FRESH = "0x" + "c".repeat(40);
const EOA = "0x" + "d".repeat(40);
const NOW = new Date("2024-06-01T00:00:00.000Z");

function meta(over: Partial<ContractMeta>): ContractMeta {
  return {
    contract: "0x0",
    verified: true,
    deployedAt: "2020-01-01T00:00:00.000Z",
    txCount: 100000,
    audited: true,
    isContract: true,
    ...over,
  };
}

describe("Address_Intel — pure verdict", () => {
  it("official rule → OFFICIAL verdict", () => {
    const rule: RiskRuleEntry = {
      contract: OFFICIAL,
      blacklisted: false,
      official: true,
      label: "Uniswap V3 Router",
    };
    const r = analyzeAddress(OFFICIAL, rule, meta({ contract: OFFICIAL }), NOW);
    expect(r.verdict).toBe("OFFICIAL");
    expect(r.badge.level).toBe("OFFICIAL");
    expect(r.badge.label).toBe("Official verified");
    expect(r.official).toBe(true);
    expect(r.label).toBe("Uniswap V3 Router");
  });

  it("blacklisted rule → DANGEROUS verdict regardless of metadata", () => {
    const rule: RiskRuleEntry = { contract: SCAM, blacklisted: true, label: "Drainer" };
    const r = analyzeAddress(SCAM, rule, meta({ contract: SCAM }), NOW);
    expect(r.verdict).toBe("DANGEROUS");
    expect(r.badge.level).toBe("DANGEROUS");
    expect(r.blacklisted).toBe(true);
    expect(r.matchedFeatures).toContain("BLACKLISTED");
  });

  it("clean unknown contract → LIKELY_SAFE", () => {
    const rule: RiskRuleEntry = { contract: FRESH, blacklisted: false };
    const r = analyzeAddress(FRESH, rule, meta({ contract: FRESH }), NOW);
    expect(r.verdict).toBe("LIKELY_SAFE");
    expect(r.badge.level).toBe("SAFE");
    expect(r.matchedFeatures).toEqual([]);
  });

  it("fresh + unverified contract → CAUTION/DANGEROUS via features", () => {
    const rule: RiskRuleEntry = { contract: FRESH, blacklisted: false };
    const r = analyzeAddress(
      FRESH,
      rule,
      meta({
        contract: FRESH,
        verified: false,
        audited: false,
        deployedAt: "2024-05-25T00:00:00.000Z",
        txCount: 3,
      }),
      NOW,
    );
    // verified=false, recently deployed, low tx, no audit → many features → HIGH/CRITICAL → DANGEROUS
    expect(["CAUTION", "DANGEROUS"]).toContain(r.verdict);
    expect(r.matchedFeatures.length).toBeGreaterThanOrEqual(2);
  });

  it("EOA target is flagged as SPENDER_IS_EOA", () => {
    const rule: RiskRuleEntry = { contract: EOA, blacklisted: false };
    const r = analyzeAddress(EOA, rule, meta({ contract: EOA, isContract: false }), NOW);
    expect(r.isContract).toBe(false);
    expect(r.matchedFeatures).toContain("SPENDER_IS_EOA");
  });

  it("deriveVerdict prioritizes blacklist over official", () => {
    expect(
      deriveVerdict(
        { contract: SCAM, blacklisted: true, official: true },
        ["BLACKLISTED"],
        "CRITICAL",
      ),
    ).toBe("DANGEROUS");
  });
});

describe("Address_Intel — analyzer with data sources", () => {
  it("returns a verdict via injected sources", async () => {
    const chain = new MockChainDataSource({
      contractMeta: { [OFFICIAL.toLowerCase()]: meta({ contract: OFFICIAL }) },
    });
    const rules = new MockRiskRuleSource({ [OFFICIAL]: { official: true, label: "Router" } });
    const intel = new AddressIntel({ chain, rules, now: () => NOW });
    const out = await intel.vetAddress(OFFICIAL);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.verdict).toBe("OFFICIAL");
  });

  it("classifies a rule-source failure", async () => {
    const chain = new MockChainDataSource({});
    const rules = new MockRiskRuleSource({});
    rules.fail = true;
    const intel = new AddressIntel({ chain, rules, now: () => NOW });
    const out = await intel.assessCounterparty(SCAM);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.unavailableSource).toBe("RiskRuleSource");
  });

  it("degrades to a rule-only verdict when the chain source is down", async () => {
    const chain = new MockChainDataSource({});
    chain.fail.contractMeta = true;
    const rules = new MockRiskRuleSource({ [SCAM]: { blacklisted: true, label: "Drainer" } });
    const intel = new AddressIntel({ chain, rules, now: () => NOW });
    const out = await intel.analyze(SCAM);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // The curated blacklist alone is enough to flag it dangerous without on-chain metadata.
      expect(out.result.verdict).toBe("DANGEROUS");
      expect(out.result.reasons.some((r) => r.includes("metadata was unavailable"))).toBe(true);
    }
  });
});
