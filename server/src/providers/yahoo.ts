/**
 * Yahoo Finance data provider.
 *
 * Uses Yahoo's public v8 chart API directly via `fetch`. The shape of the
 * response is well-known: it returns adjusted closes, OHLC, and volume for
 * the requested range and interval.
 *
 * Note: Yahoo's public endpoints are unofficial and rate-limited. We send
 * a `User-Agent` header that mimics a desktop browser to avoid the most
 * common anti-bot blocks.
 */

import {
  type GetHistoricalPricesParams,
  type MarketDataProvider,
  type PriceBar,
  type PriceSeries,
  type Quote,
} from "@market-trends/shared";

const CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const QUOTE_BASE = "https://query1.finance.yahoo.com/v7/finance/quote";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });
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
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
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
    const url = `${CHART_BASE}/${encodeURIComponent(upper)}?range=1mo&interval=1d`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as ChartResponse;
      const meta = json.chart.result?.[0]?.meta;
      return meta?.longName ?? meta?.shortName;
    } catch {
      return undefined;
    }
  }
}

function pickNumber(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
