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
import type { AuditReportStructured, MultiWalletReport, AddressType } from "../models.js";
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
      const inspections = await Promise.all(
        addresses.map(async (a) => {
          try {
            const inspection = await this.orchestrator.inspectAddress!(a);
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
            // Type-specific AI assessment (premium tiers + LLM configured).
            if (this.skills !== undefined && AI_TIERS.has(tier)) {
              try {
                entry.aiAssessment = await this.skills.analyzeByType(
                  inspection.type,
                  inspection.facts,
                );
              } catch {
                /* AI assessment is best-effort */
              }
            }
            return entry;
          } catch {
            return undefined;
          }
        }),
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
