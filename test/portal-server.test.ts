import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

import { createPortalServer, type CheckoutClientFactory } from "../src/portal/server.js";
import type { PortalConfig } from "../src/portal/config.js";
import type { LocalAuditor, AuditEngineResult } from "../src/portal/local-auditor.js";
import type { CheckoutCapClient } from "../src/portal/cap-checkout.js";
import type { AuditReportStructured } from "../src/models.js";

const WALLET = "0x" + "a".repeat(40);

function config(mode: "free" | "paid", withServiceIds = true, allowCrooKey = false): PortalConfig {
  return {
    port: 0,
    crooApiUrl: "https://api.test",
    crooWsUrl: "wss://api.test/ws",
    serviceIds: withServiceIds ? { QUICK: "svc-quick", FULL: "svc-full", MULTI: "svc-multi" } : {},
    orderTimeoutMs: 5000,
    paymentMode: mode,
    allowCrooKey,
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

/** A stub in-process audit engine returning a fixed report. */
class FakeAuditor implements LocalAuditor {
  audit(_tier: string, _addresses: string[]): Promise<AuditEngineResult> {
    return Promise.resolve({
      orderId: "local-123",
      structured: structured(),
      humanReadable: "# Report",
      decision: { proceed: true, reason: "ok", riskLevel: "LOW" as const, healthScore: 88 },
    });
  }
  vetAddress(address: string) {
    return Promise.resolve({
      ok: true,
      result: {
        address,
        verdict: "OFFICIAL",
        riskLevel: "LOW",
        official: true,
        blacklisted: false,
      },
    });
  }
}

/**
 * A fake CAP client driving the checkout: negotiate → (order appears) → pay → (completed) → deliver.
 * `behavior` controls success vs a specific failure.
 */
function fakeCheckoutFactory(behavior: "ok" | "bad-key" | "no-funds"): CheckoutClientFactory {
  return (crooKey: string) => {
    if (behavior === "bad-key") {
      const client: CheckoutCapClient = {
        negotiateOrder: () =>
          Promise.reject(Object.assign(new Error("unauthorized"), { code: 401 })),
        listOrders: () => Promise.resolve([]),
        getOrder: () => Promise.resolve({ orderId: "o1", status: "created" }),
        payOrder: () => Promise.resolve({ txHash: "0xtx" }),
        getDelivery: () => Promise.resolve({}),
      };
      return Promise.resolve(client);
    }
    // ok / no-funds share negotiate + order creation; differ at payOrder.
    const client: CheckoutCapClient = {
      negotiateOrder: () => Promise.resolve({ negotiationId: "neg-1" }),
      listOrders: () =>
        Promise.resolve([{ orderId: "ord-9", negotiationId: "neg-1", status: "created" }]),
      getOrder: () =>
        Promise.resolve({ orderId: "ord-9", status: "completed", payTxHash: "0xpay" }),
      payOrder: () => {
        if (behavior === "no-funds") {
          return Promise.reject(Object.assign(new Error("insufficient balance"), { code: 402 }));
        }
        return Promise.resolve({ txHash: "0xpay" });
      },
      getDelivery: () =>
        Promise.resolve({
          deliverableSchema: JSON.stringify(structured()),
          deliverableText: "# CAP report",
        }),
    };
    expect(crooKey).toBeTypeOf("string");
    return Promise.resolve(client);
  };
}

function startServer(
  cfg: PortalConfig,
  auditor: LocalAuditor,
  checkoutClientFactory?: CheckoutClientFactory,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createPortalServer({
    config: cfg,
    auditor,
    checkoutClientFactory,
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

/** POST /api/orders as plain JSON (no streaming). */
async function postOrder(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

describe("portal server — static + tiers", () => {
  let srv: { base: string; close: () => Promise<void> };
  beforeAll(async () => {
    srv = await startServer(config("free"), new FakeAuditor());
  });
  afterAll(async () => {
    await srv.close();
  });

  it("GET /api/health returns ok", async () => {
    const res = await fetch(`${srv.base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /api/tiers lists tiers + payment mode", async () => {
    const res = await fetch(`${srv.base}/api/tiers`);
    const data = await res.json();
    expect(data.paymentMode).toBe("free");
    const byTier = Object.fromEntries(data.tiers.map((t: { tier: string }) => [t.tier, t]));
    expect(byTier.QUICK.available).toBe(true);
    expect(byTier.QUICK.priceUsdc).toBe(0.5);
  });

  it("GET / serves the HTML shell", async () => {
    const res = await fetch(`${srv.base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Wallet Risk Audit");
  });

  it("404 for unknown paths", async () => {
    expect((await fetch(`${srv.base}/nope`)).status).toBe(404);
  });
});

describe("portal server — validation", () => {
  it("rejects an invalid address with 400", async () => {
    const srv = await startServer(config("free"), new FakeAuditor());
    try {
      const { status } = await postOrder(srv.base, { tier: "FULL", walletAddress: "0xnope" });
      expect(status).toBe(400);
    } finally {
      await srv.close();
    }
  });

  it("rejects an unknown tier with 400", async () => {
    const srv = await startServer(config("free"), new FakeAuditor());
    try {
      const { status } = await postOrder(srv.base, { tier: "NOPE", walletAddress: WALLET });
      expect(status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});

describe("portal server — free mode (no key)", () => {
  it("returns a local report when no key is supplied", async () => {
    const srv = await startServer(config("free"), new FakeAuditor());
    try {
      const { status, data } = await postOrder(srv.base, { tier: "FULL", walletAddress: WALLET });
      expect(status).toBe(200);
      expect(data.paid).toBe(false);
      expect(data.paymentBypassed).toBe(true);
      expect(data.structured.walletAddress).toBe(WALLET);
    } finally {
      await srv.close();
    }
  });
});

describe("portal server — paid mode (no key)", () => {
  it("refuses with 402 asking for a key", async () => {
    const srv = await startServer(config("paid"), new FakeAuditor());
    try {
      const { status, data } = await postOrder(srv.base, { tier: "FULL", walletAddress: WALLET });
      expect(status).toBe(402);
      expect(data.code).toBe("PAYMENT_REQUIRED");
    } finally {
      await srv.close();
    }
  });
});

describe("portal server — CAP checkout with a key", () => {
  it("settles over CAP and returns the delivered report (paid=true)", async () => {
    const srv = await startServer(
      config("paid", true, true),
      new FakeAuditor(),
      fakeCheckoutFactory("ok"),
    );
    try {
      const { status, data } = await postOrder(srv.base, {
        tier: "FULL",
        walletAddress: WALLET,
        crooKey: "croo_sk_test",
      });
      expect(status).toBe(200);
      expect(data.paid).toBe(true);
      expect(data.payTxHash).toBe("0xpay");
      expect(data.orderId).toBe("ord-9");
    } finally {
      await srv.close();
    }
  });

  it("paid mode: a bad key fails with 402 (no fallback)", async () => {
    const srv = await startServer(
      config("paid", true, true),
      new FakeAuditor(),
      fakeCheckoutFactory("bad-key"),
    );
    try {
      const { status, data } = await postOrder(srv.base, {
        tier: "FULL",
        walletAddress: WALLET,
        crooKey: "bad",
      });
      expect(status).toBe(402);
      expect(data.code).toBe("UNAUTHORIZED");
    } finally {
      await srv.close();
    }
  });

  it("free mode: an empty-wallet payment failure falls back to a local report", async () => {
    const srv = await startServer(
      config("free", true, true),
      new FakeAuditor(),
      fakeCheckoutFactory("no-funds"),
    );
    try {
      const { status, data } = await postOrder(srv.base, {
        tier: "FULL",
        walletAddress: WALLET,
        crooKey: "croo_sk_test",
      });
      expect(status).toBe(200);
      expect(data.paid).toBe(false);
      expect(data.paymentBypassed).toBe(true);
      expect(data.paymentNote).toContain("INSUFFICIENT_BALANCE");
    } finally {
      await srv.close();
    }
  });

  it("refuses a CROO-key order with 403 when the switch is OFF (paid mode)", async () => {
    // allowCrooKey defaults to false here; the demo capability is disabled.
    const srv = await startServer(
      config("paid", true, false),
      new FakeAuditor(),
      fakeCheckoutFactory("ok"),
    );
    try {
      const { status, data } = await postOrder(srv.base, {
        tier: "FULL",
        walletAddress: WALLET,
        method: "cap",
        crooKey: "croo_sk_test",
      });
      expect(status).toBe(403);
      expect(data.code).toBe("CROO_KEY_DISABLED");
    } finally {
      await srv.close();
    }
  });

  it("free mode: a CROO-key order with the switch OFF still returns a local report (not 403)", async () => {
    const srv = await startServer(
      config("free", true, false),
      new FakeAuditor(),
      fakeCheckoutFactory("ok"),
    );
    try {
      const { status, data } = await postOrder(srv.base, {
        tier: "FULL",
        walletAddress: WALLET,
        method: "cap",
        crooKey: "croo_sk_test",
      });
      expect(status).toBe(200);
      expect(data.paid).toBe(false);
      expect(data.paymentBypassed).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe("portal server — SSE streaming", () => {
  it("streams progress events then a result event", async () => {
    const srv = await startServer(
      config("paid", true, true),
      new FakeAuditor(),
      fakeCheckoutFactory("ok"),
    );
    try {
      const res = await fetch(`${srv.base}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "FULL",
          walletAddress: WALLET,
          crooKey: "croo_sk_test",
          stream: true,
        }),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: progress");
      expect(text).toContain("event: result");
      expect(text).toContain("paying");
    } finally {
      await srv.close();
    }
  });
});

describe("portal server — MetaMask payment", () => {
  /** A stub verifier that approves only a specific tx hash. */
  function verifier(goodHash: string) {
    return {
      verify: (txHash: string) =>
        Promise.resolve(
          txHash === goodHash
            ? { paid: true, reason: "ok", amountUsdc: 2 }
            : { paid: false, reason: "Insufficient USDC to our address." },
        ),
    };
  }

  it("paid mode: verified MetaMask tx returns the report (paid=true, method=metamask)", async () => {
    const server = createPortalServer({
      config: { ...config("paid"), payeeAddress: "0x" + "1".repeat(40) },
      auditor: new FakeAuditor(),
      paymentVerifier: verifier("0xgood"),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const srv = await new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          base: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
    try {
      const { status, data } = await postOrder(srv.base, {
        tier: "FULL",
        walletAddress: WALLET,
        method: "metamask",
        payTxHash: "0xgood",
      });
      expect(status).toBe(200);
      expect(data.paid).toBe(true);
      expect(data.paymentMethod).toBe("metamask");
      expect(data.payTxHash).toBe("0xgood");
    } finally {
      await srv.close();
    }
  });

  it("paid mode: an unverifiable MetaMask tx is refused with 402", async () => {
    const server = createPortalServer({
      config: { ...config("paid"), payeeAddress: "0x" + "1".repeat(40) },
      auditor: new FakeAuditor(),
      paymentVerifier: verifier("0xgood"),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const srv = await new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          base: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
    try {
      const { status, data } = await postOrder(srv.base, {
        tier: "FULL",
        walletAddress: WALLET,
        method: "metamask",
        payTxHash: "0xbad",
      });
      expect(status).toBe(402);
      expect(data.code).toBe("PAYMENT_NOT_VERIFIED");
    } finally {
      await srv.close();
    }
  });

  it("/api/tiers advertises the MetaMask payee when configured", async () => {
    const server = createPortalServer({
      config: { ...config("paid"), payeeAddress: "0x" + "1".repeat(40) },
      auditor: new FakeAuditor(),
      paymentVerifier: verifier("0xgood"),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const srv = await new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          base: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
    try {
      const data = await (await fetch(`${srv.base}/api/tiers`)).json();
      expect(data.metamask.enabled).toBe(true);
      expect(data.metamask.chainId).toBe(8453);
    } finally {
      await srv.close();
    }
  });
});

describe("portal server — /api/vet (extended target)", () => {
  it("vets an address and returns the intel verdict", async () => {
    const srv = await startServer(config("free"), new FakeAuditor());
    try {
      const res = await fetch(`${srv.base}/api/vet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: WALLET }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.intel.verdict).toBe("OFFICIAL");
    } finally {
      await srv.close();
    }
  });

  it("rejects an invalid address with 400", async () => {
    const srv = await startServer(config("free"), new FakeAuditor());
    try {
      const res = await fetch(`${srv.base}/api/vet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: "0xnope" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});
