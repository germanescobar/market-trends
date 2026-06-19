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

/** Staircase model: map a z-score to a qualitative signal. */
export interface AllocationSuggestion {
  zScore: number;
  /** Bucket label, e.g. "Strong buy". */
  label: AllocationLabel;
  /** Description of the rule that fired. */
  description: string;
}

export type AllocationLabel =
  | "strong-buy"
  | "buy"
  | "buy-moderate"
  | "sell-moderate"
  | "sell"
  | "strong-sell";

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

/** One rung of the staircase model. */
export interface AllocationRule {
  /** Inclusive lower bound of z-score. Use -Infinity for the lowest rung. */
  zMin: number;
  /** Exclusive upper bound of z-score. Use +Infinity for the highest rung. */
  zMax: number;
  label: AllocationLabel;
  description: string;
}
