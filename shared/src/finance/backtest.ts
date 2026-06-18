/**
 * Backtest simulator for buy-and-hold, DCA, and the trend-staircase strategy.
 *
 * Important rules followed here:
 *   - No lookahead bias: at each rebalance date, the regression is computed
 *     using only bars strictly before that date.
 *   - Rolling regression: the lookback window is anchored at the rebalance
 *     date (end = bar just before rebalance), not at the backtest end date.
 *   - Transaction costs are deducted from cash on every trade, charged on
 *     the notional value traded (positive when buying, positive when selling).
 *   - Trades execute at the bar's adjusted close on the rebalance date.
 *
 * Frequency handling: the input series is resampled to the requested
 * frequency before stepping, so rebalances align with monthly/quarterly
 * cadence regardless of the provider's native frequency.
 */

import type {
  AllocationRule,
  BacktestInput,
  BacktestMetrics,
  BacktestResult,
  BacktestStrategy,
  BacktestTrade,
  EquityCurvePoint,
  PriceBar,
  PriceFrequency,
  PriceSeries,
} from "../types/index.js";
import { DEFAULT_STAIRCASE, resolveAllocation } from "./allocation.js";
import {
  annualizedSharpe,
  annualizedVolatility,
  cagr,
  maxDrawdown,
  mean,
} from "./performance.js";
import { calculateLogTrend, resampleSeries } from "../regression/log-trend.js";

const PERIODS_PER_YEAR: Record<PriceFrequency, number> = {
  daily: 252,
  weekly: 52,
  monthly: 12,
};

const REBALANCE_PERIODS: Record<NonNullable<BacktestInput["rebalance"]>, number> =
  {
    monthly: 1,
    quarterly: 3,
  };

interface SimulationState {
  cash: number;
  units: number;
  totalContributed: number;
  costPaid: number;
  trades: BacktestTrade[];
  curve: EquityCurvePoint[];
}

/**
 * Run a single strategy on the given series. Returns a populated result
 * structure; the caller is responsible for invoking this three times
 * (or once for the chosen strategy) and presenting results side by side.
 */
export function runBacktest(
  input: BacktestInput,
  series: PriceSeries,
  strategy: BacktestStrategy,
): BacktestResult {
  const resampled = resampleSeries(series, input.frequency);
  const bars = filterByDateRange(resampled.bars, input.startDate, input.endDate);

  if (bars.length < 2) {
    return emptyResult(input, strategy);
  }

  const periodLength = REBALANCE_PERIODS[input.rebalance] ?? 1;
  const rules = input.staircaseRules ?? DEFAULT_STAIRCASE;

  const state: SimulationState = {
    cash: input.startingValue,
    units: 0,
    totalContributed: 0,
    costPaid: 0,
    trades: [],
    curve: [{ date: bars[0]!.date, value: input.startingValue, equityAllocation: 0 }],
  };

  // Strategy-specific initialisation.
  if (strategy === "buy-and-hold") {
    buy(state, bars[0]!, 1, input.transactionCost, strategy);
  }

  // Pre-rebalance contribution plan: contribute `monthlyContribution` every
  // month for DCA / staircase strategies. We approximate "monthly" as every
  // step when frequency === "monthly", or every ~21 daily / ~4 weekly steps
  // for higher-frequency data.
  const contributionEverySteps = contributionCadence(input.frequency);

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!;
    const stepIndex = i;

    // 1. Add the periodic contribution if it's due.
    if (stepIndex % contributionEverySteps === 0) {
      state.cash += input.monthlyContribution;
      state.totalContributed += input.monthlyContribution;
    }

    // 2. On rebalance cadence, switch strategies.
    const isRebalance = stepIndex % (periodLength * contributionEverySteps) === 0;

    if (strategy === "buy-and-hold") {
      // Already fully invested at the start; no-op.
    } else if (strategy === "dca") {
      if (isRebalance) {
        // DCA: target a fixed base equity allocation of the current portfolio value.
        const value = state.cash + state.units * bar.adjustedClose;
        const targetValue = value * input.baseEquityAllocation;
        rebalanceToTarget(
          state,
          bar,
          targetValue,
          input.transactionCost,
          strategy,
        );
      }
    } else if (strategy === "trend-staircase") {
      if (isRebalance) {
        // Recompute the regression using only data strictly before `bar.date`.
        const history: PriceSeries = {
          ...resampled,
          bars: resampled.bars.filter((b) => b.date < bar.date),
        };
        const target = computeStaircaseTarget(
          history,
          input,
          rules,
          state.cash + state.units * bar.adjustedClose,
        );
        rebalanceToTarget(
          state,
          bar,
          target,
          input.transactionCost,
          strategy,
        );
      }
    }

    // 3. Mark-to-market the equity curve.
    const value = state.cash + state.units * bar.adjustedClose;
    const equityAllocation = value > 0 ? (state.units * bar.adjustedClose) / value : 0;
    state.curve.push({ date: bar.date, value, equityAllocation });
  }

  const finalBar = bars[bars.length - 1]!;
  const values = state.curve.map((p) => p.value);
  const r = values.slice(1).map((v, i) => (values[i] === 0 ? 0 : v / values[i]! - 1));
  const years =
    (Date.parse(finalBar.date) - Date.parse(bars[0]!.date)) /
    (365.25 * 24 * 3600 * 1000);

  const metrics: BacktestMetrics = {
    finalValue: values[values.length - 1] ?? 0,
    totalContributed: state.totalContributed + input.startingValue,
    cagr: cagr(input.startingValue, values[values.length - 1] ?? 0, years),
    maxDrawdown: maxDrawdown(values),
    volatility: annualizedVolatility(r, PERIODS_PER_YEAR[input.frequency]),
    sharpe: annualizedSharpe(
      r,
      PERIODS_PER_YEAR[input.frequency],
      input.riskFreeRate ?? 0,
    ),
    numberOfTrades: state.trades.length,
    percentTimeInvested:
      mean(state.curve.map((p) => p.equityAllocation)),
    bestPeriodReturn: r.length > 0 ? Math.max(...r) : 0,
    worstPeriodReturn: r.length > 0 ? Math.min(...r) : 0,
  };

  return {
    ticker: input.ticker,
    startDate: bars[0]!.date,
    endDate: finalBar.date,
    strategy,
    metrics,
    equityCurve: state.curve,
    trades: state.trades,
    input,
  };
}

