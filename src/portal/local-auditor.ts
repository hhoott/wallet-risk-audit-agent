/**
 * Local auditor — the portal's "free mode" fallback (dev/testing only).
 *
 * In paid mode the portal hires the live Provider over CAP. In FREE mode (PORTAL_PAYMENT_MODE=free),
 * when the CAP flow cannot complete (payment fails, negotiation/order rejected, expired, or times
 * out) the portal falls back to running the SAME read-only audit locally, so we can exercise the
 * end-to-end UX without a funded Requester wallet. This bypasses paid settlement and must NEVER be
 * used in production.
 *
 * It reuses the real {@link AuditOrchestrator} and the exported {@link runAudit} (the exact logic the
 * Provider runs on a paid order), then derives the same A2A decision the Requester would.
 *
 * Security: still strictly read-only — it only consumes the injected read-only data sources and the
 * pure analysis modules; there is no signing / send-transaction path.
 */

import type { Tier } from "../config.js";
import { runAudit, type AuditRunner } from "../cap/provider.js";
import { decideFromDelivery } from "../examples/requester.js";
import type { PortalOrderResult } from "./cap-requester.js";

/** A local auditor produces a {@link PortalOrderResult} without any CAP order / payment. */
export interface LocalAuditor {
  audit(tier: Tier, addresses: string[]): Promise<PortalOrderResult>;
}

/** A {@link LocalAuditor} backed by the real orchestrator (free-mode fallback). */
export class OrchestratorLocalAuditor implements LocalAuditor {
  constructor(private readonly orchestrator: AuditRunner) {}

  async audit(tier: Tier, addresses: string[]): Promise<PortalOrderResult> {
    const deliverable = await runAudit(this.orchestrator, tier, addresses);
    const decision = decideFromDelivery(deliverable.structured);
    return {
      // No real CAP order id exists in free mode; mark it clearly as an unpaid local run.
      orderId: `local-${Date.now()}`,
      structured: deliverable.structured,
      humanReadable: deliverable.humanReadable,
      decision,
    };
  }
}
