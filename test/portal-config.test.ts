import { describe, expect, it } from "vitest";

import { loadPortalConfig, MissingPortalConfigError } from "../src/portal/config.js";

describe("portal config (unified single-process model)", () => {
  it("defaults to free mode (payment result ignored)", () => {
    const cfg = loadPortalConfig({});
    expect(cfg.paymentMode).toBe("free");
    expect(cfg.port).toBe(8787);
  });

  it("honors an explicit paid mode without needing any CAP key", () => {
    // The portal no longer opens its own CAP connection, so no SDK key is required in either mode.
    const cfg = loadPortalConfig({ PORTAL_PAYMENT_MODE: "paid" });
    expect(cfg.paymentMode).toBe("paid");
  });

  it("treats any non-'paid' value as free", () => {
    expect(loadPortalConfig({ PORTAL_PAYMENT_MODE: "anything" }).paymentMode).toBe("free");
    expect(loadPortalConfig({ PORTAL_PAYMENT_MODE: "FREE" }).paymentMode).toBe("free");
    expect(loadPortalConfig({ PORTAL_PAYMENT_MODE: "PAID" }).paymentMode).toBe("paid");
  });

  it("maps configured Service_IDs into the catalog (informational)", () => {
    const cfg = loadPortalConfig({
      SERVICE_ID_QUICK: "svc-q",
      SERVICE_ID_FULL: "svc-f",
      SERVICE_ID_MULTI: "svc-m",
    });
    expect(cfg.serviceIds).toEqual({ QUICK: "svc-q", FULL: "svc-f", MULTI: "svc-m" });
  });

  it("parses PORTAL_PORT and rejects an invalid port", () => {
    expect(loadPortalConfig({ PORTAL_PORT: "9000" }).port).toBe(9000);
    expect(() => loadPortalConfig({ PORTAL_PORT: "not-a-port" })).toThrow(MissingPortalConfigError);
    expect(() => loadPortalConfig({ PORTAL_PORT: "70000" })).toThrow(MissingPortalConfigError);
  });

  it("falls back to a sane order timeout", () => {
    expect(loadPortalConfig({}).orderTimeoutMs).toBe(120_000);
    expect(loadPortalConfig({ PORTAL_ORDER_TIMEOUT_MS: "5000" }).orderTimeoutMs).toBe(5000);
    expect(loadPortalConfig({ PORTAL_ORDER_TIMEOUT_MS: "0" }).orderTimeoutMs).toBe(120_000);
  });
});
