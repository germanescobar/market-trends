/**
 * Alpha Vantage market data provider.
 *
 * Uses Alpha Vantage's REST API via `fetch`. Unlike eToro, Alpha Vantage
 * exposes split/dividend-adjusted closes natively, so `adjustedClose` and
 * `close` carry distinct values.
 *
 * Frequency mapping:
 *   daily   → TIME_SERIES_DAILY_ADJUSTED  (premium endpoint)
 *   weekly  → TIME_SERIES_WEEKLY_ADJUSTED (free)
 *   monthly → TIME_SERIES_MONTHLY_ADJUSTED (free)
 *
 * Note: the free tier is capped at 25 requests/day. Callers should lean on the
 * storage/cache layer to stay within that budget; paid tiers lift the daily cap.
 */

import {
  type GetHistoricalPricesParams,
  type MarketDataProvider,
  type PriceBar,
  type PriceFrequency,
  type PriceSeries,
  type Quote,
} from "@market-trends/shared";

const BASE_URL = "https://www.alphavantage.co/query";

interface AlphaVantageProviderOptions {
  apiKey: string;
}

/** Per-frequency endpoint function name and the JSON key holding the series. */
interface SeriesEndpoint {
  fn: string;
  seriesKey: string;
}

/** Raw bar shape shared by the adjusted time-series endpoints. */
interface RawBar {
  "1. open"?: string;
  "2. high"?: string;
  "3. low"?: string;
  "4. close"?: string;
  "5. adjusted close"?: string;
  "6. volume"?: string;
}

type TimeSeriesResponse = Record<string, Record<string, RawBar> | unknown>;

interface GlobalQuoteResponse {
  "Global Quote"?: {
    "05. price"?: string;
    "07. latest trading day"?: string;
    "10. change percent"?: string;
  };
}

interface SymbolSearchResponse {
  bestMatches?: Array<{
    "1. symbol"?: string;
    "2. name"?: string;
  }>;
}

export class AlphaVantageProvider implements MarketDataProvider {
  readonly name = "alphavantage";

  constructor(private readonly options: AlphaVantageProviderOptions) {
    if (!options.apiKey) {
      throw new Error("ALPHAVANTAGE_API_KEY is required for MARKET_DATA_PROVIDER=alphavantage");
    }
  }

  async getHistoricalPrices({
    ticker,
    frequency = "daily",
    startDate,
    endDate,
  }: GetHistoricalPricesParams): Promise<PriceSeries> {
    const symbol = normalizeTicker(ticker);
    const endpoint = toSeriesEndpoint(frequency);
    const params: Record<string, string> = { function: endpoint.fn, symbol };
    // Daily defaults to the last 100 points; request full history. Weekly and
    // monthly endpoints always return full history and ignore `outputsize`.
    if (frequency === "daily") params.outputsize = "full";

    const json = await this.request<TimeSeriesResponse>(params);
    const series = json[endpoint.seriesKey];
    if (!series || typeof series !== "object") {
      throw new Error(`Alpha Vantage returned no ${frequency} series for ${symbol}`);
    }

    const bars = Object.entries(series as Record<string, RawBar>)
      .map(([date, raw]): PriceBar | undefined => {
        const adjustedClose = parseNumber(raw["5. adjusted close"]);
        if (adjustedClose === undefined) return undefined;
        if (startDate && date < startDate) return undefined;
        if (endDate && date > endDate) return undefined;
        return {
          date,
          adjustedClose,
          close: parseNumber(raw["4. close"]) ?? adjustedClose,
          high: parseNumber(raw["2. high"]),
          low: parseNumber(raw["3. low"]),
          volume: parseNumber(raw["6. volume"]),
        };
      })
      .filter((bar): bar is PriceBar => bar !== undefined)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (bars.length === 0) {
      throw new Error(`Alpha Vantage returned no bars for ${symbol}`);
    }

    const first = bars[0]!;
    const last = bars[bars.length - 1]!;
    return {
      ticker: symbol,
      bars,
      startDate: first.date,
      endDate: last.date,
      source: this.name,
      frequency,
    };
  }

  async getQuote(ticker: string): Promise<Quote> {
    const symbol = normalizeTicker(ticker);
    const json = await this.request<GlobalQuoteResponse>({
      function: "GLOBAL_QUOTE",
      symbol,
    });
    const quote = json["Global Quote"];
    const price = parseNumber(quote?.["05. price"]);
    if (price === undefined) {
      throw new Error(`Alpha Vantage returned no quote for ${symbol}`);
    }
    const tradingDay = quote?.["07. latest trading day"];
    return {
      ticker: symbol,
      price,
      currency: "USD",
      asOf: tradingDay ? new Date(`${tradingDay}T00:00:00Z`).toISOString() : new Date().toISOString(),
      changePercent: parsePercent(quote?.["10. change percent"]),
    };
  }

  /** Best-effort display name lookup via the SYMBOL_SEARCH endpoint. */
  async getName(ticker: string): Promise<string | undefined> {
    const symbol = normalizeTicker(ticker);
    try {
      const json = await this.request<SymbolSearchResponse>({
        function: "SYMBOL_SEARCH",
        keywords: symbol,
      });
      const exact = json.bestMatches?.find((match) => match["1. symbol"] === symbol);
      return (exact ?? json.bestMatches?.[0])?.["2. name"];
    } catch {
      return undefined;
    }
  }

  private async request<T>(params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, apikey: this.options.apiKey });
    const res = await fetch(`${BASE_URL}?${qs.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Alpha Vantage request failed (${res.status}) for ${params.function}`);
    }
    const json = (await res.json()) as T & {
      "Error Message"?: string;
      Note?: string;
      Information?: string;
    };
    // Alpha Vantage returns HTTP 200 with an explanatory field on errors and
    // rate-limit / premium-endpoint throttling, so surface those explicitly.
    if (json["Error Message"]) {
      throw new Error(`Alpha Vantage error for ${params.function}: ${json["Error Message"]}`);
    }
    if (json.Note || json.Information) {
      throw new Error(`Alpha Vantage rate limit for ${params.function}: ${json.Note ?? json.Information}`);
    }
    return json;
  }
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function toSeriesEndpoint(frequency: PriceFrequency): SeriesEndpoint {
  switch (frequency) {
    case "daily":
      return { fn: "TIME_SERIES_DAILY_ADJUSTED", seriesKey: "Time Series (Daily)" };
    case "weekly":
      return { fn: "TIME_SERIES_WEEKLY_ADJUSTED", seriesKey: "Weekly Adjusted Time Series" };
    case "monthly":
      return { fn: "TIME_SERIES_MONTHLY_ADJUSTED", seriesKey: "Monthly Adjusted Time Series" };
  }
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parsePercent(value: string | undefined): number | undefined {
  const num = parseNumber(value?.replace("%", ""));
  return num === undefined ? undefined : num / 100;
}
