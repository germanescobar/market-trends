/**
 * Storage abstraction. Two implementations are provided:
 *
 * - InMemoryStore: zero-setup, used in dev and tests. Resets on restart.
 * - PostgresStore: persistent, used in production. Activated when
 *   `DATABASE_URL` is set.
 *
 * The store persists the user's tracked ticker list. Price history is always
 * fetched fresh from the market data provider (and may be cached separately
 * in the future).
 */

import type { TrackedTicker } from "@market-trends/shared";

export interface Storage {
  listTickers(): Promise<TrackedTicker[]>;
  addTicker(ticker: TrackedTicker): Promise<TrackedTicker>;
  removeTicker(symbol: string): Promise<void>;
  updateTicker(symbol: string, patch: Partial<TrackedTicker>): Promise<TrackedTicker | null>;
}
