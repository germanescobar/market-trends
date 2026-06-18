import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Conditional class names with tailwind-merge for conflict-free composition. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format a number as a currency value with locale-aware separators. */
export function formatCurrency(
  value: number | null | undefined,
  options: { currency?: string; digits?: number } = {},
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const { currency = "USD", digits = 2 } = options;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Format a fraction as a signed percentage (e.g. 0.123 -> "+12.30%"). */
export function formatPercent(
  value: number | null | undefined,
  options: { digits?: number; sign?: boolean } = {},
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const { digits = 2, sign = true } = options;
  const v = value * 100;
  const fmt = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: sign ? "exceptZero" : "auto",
  }).format(v);
  return `${fmt}%`;
}

/** Format a numeric value with thousand separators and given decimals. */
export function formatNumber(
  value: number | null | undefined,
  digits = 2,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Format a z-score with sign and a fixed precision. */
export function formatZScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(2)}σ`;
}

/** Tailwind class for a deviation / z-score sign. */
export function deviationTone(value: number): "bull" | "bear" | "neutral" {
  if (!Number.isFinite(value)) return "neutral";
  if (value > 0.05) return "bear";
  if (value < -0.05) return "bull";
  return "neutral";
}

// Re-export the pure performance helpers from the shared package so the web
// app can compute risk metrics without round-tripping to the server.
export {
  annualizedSharpe,
  annualizedVolatility,
  cagr,
  maxDrawdown,
  mean,
  returns,
  stddev,
} from "@market-trends/shared";
