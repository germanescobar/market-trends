import type { PriceBar, PriceSeries, TrackedTicker } from "@market-trends/shared";
import type {
  GetStoredPriceSeriesInput,
  Storage,
  StoredPriceSeries,
} from "./types.js";

/** Volatile in-memory store. Suitable for dev and tests. */
export class InMemoryStore implements Storage {
  private tickers = new Map<string, TrackedTicker>();
  private priceSeries = new Map<string, StoredPriceSeries>();

  async listTickers(): Promise<TrackedTicker[]> {
    return [...this.tickers.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  async addTicker(ticker: TrackedTicker): Promise<TrackedTicker> {
    this.tickers.set(ticker.ticker.toUpperCase(), ticker);
    return ticker;
  }

  async removeTicker(symbol: string): Promise<void> {
    this.tickers.delete(symbol.toUpperCase());
  }

  async updateTicker(
    symbol: string,
    patch: Partial<TrackedTicker>,
  ): Promise<TrackedTicker | null> {
    const key = symbol.toUpperCase();
    const existing = this.tickers.get(key);
    if (!existing) return null;
    const next = { ...existing, ...patch, ticker: existing.ticker };
    this.tickers.set(key, next);
    return next;
  }

  async getPriceSeries({
    provider,
    ticker,
    frequency,
    startDate,
    endDate,
  }: GetStoredPriceSeriesInput): Promise<StoredPriceSeries | null> {
    const series = this.priceSeries.get(seriesKey(provider, ticker, frequency));
    if (!series) return null;
    const bars = filterBars(series.bars, startDate, endDate);
    if (bars.length === 0) return null;
    return {
      ...series,
      bars,
      startDate: bars[0]!.date,
      endDate: bars[bars.length - 1]!.date,
    };
  }

  async upsertPriceSeries(series: PriceSeries): Promise<void> {
    const key = seriesKey(series.source, series.ticker, series.frequency);
    const existing = this.priceSeries.get(key);
    const barsByDate = new Map<string, PriceBar>();
    for (const bar of existing?.bars ?? []) barsByDate.set(bar.date, bar);
    for (const bar of series.bars) barsByDate.set(bar.date, bar);
    const bars = [...barsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    this.priceSeries.set(key, {
      ...series,
      bars,
      startDate: bars[0]?.date ?? series.startDate,
      endDate: bars[bars.length - 1]?.date ?? series.endDate,
      fetchedAt: new Date().toISOString(),
    });
  }
}

function seriesKey(provider: string, ticker: string, frequency: string): string {
  return `${provider}:${ticker.toUpperCase()}:${frequency}`;
}

function filterBars(
  bars: PriceBar[],
  startDate: string | undefined,
  endDate: string | undefined,
): PriceBar[] {
  return bars.filter((bar) => {
    if (startDate && bar.date < startDate) return false;
    if (endDate && bar.date > endDate) return false;
    return true;
  });
}
