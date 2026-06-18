/**
 * Log-price trend regression.
 *
 * Transforms adjusted close to log space, fits ln(P) = a + b * t with OLS,
 * and produces per-observation residuals, z-scores, and ±1σ / ±2σ bands
 * in price space.
 *
 * Time index `t` is in the unit of the chosen frequency:
 *   - daily   : integer day offset
 *   - weekly  : integer week offset
 *   - monthly : integer month offset
 *
 * The slope is converted to an annualised CAGR using the appropriate
 * compounding factor for each frequency.
 */

import type {
  LogTrendRegression,
  LogTrendSeries,
  LogTrendSeriesPoint,
  LookbackYears,
  PriceBar,
  PriceFrequency,
  PriceSeries,
} from "../types/index.js";
import { linearRegression } from "./linear.js";

const MS_PER_DAY = 86_400_000;

/** Number of time-units per year for a given frequency. */
const PERIODS_PER_YEAR: Record<PriceFrequency, number> = {
  daily: 365.25,
  weekly: 52,
  monthly: 12,
};

/** Date offset (calendar days) subtracted from `endDate` for a given lookback. */
export function lookbackYearsToDays(years: number): number {
  // Use 365.25 to be calendar-accurate across leap years.
  return Math.round(years * 365.25);
}

/** Filter a price series to bars within the lookback window ending at endDate. */
export function windowSeries(
  series: PriceSeries,
  lookback: LookbackYears,
): PriceSeries {
  if (lookback === "max") return series;
  const end = Date.parse(series.endDate);
  if (Number.isNaN(end)) return series;
  const cutoff = end - lookbackYearsToDays(lookback) * MS_PER_DAY;
  const bars = series.bars.filter((b) => Date.parse(b.date) >= cutoff);
  return {
    ...series,
    bars,
    startDate: bars[0]?.date ?? series.startDate,
  };
}

/**
 * Resample a daily price series to weekly or monthly by taking the last
 * available bar per ISO week / month. Daily input is returned as-is.
 *
 * Resampling matters because the slope's units change with frequency, and
 * weekly/monthly bars dramatically reduce noise on long windows.
 */
export function resampleSeries(
  series: PriceSeries,
  frequency: PriceFrequency,
): PriceSeries {
  if (frequency === "daily") return series;
  const buckets = new Map<string, PriceBar>();
  for (const bar of series.bars) {
    const key = bucketKey(bar.date, frequency);
    const existing = buckets.get(key);
    if (!existing || existing.date < bar.date) {
      buckets.set(key, bar);
    }
  }
  const bars = [...buckets.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    ...series,
    bars,
    startDate: bars[0]?.date ?? series.startDate,
    endDate: bars[bars.length - 1]?.date ?? series.endDate,
    frequency,
  };
}

