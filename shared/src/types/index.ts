/**
 * Shared types for the market-trends app.
 *
 * These describe the shape of data flowing between the market data provider,
 * the regression engine, the storage layer, and the UI.
 */

/** A single OHLCV-style price bar. We only use the adjusted close for the
 *  regression, but keep the full bar for richer charts later. */
export interface PriceBar {
  /** ISO-8601 date (YYYY-MM-DD). Time is always 00:00 UTC. */
  date: string;
  /** Adjusted close — splits & dividends already applied. */
  adjustedClose: number;
  /** Unadjusted close (best effort from provider). */
  close: number;
  /** Daily high, if available. */
  high?: number;
  /** Daily low, if available. */
  low?: number;
  /** Daily volume, if available. */
  volume?: number;
}

/** A historical price series for one ticker, ordered ascending by date. */
export interface PriceSeries {
  ticker: string;
  bars: PriceBar[];
  /** First / last date in the series. */
  startDate: string;
  endDate: string;
  /** Source provider name (e.g. "yahoo", "stub"). */
  source: string;
  /** Frequency the series was resampled to. */
  frequency: PriceFrequency;
}

/** Sampling frequency used for regression and charting. */
export type PriceFrequency = "daily" | "weekly" | "monthly";

/** A lookback window expressed as years; "max" means all available history. */
export type LookbackYears = 5 | 10 | 15 | 20 | "max";

/** Linear regression on log prices: ln(P) = a + b * t. */
export interface LogTrendRegression {
  ticker: string;
  lookbackYears: LookbackYears;
  frequency: PriceFrequency;
  /** Number of observations used. */
  n: number;
  /** Intercept in log space. */
  intercept: number;
  /** Slope per unit time. Slope unit depends on frequency:
   *  - daily   : per day
   *  - weekly  : per week
   *  - monthly : per month
   */
  slope: number;
  /** Slope expressed as an annualised compound growth rate (CAGR). */
  annualizedCagr: number;
  /** Standard deviation of the residuals in log space. */
  residualStdDev: number;
  /** R^2 of the fit. */
  rSquared: number;
  /** Start / end of the window used. */
  startDate: string;
  endDate: string;
  /** Predicted log price for the last observation. */
  lastPredictedLogPrice: number;
  /** Trend (exponentiated) price for the last observation. */
  lastTrendPrice: number;
  /** Actual last adjusted close. */
  lastActualPrice: number;
  /** (lastActualPrice / lastTrendPrice) - 1 */
  deviationPercent: number;
  /** Residual of the last observation = log(actual) - log(predicted). */
  lastResidual: number;
  /** lastResidual / residualStdDev. */
  lastZScore: number;
}

/** Full per-observation output of a log-trend regression, used for charts. */
export interface LogTrendSeriesPoint {
  date: string;
  /** Time index in the chosen frequency's units (day/week/month offset from start). */
  t: number;
  /** Actual adjusted close. */
  actual: number;
  /** Predicted price = exp(a + b * t). */
  trend: number;
  /** Actual log price. */
  logActual: number;
  /** Predicted log price = a + b * t. */
  logTrend: number;
  /** Residual = logActual - logTrend. */
  residual: number;
  /** Z-score of residual. */
  zScore: number;
  /** Trend + k * sigma (exponentiated). */
  upperBand1: number;
  lowerBand1: number;
  upperBand2: number;
  lowerBand2: number;
}

export interface LogTrendSeries {
  ticker: string;
  lookbackYears: LookbackYears;
  frequency: PriceFrequency;
  residualStdDev: number;
  annualizedCagr: number;
  startDate: string;
  endDate: string;
  points: LogTrendSeriesPoint[];
}

/** The output of computing a snapshot for a ticker + lookback + frequency. */
export interface TickerSnapshot {
  ticker: string;
  name?: string;
  currency?: string;
  /** Warning about provider coverage or data quality, if applicable. */
  dataWarning?: string;
  quote?: Quote;
  series: PriceSeries;
  /** Map of lookback -> regression at the requested frequency. */
  trends: Record<string, LogTrendRegression>;
  /** Default trend (10Y monthly) for convenience. */
  defaultTrend: LogTrendRegression;
  /** Allocation suggestion derived from the default trend's z-score. */
  allocation: AllocationSuggestion;
  /** When this snapshot was computed. */
  asOf: string;
}

