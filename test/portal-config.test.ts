import { describe, expect, it } from "vitest";

import {
  loadPortalConfig,
  MissingPortalConfigError,
} from "../src/portal/config.js";

describe("portal config", () => {
  it("defaults to free mode so an unfunded requester can still continue", () => {
    const cfg = loadPortalConfig({ CROO_SDK_KEY: "provider-key" });

    expect(cfg.paymentMode).toBe("free");
    expect(cfg.crooSdkKey).toBe("");
  });

  it("uses an explicit portal requester key in free mode when one is provided", () => {
    const cfg = loadPortalConfig({
      CROO_SDK_KEY: "provider-key",
      PORTAL_CROO_SDK_KEY: "requester-key",
    });

    expect(cfg.paymentMode).toBe("free");
    expect(cfg.crooSdkKey).toBe("requester-key");
  });

  it("requires requester credentials only in explicit paid mode", () => {
    expect(() => loadPortalConfig({ PORTAL_PAYMENT_MODE: "paid" })).toThrow(
      MissingPortalConfigError,
    );

    const cfg = loadPortalConfig({
      PORTAL_PAYMENT_MODE: "paid",
      PORTAL_CROO_SDK_KEY: "croo_sk_test",
    });
    expect(cfg.paymentMode).toBe("paid");
    expect(cfg.crooSdkKey).toBe("croo_sk_test");
  });
});