function bucketKey(date: string, frequency: PriceFrequency): string {
  // date is YYYY-MM-DD.
  const year = date.slice(0, 4);
  if (frequency === "monthly") return `${year}-${date.slice(5, 7)}`;
  // weekly: ISO week — derived from date via UTC epoch math.
  const d = new Date(`${date}T00:00:00Z`);
  // Thursday of the current ISO week determines the year+week.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Run a log-price regression over a series window and return the
 * summary metrics for the most recent observation.
 */
export function calculateLogTrend(
  series: PriceSeries,
  lookback: LookbackYears,
  frequency: PriceFrequency,
): LogTrendRegression {
  const resampled = resampleSeries(series, frequency);
  const windowed = windowSeries(resampled, lookback);
  return summarize(windowed, lookback, frequency);
}

/** Same as calculateLogTrend but emits the full per-observation series. */
export function calculateLogTrendSeries(
  series: PriceSeries,
  lookback: LookbackYears,
  frequency: PriceFrequency,
): LogTrendSeries {
  const resampled = resampleSeries(series, frequency);
  const windowed = windowSeries(resampled, lookback);

  const bars = windowed.bars;
  if (bars.length < 2) {
    return {
      ticker: windowed.ticker,
      lookbackYears: lookback,
      frequency,
      residualStdDev: 0,
      annualizedCagr: 0,
      startDate: windowed.startDate,
      endDate: windowed.endDate,
      points: [],
    };
  }

  const t = bars.map((_, i) => i);
  const logY = bars.map((b) => Math.log(b.adjustedClose));
  const fit = linearRegression(t, logY);

  const periodsPerYear = PERIODS_PER_YEAR[frequency];
  const annualizedCagr = Math.exp(fit.slope * periodsPerYear) - 1;

  const points: LogTrendSeriesPoint[] = bars.map((bar, i) => {
    const ti = t[i]!;
    const logTrend = fit.intercept + fit.slope * ti;
    const trend = Math.exp(logTrend);
    const residual = logY[i]! - logTrend;
    const zScore = fit.residualStdDev > 0 ? residual / fit.residualStdDev : 0;
    const sigma = fit.residualStdDev;
    return {
      date: bar.date,
      t: ti,
      actual: bar.adjustedClose,
      trend,
      logActual: logY[i]!,
      logTrend,
      residual,
      zScore,
      upperBand1: Math.exp(logTrend + sigma),
      lowerBand1: Math.exp(logTrend - sigma),
      upperBand2: Math.exp(logTrend + 2 * sigma),
      lowerBand2: Math.exp(logTrend - 2 * sigma),
    };
  });

  return {
    ticker: windowed.ticker,
    lookbackYears: lookback,
    frequency,
    residualStdDev: fit.residualStdDev,
    annualizedCagr,
    startDate: windowed.startDate,
    endDate: windowed.endDate,
    points,
  };
}

/** Convert a fitted slope to an annualised compound growth rate. */
export function calculateCAGRFromSlope(
  slope: number,
  frequency: PriceFrequency,
): number {
  const periodsPerYear = PERIODS_PER_YEAR[frequency];
  return Math.exp(slope * periodsPerYear) - 1;
}

function summarize(
  series: PriceSeries,
  lookback: LookbackYears,
  frequency: PriceFrequency,
): LogTrendRegression {
  const bars = series.bars;
  const last = bars[bars.length - 1];
  if (!last || bars.length < 2) {
    const lastActual = last?.adjustedClose ?? 0;
    return {
      ticker: series.ticker,
      lookbackYears: lookback,
      frequency,
      n: bars.length,
      intercept: last ? Math.log(lastActual) : NaN,
      slope: 0,
      annualizedCagr: 0,
      residualStdDev: 0,
      rSquared: 0,
      startDate: series.startDate,
      endDate: series.endDate,
      lastPredictedLogPrice: last ? Math.log(lastActual) : NaN,
      lastTrendPrice: lastActual,
      lastActualPrice: lastActual,
      deviationPercent: 0,
      lastResidual: 0,
      lastZScore: 0,
    };
  }

  const t = bars.map((_, i) => i);
  const logY = bars.map((b) => Math.log(b.adjustedClose));
  const fit = linearRegression(t, logY);

  const lastT = t[t.length - 1]!;
  const lastPredictedLogPrice = fit.intercept + fit.slope * lastT;
  const lastActualPrice = last.adjustedClose;
  const lastTrendPrice = Math.exp(lastPredictedLogPrice);
  const lastLogActual = Math.log(lastActualPrice);
  const lastResidual = lastLogActual - lastPredictedLogPrice;
  const lastZScore =
    fit.residualStdDev > 0 ? lastResidual / fit.residualStdDev : 0;
  const deviationPercent = lastActualPrice / lastTrendPrice - 1;

  return {
    ticker: series.ticker,
    lookbackYears: lookback,
    frequency,
    n: fit.n,
    intercept: fit.intercept,
    slope: fit.slope,
    annualizedCagr: calculateCAGRFromSlope(fit.slope, frequency),
    residualStdDev: fit.residualStdDev,
    rSquared: fit.rSquared,
    startDate: series.startDate,
    endDate: series.endDate,
    lastPredictedLogPrice,
    lastTrendPrice,
    lastActualPrice,
    deviationPercent,
    lastResidual,
    lastZScore,
  };
}
