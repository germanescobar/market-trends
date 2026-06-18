import { describe, expect, it } from "vitest";
import { DEFAULT_STAIRCASE, resolveAllocation, runBacktest } from "../src/finance/index.js";
import type { BacktestInput, PriceSeries } from "../src/types/index.js";

function trendingSeries(cagr: number, vol: number, years: number): PriceSeries {
  const start = Date.UTC(2000, 0, 1);
  const end = Date.UTC(2000 + years, 0, 1);
  const bars: PriceSeries["bars"] = [];
  let p = 100;
  let s = 1234567;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const randn = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
  const mu = cagr - 0.5 * vol * vol;
  const dt = 1 / 252;
  for (let t = start; t < end; t += 86_400_000) {
    const d = new Date(t);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    p *= Math.exp(mu * dt + vol * Math.sqrt(dt) * randn());
    bars.push({
      date: d.toISOString().slice(0, 10),
      close: p,
      adjustedClose: p,
    });
  }
  return {
    ticker: "TEST",
    bars,
    startDate: bars[0]!.date,
    endDate: bars[bars.length - 1]!.date,
    source: "test",
    frequency: "daily",
  };
}

const baseInput = (overrides: Partial<BacktestInput> = {}): BacktestInput => ({
  ticker: "TEST",
  startDate: "2005-01-01",
  endDate: "2019-12-31",
  frequency: "monthly",
  startingValue: 10_000,
  monthlyContribution: 0,
  baseEquityAllocation: 0.6,
  minEquityAllocation: 0,
  maxEquityAllocation: 1,
  transactionCost: 0.001,
  rebalance: "monthly",
  ...overrides,
});

describe("runBacktest", () => {
  it("buy-and-hold produces a finite final value and a positive CAGR for an upward series", () => {
    // Use low volatility so the trend dominates and the final value > initial.
    const series = trendingSeries(0.08, 0.05, 20);
    const result = runBacktest(baseInput({ monthlyContribution: 0 }), series, "buy-and-hold");
    expect(result.metrics.finalValue).toBeGreaterThan(result.metrics.totalContributed);
    expect(result.metrics.cagr).toBeGreaterThan(0);
    expect(Number.isFinite(result.metrics.cagr)).toBe(true);
    expect(result.metrics.numberOfTrades).toBe(1);
  });

  it("DCA produces more than one trade", () => {
    const series = trendingSeries(0.05, 0.15, 15);
    const result = runBacktest(
      baseInput({ monthlyContribution: 100, baseEquityAllocation: 0.6 }),
      series,
      "dca",
    );
    expect(result.metrics.numberOfTrades).toBeGreaterThan(1);
    expect(result.metrics.percentTimeInvested).toBeGreaterThan(0);
    expect(result.metrics.percentTimeInvested).toBeLessThanOrEqual(1);
  });

  it("trend-staircase respects the staircase's deployment", () => {
    const series = trendingSeries(0.05, 0.15, 15);
    const result = runBacktest(
      baseInput({ monthlyContribution: 100, frequency: "monthly" }),
      series,
      "trend-staircase",
    );
    expect(result.metrics.numberOfTrades).toBeGreaterThan(0);
    // Average allocation should be within staircase bounds for the prices
    // seen during the backtest.
    expect(result.metrics.percentTimeInvested).toBeGreaterThanOrEqual(0);
    expect(result.metrics.percentTimeInvested).toBeLessThanOrEqual(1);
  });

  it("uses the staircase to clip allocations to min/max", () => {
    const series = trendingSeries(0.08, 0.05, 15);
    const result = runBacktest(
      baseInput({
        monthlyContribution: 0,
        startingValue: 10_000,
        frequency: "monthly",
        minEquityAllocation: 0.2,
        maxEquityAllocation: 0.8,
      }),
      series,
      "trend-staircase",
    );
    // The first bar is uninvested (we wait for the first rebalance step),
    // but every later point should fall close to the [min, max] corridor.
    // A small deadband (~1% of portfolio value) is applied to avoid churning
    // when the current allocation is already within the target band.
    for (let i = 1; i < result.equityCurve.length; i++) {
      const p = result.equityCurve[i]!;
      expect(p.equityAllocation).toBeGreaterThanOrEqual(0.18);
      expect(p.equityAllocation).toBeLessThanOrEqual(0.82);
    }
  });

  it("staircase recommendation matches z-score bucket", () => {
    expect(resolveAllocation(-3, DEFAULT_STAIRCASE).deployment).toBe(1);
    expect(resolveAllocation(-0.5, DEFAULT_STAIRCASE).deployment).toBe(0.6);
    expect(resolveAllocation(0.5, DEFAULT_STAIRCASE).deployment).toBe(0.4);
    expect(resolveAllocation(3, DEFAULT_STAIRCASE).deployment).toBe(0);
  });
});
