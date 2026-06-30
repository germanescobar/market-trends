/**
 * Analytics service. Reads price series from storage, runs log-trend
 * regressions, and assembles `TickerSnapshot`s for the UI.
 *
 * The analytics layer does NOT call upstream providers directly. The
 * `BackfillService`, `RefreshService`, and `QuoteService` write into
 * storage on their own schedules; this layer just reads. The result is:
 *
 * - The dashboard never trips a provider rate limit.
 * - Provider failures never reach the user as dashboard errors; they show
 *   up as "pending" or "stale data" badges via `backfillStatus` and
 *   `dataWarning`.
 *
 * Heavy lifting (linear regression, log-trend math, staircase) lives in
 * the shared package — this file only orchestrates I/O.
 */

import {
  calculateLogTrend,
  calculateLogTrendSeries,
  DEFAULT_STAIRCASE,
  resampleSeries,
  resolveAllocation,
  type LookbackYears,
  type LogTrendRegression,
  type LogTrendSeries,
  type PriceFrequency,
  type PriceSeries,
  type TickerSnapshot,
  type TrackedTicker,
} from "@market-trends/shared";
import type { Storage, StoredBars } from "./storage/types.js";
import { storedBarsToSeries } from "./storage/types.js";

export interface AnalyticsOptions {
  defaultFrequency: PriceFrequency;
  storage: Storage;
}

const LOOKBACKS: LookbackYears[] = [5, 10, 15, 20, "max"];

export class AnalyticsService {
  constructor(
    private storage: Storage,
    private options: AnalyticsOptions,
  ) {}

  /**
   * Build the full snapshot a UI dashboard consumes. Reads from storage
   * only; never calls a provider. The snapshot's `backfillStatus` and
   * `dataWarning` tell the UI what to render for tickers that don't have
   * fresh data yet.
   */
  async getSnapshot(
    ticker: string,
    options: { frequency?: PriceFrequency; lookback?: LookbackYears } = {},
  ): Promise<TickerSnapshot> {
    const upper = ticker.toUpperCase();
    const frequency = options.frequency ?? "monthly";
    // Storage only holds daily bars (providers always return daily;
    // weekly/monthly are derived below). Always read daily here.
    const stored = await this.storage.getBars({
      ticker: upper,
      frequency: "daily",
    });

    // No data at all → empty snapshot, dashboard shows "pending" (or
    // "failed" if the backfill errored). We surface the real status so
    // the UI can render the right badge.
    if (!stored || stored.bars.length === 0) {
      const tracked = await this.findTracked(upper);
      const status: TrackedTicker["backfillStatus"] =
        tracked?.backfillStatus ?? "pending";
      const message =
        status === "failed" && tracked?.lastBackfillError
          ? `Backfill failed: ${tracked.lastBackfillError}. Will retry on next cycle.`
          : "Awaiting first backfill.";
      return emptySnapshot(upper, tracked, status, message);
    }

    const series = storedBarsToSeries(stored);
    // Resample the daily bars into the requested frequency. Providers
    // always return daily; weekly/monthly are derived here so storage
    // only needs one row per (ticker, date).
    const resampled = resampleSeries(series, frequency);
    const trends: Record<string, LogTrendRegression> = {};
    for (const lk of LOOKBACKS) {
      trends[String(lk)] = calculateLogTrend(resampled, lk, frequency);
    }
    const defaultLookback: LookbackYears = options.lookback ?? 10;
    const defaultTrend =
      trends[String(defaultLookback)] ??
      calculateLogTrend(resampled, defaultLookback, frequency);

    const tracked = await this.findTracked(upper);
    const dataWarning = buildDataWarning(stored, resampled, defaultLookback, tracked);

    const allocation = resolveAllocation(defaultTrend.lastZScore, DEFAULT_STAIRCASE);

    // The quote is read from the `last_quotes` table that the QuoteService
    // populates. Falls back to the last bar's close when no quote row
    // exists yet (cold start).
    const liveQuote = await this.storage.getLastQuote(upper);
    const lastBar = stored.bars[stored.bars.length - 1]!;
    const quote = liveQuote ?? {
      ticker: upper,
      price: lastBar.adjustedClose,
      currency: "USD",
      asOf: new Date(lastBar.date + "T00:00:00Z").toISOString(),
    };

    return {
      ticker: upper,
      name: tracked?.name,
      currency: quote.currency,
      backfillStatus: tracked?.backfillStatus ?? "ok",
      dataWarning,
      quote,
      series: resampled,
      trends,
      defaultTrend,
      allocation,
      asOf: new Date().toISOString(),
    };
  }

