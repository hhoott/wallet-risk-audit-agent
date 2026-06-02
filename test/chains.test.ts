import { describe, it, expect } from "vitest";

import {
  SUPPORTED_CHAINS,
  CHAIN_ORDER,
  DEFAULT_CHAIN,
  DEFAULT_CHAIN_KEY,
  isChainKey,
  resolveChainKey,
  getChain,
  resolveRpcUrl,
} from "../src/chains.js";

describe("chains — registry", () => {
  it("the default chain is Ethereum Mainnet", () => {
    expect(DEFAULT_CHAIN_KEY).toBe("ethereum");
    expect(DEFAULT_CHAIN.name).toBe("Ethereum Mainnet");
    expect(DEFAULT_CHAIN.chainId).toBe(1);
    // Ethereum keeps its historical revoke slug so existing links/tests are unaffected.
    expect(DEFAULT_CHAIN.revokeChainSlug).toBe("ethereum-mainnet");
  });

  it("every ordered key has a complete descriptor with a unique chainId", () => {
    const ids = new Set<number>();
    for (const key of CHAIN_ORDER) {
      const c = SUPPORTED_CHAINS[key];
      expect(c.key).toBe(key);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.chainId).toBeGreaterThan(0);
      expect(c.coingeckoPlatformId.length).toBeGreaterThan(0);
      expect(c.coingeckoNativeId.length).toBeGreaterThan(0);
      expect(c.explorerTxUrl.startsWith("https://")).toBe(true);
      expect(ids.has(c.chainId)).toBe(false);
      ids.add(c.chainId);
    }
    expect(CHAIN_ORDER.length).toBe(5);
  });

  it("maps the expected chain ids", () => {
    expect(SUPPORTED_CHAINS.ethereum.chainId).toBe(1);
    expect(SUPPORTED_CHAINS.base.chainId).toBe(8453);
    expect(SUPPORTED_CHAINS.arbitrum.chainId).toBe(42161);
    expect(SUPPORTED_CHAINS.optimism.chainId).toBe(10);
    expect(SUPPORTED_CHAINS.polygon.chainId).toBe(137);
  });
});

describe("chains — resolution", () => {
  it("isChainKey only accepts supported keys", () => {
    expect(isChainKey("ethereum")).toBe(true);
    expect(isChainKey("base")).toBe(true);
    expect(isChainKey("solana")).toBe(false);
    expect(isChainKey(42)).toBe(false);
  });

  it("resolveChainKey accepts slugs, names, chainIds and CAIP-2", () => {
    expect(resolveChainKey("base")).toBe("base");
    expect(resolveChainKey("Base Mainnet")).toBe("base");
    expect(resolveChainKey("8453")).toBe("base");
    expect(resolveChainKey("eip155:42161")).toBe("arbitrum");
    expect(resolveChainKey("MATIC")).toBe("polygon");
    expect(resolveChainKey("optimism")).toBe("optimism");
  });

  it("resolveChainKey defaults blank/undefined to ethereum and rejects unknown", () => {
    expect(resolveChainKey(undefined)).toBe("ethereum");
    expect(resolveChainKey("")).toBe("ethereum");
    expect(resolveChainKey("   ")).toBe("ethereum");
    expect(resolveChainKey("dogechain")).toBeUndefined();
  });

  it("getChain resolves aliases and throws on unsupported", () => {
    expect(getChain("arbitrum-one").key).toBe("arbitrum");
    expect(getChain(undefined).key).toBe("ethereum");
    expect(() => getChain("unknownchain")).toThrow();
  });
});

describe("chains — RPC resolution", () => {
  it("prefers the per-chain env var, then the public default", () => {
    const base = SUPPORTED_CHAINS.base;
    expect(resolveRpcUrl(base, { BASE_RPC_URL: "https://my-base-rpc" })).toBe(
      "https://my-base-rpc",
    );
    expect(resolveRpcUrl(base, {})).toBe(base.defaultRpcUrl);
  });

  it("honors the legacy ALCHEMY_RPC_URL only for Ethereum", () => {
    const eth = SUPPORTED_CHAINS.ethereum;
    expect(resolveRpcUrl(eth, { ALCHEMY_RPC_URL: "https://legacy-eth" })).toBe(
      "https://legacy-eth",
    );
    // The legacy var does not leak onto other chains.
    expect(resolveRpcUrl(SUPPORTED_CHAINS.base, { ALCHEMY_RPC_URL: "https://legacy-eth" })).toBe(
      SUPPORTED_CHAINS.base.defaultRpcUrl,
    );
  });
});
