import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { RetryPolicy, DataSourceUnavailable } from "../src/datasource/retry.js";

describe("RetryPolicy", () => {
  // Feature: wallet-risk-audit-agent, Property 27: for a data source call that first
  // succeeds on attempt k (or always fails), the total number of attempts equals
  // min(k, maxAttempts) and never exceeds maxAttempts (at most 4 attempts including the
  // first); when all attempts fail it throws DataSourceUnavailable.
  it("Property 27: data fetch retry cap", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }), // succeeds on attempt k; > maxAttempts means always fails
        async (successAtAttempt) => {
          const maxAttempts = 4;
          let attempts = 0;
          const policy = new RetryPolicy({
            timeoutMs: 1000,
            maxAttempts,
            sleep: async () => {},
            backoffMs: () => 0,
          });

          const op = async (): Promise<string> => {
            attempts += 1;
            if (attempts >= successAtAttempt) return "ok";
            throw new Error("transient");
          };

          if (successAtAttempt <= maxAttempts) {
            const result = await policy.run(op, "test");
            expect(result).toBe("ok");
            expect(attempts).toBe(successAtAttempt);
          } else {
            await expect(policy.run(op, "test")).rejects.toBeInstanceOf(
              DataSourceUnavailable,
            );
            expect(attempts).toBe(maxAttempts);
          }
          expect(attempts).toBeLessThanOrEqual(maxAttempts);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a timeout is treated as a failure and retried", async () => {
    const policy = new RetryPolicy({
      timeoutMs: 20,
      maxAttempts: 2,
      sleep: async () => {},
    });
    let attempts = 0;
    const op = async (): Promise<string> => {
      attempts += 1;
      // never resolves -> triggers timeout
      return new Promise<string>(() => {});
    };
    await expect(policy.run(op, "slow")).rejects.toBeInstanceOf(DataSourceUnavailable);
    expect(attempts).toBe(2);
  });
});
