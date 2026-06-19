import type {
  AllocationRule,
  AllocationSuggestion,
} from "../types/index.js";

/**
 * Default staircase model. Maps z-scores from a log-trend regression to a
 * qualitative position-management signal. Tune via `setStaircaseRules`.
 *
 * Thresholds (inclusive lower, exclusive upper):
 *   z <= -2.0  : Strong buy
 *   -2.0..-1.0 : Buy
 *   -1.0..0.0  : Buy moderate
 *    0.0..+1.0 : Sell moderate
 *   +1.0..+2.0 : Sell
 *   z >= +2.0  : Strong sell
 */
export const DEFAULT_STAIRCASE: AllocationRule[] = [
  {
    zMin: -Infinity,
    zMax: -2,
    label: "strong-buy",
    description:
      "Price is more than 2σ below trend — historically rare and statistically cheap.",
  },
  {
    zMin: -2,
    zMax: -1,
    label: "buy",
    description: "Price is 1–2σ below trend — well below long-term average.",
  },
  {
    zMin: -1,
    zMax: 0,
    label: "buy-moderate",
    description: "Price is below trend but within the normal range.",
  },
  {
    zMin: 0,
    zMax: 1,
    label: "sell-moderate",
    description: "Price is above trend but within one standard deviation.",
  },
  {
    zMin: 1,
    zMax: 2,
    label: "sell",
    description: "Price is 1–2σ above trend — consider trimming the position.",
  },
  {
    zMin: 2,
    zMax: Infinity,
    label: "strong-sell",
    description:
      "Price is more than 2σ above trend — historically expensive; reduce or exit.",
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
      };
    }
  }
  // Fallback (unreachable when rules cover (-Inf, +Inf), but defensive).
  return {
    zScore,
    label: "sell-moderate",
    description: "No matching rule — using baseline sell-moderate signal.",
  };
}
