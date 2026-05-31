import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computeHealthScore,
  gradeForScore,
  weightFor,
  WEIGHTS,
  MAX_SCORE,
} from "../src/modules/health-score-engine.js";
import type { RiskItem, RiskLevel } from "../src/models.js";
import { RISK_LEVEL_ORDER } from "../src/models.js";

const RISK_LEVELS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** Generates a RiskItem over the 4 risk levels with arbitrary categories/details. */
const riskItemArb: fc.Arbitrary<RiskItem> = fc.record({
  category: fc.string(),
  riskLevel: fc.constantFrom<RiskLevel>(...RISK_LEVELS),
  detail: fc.string(),
});

/** Generates a set (array) of RiskItems. */
const riskItemsArb = (maxLength = 30): fc.Arbitrary<RiskItem[]> =>
  fc.array(riskItemArb, { maxLength });

/** Fisher–Yates-style permutation driven by a fast-check-provided index sequence. */
function permute<T>(items: readonly T[], swaps: number[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = swaps[i] !== undefined ? swaps[i] % (i + 1) : 0;
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

describe("Health_Score_Engine", () => {
  // Feature: wallet-risk-audit-agent, Property 16: for any risk item set, the Health_Score_Engine
  // outputs an integer from 0 to 100 (inclusive); when the risk item set is empty the score is 100
  // and falls in the 80–100 band.
  it("Property 16: health score value range", () => {
    fc.assert(
      fc.property(riskItemsArb(), (items) => {
        const result = computeHealthScore(items);
        expect(Number.isInteger(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        if (items.length === 0) {
          expect(result.score).toBe(100);
          expect(result.score).toBeGreaterThanOrEqual(80);
          expect(result.score).toBeLessThanOrEqual(100);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: wallet-risk-audit-agent, Property 17: for any risk item set, computing the Health_Score
  // twice on the same input gives the same score; and the score is independent of the ordering of the
  // risk items (invariant under any permutation of the set).
  it("Property 17: health score determinism (permutation invariant)", () => {
    fc.assert(
      fc.property(
        riskItemsArb(),
        fc.array(fc.nat(), { maxLength: 30 }),
        (items, swaps) => {
          const a = computeHealthScore(items);
          const b = computeHealthScore(items);
          // Same input → identical score and identical deductions ordering.
          expect(b.score).toBe(a.score);
          expect(b.deductions).toEqual(a.deductions);

          // Any permutation of the same multiset → identical score and deductions ordering.
          const shuffled = permute(items, swaps);
          const c = computeHealthScore(shuffled);
          expect(c.score).toBe(a.score);
          expect(c.deductions).toEqual(a.deductions);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: wallet-risk-audit-agent, Property 18: for any two risk item sets, if one is a superset
  // of the other, or one item's Risk_Level is raised, then the riskier side's Health_Score is not
  // higher than the other side's.
  it("Property 18: health score monotonicity", () => {
    fc.assert(
      fc.property(
        riskItemsArb(),
        riskItemsArb(15),
        (base, extra) => {
          // Adding items never increases the score (superset relation).
          const superset = base.concat(extra);
          const baseScore = computeHealthScore(base).score;
          const supersetScore = computeHealthScore(superset).score;
          expect(supersetScore).toBeLessThanOrEqual(baseScore);
        },
      ),
      { numRuns: 200 },
    );

    // Raising a single item's Risk_Level never increases the score.
    fc.assert(
      fc.property(
        riskItemsArb(20),
        fc.nat(),
        fc.constantFrom<RiskLevel>(...RISK_LEVELS),
        (items, idxSeed, higher) => {
          if (items.length === 0) return; // nothing to raise
          const idx = idxSeed % items.length;
          const original = items[idx];
          // Only consider a level that is >= the current level (a raise, not a lowering).
          if (RISK_LEVEL_ORDER[higher] < RISK_LEVEL_ORDER[original.riskLevel]) return;
          const raised = items.slice();
          raised[idx] = { ...original, riskLevel: higher };
          const beforeScore = computeHealthScore(items).score;
          const afterScore = computeHealthScore(raised).score;
          expect(afterScore).toBeLessThanOrEqual(beforeScore);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: wallet-risk-audit-agent, Property 19: for any Health_Score from 0 to 100, the qualitative
  // grade mapping satisfies 80–100 EXCELLENT, 60–79 GOOD, 40–59 FAIR, 0–39 POOR, and a higher score
  // never maps to a worse grade (the mapping is monotonic non-improving as the score decreases).
  it("Property 19: health score grade mapping", () => {
    const rank: Record<string, number> = { POOR: 0, FAIR: 1, GOOD: 2, EXCELLENT: 3 };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (score) => {
        const grade = gradeForScore(score);
        if (score >= 80) expect(grade).toBe("EXCELLENT");
        else if (score >= 60) expect(grade).toBe("GOOD");
        else if (score >= 40) expect(grade).toBe("FAIR");
        else expect(grade).toBe("POOR");

        // Monotonic: a lower score never yields a better grade.
        if (score > 0) {
          expect(rank[gradeForScore(score - 1)]).toBeLessThanOrEqual(rank[grade]);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: wallet-risk-audit-agent, Property 20: for any analysis result containing incomplete
  // modules, the Health_Score is computed only from the risk items produced by successfully completed
  // modules (the engine does not invent risks), and the report flags scoredOnIncompleteData as true.
  it("Property 20: scoring under incomplete data", () => {
    fc.assert(
      fc.property(riskItemsArb(), (items) => {
        const flagged = computeHealthScore(items, { scoredOnIncompleteData: true });
        const baseline = computeHealthScore(items);
        // The flag is recorded.
        expect(flagged.scoredOnIncompleteData).toBe(true);
        // The score equals computing over only the provided items — no invented risks.
        expect(flagged.score).toBe(baseline.score);
        expect(flagged.deductions).toEqual(baseline.deductions);
        // Default option leaves the flag false.
        expect(baseline.scoredOnIncompleteData).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: wallet-risk-audit-agent, Property 21: for any risk item set, the deduction breakdown
  // covers every identified risk item (including its risk category and Risk_Level), and is sorted by
  // each risk item's deduction contribution from high to low.
  it("Property 21: deduction breakdown coverage and ordering", () => {
    fc.assert(
      fc.property(riskItemsArb(), (items) => {
        const { deductions } = computeHealthScore(items);

        // Coverage: one deduction per identified risk item.
        expect(deductions.length).toBe(items.length);

        // Each item is represented with its Risk_Level and the correct points contribution.
        for (const d of deductions) {
          expect(RISK_LEVELS).toContain(d.riskLevel);
          expect(d.points).toBe(weightFor(d.riskLevel));
        }

        // The multiset of (category, riskLevel, detail, points) matches the input items.
        const key = (c: string, l: RiskLevel, det: string, p: number): string =>
          JSON.stringify([c, l, det, p]);
        const expected = items
          .map((it) => key(it.category, it.riskLevel, it.detail, WEIGHTS[it.riskLevel]))
          .sort();
        const actual = deductions
          .map((d) => key(d.category, d.riskLevel, d.detail, d.points))
          .sort();
        expect(actual).toEqual(expected);

        // Sorted by points descending.
        for (let i = 1; i < deductions.length; i++) {
          expect(deductions[i - 1].points).toBeGreaterThanOrEqual(deductions[i].points);
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Unit tests: specific examples and edge cases ─────────────────────────────

  it("empty risk set yields a perfect score and EXCELLENT grade", () => {
    const result = computeHealthScore([]);
    expect(result.score).toBe(MAX_SCORE);
    expect(result.grade).toBe("EXCELLENT");
    expect(result.deductions).toEqual([]);
    expect(result.scoredOnIncompleteData).toBe(false);
  });

  it("weights match the design model", () => {
    expect(WEIGHTS).toEqual({ CRITICAL: 40, HIGH: 25, MEDIUM: 12, LOW: 4 });
    expect(weightFor("CRITICAL")).toBe(40);
    expect(weightFor("HIGH")).toBe(25);
    expect(weightFor("MEDIUM")).toBe(12);
    expect(weightFor("LOW")).toBe(4);
  });

  it("computes a known additive deduction example", () => {
    const items: RiskItem[] = [
      { category: "UNLIMITED_APPROVAL", riskLevel: "CRITICAL", detail: "a" },
      { category: "SUSPICIOUS_CONTRACT", riskLevel: "MEDIUM", detail: "b" },
      { category: "ABNORMAL_TX", riskLevel: "LOW", detail: "c" },
    ];
    // 100 - (40 + 12 + 4) = 44 → FAIR
    const result = computeHealthScore(items);
    expect(result.score).toBe(44);
    expect(result.grade).toBe("FAIR");
    // Highest contribution first.
    expect(result.deductions[0].points).toBe(40);
    expect(result.deductions[result.deductions.length - 1].points).toBe(4);
  });

  it("clamps the score at 0 when deductions exceed 100", () => {
    const items: RiskItem[] = Array.from({ length: 5 }, (_, i) => ({
      category: `c${i}`,
      riskLevel: "CRITICAL" as RiskLevel,
      detail: `d${i}`,
    }));
    // 5 * 40 = 200 deduction → clamped to 0 → POOR
    const result = computeHealthScore(items);
    expect(result.score).toBe(0);
    expect(result.grade).toBe("POOR");
  });

  it("grade band boundaries map correctly", () => {
    expect(gradeForScore(100)).toBe("EXCELLENT");
    expect(gradeForScore(80)).toBe("EXCELLENT");
    expect(gradeForScore(79)).toBe("GOOD");
    expect(gradeForScore(60)).toBe("GOOD");
    expect(gradeForScore(59)).toBe("FAIR");
    expect(gradeForScore(40)).toBe("FAIR");
    expect(gradeForScore(39)).toBe("POOR");
    expect(gradeForScore(0)).toBe("POOR");
  });
});
