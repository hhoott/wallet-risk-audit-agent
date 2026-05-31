import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
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

  it("tier pricing is correct (requirements 4.4–4.6)", () => {
    expect(TIER_PRICE_USDC.QUICK).toBe(0.5);
    expect(TIER_PRICE_USDC.FULL).toBe(2);
    expect(TIER_PRICE_USDC.MULTI).toBe(5);
  });

  it("loadConfig throws when CROO_SDK_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(MissingConfigError);
  });

  it("buildServiceTierMap only includes configured tiers", () => {
    const cfg = loadConfig({ CROO_SDK_KEY: "croo_sk_test", SERVICE_ID_QUICK: "svc_q" });
    const map = buildServiceTierMap(cfg);
    expect(map.get("svc_q")).toBe("QUICK");
    expect(map.size).toBe(1);
  });
});
