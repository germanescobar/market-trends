/**
 * Storage abstraction. Two implementations are provided:
 *
 * - InMemoryStore: zero-setup, used in dev and tests. Resets on restart.
 * - PostgresStore: persistent, used in production. Activated when
 *   `DATABASE_URL` is set.
 *
 * The store persists the user's tracked ticker list and historical price bars.
 */

import type { PriceFrequency, PriceSeries, TrackedTicker } from "@market-trends/shared";

export interface Storage {
  listTickers(): Promise<TrackedTicker[]>;
  addTicker(ticker: TrackedTicker): Promise<TrackedTicker>;
  removeTicker(symbol: string): Promise<void>;
  updateTicker(symbol: string, patch: Partial<TrackedTicker>): Promise<TrackedTicker | null>;
  getPriceSeries(input: GetStoredPriceSeriesInput): Promise<StoredPriceSeries | null>;
  upsertPriceSeries(series: PriceSeries): Promise<void>;
}

export interface GetStoredPriceSeriesInput {
  provider: string;
  ticker: string;
  frequency: PriceFrequency;
  startDate?: string;
  endDate?: string;
}

export interface StoredPriceSeries extends PriceSeries {
  fetchedAt: string;
}
