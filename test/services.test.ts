import { describe, it, expect } from "vitest";
import {
  SERVICE_CATALOG,
  getServiceMetadata,
  serviceIdForTier,
  resolveServiceTierMap,
} from "../src/services.js";
import { DEFAULT_SERVICE_TIER, TIER_PRICE_USDC, loadConfig } from "../src/config.js";

describe("Service catalog (task 15)", () => {
  it("single external service has metadata with 1-5 skill tags and the default USDC price", () => {
    const meta = getServiceMetadata(DEFAULT_SERVICE_TIER);
    expect(meta.tier).toBe(DEFAULT_SERVICE_TIER);
    expect(meta.name).toBe("Web3 Address Intel Report");
    expect(meta.description.length).toBeGreaterThan(0);
    expect(meta.skillTags.length).toBeGreaterThanOrEqual(1);
    expect(meta.skillTags.length).toBeLessThanOrEqual(5);
    expect(meta.priceUsdc).toBe(TIER_PRICE_USDC[DEFAULT_SERVICE_TIER]);
    expect(meta.auditedChain).toContain("EVM multi-chain");
  });

  it("catalog exposes exactly one bookable service", () => {
    expect(Object.keys(SERVICE_CATALOG)).toEqual([DEFAULT_SERVICE_TIER]);
  });

  it("serviceIdForTier reads the single injected service id", () => {
    const config = loadConfig({
      CROO_SDK_KEY: "croo_sk_test",
      SERVICE_ID: "svc_address_intel",
    });
    expect(serviceIdForTier("FULL", config)).toBe("svc_address_intel");
    expect(serviceIdForTier("QUICK", config)).toBeUndefined();
    expect(serviceIdForTier("MULTI", config)).toBeUndefined();
  });

  it("resolveServiceTierMap maps the configured service id to the default analysis depth", () => {
    const config = loadConfig({
      CROO_SDK_KEY: "croo_sk_test",
      SERVICE_ID: "svc_address_intel",
    });
    const map = resolveServiceTierMap(config);
    expect(map.get("svc_address_intel")).toBe(DEFAULT_SERVICE_TIER);
    expect(map.size).toBe(1);
  });
});
