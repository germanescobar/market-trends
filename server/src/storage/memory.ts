import type { TrackedTicker } from "@market-trends/shared";
import type { Storage } from "./types.js";

/** Volatile in-memory store. Suitable for dev and tests. */
export class InMemoryStore implements Storage {
  private tickers = new Map<string, TrackedTicker>();

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
}
