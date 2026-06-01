import { describe, it, expect } from "vitest";

import {
  WalletActivityAnalyzer,
  annotateTransactions,
  rankCounterparties,
  formatWeiToEth,
  type CounterpartyFacts,
} from "../src/modules/wallet-activity.js";
import { MockChainDataSource, MockRiskRuleSource } from "../src/datasource/mock.js";
import type { RawTransaction } from "../src/datasource/types.js";

const WALLET = "0x" + "a".repeat(40);
const OFFICIAL = "0x" + "b".repeat(40);
const RISKY = "0x" + "c".repeat(40);
const PLAIN = "0x" + "d".repeat(40);
const NOW = new Date("2024-06-01T00:00:00.000Z");

function tx(partial: Partial<RawTransaction>): RawTransaction {
  return {
    txHash: "0x" + "f".repeat(64),
    timestamp: "2024-05-30T00:00:00.000Z",
    from: WALLET,
    to: PLAIN,
    valueWei: "0",
    valueUsd: null,
    success: true,
    gasFeeWei: "21000",
    toIsContract: false,
    direction: "OUT",
    ...partial,
  };
}

const factsFor =
  (map: Record<string, CounterpartyFacts>) =>
  (addr: string): CounterpartyFacts =>
    map[addr.toLowerCase()] ?? { official: false, blacklisted: false };

describe("formatWeiToEth", () => {
  it("formats whole and fractional ETH, trimming zeros", () => {
    expect(formatWeiToEth("0")).toBe("0");
    expect(formatWeiToEth("1000000000000000000")).toBe("1");
    expect(formatWeiToEth("1500000000000000000")).toBe("1.5");
    expect(formatWeiToEth("1234500000000000000")).toBe("1.2345");
  });

  it("returns 0 for unparseable input", () => {
    expect(formatWeiToEth("not-a-number")).toBe("0");
  });
});

describe("annotateTransactions", () => {
  it("annotates each record's counterparty situation", () => {
    const txs = [
      tx({ direction: "OUT", to: OFFICIAL, toIsContract: true, valueWei: "1000000000000000000" }),
      tx({ direction: "IN", from: RISKY, to: WALLET }),
      tx({ direction: "OUT", to: null }), // contract creation
    ];
    const facts = factsFor({
      [OFFICIAL.toLowerCase()]: { official: true, blacklisted: false, label: "Uniswap" },
      [RISKY.toLowerCase()]: { official: false, blacklisted: true },
    });

    const records = annotateTransactions(txs, facts);
    expect(records).toHaveLength(3);

    // Outbound to an official contract.
    expect(records[0].direction).toBe("OUT");
    expect(records[0].counterparty).toBe(OFFICIAL);
    expect(records[0].counterpartyLabel).toBe("Uniswap");
    expect(records[0].flags).toContain("OFFICIAL");
    expect(records[0].flags).toContain("CONTRACT");
    expect(records[0].valueEth).toBe("1");

    // Inbound from a risky address.
    expect(records[1].direction).toBe("IN");
    expect(records[1].counterparty).toBe(RISKY);
    expect(records[1].flags).toContain("RISKY");

    // Contract creation.
    expect(records[2].counterparty).toBeNull();
    expect(records[2].flags).toContain("CREATION");
  });

  it("respects the max-records cap", () => {
    const txs = Array.from({ length: 10 }, () => tx({}));
    const records = annotateTransactions(txs, factsFor({}), 3);
    expect(records).toHaveLength(3);
  });
});

describe("rankCounterparties", () => {
  it("ranks unique counterparties by interaction count, descending", () => {
    const txs = [
      tx({ direction: "OUT", to: PLAIN }),
      tx({ direction: "OUT", to: PLAIN }),
      tx({ direction: "IN", from: OFFICIAL, to: WALLET }),
    ];
    const facts = factsFor({
      [OFFICIAL.toLowerCase()]: { official: true, blacklisted: false, label: "CEX" },
    });

    const ranked = rankCounterparties(txs, facts, () => false);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].address).toBe(PLAIN);
    expect(ranked[0].interactions).toBe(2);
    expect(ranked[1].address).toBe(OFFICIAL);
    expect(ranked[1].official).toBe(true);
    expect(ranked[1].label).toBe("CEX");
  });
});

describe("WalletActivityAnalyzer", () => {
  it("produces annotated activity from the chain + rule sources", async () => {
    const chain = new MockChainDataSource({
      transactions: {
        [WALLET.toLowerCase()]: [
          tx({
            direction: "OUT",
            to: OFFICIAL,
            toIsContract: true,
            timestamp: "2024-05-30T00:00:00.000Z",
          }),
          tx({ direction: "IN", from: RISKY, to: WALLET, timestamp: "2024-05-29T00:00:00.000Z" }),
        ],
      },
    });
    const rules = new MockRiskRuleSource({
      [OFFICIAL]: { official: true, label: "Uniswap V3" },
      [RISKY]: { blacklisted: true },
    });
    const analyzer = new WalletActivityAnalyzer({ chain, rules, now: () => NOW });

    const activity = await analyzer.analyze(WALLET, { windowDays: 90 });
    expect(activity.analyzedCount).toBe(2);
    expect(activity.records).toHaveLength(2);
    expect(activity.counterparties).toHaveLength(2);
    // The official counterparty should carry its label.
    const official = activity.counterparties.find((c) => c.official);
    expect(official?.label).toBe("Uniswap V3");
    // The risky counterparty should be flagged blacklisted.
    const risky = activity.counterparties.find((c) => c.blacklisted);
    expect(risky?.address).toBe(RISKY);
  });

  it("degrades to empty activity when the data source is unavailable", async () => {
    const chain = new MockChainDataSource({});
    chain.fail.transactions = true;
    const rules = new MockRiskRuleSource({});
    const analyzer = new WalletActivityAnalyzer({ chain, rules, now: () => NOW });

    const activity = await analyzer.analyze(WALLET, { windowDays: 90 });
    expect(activity.analyzedCount).toBe(0);
    expect(activity.records).toEqual([]);
    expect(activity.counterparties).toEqual([]);
  });
});
