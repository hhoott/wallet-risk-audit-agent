/**
 * Audit engine adapter for the web/API portal.
 *
 * In the unified single-process model the portal runs the SAME read-only audit the CAP Provider
 * runs — in-process, via the Provider's own {@link AuditRunner} (orchestrator). This adapter wraps
 * that engine behind a small {@link LocalAuditor} interface the HTTP server depends on, so the
 * server stays decoupled from the CAP/SDK types.
 *
 * It reuses the exported {@link runAudit} (the exact logic the Provider runs on a paid order) and
 * derives the same A2A decision (Risk_Level / Health_Score gating) the example Requester would.
 *
 * AI insight (optional): when an {@link AuditSkillSet} is injected, the single service is enriched
 * with an LLM-generated structured verdict plus plain-language risk explanation. The scanner report
 * is produced first as evidence; the LLM layer assigns the final official/risk badge from that log.
 *
 * Security: strictly read-only — it only consumes the injected read-only data sources and the pure
 * analysis modules; there is no signing / send-transaction path.
 */

import type { Tier } from "../config.js";
import { runAudit, type AuditRunner } from "../cap/provider.js";
import { decideFromDelivery, type AuditDecision } from "../examples/requester.js";
import type {
  AuditReportStructured,
  MultiWalletReport,
  AddressType,
  AddressBadge,
  AddressVerdict,
  RiskLevel,
  WalletActivity,
  RelatedAddressAnalysis,
  AddressStanding,
} from "../models.js";
import type { AuditSkillSet, LlmAddressVerdict } from "../llm/skills.js";
import type { TokenContractInfo } from "../datasource/types.js";
import { DEFAULT_CHAIN, type ChainDescriptor } from "../chains.js";
import { buildAddressStanding } from "../modules/address-intel.js";

/** One audited address's type-aware inspection (scanner evidence + optional AI assessment). */
export interface AddressIntelEntry {
  address: string;
  type: AddressType;
  verdict: AddressVerdict;
  riskLevel: RiskLevel;
  official: boolean;
  blacklisted: boolean;
  label?: string;
  badge: AddressBadge;
  reasons: string[];
  /** Token security signals, present only for ERC-20 token contracts. */
  token?: TokenContractInfo;
  /** Type-specific AI assessment (Markdown), present when an LLM is configured. */
  aiAssessment?: string;
  /** Structured LLM classification derived from the evidence log. */
  aiVerdict?: LlmAddressVerdict;
  /** The fact/evidence log that was given to the LLM. */
  evidenceLog?: unknown;
  /**
   * Annotated transaction records + ranked counterparties — present for EOA wallets on FULL/MULTI
   * (QUICK stays lean and does not fetch transaction history).
   */
  activity?: WalletActivity;
  /**
   * Deeper analysis of addresses related to this one (MULTI tier only): the wallet's top transaction
   * counterparties (each with its own type + risk verdict), or a token/contract's owner address.
   */
  related?: RelatedAddressAnalysis[];
}

/** AI-generated insight attached to a report (best-effort; absent when the LLM is unconfigured). */
export interface AiInsight {
  /** Plain-language explanation of the findings (Markdown). */
  explanation?: string;
  /** Prioritized remediation checklist (Markdown). */
  remediation?: string;
  /** Set when AI was requested but failed (so the UI can note it without breaking). */
  error?: string;
}

/** Result of an in-process audit run (no CAP order / payment involved). */
export interface AuditEngineResult {
  /** An identifier for this run (local, not a CAP order id). */
  orderId: string;
  /** Machine-readable structured report (single wallet) or multi-wallet summary. */
  structured: AuditReportStructured | MultiWalletReport;
  /** Human-readable Markdown report. */
  humanReadable: string;
  /** A2A gating decision derived from Risk_Level / Health_Score (proceed / abort). */
  decision: AuditDecision;
  /** Optional AI insight when an LLM is configured. */
  ai?: AiInsight;
  /**
   * Per-audited-address, type-aware intelligence (type detection + verdict + token signals + an
   * optional type-specific AI assessment), produced automatically alongside the wallet audit.
   */
  addressIntel?: AddressIntelEntry[];
}

