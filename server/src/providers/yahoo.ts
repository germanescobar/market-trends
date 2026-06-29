/**
 * Yahoo Finance data provider.
 *
 * Uses Yahoo's public v8 chart API directly via `fetch`. The shape of the
 * response is well-known: it returns adjusted closes, OHLC, and volume for
 * the requested range and interval.
 *
 * Note: Yahoo's public endpoints are unofficial and rate-limited. We send
 * a `User-Agent` header that mimics a desktop browser to avoid the most
 * common anti-bot blocks, throttle concurrent calls through a token bucket
 * to smooth bursts from parallel dashboard loads, and retry with
 * exponential backoff on 429.
 */

import {
  type GetHistoricalPricesParams,
  type MarketDataProvider,
  type PriceBar,
  type PriceSeries,
  type Quote,
} from "@market-trends/shared";
import { TTLCache } from "../cache.js";

const CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const QUOTE_BASE = "https://query1.finance.yahoo.com/v7/finance/quote";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Rate-limiter / retry tuning. The numbers below are deliberately
// conservative: Yahoo's public v8 endpoints start returning 429 well before
// the documented limits, and bursts (e.g. `Promise.all` over N tickers in a
// dashboard reload) trip the limit even when total daily volume is fine.
// Sustaining ~2 req/sec with a small burst capacity keeps us comfortably
// under the throttle while keeping the dashboard snappy.
const RATE_LIMIT_CAPACITY = 4;     // max concurrent in-flight requests
const RATE_LIMIT_REFILL_PER_SEC = 2;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 8_000;

const NAME_CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // names rarely change; cache for a day

/**
 * Thrown by `getHistoricalPrices` / `getQuote` when Yahoo returns 429 after
 * the configured retry budget is exhausted. Callers (e.g. analytics) can
 * detect this with `instanceof YahooRateLimitedError` and serve stale data.
 */
export class YahooRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooRateLimitedError";
  }
}

interface ChartResponse {
  chart: {
    result?: Array<{
      meta: {
        symbol: string;
        currency?: string;
        longName?: string;
        shortName?: string;
        regularMarketPrice?: number;
        previousClose?: number;
        regularMarketTime?: number;
      };
      timestamp?: number[];
      indicators: {
        adjclose?: Array<{ adjclose: Array<number | null> }>;
        quote?: Array<{
          close: Array<number | null>;
          high: Array<number | null>;
          low: Array<number | null>;
          volume: Array<number | null>;
          open: Array<number | null>;
        }>;
      };
    }>;
    error: { code: string; description: string } | null;
  };
}

interface QuoteResponse {
  quoteResponse: {
    result?: Array<{
      symbol: string;
      shortName?: string;
      longName?: string;
      regularMarketPrice?: number;
      regularMarketChangePercent?: number;
      currency?: string;
      regularMarketTime?: number;
    }>;
    error: { code: string; description: string } | null;
  };
}

export class YahooFinanceProvider implements MarketDataProvider {
  readonly name = "yahoo";

  // Per-ticker name cache. Names come from the chart endpoint's metadata
  // and only change on corporate actions; we cache for a day so the
  // snapshot hot path doesn't have to refetch them on every load.
  private static readonly nameCache = new TTLCache<string>(NAME_CACHE_TTL_MS);

