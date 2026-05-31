import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ApprovalScanner,
  isUnlimitedApproval,
  UNLIMITED_ERC20_THRESHOLD,
  UNKNOWN_LABEL,
  NO_APPROVALS_MESSAGE,
} from "../src/modules/approval-scanner.js";
import { MockChainDataSource } from "../src/datasource/mock.js";
import type { RawApproval } from "../src/datasource/types.js";
import type { Address, ApprovalKind } from "../src/models.js";

// ── Generators ─────────────────────────────────────────────────────

const UINT256_MAX = 2n ** 256n - 1n;

/** 40-hex address generator. */
const addressArb: fc.Arbitrary<Address> = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((h) => `0x${h}` as Address);

/**
 * allowance generator: focuses sampling around the 2^255 boundary and the global endpoints.
 * Covers 0, 2^255-1, 2^255, 2^255+1, uint256 max, plus globally random large integers.
 */
const allowanceArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("0"),
  fc.constant((UNLIMITED_ERC20_THRESHOLD - 1n).toString()),
  fc.constant(UNLIMITED_ERC20_THRESHOLD.toString()),
  fc.constant((UNLIMITED_ERC20_THRESHOLD + 1n).toString()),
  fc.constant(UINT256_MAX.toString()),
  fc.bigInt({ min: 0n, max: UINT256_MAX }).map((v) => v.toString()),
);

const fungibleKindArb: fc.Arbitrary<ApprovalKind> = fc.constantFrom(
  "ERC20",
  "PERMIT2",
);

const operatorKindArb: fc.Arbitrary<ApprovalKind> = fc.constantFrom(
  "ERC721_OPERATOR",
  "ERC1155_OPERATOR",
);

/** Same-address ERC-20 / Permit2 approval generator (allowance sampled at boundaries). */
const fungibleApprovalArb: fc.Arbitrary<RawApproval> = fc.record({
  tokenContract: addressArb,
  spender: addressArb,
  spenderLabel: fc.option(fc.string(), { nil: undefined }),
  kind: fungibleKindArb,
  allowance: allowanceArb,
  lastUpdated: fc.constant("2024-01-01T00:00:00.000Z"),
});

/** Same-address ERC-721 / ERC-1155 operator approval generator (setApprovalForAll true/false). */
const operatorApprovalArb: fc.Arbitrary<RawApproval> = fc.record({
  tokenContract: addressArb,
  spender: addressArb,
  spenderLabel: fc.option(fc.string(), { nil: undefined }),
  kind: operatorKindArb,
  allowance: fc.constant("0"),
  operatorApproved: fc.boolean(),
  lastUpdated: fc.constant("2024-01-01T00:00:00.000Z"),
});

const anyApprovalArb: fc.Arbitrary<RawApproval> = fc.oneof(
  fungibleApprovalArb,
  operatorApprovalArb,
);

const TEST_ADDR = "0x1111111111111111111111111111111111111111" as Address;

// ── Property 4: unlimited approval determination (requirements 6.2, 6.3) ─

