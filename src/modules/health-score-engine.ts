/**
 * Health_Score_Engine (task 10.1, per the "Health_Score_Engine" row in design.md and requirement 12).
 *
 * Pure logic component: turns the set of identified RiskItems (category + Risk_Level) into a
 * 0–100 integer Health_Score, a qualitative grade, and a per-item deduction breakdown. The module
 * never accesses the network and depends only on its inputs, so it is fully deterministic and can
 * be driven directly by property tests.
 *
 * Scoring model (design.md "Health score model"): a purely additive deduction function. This single
 * definition is the source of both determinism (requirement 12.4) and monotonicity (requirement 12.5):
 *
 *   weight(Risk_Level): CRITICAL=40, HIGH=25, MEDIUM=12, LOW=4   (non-increasing by severity)
 *   deduction(report)  = Σ weight(item.riskLevel) over every identified RiskItem in scope
 *   Health_Score       = max(0, 100 - deduction)
 *
 * Because the weights are non-negative integers and summation is order-independent, the score is an
 * integer, stays within [0, 100] after the max(0, …) clamp, is invariant to input ordering, and
 * never increases when a risk item is added or an item's Risk_Level is raised.
 */

import type {
  HealthGrade,
  HealthScoreResult,
  RiskItem,
  RiskLevel,
  ScoreDeduction,
} from "../models.js";
import { RISK_LEVEL_ORDER } from "../models.js";

// ── Scoring weights (design.md "Health score model") ────────────────────────────

/**
 * Deduction weight per Risk_Level. Integers and non-increasing by severity
 * (CRITICAL ≥ HIGH ≥ MEDIUM ≥ LOW), which keeps the score an integer and guarantees
 * monotonicity when an item's level is raised.
 */
export const WEIGHTS: Record<RiskLevel, number> = {
  CRITICAL: 40,
  HIGH: 25,
  MEDIUM: 12,
  LOW: 4,
};

/** The maximum (perfect) score, returned when there is no identified risk. */
export const MAX_SCORE = 100;

/** Pure deduction weight for a single Risk_Level. */
export function weightFor(riskLevel: RiskLevel): number {
  return WEIGHTS[riskLevel];
}

// ── Grade mapping (requirement 12.6) ────────────────────────────────────────────

/**
 * Maps a Health_Score to its qualitative grade (requirement 12.6):
 *   80–100 → EXCELLENT, 60–79 → GOOD, 40–59 → FAIR, 0–39 → POOR.
 * The bands are non-overlapping and cover [0, 100]; the mapping is monotonic
 * (a higher score never yields a worse grade).
 */
export function gradeForScore(score: number): HealthGrade {
  if (score >= 80) return "EXCELLENT";
  if (score >= 60) return "GOOD";
  if (score >= 40) return "FAIR";
  return "POOR";
}

// ── Deduction ordering (requirement 12.2) ───────────────────────────────────────

/**
 * Deterministic ordering for the deduction breakdown (requirement 12.2): primarily by points
 * contribution descending. Ties are broken deterministically so the ordering is independent of
 * input array order (requirement 12.4): higher Risk_Level first (RISK_LEVEL_ORDER desc), then
 * category ascending, then detail ascending.
 */
function compareDeductions(a: ScoreDeduction, b: ScoreDeduction): number {
  if (a.points !== b.points) return b.points - a.points; // points descending
  const levelDelta = RISK_LEVEL_ORDER[b.riskLevel] - RISK_LEVEL_ORDER[a.riskLevel];
  if (levelDelta !== 0) return levelDelta; // higher Risk_Level first
  if (a.category !== b.category) return a.category < b.category ? -1 : 1; // category ascending
  if (a.detail !== b.detail) return a.detail < b.detail ? -1 : 1; // detail ascending
  return 0;
}

// ── Public API ──────────────────────────────────────────────────────────────────

/** Optional inputs for {@link computeHealthScore}. */
export interface ComputeHealthScoreOptions {
  /**
   * When true, the result is flagged as computed on incomplete data (requirement 12.7).
   * The caller is responsible for passing only the risk items from completed modules; the
   * engine simply records the flag and never invents risks.
   */
  scoredOnIncompleteData?: boolean;
}

/**
 * Computes the Health_Score for a set of identified risk items (requirement 12).
 *
 * - 12.1: returns an integer score in [0, 100]; 100 means no identified risk.
 * - 12.2: `deductions` covers every identified risk item (category + Risk_Level + points),
 *   sorted by points contribution descending with a deterministic tie-break.
 * - 12.3: an empty `riskItems` yields score 100 (which falls in the 80–100 band).
 * - 12.4: deterministic — summation is order-independent, so any permutation of the same items
 *   yields the same score and the same deductions ordering.
 * - 12.5: monotonic — non-negative additive weights with a max(0, …) clamp guarantee the score is
 *   non-increasing when items are added or an item's Risk_Level is raised.
 * - 12.7: when `scoredOnIncompleteData` is true, the flag is recorded and the score is computed only
 *   from the provided (completed-module) risk items.
 */
export function computeHealthScore(
  riskItems: RiskItem[],
  options: ComputeHealthScoreOptions = {},
): HealthScoreResult {
  // One deduction per identified risk item (requirement 12.2: coverage).
  const deductions: ScoreDeduction[] = riskItems.map((item) => ({
    category: item.category,
    riskLevel: item.riskLevel,
    points: weightFor(item.riskLevel),
    detail: item.detail,
  }));

  // Order-independent sum of non-negative integer weights (requirement 12.4).
  const totalDeduction = deductions.reduce((sum, d) => sum + d.points, 0);

  // Clamp to [0, 100]; stays an integer because all weights are integers (requirement 12.1).
  const score = Math.max(0, MAX_SCORE - totalDeduction);

  // Sort the breakdown by contribution descending with a deterministic tie-break (requirement 12.2).
  deductions.sort(compareDeductions);

  return {
    score,
    grade: gradeForScore(score),
    deductions,
    scoredOnIncompleteData: options.scoredOnIncompleteData === true,
  };
}
