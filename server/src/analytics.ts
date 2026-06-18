/**
 * Analytics service. Wraps the market data provider with caching, runs the
 * log-trend regressions, and assembles `TickerSnapshot`s for the UI.
 *
 * Heavy lifting (linear regression, log-trend math, staircase) lives in the
 * shared package — this file only orchestrates I/O.
 */

import {
  calculateLogTrend,
  calculateLogTrendSeries,
  DEFAULT_STAIRCASE,
  resolveAllocation,
  type LookbackYears,
  type LogTrendRegression,
  type LogTrendSeries,
  type MarketDataProvider,
  type PriceFrequency,
  type PriceSeries,
  type TickerSnapshot,
  type Quote,
} from "@market-trends/shared";
import { TTLCache } from "./cache.js";

export interface AnalyticsOptions {
  ttlSeconds: number;
  defaultFrequency: PriceFrequency;
}

const LOOKBACKS: LookbackYears[] = [5, 10, 15, 20, "max"];

export class AnalyticsService {
  private seriesCache = new TTLCache<PriceSeries>(0);
  private quoteCache = new TTLCache<Quote>(0);

  constructor(
    private provider: MarketDataProvider,
    options: AnalyticsOptions,
  ) {
    this.seriesCache = new TTLCache(options.ttlSeconds * 1000);
    this.quoteCache = new TTLCache(Math.min(options.ttlSeconds * 1000, 60_000));
  }

  /** Fetch (and cache) the daily price series for a ticker. */
  async getSeries(
    ticker: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PriceSeries> {
    const key = `series:${ticker}:${startDate ?? ""}:${endDate ?? ""}`;
    const cached = this.seriesCache.get(key);
    if (cached) return cached;
    const fresh = await this.provider.getHistoricalPrices({ ticker, startDate, endDate });
    this.seriesCache.set(key, fresh);
    return fresh;
  }

  async getQuote(ticker: string): Promise<Quote> {
    const key = `quote:${ticker}`;
    const cached = this.quoteCache.get(key);
    if (cached) return cached;
    const fresh = await this.provider.getQuote(ticker);
    this.quoteCache.set(key, fresh);
    return fresh;
  }

  /** Build the full snapshot a UI dashboard consumes. */
  async getSnapshot(
    ticker: string,
    options: { frequency?: PriceFrequency; lookback?: LookbackYears } = {},
  ): Promise<TickerSnapshot> {
    const frequency = options.frequency ?? "monthly";
    const series = await this.getSeries(ticker);
    // Always compute all standard lookbacks so the UI can compare them.
    // The extra regressions are cheap once the series is in memory.
    const trends: Record<string, LogTrendRegression> = {};
    for (const lk of LOOKBACKS) {
      trends[String(lk)] = calculateLogTrend(series, lk, frequency);
    }
    const defaultLookback: LookbackYears = options.lookback ?? 10;
    const defaultTrend =
      trends[String(defaultLookback)] ?? calculateLogTrend(series, defaultLookback, frequency);

    const allocation = resolveAllocation(defaultTrend.lastZScore, DEFAULT_STAIRCASE);

    let quote: Quote | undefined;
    let name: string | undefined;
    try {
      quote = await this.getQuote(ticker);
    } catch {
      // Quote is optional on the snapshot — fall back to last bar price.
    }
    if (this.provider instanceof Object && "getName" in this.provider) {
      try {
        name = await (this.provider as { getName: (t: string) => Promise<string | undefined> }).getName(ticker);
      } catch {
        // ignore
      }
    }

    return {
      ticker: ticker.toUpperCase(),
      name,
      currency: quote?.currency,
      quote,
      series,
      trends,
      defaultTrend,
      allocation,
      asOf: new Date().toISOString(),
    };
  }

  /** Build the full per-observation series for charting. */
  async getSeriesForChart(
    ticker: string,
    lookback: LookbackYears,
    frequency: PriceFrequency,
  ): Promise<LogTrendSeries> {
    const series = await this.getSeries(ticker);
    return calculateLogTrendSeries(series, lookback, frequency);
  }
}
