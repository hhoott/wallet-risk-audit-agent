import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_SERVICE_TIER,
  TIER_PRICE_USDC,
  buildServiceTierMap,
  loadConfig,
  MissingConfigError,
} from "../src/config.js";

describe("toolchain smoke", () => {
  it("fast-check runs inside vitest", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 },
    );
  });

  it("tier pricing is correct", () => {
    expect(TIER_PRICE_USDC.QUICK).toBe(0.5);
    expect(TIER_PRICE_USDC.FULL).toBe(0.01);
    expect(TIER_PRICE_USDC.MULTI).toBe(5);
  });

  it("loadConfig throws when CROO_SDK_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(MissingConfigError);
  });

  it("buildServiceTierMap maps the single configured service to the default tier", () => {
    const cfg = loadConfig({ CROO_SDK_KEY: "croo_sk_test", SERVICE_ID: "svc_address_intel" });
    const map = buildServiceTierMap(cfg);
    expect(map.get("svc_address_intel")).toBe(DEFAULT_SERVICE_TIER);
    expect(map.size).toBe(1);
  });
});