/** Runs the read-only wallet audit in-process and returns a report. */
export interface LocalAuditor {
  /** Audit one or more addresses at a tier on the given chain key (defaults to "ethereum"). */
  audit(tier: Tier, addresses: string[], chainKey?: string): Promise<AuditEngineResult>;
  /** Vet an address / assess a counterparty (extended target). Returns the structured result. */
  vetAddress(address: string, chainKey?: string): Promise<AddressVetResult>;
}

/** Result of an address-vetting / counterparty check (server-facing shape). */
export interface AddressVetResult {
  ok: boolean;
  /** The structured intel when ok; an error reason otherwise. */
  result?: unknown;
  reason?: string;
  /** Optional AI explanation of the verdict (premium). */
  ai?: AiInsight;
}

/** Tiers that receive AI insight (the premium value-add). QUICK stays lean + cheap. */
const AI_TIERS: ReadonlySet<Tier> = new Set<Tier>(["FULL", "MULTI"]);

/**
 * Tiers that fetch annotated transaction history (the per-counterparty "target situation" view).
 * QUICK omits it to stay lean and cheap; FULL and MULTI include it.
 */
const ACTIVITY_TIERS: ReadonlySet<Tier> = new Set<Tier>(["FULL", "MULTI"]);

/**
 * Tiers that run the deeper RELATED-address analysis (the top tier's headline value-add): for a
 * wallet, the most-interacted counterparties are themselves typed + risk-assessed; for a token /
 * contract, its owner address is. MULTI only.
 */
const RELATED_TIERS: ReadonlySet<Tier> = new Set<Tier>(["MULTI"]);

/** How many of a wallet's top counterparties to deeply analyze at the MULTI tier. */
const MAX_RELATED_COUNTERPARTIES = 5;

function auditEvidenceForAddress(
  structured: AuditReportStructured | MultiWalletReport,
  address: string,
): unknown {
  const key = address.toLowerCase();
  const report =
    "reports" in structured
      ? structured.reports.find((r) => r.walletAddress.toLowerCase() === key)
      : structured.walletAddress.toLowerCase() === key
        ? structured
        : undefined;
  return JSON.parse(
    JSON.stringify(report ?? structured, (field, value) => {
      // The LLM should classify from evidence fields, not echo a previously assigned standing.
      if (field === "addressStanding") return undefined;
      return value;
    }),
  );
}

/** A {@link LocalAuditor} backed by the agent's real orchestrator (shared in the unified process). */
export class OrchestratorLocalAuditor implements LocalAuditor {
  constructor(
    private readonly orchestrator: AuditRunner,
    /** Optional AI skill set; when present, reports are enriched with LLM insight. */
    private readonly skills?: AuditSkillSet,
    /** The audited chain (injected into AI prompts so the model knows which chain it's analyzing). */
    private readonly chain: ChainDescriptor = DEFAULT_CHAIN,
  ) {}