describe("Approval_Scanner — unlimited approval determination", () => {
  // Feature: wallet-risk-audit-agent, Property 4: for any approval record, it is marked as
  // Unlimited_Approval if and only if (ERC-20 allowance ≥ 2^255) or
  // (ERC-721/ERC-1155 setApprovalForAll is true).
  it("Property 4: unlimited approval determination", () => {
    fc.assert(
      fc.property(anyApprovalArb, (raw) => {
        const expected =
          raw.operatorApproved === true ||
          BigInt(raw.allowance) >= UNLIMITED_ERC20_THRESHOLD;
        expect(isUnlimitedApproval(raw)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("exact determination at the 2^255 boundary (boundary sampling confirmation)", () => {
    const base = {
      tokenContract: TEST_ADDR,
      spender: TEST_ADDR,
      kind: "ERC20" as ApprovalKind,
      lastUpdated: "2024-01-01T00:00:00.000Z",
    };
    expect(
      isUnlimitedApproval({ ...base, allowance: (UNLIMITED_ERC20_THRESHOLD - 1n).toString() }),
    ).toBe(false);
    expect(
      isUnlimitedApproval({ ...base, allowance: UNLIMITED_ERC20_THRESHOLD.toString() }),
    ).toBe(true);
    expect(
      isUnlimitedApproval({ ...base, allowance: (UNLIMITED_ERC20_THRESHOLD + 1n).toString() }),
    ).toBe(true);
  });

  it("setApprovalForAll=false and allowance=0 is not marked unlimited", () => {
    expect(
      isUnlimitedApproval({
        tokenContract: TEST_ADDR,
        spender: TEST_ADDR,
        kind: "ERC721_OPERATOR",
        allowance: "0",
        operatorApproved: false,
        lastUpdated: "2024-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});

// ── Property 5: approval record field completeness (requirement 6.4) ─

describe("Approval_Scanner — approval record field completeness", () => {
  // Feature: wallet-risk-audit-agent, Property 5: for any Unlimited_Approval record,
  // the output always contains the four fields: token contract address, spender address,
  // spender readable label (which is "Unknown" when there is no label), and the
  // most recent update timestamp.
  it("Property 5: approval record field completeness", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyApprovalArb, { minLength: 1, maxLength: 20 }),
        async (raws) => {
          const ds = new MockChainDataSource({ approvals: { [TEST_ADDR.toLowerCase()]: raws } });
          const scanner = new ApprovalScanner(ds);
          const result = await scanner.scan(TEST_ADDR);
          expect(result.status).toBe("OK");
          if (result.status !== "OK") return;

          for (const rec of result.approvals) {
            if (!rec.isUnlimited) continue;
            // Completeness of the four fields.
            expect(typeof rec.tokenContract).toBe("string");
            expect(rec.tokenContract.length).toBeGreaterThan(0);
            expect(typeof rec.spender).toBe("string");
            expect(rec.spender.length).toBeGreaterThan(0);
            expect(typeof rec.spenderLabel).toBe("string");
            expect(rec.spenderLabel.length).toBeGreaterThan(0);
            expect(typeof rec.lastUpdated).toBe("string");
            expect(rec.lastUpdated.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it("a spender without a label falls back to \"Unknown\"", async () => {
    const raws: RawApproval[] = [
      {
        tokenContract: TEST_ADDR,
        spender: TEST_ADDR,
        kind: "ERC20",
        allowance: UNLIMITED_ERC20_THRESHOLD.toString(),
        lastUpdated: "2024-01-01T00:00:00.000Z",
      },
    ];
    const ds = new MockChainDataSource({ approvals: { [TEST_ADDR.toLowerCase()]: raws } });
    const scanner = new ApprovalScanner(ds);
    const result = await scanner.scan(TEST_ADDR);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.approvals[0].spenderLabel).toBe(UNKNOWN_LABEL);
    expect(result.approvals[0].isUnlimited).toBe(true);
  });
});

// ── Property 7: data source failure does not overwrite the last successful result (requirement 6.6) ─

describe("Approval_Scanner — failure does not overwrite the last successful result", () => {
  // Feature: wallet-risk-audit-agent, Property 7: for any wallet address, if it has a previous
  // successful approval scan result, then when the data source is unavailable this time, a failure
  // result is returned but the address's last successful data remains unchanged and is not
  // overwritten. (This task only covers the Approval_Scanner half.)
  it("Property 7: data source failure does not overwrite the last successful result", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyApprovalArb, { minLength: 1, maxLength: 15 }),
        async (raws) => {
          const ds = new MockChainDataSource({ approvals: { [TEST_ADDR.toLowerCase()]: raws } });
          const scanner = new ApprovalScanner(ds);

          // 1) Scan successfully first to establish the cache.
          const first = await scanner.scan(TEST_ADDR);
          expect(first.status).toBe("OK");
          if (first.status !== "OK") return;
          const snapshot = JSON.stringify(first.approvals);

          // 2) Make the data source fail.
          ds.fail.approvals = true;
          const failed = await scanner.scan(TEST_ADDR);
          expect(failed.status).toBe("FAILED");
          if (failed.status !== "FAILED") return;
          // The failure result returns the last successful cache, and its content is unchanged.
          expect(failed.cached).not.toBeNull();
          expect(JSON.stringify(failed.cached)).toBe(snapshot);

          // 3) The cache can still be read again, and the value has not been overwritten.
          expect(JSON.stringify(scanner.getCached(TEST_ADDR))).toBe(snapshot);

          // 4) Recover the data source → the cached value matches the first scan (verifying it was not corrupted).
          ds.fail.approvals = false;
          const recovered = await scanner.scan(TEST_ADDR);
          expect(recovered.status).toBe("OK");
          if (recovered.status !== "OK") return;
          expect(JSON.stringify(recovered.approvals)).toBe(snapshot);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("cached is null in the failure result when there has never been a successful scan", async () => {
    const ds = new MockChainDataSource();
    ds.fail.approvals = true;
    const scanner = new ApprovalScanner(ds);
    const result = await scanner.scan(TEST_ADDR);
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.cached).toBeNull();
  });
});

// ── Unit tests: no approval records (requirement 6.5) ──────────────

describe("Approval_Scanner — no approval records", () => {
  it("data source returns empty → EMPTY result (requirement 6.5)", async () => {
    const ds = new MockChainDataSource({ approvals: { [TEST_ADDR.toLowerCase()]: [] } });
    const scanner = new ApprovalScanner(ds);
    const result = await scanner.scan(TEST_ADDR);
    expect(result.status).toBe("EMPTY");
    if (result.status !== "EMPTY") return;
    expect(result.approvals).toEqual([]);
    expect(result.message).toBe(NO_APPROVALS_MESSAGE);
  });

  it("returns EMPTY when the address has no preset data at all", async () => {
    const ds = new MockChainDataSource();
    const scanner = new ApprovalScanner(ds);
    const result = await scanner.scan(TEST_ADDR);
    expect(result.status).toBe("EMPTY");
  });
});
