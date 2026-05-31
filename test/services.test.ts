import { describe, it, expect } from "vitest";
import {
  SERVICE_CATALOG,
  getServiceMetadata,
  serviceIdForTier,
  resolveServiceTierMap,
} from "../src/services.js";
import { TIER_PRICE_USDC, loadConfig, type Tier } from "../src/config.js";

const TIERS: Tier[] = ["QUICK", "FULL", "MULTI"];

describe("Service catalog (task 15)", () => {
  it("each tier has metadata with 1-5 skill tags and the correct USDC price", () => {
    for (const tier of TIERS) {
      const meta = getServiceMetadata(tier);
      expect(meta.tier).toBe(tier);
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.skillTags.length).toBeGreaterThanOrEqual(1);
      expect(meta.skillTags.length).toBeLessThanOrEqual(5);
      expect(meta.priceUsdc).toBe(TIER_PRICE_USDC[tier]);
      expect(meta.auditedChain).toBe("Ethereum Mainnet");
    }
  });

  it("catalog covers exactly the three tiers", () => {
    expect(Object.keys(SERVICE_CATALOG).sort()).toEqual(["FULL", "MULTI", "QUICK"]);
  });

  it("serviceIdForTier reads injected env-backed config and is absent when unconfigured", () => {
    const config = loadConfig({
      CROO_SDK_KEY: "croo_sk_test",
      SERVICE_ID_QUICK: "svc_q",
      SERVICE_ID_FULL: "svc_f",
    });
    expect(serviceIdForTier("QUICK", config)).toBe("svc_q");
    expect(serviceIdForTier("FULL", config)).toBe("svc_f");
    expect(serviceIdForTier("MULTI", config)).toBeUndefined();
  });

  it("resolveServiceTierMap maps configured service ids back to their tiers", () => {
    const config = loadConfig({
      CROO_SDK_KEY: "croo_sk_test",
      SERVICE_ID_QUICK: "svc_q",
      SERVICE_ID_FULL: "svc_f",
      SERVICE_ID_MULTI: "svc_m",
    });
    const map = resolveServiceTierMap(config);
    expect(map.get("svc_q")).toBe("QUICK");
    expect(map.get("svc_f")).toBe("FULL");
    expect(map.get("svc_m")).toBe("MULTI");
    expect(map.size).toBe(3);
  });
});
