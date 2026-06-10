import { describe, it, expect } from "vitest";

import {
  AuditSkillSet,
  explainRisks,
  remediationPlan,
  answerQuestion,
  classifyAddressEvidence,
  type ChatModel,
} from "../src/llm/skills.js";
import { loadLlmConfig } from "../src/llm/config.js";
import type { AuditReportStructured } from "../src/models.js";

const WALLET = "0x" + "a".repeat(40);

function report(): AuditReportStructured {
  return {
    schemaVersion: "1.0.0",
    walletAddress: WALLET,
    auditedChain: "Ethereum Mainnet",
    generatedAt: "2024-01-01T00:00:00.000Z",
    tier: "FULL",
    readOnlyDeclaration: "read-only secret declaration text",
    healthScore: 42,
    healthGrade: "FAIR",
    riskLevelSummary: "HIGH",
    scoredOnIncompleteData: false,
    approvals: [
      {
        tokenContract: "0x" + "b".repeat(40),
        spender: "0x" + "c".repeat(40),
        spenderLabel: "Unknown",
        kind: "ERC20",
        allowance: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        isUnlimited: true,
        lastUpdated: "2024-01-01T00:00:00.000Z",
      },
    ],
    contractRisks: [],
    assets: null,
    txFindings: [],
    revokeAdvice: [],
    moduleStatuses: [],
  };
}

/** A fake ChatModel that records prompts and returns a canned answer. */
class FakeModel implements ChatModel {
  lastSystem = "";
  lastUser = "";
  complete(systemPrompt: string, userPrompt: string): Promise<string> {
    this.lastSystem = systemPrompt;
    this.lastUser = userPrompt;
    return Promise.resolve("**AI**: explanation grounded in the report.");
  }
}

class JsonModel implements ChatModel {
  lastUser = "";
  complete(_systemPrompt: string, userPrompt: string): Promise<string> {
    this.lastUser = userPrompt;
    return Promise.resolve(JSON.stringify({
      address: WALLET,
      verdict: "DANGEROUS",
      riskLevel: "CRITICAL",
      badge: {
        level: "DANGEROUS",
        label: "Dangerous",
        description: "High-risk evidence found.",
      },
      official: false,
      blacklisted: true,
      confidence: "HIGH",
      reasons: ["Evidence log shows a high-risk approval."],
      approvalRisks: ["Unlimited approval to unknown spender."],
      transactionRisks: [],
      evidenceUsed: ["auditEvidence.approvals[0]"],
    }));
  }
}

class UnsupportedOfficialModel implements ChatModel {
  complete(): Promise<string> {
    return Promise.resolve(JSON.stringify({
      address: WALLET,
      verdict: "OFFICIAL",
      riskLevel: "LOW",
      badge: {
        level: "OFFICIAL",
        label: "Famous wallet",
        description: "Model memory says this is famous.",
      },
      official: true,
      blacklisted: false,
      label: "Famous wallet",
      confidence: "HIGH",
      reasons: ["This is a widely documented public figure address."],
      approvalRisks: [],
      transactionRisks: [],
      evidenceUsed: ["model memory"],
    }));
  }
}

describe("LLM config", () => {
  it("is disabled when no API key is set", () => {
    const cfg = loadLlmConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it("is enabled and reads base url + model from env", () => {
    const cfg = loadLlmConfig({
      LLM_API_KEY: "sk-x",
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_MODEL: "deepseek-chat",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseUrl).toBe("https://api.deepseek.com");
    expect(cfg.model).toBe("deepseek-chat");
  });
});

describe("LLM skills", () => {
  it("explainRisks feeds the report (minus the read-only declaration) to the model", async () => {
    const model = new FakeModel();
    const out = await explainRisks(model, report());
    expect(out).toContain("AI");
    expect(model.lastUser).toContain(WALLET);
    expect(model.lastUser).toContain("HIGH");
    // The verbose read-only declaration is stripped from the prompt payload.
    expect(model.lastUser).not.toContain("read-only secret declaration text");
    // System prompt enforces grounding.
    expect(model.lastSystem.toLowerCase()).toContain("never invent");
  });

  it("remediationPlan asks for a prioritized checklist", async () => {
    const model = new FakeModel();
    await remediationPlan(model, report());
    expect(model.lastUser.toLowerCase()).toContain("action plan");
  });

  it("answerQuestion embeds the user's question", async () => {
    const model = new FakeModel();
    await answerQuestion(model, report(), "why is this approval dangerous?");
    expect(model.lastUser).toContain("why is this approval dangerous?");
  });

  it("AuditSkillSet wraps the model", async () => {
    const skills = new AuditSkillSet(new FakeModel());
    expect(await skills.explainRisks(report())).toContain("AI");
    expect(await skills.remediationPlan(report())).toContain("AI");
    expect(await skills.answerQuestion(report(), "q")).toContain("AI");
  });

  it("classifyAddressEvidence asks the model for structured badge/risk JSON", async () => {
    const model = new JsonModel();
    const verdict = await classifyAddressEvidence(model, {
      address: WALLET,
      auditEvidence: report(),
    });
    expect(verdict.verdict).toBe("DANGEROUS");
    expect(verdict.badge.level).toBe("DANGEROUS");
    expect(verdict.approvalRisks[0]).toContain("Unlimited");
    expect(model.lastUser).toContain("Return ONLY a JSON object");
    expect(model.lastUser).toContain("Evidence JSON");
    expect(model.lastUser).toContain("do not merely restate a precomputed label");
  });

  it("does not apply an official EOA verdict when the evidence lacks an official source label", async () => {
    const verdict = await classifyAddressEvidence(new UnsupportedOfficialModel(), {
      address: WALLET,
      addressInspection: {
        type: "EOA",
        facts: {
          contractMeta: {
            contractName: null,
            verified: false,
            txCount: 10000,
            isContract: false,
          },
          scannerWarnings: [],
        },
      },
      auditEvidence: {
        approvals: [],
        contractRisks: [],
        txFindings: [],
        healthScore: 100,
      },
    });
    expect(verdict.official).toBe(false);
    expect(verdict.verdict).toBe("LIKELY_SAFE");
    expect(verdict.badge.level).toBe("SAFE");
    expect(verdict.label).toBeUndefined();
    expect(verdict.reasons[0]).toContain("lacks an explicit official-source signal");
  });
});
