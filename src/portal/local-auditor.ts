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
 * AI insight (optional): when an {@link AuditSkillSet} is injected, FULL/MULTI audits are enriched
 * with an LLM-generated plain-language risk explanation + remediation plan (the deterministic report
 * is always produced first; the AI layer is strictly additive and best-effort).
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
  WalletActivity,
  RelatedAddressAnalysis,
} from "../models.js";
import type { AuditSkillSet } from "../llm/skills.js";
import type { TokenContractInfo } from "../datasource/types.js";

/** One audited address's type-aware inspection (deterministic facts + optional AI assessment). */
export interface AddressIntelEntry {
  address: string;
  type: AddressType;
  verdict: string;
  official: boolean;
  blacklisted: boolean;
  label?: string;
  reasons: string[];
  /** Token security signals, present only for ERC-20 token contracts. */
  token?: TokenContractInfo;
  /** Type-specific AI assessment (Markdown), present on premium tiers when an LLM is configured. */
  aiAssessment?: string;
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
  /** Optional AI insight (FULL/MULTI tiers when an LLM is configured). */
  ai?: AiInsight;
  /**
   * Per-audited-address, type-aware intelligence (type detection + verdict + token signals + an
   * optional type-specific AI assessment), produced automatically alongside the wallet audit.
   */
  addressIntel?: AddressIntelEntry[];
}

/** Runs the read-only wallet audit in-process and returns a report. */
export interface LocalAuditor {
  audit(tier: Tier, addresses: string[]): Promise<AuditEngineResult>;
  /** Vet an address / assess a counterparty (extended target). Returns the structured result. */
  vetAddress(address: string): Promise<AddressVetResult>;
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

/** A {@link LocalAuditor} backed by the agent's real orchestrator (shared in the unified process). */
export class OrchestratorLocalAuditor implements LocalAuditor {
  constructor(
    private readonly orchestrator: AuditRunner,
    /** Optional AI skill set; when present, FULL/MULTI reports are enriched with LLM insight. */
    private readonly skills?: AuditSkillSet,
  ) {}

  async audit(tier: Tier, addresses: string[]): Promise<AuditEngineResult> {
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
        addresses.map((a) => this.inspectOne(a, tier, inspectAddress)),
      );
      const found = inspections.filter((x): x is AddressIntelEntry => x !== undefined);
      if (found.length > 0) result.addressIntel = found;
    }

    // Best-effort AI enrichment for premium tiers. Never let an LLM failure break the audit.
    if (this.skills !== undefined && AI_TIERS.has(tier)) {
      try {
        const [explanation, remediation] = await Promise.all([
          this.skills.explainRisks(deliverable.structured),
          this.skills.remediationPlan(deliverable.structured),
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
  ): Promise<AddressIntelEntry | undefined> {
    try {
      const inspection = await inspectAddress(address);
      const entry: AddressIntelEntry = {
        address: inspection.address,
        type: inspection.type,
        verdict: inspection.intel.verdict,
        official: inspection.intel.official,
        blacklisted: inspection.intel.blacklisted,
        label: inspection.intel.label,
        reasons: inspection.intel.reasons,
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
          entry.aiAssessment = await this.skills.analyzeByType(inspection.type, inspection.facts);
        } catch {
          /* AI assessment is best-effort */
        }
      }
      return entry;
    } catch {
      return undefined;
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
          const analysis: RelatedAddressAnalysis = {
            address: sub.address,
            relation: t.relation,
            interactions: t.interactions,
            type: sub.type,
            verdict: sub.intel.verdict,
            official: sub.intel.official,
            blacklisted: sub.intel.blacklisted,
            label: sub.intel.label,
            reasons: sub.intel.reasons,
          };
          if (this.skills !== undefined) {
            try {
              analysis.aiAssessment = await this.skills.analyzeByType(sub.type, sub.facts);
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
  async vetAddress(address: string): Promise<AddressVetResult> {
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
        out.ai = { explanation: await this.skills.explainAddress(outcome.result) };
      } catch (err) {
        out.ai = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return out;
  }
}
