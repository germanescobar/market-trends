/**
 * Storage abstraction. Two implementations are provided:
 *
 * - InMemoryStore: zero-setup, used in dev and tests. Resets on restart.
 * - PostgresStore: persistent, used in production. Activated when
 *   `DATABASE_URL` is set.
 *
 * The store persists the user's tracked ticker list, the historical price
 * bars (multi-source), and the latest live quote per ticker. Bars are
 * keyed by (ticker, frequency, date); the source provider is a column.
 */

import type {
  BackfillStatus,
  LastQuote,
  PriceBar,
  PriceFrequency,
  PriceSeries,
  TrackedTicker,
} from "@market-trends/shared";

export interface Storage {
  // ---- Tracked tickers ----
  listTickers(): Promise<TrackedTicker[]>;
  addTicker(ticker: TrackedTicker): Promise<TrackedTicker>;
  removeTicker(symbol: string): Promise<void>;
  updateTicker(
    symbol: string,
    patch: Partial<TrackedTicker>,
  ): Promise<TrackedTicker | null>;

  // ---- Bars (multi-source) ----
  /** Read all bars for a (ticker, frequency) pair, optionally filtered by
   *  date range. Bars are returned in ascending date order. The result
   *  carries the most-recent `fetchedAt` of any contributing row, used
   *  by the analytics layer to decide whether to refresh. */
  getBars(input: GetStoredBarsInput): Promise<StoredBars | null>;
  /** Upsert bars for a single source provider. Existing bars from OTHER
   *  providers for the same dates are preserved (the storage layer is
   *  multi-source); only the supplied provider's rows are replaced.
   *  Returns the merged series after the write. */
  upsertBars(input: UpsertBarsInput): Promise<StoredBars>;
  /** Cheap "when did we last successfully update bars?" lookup. */
  getLatestFetchedAt(ticker: string, frequency: PriceFrequency): Promise<string | null>;

  // ---- Last quote ----
  getLastQuote(symbol: string): Promise<LastQuote | null>;
  upsertLastQuote(quote: LastQuote): Promise<void>;

  // ---- Maintenance ----
  close?(): Promise<void>;
}

export interface GetStoredBarsInput {
  ticker: string;
  frequency: PriceFrequency;
  startDate?: string;
  endDate?: string;
}

export interface UpsertBarsInput {
  ticker: string;
  frequency: PriceFrequency;
  sourceProvider: string;
  bars: PriceBar[];
}

export interface StoredBars {
  ticker: string;
  frequency: PriceFrequency;
  bars: PriceBar[];
  startDate: string;
  endDate: string;
  /** Earliest fetch timestamp across all contributing rows. */
  fetchedAt: string;
  /** Source providers that contributed at least one row. */
  sources: string[];
}

/** Back-compat helper: turn a StoredBars into the PriceSeries the rest of
 *  the app expects. The `source` field is set to the most-recent
 *  contributor (alphabetical fallback when nothing's "most recent"). */
export function storedBarsToSeries(stored: StoredBars): PriceSeries {
  const source = stored.sources.length === 1
    ? stored.sources[0]!
    : stored.sources.slice().sort()[0] ?? "unknown";
  return {
    ticker: stored.ticker,
    bars: stored.bars,
    startDate: stored.startDate,
    endDate: stored.endDate,
    source,
    frequency: stored.frequency,
  };
}

export type { BackfillStatus, LastQuote, PriceBar, PriceSeries, TrackedTicker };