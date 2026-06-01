import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

import { createPortalServer } from "../src/portal/server.js";
import {
  PortalRequester,
  PortalOrderError,
  type PortalCapClient,
  type PortalCapEventStream,
  type PortalDelivery,
} from "../src/portal/cap-requester.js";
import type { PortalConfig } from "../src/portal/config.js";
import type { AuditReportStructured } from "../src/models.js";

const WALLET = "0x" + "a".repeat(40);

function config(): PortalConfig {
  return {
    port: 0,
    crooApiUrl: "https://api.test",
    crooWsUrl: "wss://api.test/ws",
    crooSdkKey: "test-key",
    serviceIds: { QUICK: "svc-quick", FULL: "svc-full" }, // MULTI intentionally unconfigured
    orderTimeoutMs: 5000,
    paymentMode: "paid",
  };
}

function structured(): AuditReportStructured {
  return {
    schemaVersion: "1.0.0",
    walletAddress: WALLET,
    auditedChain: "Ethereum Mainnet",
    generatedAt: "2024-01-01T00:00:00.000Z",
    tier: "FULL",
    readOnlyDeclaration: "read-only",
    healthScore: 88,
    healthGrade: "EXCELLENT",
    riskLevelSummary: "LOW",
    scoredOnIncompleteData: false,
    approvals: [],
    contractRisks: [],
    assets: null,
    txFindings: [],
    revokeAdvice: [],
    moduleStatuses: [],
  };
}

/** A fake requester whose placeOrder is scripted; bypasses CAP entirely. */
class FakeRequester extends PortalRequester {
  constructor(private readonly behavior: "ok" | "rejected" = "ok") {
    // The base needs a client, but we override placeOrder/connect so it is never used.
    super({} as PortalCapClient);
  }
  override connect(): Promise<void> {
    return Promise.resolve();
  }
  override placeOrder(params: { serviceId: string; walletAddresses: string[] }) {
    if (this.behavior === "rejected") {
      return Promise.reject(new PortalOrderError("rejected by provider", "ORDER_REJECTED"));
    }
    return Promise.resolve({
      orderId: "ord-xyz",
      structured: structured(),
      humanReadable: "# Report",
      decision: { proceed: true, reason: "ok", riskLevel: "LOW" as const, healthScore: 88 },
    });
  }
}

