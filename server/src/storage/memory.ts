import type { LastQuote, PriceBar, PriceFrequency, TrackedTicker } from "@market-trends/shared";
import type {
  GetStoredBarsInput,
  Storage,
  StoredBars,
  UpsertBarsInput,
} from "./types.js";

/** Volatile in-memory store. Suitable for dev and tests. */
export class InMemoryStore implements Storage {
  private tickers = new Map<string, TrackedTicker>();
  // bars keyed by `${ticker}:${frequency}` -> list of bars with provider.
  private barsByKey = new Map<string, Array<PriceBar & { source: string; fetchedAt: string }>>();
  private quotes = new Map<string, LastQuote>();

  // ---- Tracked tickers ----

  async listTickers(): Promise<TrackedTicker[]> {
    return [...this.tickers.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  async addTicker(ticker: TrackedTicker): Promise<TrackedTicker> {
    const key = ticker.ticker.toUpperCase();
    const next: TrackedTicker = {
      ...ticker,
      ticker: key,
      backfillStatus: ticker.backfillStatus ?? "pending",
    };
    this.tickers.set(key, next);
    return next;
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
    const next: TrackedTicker = { ...existing, ...patch, ticker: existing.ticker };
    this.tickers.set(key, next);
    return next;
  }

  // ---- Bars ----

  async getBars({
    ticker,
    frequency,
    startDate,
    endDate,
  }: GetStoredBarsInput): Promise<StoredBars | null> {
    const key = `${ticker.toUpperCase()}:${frequency}`;
    const rows = this.barsByKey.get(key);
    if (!rows || rows.length === 0) return null;
    // For each date, pick the row with the most recent fetched_at across
    // providers. Mirrors the Postgres merge logic so the dashboard behaves
    // the same in dev and prod.
    const byDate = new Map<string, PriceBar & { source: string; fetchedAt: string }>();
    for (const row of rows) {
      const existing = byDate.get(row.date);
      if (!existing || row.fetchedAt > existing.fetchedAt) {
        byDate.set(row.date, row);
      }
    }
    const merged = [...byDate.values()]
      .filter((row) => {
        if (startDate && row.date < startDate) return false;
        if (endDate && row.date > endDate) return false;
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    if (merged.length === 0) return null;
    const sources = new Set(merged.map((r) => r.source));
    let latest = merged[0]!.fetchedAt;
    for (const row of merged) if (row.fetchedAt > latest) latest = row.fetchedAt;
    return {
      ticker: ticker.toUpperCase(),
      frequency,
      bars: merged.map(({ source: _source, fetchedAt: _fetchedAt, ...bar }) => bar),
      startDate: merged[0]!.date,
      endDate: merged[merged.length - 1]!.date,
      fetchedAt: latest,
      sources: [...sources],
    };
  }

  async upsertBars({
    ticker,
    frequency,
    sourceProvider,
    bars,
  }: UpsertBarsInput): Promise<StoredBars> {
    const key = `${ticker.toUpperCase()}:${frequency}`;
    const existing = this.barsByKey.get(key) ?? [];
    const without = existing.filter((row) => row.source !== sourceProvider);
    const now = new Date().toISOString();
    const added = bars.map((bar) => ({ ...bar, source: sourceProvider, fetchedAt: now }));
    this.barsByKey.set(key, [...without, ...added]);
    const merged = await this.getBars({ ticker, frequency });
    if (merged) return merged;
    return {
      ticker: ticker.toUpperCase(),
      frequency,
      bars: [],
      startDate: "",
      endDate: "",
      fetchedAt: now,
      sources: [sourceProvider],
    };
  }

  async getLatestFetchedAt(
    ticker: string,
    frequency: PriceFrequency,
  ): Promise<string | null> {
    const key = `${ticker.toUpperCase()}:${frequency}`;
    const rows = this.barsByKey.get(key);
    if (!rows || rows.length === 0) return null;
    let latest = rows[0]!.fetchedAt;
    for (const row of rows) if (row.fetchedAt > latest) latest = row.fetchedAt;
    return latest;
  }

  // ---- Last quote ----

  async getLastQuote(symbol: string): Promise<LastQuote | null> {
    return this.quotes.get(symbol.toUpperCase()) ?? null;
  }

  async upsertLastQuote(quote: LastQuote): Promise<void> {
    this.quotes.set(quote.ticker.toUpperCase(), {
      ...quote,
      fetchedAt: new Date().toISOString(),
    });
  }
}