  /** Build the per-observation series for charting. Same storage read as
   *  `getSnapshot`, just returns the regression points. */
  async getSeriesForChart(
    ticker: string,
    lookback: LookbackYears,
    frequency: PriceFrequency,
  ): Promise<LogTrendSeries> {
    const stored = await this.storage.getBars({
      ticker: ticker.toUpperCase(),
      frequency: "daily",
    });
    if (!stored || stored.bars.length === 0) {
      // Return an empty series rather than throwing — the chart will show
      // its "no data" state.
      return {
        ticker: ticker.toUpperCase(),
        lookbackYears: lookback,
        frequency,
        residualStdDev: 0,
        annualizedCagr: 0,
        startDate: "",
        endDate: "",
        points: [],
      };
    }
    const series = storedBarsToSeries(stored);
    const resampled = resampleSeries(series, frequency);
    return calculateLogTrendSeries(resampled, lookback, frequency);
  }

  private async findTracked(ticker: string): Promise<TrackedTicker | null> {
    const all = await this.storage.listTickers();
    return all.find((t) => t.ticker === ticker.toUpperCase()) ?? null;
  }
}

function emptySnapshot(
  ticker: string,
  tracked: TrackedTicker | null,
  status: TrackedTicker["backfillStatus"],
  message: string,
): TickerSnapshot {
  // The shared calculateLogTrend / calculateLogTrendSeries functions
  // require at least 2 points; an empty series would throw. We hand back
  // a placeholder snapshot with zero values and the dataWarning that the
  // dashboard already renders.
  const emptySeries: PriceSeries = {
    ticker,
    bars: [],
    startDate: "",
    endDate: "",
    source: "none",
    frequency: "monthly",
  };
  const placeholderRegression: LogTrendRegression = {
    ticker,
    lookbackYears: 10,
    frequency: "monthly",
    n: 0,
    intercept: 0,
    slope: 0,
    annualizedCagr: 0,
    residualStdDev: 0,
    rSquared: 0,
    startDate: "",
    endDate: "",
    lastPredictedLogPrice: 0,
    lastTrendPrice: 0,
    lastActualPrice: 0,
    deviationPercent: 0,
    lastResidual: 0,
    lastZScore: 0,
  };
  return {
    ticker,
    name: tracked?.name,
    backfillStatus: status,
    dataWarning: message,
    series: emptySeries,
    trends: { "10": placeholderRegression },
    defaultTrend: placeholderRegression,
    allocation: { zScore: 0, label: "pending", description: "No data yet." },
    asOf: new Date().toISOString(),
  };
}

function buildDataWarning(
  stored: StoredBars,
  series: PriceSeries,
  defaultLookback: LookbackYears,
  tracked: TrackedTicker | null,
): string | undefined {
  const messages: string[] = [];

  // Coverage warning: series starts after the requested lookback would.
  if (defaultLookback !== "max" && series.endDate) {
    const endMs = Date.parse(series.endDate);
    if (Number.isFinite(endMs)) {
      const expectedStart = new Date(endMs - Math.round(defaultLookback * 365.25) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (series.startDate > expectedStart) {
        messages.push(
          `Provider history starts ${series.startDate}; ${defaultLookback}Y trend uses available history only.`,
        );
      }
    }
  }

  // Stale-data warning: if we haven't successfully written any bars in
  // more than 24 hours, the refresh service has stopped keeping up.
  const fetchedAtMs = Date.parse(stored.fetchedAt);
  if (Number.isFinite(fetchedAtMs)) {
    const ageHours = (Date.now() - fetchedAtMs) / 3_600_000;
    if (ageHours > 24) {
      messages.push(
        `Bars are ${Math.round(ageHours / 24)} day(s) old; refresh has not run recently.`,
      );
    }
  }

  // Failed backfill warning.
  if (tracked?.backfillStatus === "failed" && tracked.lastBackfillError) {
    messages.push(`Last backfill failed: ${tracked.lastBackfillError}`);
  }

  // Multi-source notice: if the chart is stitched together from several
  // providers, tell the user (transparency beats silent surprise).
  if (stored.sources.length > 1) {
    messages.push(
      `History stitched from: ${stored.sources.join(", ")}.`,
    );
  }

  return messages.length > 0 ? messages.join(" ") : undefined;
}