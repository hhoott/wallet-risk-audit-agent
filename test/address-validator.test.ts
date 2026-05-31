import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { getAddress } from "viem";
import {
  validateAddress,
  validateAddresses,
  isSupportedNetwork,
} from "../src/modules/address-validator.js";
import { AUDITED_CHAIN, MAX_ADDRESSES_PER_REQUEST } from "../src/config.js";

// ── Test utilities / generators ──────────────────────────────────────

/** Independent oracle: whether, after trimming, the value matches the valid address format (a reference implementation decoupled from the implementation). */
const ADDRESS_ORACLE = /^0x[0-9a-fA-F]{40}$/;
function expectedValid(raw: string): boolean {
  return ADDRESS_ORACLE.test(raw.trim());
}

const HEX_LOWER = "0123456789abcdef".split("");

/** 40 lowercase hexadecimal characters. */
const hex40 = fc
  .array(fc.constantFrom(...HEX_LOWER), { minLength: 40, maxLength: 40 })
  .map((cs) => cs.join(""));

/** Valid address generator: covers all-lowercase, all-uppercase, randomly mixed case, and real EIP-55 checksum form. */
const validAddress: fc.Arbitrary<string> = hex40.chain((body) => {
  const lower = `0x${body}`;
  const upper = `0x${body.toUpperCase()}`;
  const checksum = getAddress(lower as `0x${string}`); // real EIP-55 checksum
  // random per-character mixed case
  const mixed = fc
    .array(fc.boolean(), { minLength: 40, maxLength: 40 })
    .map(
      (flags) =>
        `0x${body
          .split("")
          .map((c, i) => (flags[i] ? c.toUpperCase() : c))
          .join("")}`,
    );
  return fc.oneof(
    fc.constant(lower),
    fc.constant(upper),
    fc.constant(checksum),
    mixed,
  );
});

/** Generator for various invalid forms. */
const invalidAddress: fc.Arbitrary<string> = fc.oneof(
  // abnormal length (0x + n hex, n ≠ 40)
  fc
    .integer({ min: 0, max: 64 })
    .filter((n) => n !== 40)
    .chain((n) =>
      fc
        .array(fc.constantFrom(...HEX_LOWER), { minLength: n, maxLength: n })
        .map((cs) => `0x${cs.join("")}`),
    ),
  // missing 0x prefix (bare 40 hex)
  hex40,
  // contains non-hex characters
  hex40.map((body) => `0x${body.slice(0, 39)}g`),
  // ENS domains
  fc.constantFrom("vitalik.eth", "foo.eth", "a.b.eth", "wallet.crypto"),
  // empty / whitespace-only
  fc.constantFrom("", "   ", "\t", "\n  "),
  // arbitrary string
  fc.string(),
);

// ── Property 1 ───────────────────────────────────────────────────────

