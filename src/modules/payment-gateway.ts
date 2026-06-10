/**
 * Payment_Gateway (task 14.1 / 14.2, per the "Payment_Gateway" row in design.md and
 * requirements 2.2/2.6/2.7, 4, 5.3, 18.4/18.5).
 *
 * Pure decision-making component: this module contains NO CAP SDK calls. It only computes
 * negotiation / pricing / settlement / refund DECISIONS from plain inputs. The CAP adapter layer
 * (task 16) is responsible for turning these decisions into real SDK calls
 * (AcceptNegotiation / RejectNegotiation / DeliverOrder / RejectOrder).
 *
 * Settlement facts the decisions assume (kept here as documentation only; no chain access happens
 * in this module):
 *  - Settlement_Asset is USDC on Base (requirement 4.3). This service never operates the
 *    settlement chain directly — the CAP SDK + CAPVault do.
 *  - All on-chain gas is sponsored by the CROO platform; neither the Caller nor this Agent needs to
 *    hold ETH to settle (requirement 4.11).
 *  - On delivery confirmation CAPVault auto-splits the escrowed USDC: platform fee -> Treasury,
 *    remainder -> this Agent's AA wallet (requirement 4.8 / 18.4).
 *  - A `paid` order that is rejected/expired has its escrow refunded to the Requester
 *    (requirement 18.5).
 */

import type { Tier } from "../config.js";
import { TIER_PRICE_USDC } from "../config.js";
import type { Address, ModuleState, ModuleStatus, SettlementRecord } from "../models.js";

// ── Negotiation decision (task 14.2, Property 3, requirements 2.2 / 2.6) ───────────────

/**
 * Discriminated union describing the negotiation outcome.
 *  - ACCEPT: the serviceId maps to a configured tier AND the requirements payload yields at least
 *    one wallet address. Carries the resolved tier and the parsed wallet list for the adapter layer.
 *  - REJECT: carries a human-readable reason (unknown service id, or missing/blank/unparseable
 *    required parameters / empty wallet list).
 */
export type NegotiationDecision =
  | { action: "ACCEPT"; tier: Tier; walletAddresses: Address[] }
  | { action: "REJECT"; reason: string };

/** Input to {@link decideNegotiation}: the target serviceId and the raw requirements payload. */
export interface NegotiationDecisionInput {
  /** The negotiation's target Service_ID. */
  serviceId: string;
  /**
   * Raw requirements payload carried by the negotiation (CAP `Negotiation.requirements`, a string).
   * Convention: a JSON string such as `{"walletAddresses":["0x.."]}`. May be undefined/blank.
   */
  requirements: string | undefined;
}

/**
 * Pure helper: parse the audit requirements payload into a wallet address list.
 *
 * Accepts the conventional `{"walletAddresses": string[]}` shape, and also a single
 * `{"walletAddress": "0x.."}` for convenience. Returns the list of non-empty, non-blank wallet
 * strings, or `[]` for any invalid input (undefined / blank / unparseable JSON / wrong shape /
 * empty or all-blank list).
 *
 * Address format is NOT validated deeply here — that is the Address_Validator's job downstream.
 * This helper only requires a non-empty list of non-empty strings.
 */
export function parseAuditRequirements(payload: string | undefined): Address[] {
  if (typeof payload !== "string") return [];
  const trimmed = payload.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];

  const obj = parsed as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (Array.isArray(obj.walletAddresses)) {
    candidates.push(...obj.walletAddresses);
  } else if (typeof obj.walletAddress === "string") {
    candidates.push(obj.walletAddress);
  }

  // Keep only non-empty, non-blank strings; deeper format validation happens in Address_Validator.
  return candidates.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/**
 * Decide whether to accept or reject a CAP negotiation (requirements 2.2 / 2.6).
 *
 * Returns ACCEPT if and only if BOTH hold:
 *  1. `serviceId` is present in the configured Service_ID -> Tier map (one of this Agent's tiers), and
 *  2. the requirements payload parses to at least one wallet address.
 * Otherwise returns REJECT with a reason explaining the failure.
 *
 * @param input            the serviceId and raw requirements payload from the negotiation
 * @param serviceTierMap   the configured Service_ID -> Tier map (see buildServiceTierMap)
 */
export function decideNegotiation(
  input: NegotiationDecisionInput,
  serviceTierMap: Map<string, Tier>,
): NegotiationDecision {
  const tier = serviceTierMap.get(input.serviceId);
  if (tier === undefined) {
    return {
      action: "REJECT",
      reason: `Unsupported service: serviceId "${input.serviceId}" is not one of this Agent's configured tiers.`,
    };
  }

  const walletAddresses = parseAuditRequirements(input.requirements);
  if (walletAddresses.length === 0) {
    return {
      action: "REJECT",
      reason:
        'Missing required parameters: requirements must be a JSON payload containing a non-empty walletAddresses list (e.g. {"walletAddresses":["0x.."]}).',
    };
  }

  return { action: "ACCEPT", tier, walletAddresses };
}

// ── Pricing (task 14.1, requirements 4.4 / 4.5 / 4.6) ──────────────────────────────────