  async audit(tier: Tier, addresses: string[], _chainKey?: string): Promise<AuditEngineResult> {
    const deliverable = await runAudit(this.orchestrator, tier, addresses);
    const decision = decideFromDelivery(deliverable.structured);
    const result: AuditEngineResult = {
      // A local run id; not a CAP order id (web/API orders don't create a CAP order).
      orderId: `local-${Date.now()}`,
      structured: deliverable.structured,
      humanReadable: deliverable.humanReadable,
      decision,
    };

    // Automatically inspect each audited address: detect its type (wallet / token / NFT / contract)
    // and, when an LLM is configured, route to a TYPE-SPECIFIC AI assessment. The user doesn't pick
    // this — we always run it. Best-effort: failures are simply omitted.
    if (typeof this.orchestrator.inspectAddress === "function") {
      const inspectAddress = this.orchestrator.inspectAddress.bind(this.orchestrator);
      const inspections = await Promise.all(
        addresses.map((a) => this.inspectOne(a, tier, inspectAddress, deliverable.structured)),
      );
      const found = inspections.filter((x): x is AddressIntelEntry => x !== undefined);
      if (found.length > 0) {
        result.addressIntel = found;
        this.applyPrimaryLlmVerdict(result.structured, found[0]);
      }
    }

    // Best-effort AI enrichment for premium tiers. Never let an LLM failure break the audit.
    if (this.skills !== undefined && AI_TIERS.has(tier)) {
      try {
        const [explanation, remediation] = await Promise.all([
          this.skills.explainRisks(deliverable.structured, this.chain.promptLabel),
          this.skills.remediationPlan(deliverable.structured, this.chain.promptLabel),
        ]);
        result.ai = { explanation, remediation };
      } catch (err) {
        result.ai = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return result;
  }

  /**
   * Inspect one audited address: type detection + base verdict + token signals, then layer on the
   * tier-specific value-adds (annotated activity for FULL/MULTI EOAs, related-address analysis for
   * MULTI, and a type-specific AI assessment when an LLM is configured). Best-effort; never throws.
   */
  private async inspectOne(
    address: string,
    tier: Tier,
    inspectAddress: NonNullable<AuditRunner["inspectAddress"]>,
    structured: AuditReportStructured | MultiWalletReport,
  ): Promise<AddressIntelEntry | undefined> {
    try {
      const inspection = await inspectAddress(address);
      const standing = buildAddressStanding(inspection.address, inspection.type, inspection.intel);
      const entry: AddressIntelEntry = {
        address: inspection.address,
        type: inspection.type,
        verdict: standing.verdict,
        riskLevel: standing.riskLevel,
        official: standing.official,
        blacklisted: standing.blacklisted,
        label: standing.label,
        badge: standing.badge,
        reasons: standing.reasons,
        token: inspection.token,
      };

      // Annotated transaction history for personal wallets (FULL/MULTI only).
      if (
        inspection.type === "EOA" &&
        ACTIVITY_TIERS.has(tier) &&
        typeof this.orchestrator.walletActivity === "function"
      ) {
        try {
          entry.activity = await this.orchestrator.walletActivity(address);
        } catch {
          /* activity is best-effort */
        }
      }

      // Deeper related-address analysis (MULTI tier headline value-add).
      if (RELATED_TIERS.has(tier)) {
        const related = await this.buildRelated(inspection.type, entry, inspectAddress);
        if (related.length > 0) entry.related = related;
      }

      // Type-specific AI assessment (premium tiers + LLM configured).
      if (this.skills !== undefined && AI_TIERS.has(tier)) {
        try {
          entry.evidenceLog = this.buildEvidenceLog(
            entry,
            inspection.facts,
            auditEvidenceForAddress(structured, inspection.address),
          );
          const aiVerdict = await this.skills.classifyAddressEvidence(
            entry.evidenceLog,
            this.chain.promptLabel,
          );
          this.mergeAiVerdict(entry, aiVerdict);
        } catch {
          /* structured LLM verdict is best-effort */
        }
        try {
          entry.aiAssessment = await this.skills.analyzeByType(
            inspection.type,
            entry.evidenceLog ?? inspection.facts,
            this.chain.promptLabel,
          );
        } catch {
          /* AI assessment is best-effort */
        }
      }
      return entry;
    } catch {
      return undefined;
    }
  }

  private buildEvidenceLog(
    entry: AddressIntelEntry,
    facts: Record<string, unknown>,
    auditEvidence: unknown,
  ): Record<string, unknown> {
    return {
      address: entry.address,
      chain: this.chain.key,
      chainName: this.chain.name,
      auditEvidence,
      observedAddress: {
        type: entry.type,
      },
      typeFacts: facts,
      token: entry.token,
      walletActivity: entry.activity
        ? {
            windowDays: entry.activity.windowDays,
            analyzedCount: entry.activity.analyzedCount,
            records: entry.activity.records.slice(0, 25),
            counterparties: entry.activity.counterparties.slice(0, 20),
          }
        : undefined,
    };
  }

  private mergeAiVerdict(entry: AddressIntelEntry, ai: LlmAddressVerdict): void {
    entry.aiVerdict = ai;
    entry.verdict = ai.verdict;
    entry.riskLevel = ai.riskLevel;
    entry.official = ai.official;
    entry.blacklisted = ai.blacklisted;
    if (ai.label !== undefined) entry.label = ai.label;
    entry.badge = ai.badge;
    entry.reasons = ai.reasons.length > 0 ? ai.reasons : entry.reasons;
  }

  private applyPrimaryLlmVerdict(
    structured: AuditReportStructured | MultiWalletReport,
    entry: AddressIntelEntry | undefined,
  ): void {
    if (entry?.aiVerdict === undefined) return;
    const standing: AddressStanding = {
      address: entry.address,
      type: entry.type,
      verdict: entry.verdict,
      riskLevel: entry.riskLevel,
      official: entry.official,
      blacklisted: entry.blacklisted,
      label: entry.label,
      badge: entry.badge,
      reasons: entry.reasons,
    };
    if ("reports" in structured) {
      const first = structured.reports.find(
        (r) => r.walletAddress.toLowerCase() === entry.address.toLowerCase(),
      );
      if (first) first.addressStanding = standing;
    } else {
      structured.addressStanding = standing;
    }
  }

  /**
   * Build the deeper related-address analysis for the MULTI tier:
   *  - EOA wallet → its top transaction counterparties (each independently typed + risk-assessed);
   *  - token / NFT / contract → its owner address (when readable).
   * Each related address gets an optional type-specific AI note when an LLM is configured.
   */
  private async buildRelated(
    type: AddressType,
    entry: AddressIntelEntry,
    inspectAddress: NonNullable<AuditRunner["inspectAddress"]>,
  ): Promise<RelatedAddressAnalysis[]> {
    const targets: {
      address: string;
      relation: "COUNTERPARTY" | "OWNER";
      interactions?: number;
    }[] = [];

    if (type === "EOA" && entry.activity) {
      for (const cp of entry.activity.counterparties.slice(0, MAX_RELATED_COUNTERPARTIES)) {
        targets.push({
          address: cp.address,
          relation: "COUNTERPARTY",
          interactions: cp.interactions,
        });
      }
    } else if (entry.token?.owner) {
      targets.push({ address: entry.token.owner, relation: "OWNER" });
    }

    const analyses = await Promise.all(
      targets.map(async (t) => {
        try {
          const sub = await inspectAddress(t.address);
          const standing = buildAddressStanding(sub.address, sub.type, sub.intel);
          const analysis: RelatedAddressAnalysis = {
            address: sub.address,
            relation: t.relation,
            interactions: t.interactions,
            type: sub.type,
            verdict: standing.verdict,
            riskLevel: standing.riskLevel,
            official: standing.official,
            blacklisted: standing.blacklisted,
            label: standing.label,
            badge: standing.badge,
            reasons: standing.reasons,
          };
          if (this.skills !== undefined) {
            try {
              analysis.aiAssessment = await this.skills.analyzeByType(
                sub.type,
                sub.facts,
                this.chain.promptLabel,
              );
            } catch {
              /* AI note is best-effort */
            }
          }
          return analysis;
        } catch {
          return undefined;
        }
      }),
    );
    return analyses.filter((x): x is RelatedAddressAnalysis => x !== undefined);
  }

  /**
   * Vet an address / assess a counterparty. Uses the orchestrator's Address_Intel when available;
   * adds a best-effort AI explanation of the verdict when an LLM is configured.
   */
  async vetAddress(address: string, _chainKey?: string): Promise<AddressVetResult> {
    if (typeof this.orchestrator.vetAddress !== "function") {
      return { ok: false, reason: "Address vetting is not supported by this audit engine." };
    }
    const outcome = await this.orchestrator.vetAddress(address);
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }
    const out: AddressVetResult = { ok: true, result: outcome.result };
    if (this.skills !== undefined) {
      try {
        out.ai = {
          explanation: await this.skills.explainAddress(outcome.result, this.chain.promptLabel),
        };
      } catch (err) {
        out.ai = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return out;
  }
}
