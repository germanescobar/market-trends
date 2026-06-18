import { describe, expect, it } from "vitest";
import { linearRegression } from "../src/regression/linear.js";
import { calculateLogTrend } from "../src/regression/log-trend.js";
import type { PriceSeries } from "../src/types/index.js";

describe("linearRegression", () => {
  it("fits a perfect line exactly", () => {
    const x = [0, 1, 2, 3, 4];
    const y = [2, 4, 6, 8, 10]; // y = 2 + 2x
    const fit = linearRegression(x, y);
    expect(fit.intercept).toBeCloseTo(2, 10);
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.rSquared).toBeCloseTo(1, 10);
    expect(fit.residualStdDev).toBeCloseTo(0, 10);
    expect(fit.n).toBe(5);
  });

  it("fits a constant", () => {
    const x = [0, 1, 2, 3, 4];
    const y = [5, 5, 5, 5, 5];
    const fit = linearRegression(x, y);
    expect(fit.intercept).toBeCloseTo(5, 10);
    expect(fit.slope).toBeCloseTo(0, 10);
    expect(fit.rSquared).toBe(0);
  });

  it("handles noisy data with known slope", () => {
    // y = 3 + 0.5*x + tiny noise
    const x = Array.from({ length: 50 }, (_, i) => i);
    const y = x.map((xi) => 3 + 0.5 * xi + Math.sin(xi) * 0.001);
    const fit = linearRegression(x, y);
    expect(fit.slope).toBeCloseTo(0.5, 1);
    expect(fit.intercept).toBeCloseTo(3, 1);
    expect(fit.rSquared).toBeGreaterThan(0.99);
  });

  it("returns NaN for empty input", () => {
    const fit = linearRegression([], []);
    expect(fit.n).toBe(0);
    expect(Number.isNaN(fit.slope)).toBe(true);
    expect(Number.isNaN(fit.intercept)).toBe(true);
  });

  it("returns a flat line for a single observation", () => {
    const fit = linearRegression([3], [10]);
    expect(fit.slope).toBe(0);
    expect(fit.intercept).toBe(10);
    expect(fit.rSquared).toBe(0);
  });

  it("handles all-equal x without dividing by zero", () => {
    const fit = linearRegression([1, 1, 1], [2, 4, 6]);
    expect(Number.isFinite(fit.slope)).toBe(true);
    expect(Number.isFinite(fit.intercept)).toBe(true);
  });
});

describe("calculateLogTrend", () => {
  function syntheticSeries(cagr: number, vol: number, years: number, ticker = "TEST"): PriceSeries {
    // Build a daily series with monthly resampling that should approximate the requested CAGR.
    const start = Date.UTC(2000, 0, 1);
    const end = Date.UTC(2000 + years, 0, 1);
    const bars: PriceSeries["bars"] = [];
    let p = 100;
    const dt = 1 / 252;
    const mu = cagr - 0.5 * vol * vol;
    const sigma = vol;
    // Deterministic RNG.
    let s = 1234567;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const randn = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
    for (let t = start; t < end; t += 86_400_000) {
      const d = new Date(t);
      const day = d.getUTCDay();
      if (day === 0 || day === 6) continue;
      p *= Math.exp(mu * dt + sigma * Math.sqrt(dt) * randn());
      bars.push({
        date: d.toISOString().slice(0, 10),
        close: p,
        adjustedClose: p,
      });
    }
    return {
      ticker,
      bars,
      startDate: bars[0]!.date,
      endDate: bars[bars.length - 1]!.date,
      source: "test",
      frequency: "daily",
    };
  }

  it("recovers an approximate annualised CAGR for a synthetic series", () => {
    const targetCagr = 0.08;
    const series = syntheticSeries(targetCagr, 0.0, 30); // zero vol, long history
    const trend = calculateLogTrend(series, "max", "monthly");
    // No-vol synthetic series is exactly geometric, so CAGR recovery should be tight.
    expect(trend.annualizedCagr).toBeCloseTo(targetCagr, 1);
    expect(trend.lastActualPrice).toBeGreaterThan(0);
    expect(trend.lastTrendPrice).toBeGreaterThan(0);
    // With resampling, the last bar may not land exactly on the trend line —
    // but deviation should still be modest.
    expect(Math.abs(trend.deviationPercent)).toBeLessThan(0.3);
    expect(Number.isFinite(trend.lastZScore)).toBe(true);
  });

  it("respects the lookback window", () => {
    const series = syntheticSeries(0.08, 0.0, 25);
    const trend5 = calculateLogTrend(series, 5, "monthly");
    const trendMax = calculateLogTrend(series, "max", "monthly");
    // Both should be near 8% but with different sample sizes.
    expect(trend5.n).toBeLessThan(trendMax.n);
    expect(trend5.startDate >= trendMax.startDate).toBe(true);
  });

  it("produces finite z-scores for noisy data", () => {
    const series = syntheticSeries(0.08, 0.2, 15);
    const trend = calculateLogTrend(series, 10, "monthly");
    expect(Number.isFinite(trend.lastZScore)).toBe(true);
    // With 20% vol, residuals in log space are roughly ~20%/sqrt(years).
    // The last z-score could land anywhere within ~3 standard deviations.
    expect(Math.abs(trend.lastZScore)).toBeLessThan(5);
  });
});