/** Convert a monthly contribution to a per-step cadence for a given frequency. */
function contributionCadence(frequency: PriceFrequency): number {
  // Each step is one bar of `frequency`. We want contributions roughly monthly.
  switch (frequency) {
    case "monthly":
      return 1;
    case "weekly":
      return 4; // ~4 weeks/month
    case "daily":
      return 21; // ~21 trading days/month
  }
}

function computeStaircaseTarget(
  history: PriceSeries,
  input: BacktestInput,
  rules: AllocationRule[],
  portfolioValue: number,
): number {
  const lookback = 10 as const; // 10Y default; future: make configurable.
  const trend = calculateLogTrend(history, lookback, input.frequency);
  const suggestion = resolveAllocation(trend.lastZScore, rules);
  const target = portfolioValue * clamp(
    suggestion.deployment,
    input.minEquityAllocation,
    input.maxEquityAllocation,
  );
  return target;
}

function buy(
  state: SimulationState,
  bar: PriceBar,
  fraction: number,
  costRate: number,
  strategy: BacktestStrategy,
): void {
  const cashAvailable = state.cash * fraction;
  if (cashAvailable <= 0 || bar.adjustedClose <= 0) return;
  const cost = cashAvailable * costRate;
  const netCash = cashAvailable - cost;
  const quantity = netCash / bar.adjustedClose;
  state.cash -= cashAvailable;
  state.units += quantity;
  state.costPaid += cost;
  state.trades.push({
    date: bar.date,
    quantity,
    price: bar.adjustedClose,
    cashFlow: cashAvailable,
    cost,
    strategy,
  });
}

function sell(
  state: SimulationState,
  bar: PriceBar,
  fraction: number,
  costRate: number,
  strategy: BacktestStrategy,
): void {
  if (state.units <= 0) return;
  const sellUnits = state.units * fraction;
  const gross = sellUnits * bar.adjustedClose;
  const cost = gross * costRate;
  const net = gross - cost;
  state.units -= sellUnits;
  state.cash += net;
  state.costPaid += cost;
  state.trades.push({
    date: bar.date,
    quantity: -sellUnits,
    price: bar.adjustedClose,
    cashFlow: -gross,
    cost,
    strategy,
  });
}

/**
 * Move the portfolio to a target equity value, executing at most two trades
 * (sell then buy) and applying transaction costs to each.
 */
function rebalanceToTarget(
  state: SimulationState,
  bar: PriceBar,
  targetValue: number,
  costRate: number,
  strategy: BacktestStrategy,
): void {
  const currentValue = state.units * bar.adjustedClose;
  if (bar.adjustedClose <= 0) return;
  const delta = targetValue - currentValue;

  // Deadband of 1% of portfolio value to avoid churning.
  const portfolioValue = currentValue + state.cash;
  if (Math.abs(delta) < portfolioValue * 0.01) return;

  if (delta > 0) {
    // Need to buy `delta` worth.
    const cashAvailable = Math.min(delta, state.cash);
    if (cashAvailable > 0) {
      buy(state, bar, cashAvailable / state.cash, costRate, strategy);
    }
  } else {
    // Need to sell `-delta` worth.
    const fraction = Math.min(1, -delta / currentValue);
    sell(state, bar, fraction, costRate, strategy);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function filterByDateRange(
  bars: PriceBar[],
  startDate: string,
  endDate: string,
): PriceBar[] {
  return bars.filter((b) => b.date >= startDate && b.date <= endDate);
}

function emptyResult(input: BacktestInput, strategy: BacktestStrategy): BacktestResult {
  return {
    ticker: input.ticker,
    startDate: input.startDate,
    endDate: input.endDate,
    strategy,
    metrics: {
      finalValue: input.startingValue,
      totalContributed: input.startingValue,
      cagr: 0,
      maxDrawdown: 0,
      volatility: 0,
      sharpe: 0,
      numberOfTrades: 0,
      percentTimeInvested: 0,
      bestPeriodReturn: 0,
      worstPeriodReturn: 0,
    },
    equityCurve: [
      { date: input.startDate, value: input.startingValue, equityAllocation: 0 },
    ],
    trades: [],
    input,
  };
}
