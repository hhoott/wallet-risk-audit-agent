import { describe, it, expect } from "vitest";

import type { AuditRunner } from "../src/cap/provider.js";
import { OrchestratorLocalAuditor } from "../src/portal/local-auditor.js";
import { AuditSkillSet, type ChatModel } from "../src/llm/skills.js";
import type {
  AddressInspection,
  WalletActivity,
  AuditReportStructured,
  AuditReport,
  ModuleStatus,
} from "../src/models.js";

const ADDRESS = "0x" + "e".repeat(40);
const SPENDER = "0x" + "f".repeat(40);
const ISO = "2026-06-10T00:00:00.000Z";

function structuredWithPrecomputedStanding(): AuditReportStructured {
  return {
    schemaVersion: "1.0.0",
    walletAddress: ADDRESS,
    auditedChain: "Ethereum Mainnet",
    auditedChainKey: "ethereum",
    generatedAt: ISO,
    tier: "FULL",
    readOnlyDeclaration: "read-only",
    healthScore: 72,
    healthGrade: "GOOD",
    riskLevelSummary: "MEDIUM",
    addressStanding: {
      address: ADDRESS,
      type: "CONTRACT",
      verdict: "DANGEROUS",
      riskLevel: "CRITICAL",
      official: false,
      blacklisted: true,
      badge: {
        level: "DANGEROUS",
        label: "Dangerous",
        description: "Precomputed field that must not be sent to the classifier evidence.",
      },
      reasons: ["This stale standing should be stripped from LLM evidence."],
    },
    scoredOnIncompleteData: false,
    approvals: [
      {
        tokenContract: "0x" + "a".repeat(40),
        spender: SPENDER,
        spenderLabel: "Unknown",
        kind: "ERC20",
        allowance: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        isUnlimited: true,
        lastUpdated: ISO,
      },
    ],
    contractRisks: [],
    assets: null,
    txFindings: [],
    revokeAdvice: [],
    moduleStatuses: [],
  };
}

class CapturingModel implements ChatModel {
  classifyPrompt = "";

  complete(_systemPrompt: string, userPrompt: string, label = "call"): Promise<string> {
    if (label === "classifyAddressEvidence") {
      this.classifyPrompt = userPrompt;
      return Promise.resolve(
        JSON.stringify({
          address: ADDRESS,
          verdict: "OFFICIAL",
          riskLevel: "LOW",
          badge: {
            level: "OFFICIAL",
            label: "Official verified",
            description: "Explorer metadata and transaction evidence support an official service.",
          },
          official: true,
          blacklisted: false,
          label: "Example Router",
          confidence: "HIGH",
          reasons: ["Contract metadata is verified and named ExampleRouter in the evidence log."],
          approvalRisks: ["Unlimited approval evidence was present and reviewed."],
          transactionRisks: [],
          evidenceUsed: ["auditEvidence.approvals[0]", "typeFacts.contractMeta.contractName"],
        }),
      );
    }
    return Promise.resolve("AI markdown grounded in the supplied evidence.");
  }
}

class FakeRunner implements AuditRunner {
  auditWallet(): Promise<{
    report: AuditReport;
    statuses: ModuleStatus[];
    tier: "FULL";
    windowDays: number;
    healthScore: { score: number; grade: "GOOD"; incomplete: boolean };
  }> {
    const structured = structuredWithPrecomputedStanding();
    return Promise.resolve({
      report: { structured, humanReadable: "# Report" },
      statuses: [],
      tier: "FULL",
      windowDays: 90,
      healthScore: { score: 72, grade: "GOOD", incomplete: false },
    });
  }

  auditMultipleWallets(): Promise<{ multi: { schemaVersion: string; walletCount: number; reports: AuditReportStructured[] }; perWallet: [] }> {
    return Promise.resolve({ multi: { schemaVersion: "1.0.0", walletCount: 0, reports: [] }, perWallet: [] });
  }

  inspectAddress(): Promise<AddressInspection> {
    return Promise.resolve({
      address: ADDRESS,
      type: "CONTRACT",
      intel: {
        address: ADDRESS,
        isContract: true,
        official: false,
        blacklisted: false,
        verdict: "CAUTION",
        riskLevel: "MEDIUM",
        badge: {
          level: "CAUTION",
          label: "Use caution",
          description: "Fallback standing before LLM evidence classification.",
        },
        matchedFeatures: ["NO_AUDIT"],
        reasons: ["Fallback scanner warning."],
        meta: {
          contract: ADDRESS,
          name: "ExampleRouter",
          verified: true,
          deployedAt: "2024-01-01T00:00:00.000Z",
          txCount: 12000,
          audited: false,
          isContract: true,
        },
      },
      facts: {
        address: ADDRESS,
        type: "CONTRACT",
        contractMeta: {
          contractName: "ExampleRouter",
          verified: true,
          deployedAt: "2024-01-01T00:00:00.000Z",
          txCount: 12000,
          audited: false,
          isContract: true,
        },
        scannerWarnings: ["NO_AUDIT"],
      },
    });
  }

  walletActivity(): Promise<WalletActivity> {
    return Promise.resolve({
      windowDays: 90,
      analyzedCount: 1,
      records: [
        {
          txHash: "0xhash",
          timestamp: ISO,
          direction: "OUT",
          counterparty: SPENDER,
          counterpartyIsContract: true,
          success: true,
          valueEth: "0",
          valueUsd: null,
          flags: ["CONTRACT"],
        },
      ],
      counterparties: [
        {
          address: SPENDER,
          interactions: 1,
          isContract: true,
          official: false,
          blacklisted: false,
        },
      ],
    });
  }
}

function extractEvidence(prompt: string): Record<string, unknown> {
  const match = prompt.match(/Evidence JSON:\n([\s\S]*?)\n\nReturn ONLY a JSON object/);
  if (!match?.[1]) throw new Error("Missing evidence JSON in prompt.");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("OrchestratorLocalAuditor LLM evidence classification", () => {
  it("classifies from sanitized evidence and applies aiVerdict to addressStanding", async () => {
    const model = new CapturingModel();
    const auditor = new OrchestratorLocalAuditor(new FakeRunner(), new AuditSkillSet(model));

    const result = await auditor.audit("FULL", [ADDRESS]);
    const intel = result.addressIntel?.[0];

    expect(intel?.aiVerdict?.badge.level).toBe("OFFICIAL");
    expect(intel?.evidenceLog).toBeDefined();
    expect(result.structured).not.toHaveProperty("reports");
    if ("reports" in result.structured) throw new Error("Expected a single report.");
    expect(result.structured.addressStanding?.badge.level).toBe("OFFICIAL");
    expect(result.structured.addressStanding?.label).toBe("Example Router");

    const evidence = extractEvidence(model.classifyPrompt);
    expect(JSON.stringify(evidence)).not.toContain("addressStanding");
    expect(JSON.stringify(evidence)).not.toContain("Precomputed field");
    expect(evidence).toHaveProperty("auditEvidence");
    expect(evidence).toHaveProperty("typeFacts");
    expect(JSON.stringify(evidence)).toContain("approvals");
    expect(JSON.stringify(evidence)).toContain("ExampleRouter");
  });
});