/** Start a server on an ephemeral port and return its base URL + a close fn. */
function startServer(requester: PortalRequester): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createPortalServer({
    config: config(),
    requester,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("portal HTTP server", () => {
  let srv: { base: string; close: () => Promise<void> };

  beforeAll(async () => {
    srv = await startServer(new FakeRequester("ok"));
  });
  afterAll(async () => {
    await srv.close();
  });

  it("GET /api/health returns ok", async () => {
    const res = await fetch(`${srv.base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /api/tiers lists tiers and marks availability from configured Service_IDs", async () => {
    const res = await fetch(`${srv.base}/api/tiers`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const byTier = Object.fromEntries(data.tiers.map((t: { tier: string }) => [t.tier, t]));
    expect(byTier.QUICK.available).toBe(true);
    expect(byTier.FULL.available).toBe(true);
    expect(byTier.MULTI.available).toBe(false); // not configured
    expect(byTier.QUICK.priceUsdc).toBe(0.5);
  });

  it("GET / serves the portal HTML shell", async () => {
    const res = await fetch(`${srv.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Wallet Risk Audit");
  });

  it("GET /assets/styles.css serves CSS", async () => {
    const res = await fetch(`${srv.base}/assets/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("POST /api/orders rejects an invalid address with 400", async () => {
    const res = await fetch(`${srv.base}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "FULL", walletAddress: "0xnotvalid" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("POST /api/orders rejects an unconfigured tier with 400", async () => {
    const res = await fetch(`${srv.base}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "MULTI", walletAddresses: [WALLET] }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/orders returns the report on success", async () => {
    const res = await fetch(`${srv.base}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "FULL", walletAddress: WALLET }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.orderId).toBe("ord-xyz");
    expect(data.tier).toBe("FULL");
    expect(data.structured.walletAddress).toBe(WALLET);
    expect(data.decision.proceed).toBe(true);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${srv.base}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("portal HTTP server — order failure mapping", () => {
  it("maps a PortalOrderError to the right HTTP status", async () => {
    const srv = await startServer(new FakeRequester("rejected"));
    try {
      const res = await fetch(`${srv.base}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "FULL", walletAddress: WALLET }),
      });
      expect(res.status).toBe(422); // ORDER_REJECTED → 422
      const data = await res.json();
      expect(data.code).toBe("ORDER_REJECTED");
    } finally {
      await srv.close();
    }
  });
});

// ── Free mode ───────────────────────────────────────────────────────────────────────────

import type { LocalAuditor } from "../src/portal/local-auditor.js";

/** A stub local auditor that returns a fixed unpaid result. */
class FakeLocalAuditor implements LocalAuditor {
  audit(_tier: string, _addresses: string[]) {
    return Promise.resolve({
      orderId: "local-123",
      structured: structured(),
      humanReadable: "# Local report",
      decision: { proceed: true, reason: "ok", riskLevel: "LOW" as const, healthScore: 88 },
    });
  }
}

function freeConfig(withServiceIds: boolean): PortalConfig {
  return {
    port: 0,
    crooApiUrl: "https://api.test",
    crooWsUrl: "wss://api.test/ws",
    crooSdkKey: "",
    serviceIds: withServiceIds ? { FULL: "svc-full" } : {},
    orderTimeoutMs: 1000,
    paymentMode: "free",
  };
}

function startFreeServer(
  cfg: PortalConfig,
  requester: PortalRequester,
  localAuditor: LocalAuditor,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createPortalServer({
    config: cfg,
    requester,
    localAuditor,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("portal HTTP server — free mode", () => {
  it("falls back to a local audit when the paid CAP flow fails", async () => {
    const srv = await startFreeServer(freeConfig(true), new FakeRequester("rejected"), new FakeLocalAuditor());
    try {
      const res = await fetch(`${srv.base}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "FULL", walletAddress: WALLET }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.paid).toBe(false);
      expect(data.orderId).toBe("local-123");
      expect(data.fallbackReason).toContain("ORDER_REJECTED");
      expect(data.structured.walletAddress).toBe(WALLET);
    } finally {
      await srv.close();
    }
  });

  it("runs a local audit directly when a tier has no Service_ID (skips CAP)", async () => {
    // The requester would throw if called; the direct local path must avoid it.
    const neverRequester = new FakeRequester("rejected");
    const srv = await startFreeServer(freeConfig(false), neverRequester, new FakeLocalAuditor());
    try {
      const res = await fetch(`${srv.base}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "FULL", walletAddress: WALLET }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.paid).toBe(false);
      expect(data.orderId).toBe("local-123");
    } finally {
      await srv.close();
    }
  });

  it("marks all tiers available and reports paymentMode=free in /api/tiers", async () => {
    const srv = await startFreeServer(freeConfig(false), new FakeRequester("ok"), new FakeLocalAuditor());
    try {
      const res = await fetch(`${srv.base}/api/tiers`);
      const data = await res.json();
      expect(data.paymentMode).toBe("free");
      for (const t of data.tiers) expect(t.available).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("still returns a PAID result (paid=true) when the CAP flow succeeds in free mode", async () => {
    const srv = await startFreeServer(freeConfig(true), new FakeRequester("ok"), new FakeLocalAuditor());
    try {
      const res = await fetch(`${srv.base}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "FULL", walletAddress: WALLET }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.paid).toBe(true);
      expect(data.orderId).toBe("ord-xyz");
    } finally {
      await srv.close();
    }
  });
});