  async getHistoricalPrices({
    ticker,
    startDate,
    endDate,
  }: GetHistoricalPricesParams): Promise<PriceSeries> {
    const upper = ticker.toUpperCase();
    const period1 = startDate ? Math.floor(Date.parse(startDate) / 1000) : undefined;
    const period2 = endDate ? Math.ceil(Date.parse(endDate) / 1000) : undefined;

    const params = new URLSearchParams({
      interval: "1d",
      includeAdjustedClose: "true",
      events: "div,splits",
    });
    if (period1) params.set("period1", String(period1));
    if (period2) params.set("period2", String(period2));

    const url = `${CHART_BASE}/${encodeURIComponent(upper)}?${params.toString()}`;
    const res = await throttledFetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    }, upper);
    if (!res.ok) {
      throw new Error(`Yahoo chart request failed (${res.status}) for ${upper}`);
    }
    const json = (await res.json()) as ChartResponse;
    if (json.chart.error) {
      throw new Error(`Yahoo chart error: ${json.chart.error.description}`);
    }
    const result = json.chart.result?.[0];
    if (!result) {
      throw new Error(`No chart data for ${upper}`);
    }
    const timestamps = result.timestamp ?? [];
    const adj = result.indicators.adjclose?.[0]?.adjclose ?? [];
    const quote = result.indicators.quote?.[0] ?? {
      close: [],
      high: [],
      low: [],
      volume: [],
      open: [],
    };

    const bars: PriceBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      if (typeof ts !== "number") continue;
      const a = adj[i];
      if (typeof a !== "number" || !Number.isFinite(a)) continue;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      bars.push({
        date,
        adjustedClose: a,
        close: pickNumber(quote.close[i]) ?? a,
        high: pickNumber(quote.high[i]),
        low: pickNumber(quote.low[i]),
        volume: pickNumber(quote.volume[i]),
      });
    }
    if (bars.length === 0) {
      throw new Error(`Yahoo returned no bars for ${upper}`);
    }
    const first = bars[0]!;
    const last = bars[bars.length - 1]!;
    return {
      ticker: upper,
      bars,
      startDate: first.date,
      endDate: last.date,
      source: this.name,
      frequency: "daily",
    };
  }

  async getQuote(ticker: string): Promise<Quote> {
    const upper = ticker.toUpperCase();
    const url = `${QUOTE_BASE}?symbols=${encodeURIComponent(upper)}`;
    const res = await throttledFetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    }, upper);
    if (!res.ok) {
      throw new Error(`Yahoo quote request failed (${res.status}) for ${upper}`);
    }
    const json = (await res.json()) as QuoteResponse;
    if (json.quoteResponse.error) {
      throw new Error(`Yahoo quote error: ${json.quoteResponse.error.description}`);
    }
    const r = json.quoteResponse.result?.[0];
    if (!r || typeof r.regularMarketPrice !== "number") {
      throw new Error(`No quote for ${upper}`);
    }
    return {
      ticker: upper,
      price: r.regularMarketPrice,
      currency: r.currency ?? "USD",
      asOf:
        typeof r.regularMarketTime === "number"
          ? new Date(r.regularMarketTime * 1000).toISOString()
          : new Date().toISOString(),
      changePercent:
        typeof r.regularMarketChangePercent === "number"
          ? r.regularMarketChangePercent / 100
          : undefined,
    };
  }

  /** Best-effort display name lookup via the chart endpoint's metadata. */
  async getName(ticker: string): Promise<string | undefined> {
    const upper = ticker.toUpperCase();
    // Names rarely change; cache for a day so the snapshot hot path
    // doesn't refetch them on every load.
    const cached = YahooFinanceProvider.nameCache.get(upper);
    if (cached !== undefined) return cached;
    const url = `${CHART_BASE}/${encodeURIComponent(upper)}?range=1mo&interval=1d`;
    try {
      const res = await throttledFetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      }, upper);
      if (!res.ok) return undefined;
      const json = (await res.json()) as ChartResponse;
      const meta = json.chart.result?.[0]?.meta;
      const name = meta?.longName ?? meta?.shortName;
      if (name) YahooFinanceProvider.nameCache.set(upper, name);
      return name;
    } catch {
      return undefined;
    }
  }
}

function pickNumber(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Token-bucket rate limiter, process-global. `acquire()` resolves once the
 * bucket has a token, optionally waiting for one to be refilled. The
 * implementation is deliberately minimal: it tracks `tokens` (a float) and
 * the timestamp of the last refill, and is mutex-guarded by a queue so
 * concurrent callers serialize through the bucket rather than racing on
 * the float.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
      // Schedule a wake-up in case nothing else is queued behind us.
      const waitMs = Math.max(50, Math.ceil((1 - this.tokens) / this.refillPerSec * 1_000));
      setTimeout(() => this.drain(), waitMs);
    });
  }

  private refill(now: number = Date.now()): void {
    const elapsedSec = (now - this.lastRefill) / 1_000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  private drain(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const next = this.queue.shift();
      next?.();
    }
    if (this.queue.length > 0) {
      const waitMs = Math.max(50, Math.ceil((1 - this.tokens) / this.refillPerSec * 1_000));
      setTimeout(() => this.drain(), waitMs);
    }
  }
}

const yahooBucket = new TokenBucket(RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL_PER_SEC);

/**
 * Wrapper around `fetch` that smooths bursts through the token bucket and
 * retries with exponential backoff on HTTP 429. Other non-OK statuses are
 * surfaced as-is so the caller can decide what to do.
 *
 * Throws `YahooRateLimitedError` after the retry budget is exhausted so
 * upstream layers (analytics) can detect rate-limit pressure and serve
 * stale data with a warning rather than failing the whole snapshot.
 */
async function throttledFetch(
  url: string,
  init: RequestInit,
  tickerForLog: string,
): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    await yahooBucket.acquire();
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    lastStatus = res.status;
    // Drain the body so the connection can be reused, then back off.
    try {
      await res.text();
    } catch {
      // ignore
    }
    if (attempt < RETRY_MAX_ATTEMPTS - 1) {
      const delay = Math.min(
        RETRY_MAX_DELAY_MS,
        RETRY_BASE_DELAY_MS * 2 ** attempt,
      );
      // Add ±25% jitter so concurrent callers don't lock-step their retries.
      const jitter = delay * (0.75 + Math.random() * 0.5);
      await sleep(jitter);
    }
  }
  throw new YahooRateLimitedError(
    `Yahoo rate limit (429) for ${tickerForLog} after ${RETRY_MAX_ATTEMPTS} attempts`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