/** Per-tier USDC price; the externally exposed single service currently uses FULL. */
export function priceForTier(tier: Tier): number {
  return TIER_PRICE_USDC[tier];
}

// ── Settlement / refund decision (task 14.1, Property 29, requirements 4.2/4.9, 18.4/18.5, 2.7) ──

/**
 * A signal that a single analysis module succeeded. Accepts the rich `ModuleStatus` object, the
 * bare `ModuleState` enum, or a simple boolean (true = succeeded) so the orchestrator can pass
 * whichever form is convenient.
 */
export type ModuleSuccessSignal = ModuleStatus | ModuleState | boolean;

/** Whether a single module success signal represents a succeeded module (status "OK" / true). */
export function isModuleSucceeded(signal: ModuleSuccessSignal): boolean {
  if (typeof signal === "boolean") return signal;
  if (typeof signal === "string") return signal === "OK";
  return signal.status === "OK";
}

/** Whether at least one module succeeded among the given signals (requirement 18.4). */
export function someModuleSucceeded(signals: ModuleSuccessSignal[]): boolean {
  return signals.some(isModuleSucceeded);
}

/**
 * Discriminated union describing the delivery / settlement / refund decision.
 *  - WITHHOLD_DELIVERY: escrow is not locked yet; we must not deliver before USDC is escrowed
 *    (requirements 4.2 / 4.9 / 2.7).
 *  - DELIVER_AND_SETTLE: escrow locked AND at least one module succeeded → deliver and settle the
 *    full tier amount; CAPVault auto-splits platform fee -> Treasury, remainder -> AA wallet
 *    (requirement 18.4). `amountUsdc` is the full tier price.
 *  - REJECT_AND_REFUND: escrow locked but no module succeeded → RejectOrder; CAPVault refunds the
 *    escrow to the Requester (requirement 18.5).
 */
export type SettlementDecision =
  | { action: "WITHHOLD_DELIVERY"; reason: string }
  | { action: "DELIVER_AND_SETTLE"; amountUsdc: number }
  | { action: "REJECT_AND_REFUND"; reason: string };

/** Input to {@link decideSettlement}. */
export interface SettlementDecisionInput {
  /** Whether USDC has been locked into CAPVault escrow (PayOrder completed). */
  escrowLocked: boolean;
  /** Per-module completion signals; at least one "OK" means an analysis module succeeded. */
  moduleStatuses: ModuleSuccessSignal[];
  /** The purchased tier, used to compute the full settlement amount. */
  tier: Tier;
}

/**
 * Decide whether to deliver-and-settle, withhold delivery, or reject-and-refund a paid CAP order.
 *
 * Logic (requirements 4.2 / 4.9 / 2.7, 18.4, 18.5):
 *  1. If escrow is NOT locked → WITHHOLD_DELIVERY (never deliver before USDC is escrowed).
 *  2. Else if at least one module succeeded → DELIVER_AND_SETTLE with the full tier amount.
 *  3. Else (escrow locked but no module succeeded) → REJECT_AND_REFUND.
 */
export function decideSettlement(input: SettlementDecisionInput): SettlementDecision {
  if (!input.escrowLocked) {
    return {
      action: "WITHHOLD_DELIVERY",
      reason:
        "Payment not completed: USDC has not been locked into CAPVault escrow yet; delivery is withheld.",
    };
  }

  if (someModuleSucceeded(input.moduleStatuses)) {
    return {
      action: "DELIVER_AND_SETTLE",
      amountUsdc: priceForTier(input.tier),
    };
  }

  return {
    action: "REJECT_AND_REFUND",
    reason:
      "Data unavailable: no analysis module succeeded; rejecting the order so CAPVault refunds the escrowed USDC to the Requester.",
  };
}

// ── Settlement record (task 14.1, Property 30, requirement 4.10) ───────────────────────

/**
 * Build a settlement record for a completed CAP order (requirement 4.10). The settled amount is the
 * full tier price. Gas is platform-sponsored and the asset is Base USDC (no ETH needed).
 */
export function recordSettlement(
  orderId: string,
  tier: Tier,
  payerAddress: Address,
  settlementTxHash: string,
): SettlementRecord {
  return {
    orderId,
    tier,
    payerAddress,
    settlementTxHash,
    amountUsdc: priceForTier(tier),
  };
}

/**
 * Simple in-memory store of settlement records, keyed by orderId. Records the tier, payer address
 * and on-chain settlement transaction hash for each completed CAP order (requirement 4.10).
 */
export class SettlementLedger {
  private readonly store = new Map<string, SettlementRecord>();

  /** Build and persist a settlement record, returning the stored record. */
  record(
    orderId: string,
    tier: Tier,
    payerAddress: Address,
    settlementTxHash: string,
  ): SettlementRecord {
    const rec = recordSettlement(orderId, tier, payerAddress, settlementTxHash);
    this.store.set(orderId, rec);
    return rec;
  }

  /** Look up a previously recorded settlement by orderId (undefined if none). */
  get(orderId: string): SettlementRecord | undefined {
    return this.store.get(orderId);
  }

  /** All recorded settlements (insertion order). */
  all(): SettlementRecord[] {
    return [...this.store.values()];
  }
}
