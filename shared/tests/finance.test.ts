import { describe, expect, it } from "vitest";
import {
  annualizedSharpe,
  annualizedVolatility,
  cagr,
  maxDrawdown,
  mean,
  returns,
  stddev,
} from "../src/finance/performance.js";
import { DEFAULT_STAIRCASE, resolveAllocation } from "../src/finance/allocation.js";

describe("performance metrics", () => {
  it("computes simple returns", () => {
    const r = returns([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 10);
    expect(r[1]).toBeCloseTo(-0.1, 10);
  });

  it("computes mean and stddev", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    const s = stddev([1, 2, 3, 4, 5]);
    expect(s).toBeCloseTo(Math.sqrt(2.5), 6);
  });

  it("computes CAGR", () => {
    // 100 -> 200 over 10 years => ~7.18% CAGR.
    expect(cagr(100, 200, 10)).toBeCloseTo(Math.pow(2, 0.1) - 1, 6);
  });

  it("computes max drawdown as a negative number", () => {
    // peak at index 2, trough at index 4: dd = 80/150 - 1
    expect(maxDrawdown([100, 120, 150, 100, 80, 130])).toBeCloseTo(80 / 150 - 1, 6);
  });

  it("annualises volatility by sqrt(periods)", () => {
    const r = [0.01, -0.02, 0.03, -0.01];
    const monthly = annualizedVolatility(r, 12);
    const annual = stddev(r) * Math.sqrt(12);
    expect(monthly).toBeCloseTo(annual, 10);
  });

  it("computes Sharpe-like ratio", () => {
    const r = [0.01, 0.02, 0.015, -0.005];
    const sharpe = annualizedSharpe(r, 12, 0);
    expect(sharpe).not.toBe(0);
  });

  it("returns 0 for degenerate inputs", () => {
    expect(cagr(0, 100, 1)).toBe(0);
    expect(cagr(100, 0, 1)).toBe(0);
    expect(cagr(100, 100, 0)).toBe(0);
    expect(maxDrawdown([])).toBe(0);
    expect(annualizedVolatility([], 12)).toBe(0);
  });
});

describe("staircase allocation", () => {
  it("returns strong-buy label for very negative z-scores", () => {
    const a = resolveAllocation(-3, DEFAULT_STAIRCASE);
    expect(a.label).toBe("strong-buy");
  });

  it("returns strong-sell label for very positive z-scores", () => {
    const a = resolveAllocation(3, DEFAULT_STAIRCASE);
    expect(a.label).toBe("strong-sell");
  });

  it("matches the documented buckets", () => {
    const cases: Array<[number, string]> = [
      [-2.5, "strong-buy"],
      [-1.5, "buy"],
      [-0.5, "buy-moderate"],
      [0.5, "sell-moderate"],
      [1.5, "sell"],
      [2.5, "strong-sell"],
    ];
    for (const [z, label] of cases) {
      const a = resolveAllocation(z, DEFAULT_STAIRCASE);
      expect(a.label).toBe(label);
    }
  });

  it("falls back to sell-moderate when no rule matches", () => {
    const a = resolveAllocation(0, []);
    expect(a.label).toBe("sell-moderate");
  });
});
