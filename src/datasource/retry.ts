/**
 * Unified retry / timeout policy (task 3.2, requirements 18.1 / 18.2).
 *
 * Rule: each request has a 10s timeout; on failure (timeout or error) it auto-retries,
 * at most 3 retries (4 attempts total including the first); if all attempts fail it
 * throws DataSourceUnavailable.
 */

import { DATA_SOURCE_TIMEOUT_MS, DATA_SOURCE_MAX_ATTEMPTS } from "../config.js";

/** Thrown when a data source remains unavailable after retries are exhausted. */
export class DataSourceUnavailable extends Error {
  constructor(
    public readonly sourceName: string,
    public readonly attempts: number,
    public readonly lastError?: unknown,
  ) {
    super(`Data source unavailable: ${sourceName} (after ${attempts} attempts)`);
    this.name = "DataSourceUnavailable";
  }
}

export interface RetryPolicyOptions {
  timeoutMs: number;
  maxAttempts: number;
  /** Injected sleep, for testing; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Retry backoff (ms) computation; defaults to no backoff (0), for tests and fast failure. */
  backoffMs?: (attempt: number) => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Apply a timeout to a single Promise. On timeout, reject with a TimeoutError (the underlying op is not cancelled). */
function withTimeout<T>(op: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Request timed out (${timeoutMs}ms)`));
      }
    }, timeoutMs);
    op().then(
      (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(val);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}

export class RetryPolicy {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: (attempt: number) => number;

  constructor(opts?: Partial<RetryPolicyOptions>) {
    this.timeoutMs = opts?.timeoutMs ?? DATA_SOURCE_TIMEOUT_MS;
    this.maxAttempts = opts?.maxAttempts ?? DATA_SOURCE_MAX_ATTEMPTS;
    this.sleep = opts?.sleep ?? defaultSleep;
    this.backoffMs = opts?.backoffMs ?? (() => 0);
  }

  /**
   * Run an operation with timeout and retry.
   * Total attempts = min(attempt at which it first succeeds, maxAttempts), never exceeding maxAttempts.
   * If all attempts fail, throws DataSourceUnavailable(label, maxAttempts, lastError).
   */
  async run<T>(op: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await withTimeout(op, this.timeoutMs);
      } catch (err) {
        lastError = err;
        if (attempt < this.maxAttempts) {
          const delay = this.backoffMs(attempt);
          if (delay > 0) await this.sleep(delay);
        }
      }
    }
    throw new DataSourceUnavailable(label, this.maxAttempts, lastError);
  }
}