/** A snapshot of a single ticker's current quote. */
export interface Quote {
  ticker: string;
  price: number;
  currency: string;
  /** ISO-8601 timestamp from provider. */
  asOf: string;
  /** Day change as a fraction, e.g. 0.012 = +1.2%. */
  changePercent?: number;
}

/** Staircase model: map a z-score to an allocation suggestion. */
export interface AllocationSuggestion {
  zScore: number;
  /** Bucket label, e.g. "Strong buy". */
  label: AllocationLabel;
  /** Description of the rule that fired. */
  description: string;
  /** Suggested deployment of planned cash, in [0, 1]. */
  deployment: number;
}

export type AllocationLabel =
  | "strong-buy"
  | "buy-aggressive"
  | "buy-moderate"
  | "normal-dca"
  | "buy-less"
  | "hold-cash";

/** Tracked ticker the user wants to monitor. */
export interface TrackedTicker {
  ticker: string;
  /** Display name (resolved lazily from quote metadata). */
  name?: string;
  /** ISO-8601 timestamp when last refreshed. */
  lastUpdated?: string;
  /** Free-form note from the user. */
  note?: string;
}

/** Inputs for a backtest. */
export interface BacktestInput {
  ticker: string;
  startDate: string;
  endDate: string;
  frequency: PriceFrequency;
  startingValue: number;
  monthlyContribution: number;
  baseEquityAllocation: number;
  minEquityAllocation: number;
  maxEquityAllocation: number;
  /** Per-trade transaction cost as a fraction (e.g. 0.001 = 10 bps). */
  transactionCost: number;
  /** How often to rebalance. */
  rebalance: "monthly" | "quarterly";
  /** Optional custom staircase rules. If omitted, the default is used. */
  staircaseRules?: AllocationRule[];
  /** Optional risk-free rate used for the Sharpe-like ratio (annualised). */
  riskFreeRate?: number;
}

/** One rung of the staircase model. */
export interface AllocationRule {
  /** Inclusive lower bound of z-score. Use -Infinity for the lowest rung. */
  zMin: number;
  /** Exclusive upper bound of z-score. Use +Infinity for the highest rung. */
  zMax: number;
  label: AllocationLabel;
  description: string;
  /** Allocation to equity, in [0, 1]. */
  allocation: number;
}

/** Output of a single backtest run. */
export interface BacktestResult {
  ticker: string;
  startDate: string;
  endDate: string;
  strategy: BacktestStrategy;
  metrics: BacktestMetrics;
  /** Equity curve: portfolio value at each rebalance step. */
  equityCurve: EquityCurvePoint[];
  /** Trades executed during the backtest. */
  trades: BacktestTrade[];
  /** Full input echo for traceability. */
  input: BacktestInput;
}

export type BacktestStrategy =
  | "buy-and-hold"
  | "dca"
  | "trend-staircase";

export interface BacktestMetrics {
  finalValue: number;
  totalContributed: number;
  /** Annualised compound growth rate of portfolio value. */
  cagr: number;
  /** Maximum peak-to-trough decline as a negative number. */
  maxDrawdown: number;
  /** Annualised volatility of monthly returns. */
  volatility: number;
  /** Annualised Sharpe-like ratio. */
  sharpe: number;
  numberOfTrades: number;
  /** Fraction of time the strategy held equity. */
  percentTimeInvested: number;
  bestPeriodReturn: number;
  worstPeriodReturn: number;
}

export interface EquityCurvePoint {
  date: string;
  value: number;
  /** Equity allocation in [0, 1] at this point. */
  equityAllocation: number;
}

export interface BacktestTrade {
  date: string;
  /** Positive = buy, negative = sell, in units of the asset. */
  quantity: number;
  /** Price per unit. */
  price: number;
  /** Cost paid in cash, including transaction costs (positive when buying). */
  cashFlow: number;
  /** Transaction cost charged on this trade. */
  cost: number;
  /** Strategy that generated the trade. */
  strategy: BacktestStrategy;
}
