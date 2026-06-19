/**
 * Presentation helpers for allocation labels: human-readable names and the
 * colour tones used by badges/charts.
 */
import type { AllocationLabel } from "@market-trends/shared";

export const ALLOCATION_LABELS: Record<AllocationLabel, string> = {
  "strong-buy": "Strong buy",
  buy: "Buy",
  "buy-moderate": "Buy moderate",
  "sell-moderate": "Sell moderate",
  sell: "Sell",
  "strong-sell": "Strong sell",
};

export function allocationTone(
  label: AllocationLabel,
): "bull" | "bear" | "neutral" {
  switch (label) {
    case "strong-buy":
    case "buy":
    case "buy-moderate":
      return "bull";
    case "strong-sell":
    case "sell":
    case "sell-moderate":
      return "bear";
  }
}
