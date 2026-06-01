import { describe, it, expect } from "vitest";

import { AddressInspector } from "../src/modules/address-inspector.js";
import { MockChainDataSource, MockRiskRuleSource } from "../src/datasource/mock.js";
import type { TokenContractInfo } from "../src/datasource/types.js";

const TOKEN = "0x" + "a".repeat(40);
const NFT = "0x" + "b".repeat(40);
const EOA = "0x" + "c".repeat(40);
const NOW = new Date("2024-06-01T00:00:00.000Z");

const riskyToken: TokenContractInfo = {
  name: "Sketchy",
  symbol: "SKT",
  decimals: 18,
  totalSupply: "1000000",
  hasOwner: true,
  owner: "0x" + "9".repeat(40),
  mintable: true,
  pausable: true,
  hasBlacklist: true,
};

describe("Address_Inspector — type detection + facts", () => {
  it("detects an ERC-20 token and attaches token signals", async () => {
    const chain = new MockChainDataSource({
      addressType: { [TOKEN.toLowerCase()]: "ERC20" },
      tokenInfo: { [TOKEN.toLowerCase()]: riskyToken },
      contractMeta: {
        [TOKEN.toLowerCase()]: {
          contract: TOKEN,
          verified: true,
          deployedAt: "2024-05-20T00:00:00.000Z",
          txCount: 5,
          audited: false,
          isContract: true,
        },
      },
    });
    const rules = new MockRiskRuleSource({});
    const inspector = new AddressInspector({ chain, rules, now: () => NOW });

    const r = await inspector.inspect(TOKEN);
    expect(r.type).toBe("ERC20");
    expect(r.token?.mintable).toBe(true);
    expect(r.token?.pausable).toBe(true);
    expect(r.token?.hasBlacklist).toBe(true);
    expect(r.facts.type).toBe("ERC20");
    expect(r.facts.token).toBeDefined();
  });

  it("detects an NFT collection (no token signals fetched)", async () => {
    const chain = new MockChainDataSource({
      addressType: { [NFT.toLowerCase()]: "ERC721" },
    });
    const rules = new MockRiskRuleSource({ [NFT]: { official: true, label: "Cool Cats" } });
    const inspector = new AddressInspector({ chain, rules, now: () => NOW });

    const r = await inspector.inspect(NFT);
    expect(r.type).toBe("ERC721");
    expect(r.token).toBeUndefined();
    expect(r.intel.official).toBe(true);
  });

  it("detects an EOA", async () => {
    const chain = new MockChainDataSource({ addressType: { [EOA.toLowerCase()]: "EOA" } });
    const rules = new MockRiskRuleSource({});
    const inspector = new AddressInspector({ chain, rules, now: () => NOW });

    const r = await inspector.inspect(EOA);
    expect(r.type).toBe("EOA");
  });

  it("degrades to UNKNOWN when detection is unsupported / fails", async () => {
    const chain = new MockChainDataSource({});
    // Force the detector to throw.
    chain.detectAddressType = () => Promise.reject(new Error("rpc down"));
    const rules = new MockRiskRuleSource({});
    const inspector = new AddressInspector({ chain, rules, now: () => NOW });

    const r = await inspector.inspect(TOKEN);
    expect(r.type).toBe("UNKNOWN");
    // Still returns a base verdict.
    expect(r.intel).toBeDefined();
  });
});
