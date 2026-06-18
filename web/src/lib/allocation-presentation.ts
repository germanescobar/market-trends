/**
 * Presentation helpers for allocation labels: human-readable names and the
 * colour tones used by badges/charts.
 */
import type { AllocationLabel } from "@market-trends/shared";

export const ALLOCATION_LABELS: Record<AllocationLabel, string> = {
  "strong-buy": "Strong buy",
  "buy-aggressive": "Buy aggressive",
  "buy-moderate": "Buy moderate",
  "normal-dca": "Normal DCA",
  "buy-less": "Buy less",
  "hold-cash": "Hold cash",
};

export function allocationTone(
  label: AllocationLabel,
): "bull" | "bear" | "neutral" {
  switch (label) {
    case "strong-buy":
    case "buy-aggressive":
    case "buy-moderate":
      return "bull";
    case "hold-cash":
    case "buy-less":
      return "bear";
    case "normal-dca":
      return "neutral";
  }
}
