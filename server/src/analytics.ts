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
import type { Storage, StoredPriceSeries } from "./storage/types.js";

export interface AnalyticsOptions {
  ttlSeconds: number;
  defaultFrequency: PriceFrequency;
  storage?: Storage;
}

const LOOKBACKS: LookbackYears[] = [5, 10, 15, 20, "max"];

export class AnalyticsService {
  private seriesCache = new TTLCache<PriceSeries>(0);
  private quoteCache = new TTLCache<Quote>(0);
  private storage?: Storage;

  constructor(
    private provider: MarketDataProvider,
    options: AnalyticsOptions,
  ) {
    this.seriesCache = new TTLCache(options.ttlSeconds * 1000);
    this.quoteCache = new TTLCache(Math.min(options.ttlSeconds * 1000, 60_000));
    this.storage = options.storage;
  }

  /** Fetch (and cache) the provider price series for a ticker. */
  async getSeries(
    ticker: string,
    startDate?: string,
    endDate?: string,
    frequency: PriceFrequency = "daily",
  ): Promise<PriceSeries> {
    const key = `series:${ticker}:${frequency}:${startDate ?? ""}:${endDate ?? ""}`;
    const cached = this.seriesCache.get(key);
    if (cached) return cached;
    const stored = await this.storage?.getPriceSeries({
      provider: this.provider.name,
      ticker,
      frequency,
      startDate,
      endDate,
    });
    if (stored && isStoredSeriesUsable(stored, startDate, endDate)) {
      this.seriesCache.set(key, stored);
      return stored;
    }

    const fresh = await this.provider.getHistoricalPrices({
      ticker,
      frequency,
      startDate,
      endDate,
    });
    await this.storage?.upsertPriceSeries(fresh);
    const merged = await this.storage?.getPriceSeries({
      provider: this.provider.name,
      ticker: fresh.ticker,
      frequency: fresh.frequency,
      startDate,
      endDate,
    });
    const series = merged ?? fresh;
    this.seriesCache.set(key, series);
    return series;
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
    const series = await this.getSeries(ticker, undefined, undefined, providerFrequencyFor(frequency));
    // Always compute all standard lookbacks so the UI can compare them.
    // The extra regressions are cheap once the series is in memory.
    const trends: Record<string, LogTrendRegression> = {};
    for (const lk of LOOKBACKS) {
      trends[String(lk)] = calculateLogTrend(series, lk, frequency);
    }
    const defaultLookback: LookbackYears = options.lookback ?? 10;
    const defaultTrend =
      trends[String(defaultLookback)] ?? calculateLogTrend(series, defaultLookback, frequency);
    const dataWarning = coverageWarning(series, defaultLookback);

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
      dataWarning,
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
    const series = await this.getSeries(ticker, undefined, undefined, providerFrequencyFor(frequency));
    return calculateLogTrendSeries(series, lookback, frequency);
  }
}

function providerFrequencyFor(frequency: PriceFrequency): PriceFrequency {
  return frequency === "daily" ? "daily" : "weekly";
}

function coverageWarning(series: PriceSeries, lookback: LookbackYears): string | undefined {
  if (lookback === "max") return undefined;
  const end = Date.parse(series.endDate);
  if (!Number.isFinite(end)) return undefined;
  const expectedStart = new Date(end - Math.round(lookback * 365.25) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (series.startDate <= expectedStart) return undefined;
  return `Provider history starts ${series.startDate}; ${lookback}Y trend uses available history only.`;
}

function isStoredSeriesUsable(
  series: StoredPriceSeries,
  startDate: string | undefined,
  endDate: string | undefined,
): boolean {
  if (startDate && series.startDate > startDate) return false;
  if (endDate && series.endDate < endDate) return false;

  const today = new Date().toISOString().slice(0, 10);
  if (endDate && endDate < today) return true;
  if (series.endDate >= today) return true;
  return series.fetchedAt.slice(0, 10) >= today;
}
