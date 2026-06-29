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
import { YahooRateLimitedError } from "./providers/yahoo.js";
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

    let fresh: PriceSeries;
    try {
      fresh = await this.provider.getHistoricalPrices({
        ticker,
        frequency,
        startDate,
        endDate,
      });
    } catch (err) {
      // When the provider is rate-limited, fall back to whatever we have in
      // storage rather than failing the dashboard. The caller can check
      // `dataWarning` on the snapshot to surface the staleness.
      if (isRateLimitError(err) && stored) {
        const series: PriceSeries = stored;
        this.seriesCache.set(key, series);
        return series;
      }
      throw err;
    }
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
    const dataWarnings: string[] = [];
    const coverageMsg = coverageWarning(series, defaultLookback);
    if (coverageMsg) dataWarnings.push(coverageMsg);

    const allocation = resolveAllocation(defaultTrend.lastZScore, DEFAULT_STAIRCASE);

    // Quote: prefer a live `getQuote` call, but fall back to the last bar
    // when the stored series is fresh enough that we don't need a separate
    // Yahoo round-trip. This saves one Yahoo call per snapshot, which is
    // the single biggest source of 429s on dashboard reloads.
    let quote: Quote | undefined;
    const lastBarPrice = lastFreshBarPrice(series);
    if (lastBarPrice !== undefined) {
      quote = {
        ticker: ticker.toUpperCase(),
        price: lastBarPrice.price,
        currency: lastBarPrice.currency ?? "USD",
        asOf: lastBarPrice.asOf,
      };
    }
    if (!quote) {
      try {
        quote = await this.getQuote(ticker);
      } catch (err) {
        if (isRateLimitError(err)) {
          dataWarnings.push(
            "Live quote unavailable due to upstream rate limiting; showing last known price.",
          );
        }
        // Otherwise fall through: snapshot has no quote, that's fine.
      }
    }
    if (quote && lastBarPrice && quotePriceAge(quote) > ONE_DAY_MS) {
      dataWarnings.push(
        `Live quote is ${describeAge(quote)} old; consider a manual refresh.`,
      );
    }

    let name: string | undefined;
    if (this.provider instanceof Object && "getName" in this.provider) {
      try {
        name = await (this.provider as { getName: (t: string) => Promise<string | undefined> }).getName(ticker);
      } catch (err) {
        if (isRateLimitError(err)) {
          dataWarnings.push(
            "Display name unavailable due to upstream rate limiting.",
          );
        }
        // Otherwise ignore; name is optional.
      }
    }

    return {
      ticker: ticker.toUpperCase(),
      name,
      currency: quote?.currency,
      dataWarning: dataWarnings.length > 0 ? dataWarnings.join(" ") : undefined,
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

/**
 * Returns the latest bar's close price when the series is fresh enough
 * that we can use it as a stand-in for the live quote. The threshold is
 * generous (a few days) because we already pay for the bar in the series
 * fetch, and a slightly stale quote is fine for the dashboard's purpose.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const QUOTE_FALLBACK_MAX_AGE_MS = 3 * ONE_DAY_MS;

function lastFreshBarPrice(series: PriceSeries): { price: number; asOf: string; currency?: string } | undefined {
  const last = series.bars.at(-1);
  if (!last || typeof last.adjustedClose !== "number" || !Number.isFinite(last.adjustedClose)) {
    return undefined;
  }
  const today = new Date().toISOString().slice(0, 10);
  // Treat anything within the freshness window as usable.
  const ageMs = Date.parse(today) - Date.parse(last.date);
  if (!Number.isFinite(ageMs) || ageMs > QUOTE_FALLBACK_MAX_AGE_MS) return undefined;
  return {
    price: last.adjustedClose,
    asOf: new Date(last.date + "T00:00:00Z").toISOString(),
  };
}

function quotePriceAge(quote: Quote): number {
  const ts = Date.parse(quote.asOf);
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return Date.now() - ts;
}

function describeAge(quote: Quote): string {
  const ageMs = quotePriceAge(quote);
  if (!Number.isFinite(ageMs)) return "an unknown amount of time";
  if (ageMs < 0) return "0 minutes";
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * True if the error from the provider indicates upstream rate limiting
 * (and therefore the caller should consider falling back to cached data
 * rather than failing). Currently matches the Yahoo-specific error type;
 * extend here when other providers add a similar concept.
 */
function isRateLimitError(err: unknown): boolean {
  return err instanceof YahooRateLimitedError;
}