describe("Address_Validator — validateAddress", () => {
  // Feature: wallet-risk-audit-agent, Property 1: for any string, Address_Validator deems its format valid if and only if it starts with 0x followed by exactly 40 hexadecimal characters (case-insensitive) for a total length of 42; any value that does not satisfy this is rejected and returns a message indicating the reason, and no pending-analysis record is produced.
  it("Property 1: address format validation correctness", () => {
    fc.assert(
      fc.property(fc.oneof(validAddress, invalidAddress), (raw) => {
        const result = validateAddress(raw);
        const oracle = expectedValid(raw);

        // valid if and only if the format is satisfied
        expect(result.valid).toBe(oracle);

        if (oracle) {
          // passes → marked as pending-analysis, normalized to all-lowercase, no error
          expect(result.pendingAnalysis).toBe(true);
          expect(result.normalized).toBe(raw.trim().toLowerCase());
          expect(result.error).toBeUndefined();
          expect(result.errorKind).toBeUndefined();
        } else {
          // rejected → no pending-analysis record created, accompanied by reason and category
          expect(result.pendingAnalysis).toBe(false);
          expect(result.normalized).toBeUndefined();
          expect(result.error).toBeTruthy();
          expect(result.errorKind).toBeDefined();
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ── Property 2 ───────────────────────────────────────────────────────

/** Deduplication key: trim whitespace + lowercase (consistent with the implementation's deduplication semantics). */
function dedupKey(raw: string): string {
  return raw.trim().toLowerCase();
}

describe("Address_Validator — validateAddresses", () => {
  // Feature: wallet-risk-audit-agent, Property 2: for any list of wallet addresses, the result that batch validation gives for each address matches the result of validating that address individually; and after deduplicating a list containing repeated addresses, the output addresses are mutually distinct and equal to the deduplicated set of the input.
  it("Property 2: batch validation is equivalent to validating one by one and deduplication is idempotent", () => {
    fc.assert(
      fc.property(
        // keep within the limit (≤ 50), focusing on constructing lists with duplicates
        fc.array(fc.oneof(validAddress, invalidAddress), {
          minLength: 0,
          maxLength: MAX_ADDRESSES_PER_REQUEST,
        }),
        (list) => {
          const batch = validateAddresses(list);
          expect(batch.rejected).toBe(false);

          // expected deduplicated key set (in order of first appearance)
          const firstByKey = new Map<string, string>();
          for (const raw of list) {
            const k = dedupKey(raw);
            if (!firstByKey.has(k)) firstByKey.set(k, raw);
          }
          const expectedKeys = [...firstByKey.keys()];

          // count and order: exactly one result per deduplicated key
          expect(batch.results.length).toBe(expectedKeys.length);
          const resultKeys = batch.results.map((r) => dedupKey(r.input));
          expect(resultKeys).toEqual(expectedKeys);

          // equivalence: each batch result === validating its first-occurrence raw individually
          for (const r of batch.results) {
            const first = firstByKey.get(dedupKey(r.input))!;
            expect(r).toEqual(validateAddress(first));
          }

          // deduplication: result keys are mutually distinct
          expect(new Set(resultKeys).size).toBe(resultKeys.length);

          // pendingAddresses: mutually distinct, all-lowercase, equal to the deduplicated set of valid addresses
          const expectedPending = batch.results
            .filter((r) => r.valid)
            .map((r) => r.normalized!);
          expect(batch.pendingAddresses).toEqual(expectedPending);
          expect(new Set(batch.pendingAddresses).size).toBe(
            batch.pendingAddresses.length,
          );
          for (const a of batch.pendingAddresses) {
            expect(a).toBe(a.toLowerCase());
          }

          // idempotence: re-running batch validation on the result inputs leaves the deduplicated set unchanged
          const again = validateAddresses(batch.results.map((r) => r.input));
          expect(again.results.map((r) => dedupKey(r.input))).toEqual(
            expectedKeys,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ── Task 4.4: boundary unit tests ────────────────────────────────────

describe("Address_Validator — boundary unit tests", () => {
  const VALID_LOWER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

  it("accepts an all-lowercase address", () => {
    const r = validateAddress(VALID_LOWER);
    expect(r.valid).toBe(true);
    expect(r.pendingAnalysis).toBe(true);
    expect(r.normalized).toBe(VALID_LOWER);
  });

  it("accepts an all-uppercase address and normalizes it to lowercase", () => {
    const r = validateAddress("0x" + VALID_LOWER.slice(2).toUpperCase());
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe(VALID_LOWER);
  });

  it("accepts an EIP-55 checksum (mixed-case) address", () => {
    const checksum = getAddress(VALID_LOWER as `0x${string}`);
    expect(checksum).not.toBe(VALID_LOWER); // confirm it is indeed mixed case
    const r = validateAddress(checksum);
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe(VALID_LOWER);
  });

  // Requirement 1.3: blank address
  it("rejects an empty string and indicates the address must not be empty (1.3)", () => {
    const r = validateAddress("");
    expect(r.valid).toBe(false);
    expect(r.pendingAnalysis).toBe(false);
    expect(r.errorKind).toBe("EMPTY");
    expect(r.error).toContain("must not be empty");
  });

  it("rejects a whitespace-only value and indicates the address must not be empty (1.3)", () => {
    const r = validateAddress("    ");
    expect(r.valid).toBe(false);
    expect(r.errorKind).toBe("EMPTY");
    expect(r.error).toContain("must not be empty");
  });

  it("rejects an ENS domain as a format error (1.2)", () => {
    const r = validateAddress("vitalik.eth");
    expect(r.valid).toBe(false);
    expect(r.errorKind).toBe("INVALID_FORMAT");
    expect(r.pendingAnalysis).toBe(false);
  });

  it("rejects a wrong-length value as a format error and explains the length (1.2)", () => {
    const r = validateAddress("0x1234");
    expect(r.valid).toBe(false);
    expect(r.errorKind).toBe("INVALID_FORMAT");
    expect(r.error).toContain("length");
  });

  it("rejects a value containing non-hexadecimal characters as a format error (1.2)", () => {
    const r = validateAddress("0x" + "z".repeat(40));
    expect(r.valid).toBe(false);
    expect(r.errorKind).toBe("INVALID_FORMAT");
  });

  // Requirement 1.6: more than 50 addresses
  it("rejects the entire request when there are more than 50 addresses and indicates the limit of 50 (1.6)", () => {
    const addrs = Array.from(
      { length: MAX_ADDRESSES_PER_REQUEST + 1 },
      (_, i) => "0x" + i.toString(16).padStart(40, "0"),
    );
    const batch = validateAddresses(addrs);
    expect(batch.rejected).toBe(true);
    expect(batch.errorKind).toBe("TOO_MANY_ADDRESSES");
    expect(batch.error).toContain(String(MAX_ADDRESSES_PER_REQUEST));
    expect(batch.results).toHaveLength(0);
    expect(batch.pendingAddresses).toHaveLength(0);
  });

  it("does not trigger the limit rejection at exactly 50 addresses (1.6 boundary)", () => {
    const addrs = Array.from(
      { length: MAX_ADDRESSES_PER_REQUEST },
      (_, i) => "0x" + i.toString(16).padStart(40, "0"),
    );
    const batch = validateAddresses(addrs);
    expect(batch.rejected).toBe(false);
    expect(batch.results).toHaveLength(MAX_ADDRESSES_PER_REQUEST);
  });

  it("keeps only one entry after deduplicating repeated addresses (1.7)", () => {
    const batch = validateAddresses([
      VALID_LOWER,
      VALID_LOWER.toUpperCase().replace("0X", "0x"), // same address, different case
      VALID_LOWER,
    ]);
    expect(batch.rejected).toBe(false);
    expect(batch.results).toHaveLength(1);
    expect(batch.pendingAddresses).toEqual([VALID_LOWER]);
  });

  // Requirement 17.2: non-Ethereum network message
  it("returns 'this network is not supported yet' when a non-Ethereum network is explicitly declared (17.2)", () => {
    const r = validateAddress(VALID_LOWER, { network: "Polygon" });
    expect(r.valid).toBe(false);
    expect(r.errorKind).toBe("UNSUPPORTED_NETWORK");
    expect(r.error).toContain("not supported yet");
  });

  it("treats the audited chain / its aliases as a supported network (17.2)", () => {
    expect(isSupportedNetwork(AUDITED_CHAIN)).toBe(true);
    expect(isSupportedNetwork("ethereum")).toBe(true);
    expect(isSupportedNetwork("eth")).toBe(true);
    expect(isSupportedNetwork("1")).toBe(true);
    expect(isSupportedNetwork(undefined)).toBe(true);
    expect(isSupportedNetwork("")).toBe(true);
    expect(isSupportedNetwork("Polygon")).toBe(false);
    expect(isSupportedNetwork("bsc")).toBe(false);

    const ok = validateAddress(VALID_LOWER, { network: "ethereum" });
    expect(ok.valid).toBe(true);
  });

  it("returns not-supported per address for a non-Ethereum network in batch validation (17.2 + 1.5)", () => {
    const batch = validateAddresses([VALID_LOWER], { network: "Arbitrum" });
    expect(batch.rejected).toBe(false);
    expect(batch.results[0].errorKind).toBe("UNSUPPORTED_NETWORK");
    expect(batch.pendingAddresses).toHaveLength(0);
  });
});
