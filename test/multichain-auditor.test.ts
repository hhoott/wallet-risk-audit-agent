import { describe, it, expect } from "vitest";

import { MultiChainAuditor } from "../src/portal/multichain-auditor.js";
import type {
  AuditEngineResult,
  AddressVetResult,
  LocalAuditor,
} from "../src/portal/local-auditor.js";

/** A fake per-chain auditor that records the chain key it was built for. */
class FakeChainAuditor implements LocalAuditor {
  constructor(public readonly builtFor: string) {}
  audit(_tier: string, _addresses: string[], chainKey?: string): Promise<AuditEngineResult> {
    return Promise.resolve({
      orderId: `local-${this.builtFor}`,
      structured: { auditedChainKey: chainKey ?? this.builtFor } as never,
      humanReadable: `# ${this.builtFor}`,
      decision: { proceed: true, reason: "ok", riskLevel: "LOW" as const, healthScore: 100 },
    });
  }
  vetAddress(_address: string, chainKey?: string): Promise<AddressVetResult> {
    return Promise.resolve({ ok: true, result: { chain: chainKey ?? this.builtFor } });
  }
}

describe("MultiChainAuditor", () => {
  it("dispatches to a per-chain engine built for the resolved chain key", async () => {
    const built: string[] = [];
    const auditor = new MultiChainAuditor((key) => {
      built.push(key);
      return new FakeChainAuditor(key);
    });

    const eth = await auditor.audit("FULL", ["0x" + "a".repeat(40)], "ethereum");
    expect(eth.orderId).toBe("local-ethereum");

    const base = await auditor.audit("FULL", ["0x" + "a".repeat(40)], "base");
    expect(base.orderId).toBe("local-base");

    expect(built).toEqual(["ethereum", "base"]);
  });

  it("caches each per-chain engine (built once per chain)", async () => {
    const built: string[] = [];
    const auditor = new MultiChainAuditor((key) => {
      built.push(key);
      return new FakeChainAuditor(key);
    });

    await auditor.audit("QUICK", ["0x" + "a".repeat(40)], "arbitrum");
    await auditor.audit("QUICK", ["0x" + "b".repeat(40)], "arbitrum");
    await auditor.vetAddress("0x" + "c".repeat(40), "arbitrum");

    expect(built).toEqual(["arbitrum"]); // built once, reused
  });

  it("resolves aliases / chainIds and defaults blank to ethereum", async () => {
    const built: string[] = [];
    const auditor = new MultiChainAuditor((key) => {
      built.push(key);
      return new FakeChainAuditor(key);
    });

    await auditor.audit("FULL", ["0x" + "a".repeat(40)], "8453"); // chainId for base
    await auditor.audit("FULL", ["0x" + "a".repeat(40)], undefined); // default ethereum

    expect(built).toEqual(["base", "ethereum"]);
  });
});
