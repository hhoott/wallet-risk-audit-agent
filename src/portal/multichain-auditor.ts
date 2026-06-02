/**
 * Multi-chain audit dispatcher for the portal.
 *
 * The audit engine ({@link AuditOrchestrator}) is built for ONE audited chain (its data sources
 * target a specific Etherscan chainid + viem network + CoinGecko platform). To let a single portal
 * audit any of the supported chains per-request, this wrapper lazily builds and caches one
 * {@link OrchestratorLocalAuditor} per chain key, and dispatches each call to the right one.
 *
 * Security: strictly read-only — every per-chain engine only consumes the injected read-only data
 * providers; there is no signing / send-transaction path.
 */

import type { Tier } from "../config.js";
import { getChain, type ChainKey } from "../chains.js";
import {
  OrchestratorLocalAuditor,
  type AuditEngineResult,
  type AddressVetResult,
  type LocalAuditor,
} from "./local-auditor.js";

/** Builds a per-chain {@link LocalAuditor} for the given chain key. Injectable for tests. */
export type ChainAuditorFactory = (chainKey: ChainKey) => LocalAuditor | Promise<LocalAuditor>;

/**
 * A {@link LocalAuditor} that dispatches to a per-chain engine, building each lazily on first use
 * and caching it thereafter. An unknown / unsupported chain key falls back to the default chain.
 */
export class MultiChainAuditor implements LocalAuditor {
  private readonly cache = new Map<ChainKey, Promise<LocalAuditor>>();

  constructor(private readonly factory: ChainAuditorFactory) {}

  private resolve(chainKey: string | undefined): Promise<LocalAuditor> {
    // Normalize through getChain so aliases / chainIds / blank all map to a supported key.
    const key = getChain(chainKey).key;
    let entry = this.cache.get(key);
    if (entry === undefined) {
      entry = Promise.resolve(this.factory(key));
      this.cache.set(key, entry);
    }
    return entry;
  }

  async audit(tier: Tier, addresses: string[], chainKey?: string): Promise<AuditEngineResult> {
    const auditor = await this.resolve(chainKey);
    return auditor.audit(tier, addresses, chainKey);
  }

  async vetAddress(address: string, chainKey?: string): Promise<AddressVetResult> {
    const auditor = await this.resolve(chainKey);
    return auditor.vetAddress(address, chainKey);
  }
}

/** Re-export for convenience so the portal entry can build per-chain engines. */
export { OrchestratorLocalAuditor };
