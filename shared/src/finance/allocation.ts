import type {
  AllocationRule,
  AllocationSuggestion,
} from "../types/index.js";

/**
 * Default staircase model. Maps z-scores from a log-trend regression to a
 * suggested deployment of planned cash. Inspired by systematic value/DCA
 * frameworks; tune via `setStaircaseRules`.
 *
 * Thresholds (inclusive lower, exclusive upper):
 *   z <= -2.0  : Strong buy       (deploy 100%)
 *   -2.0..-1.0 : Buy aggressive   (75%)
 *   -1.0..0.0  : Buy moderate     (60%)
 *    0.0..+1.0 : Normal DCA       (40%)
 *   +1.0..+2.0 : Buy less         (20%)
 *   z >= +2.0  : Hold cash / trim (0%)
 */
export const DEFAULT_STAIRCASE: AllocationRule[] = [
  {
    zMin: -Infinity,
    zMax: -2,
    label: "strong-buy",
    description:
      "Price is more than 2σ below trend — historically rare and statistically cheap.",
    allocation: 1.0,
  },
  {
    zMin: -2,
    zMax: -1,
    label: "buy-aggressive",
    description: "Price is 1–2σ below trend — well below long-term average.",
    allocation: 0.75,
  },
  {
    zMin: -1,
    zMax: 0,
    label: "buy-moderate",
    description: "Price is below trend but within the normal range.",
    allocation: 0.6,
  },
  {
    zMin: 0,
    zMax: 1,
    label: "normal-dca",
    description: "Price is above trend but within one standard deviation.",
    allocation: 0.4,
  },
  {
    zMin: 1,
    zMax: 2,
    label: "buy-less",
    description: "Price is 1–2σ above trend — be cautious with new purchases.",
    allocation: 0.2,
  },
  {
    zMin: 2,
    zMax: Infinity,
    label: "hold-cash",
    description:
      "Price is more than 2σ above trend — historically expensive; favour cash.",
    allocation: 0,
  },
];

/** Resolve a z-score to an allocation suggestion using the supplied rules. */
export function resolveAllocation(
  zScore: number,
  rules: AllocationRule[] = DEFAULT_STAIRCASE,
): AllocationSuggestion {
  for (const rule of rules) {
    if (zScore >= rule.zMin && zScore < rule.zMax) {
      return {
        zScore,
        label: rule.label,
        description: rule.description,
        deployment: clamp01(rule.allocation),
      };
    }
  }
  // Fallback (unreachable when rules cover (-Inf, +Inf), but defensive).
  return {
    zScore,
    label: "normal-dca",
    description: "No matching rule — using baseline DCA.",
    deployment: 0.4,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
