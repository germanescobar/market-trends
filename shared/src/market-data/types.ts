/**
 * Market data provider abstraction.
 *
 * Concrete implementations live in the server package. The shared package
 * only defines the contract so the UI can reason about provider-agnostic
 * shapes and the server can swap providers via configuration.
 */

import type { PriceSeries, Quote } from "../types/index.js";

export interface GetHistoricalPricesParams {
  ticker: string;
  /** ISO-8601 date string (YYYY-MM-DD). */
  startDate?: string;
  /** ISO-8601 date string (YYYY-MM-DD). Defaults to today. */
  endDate?: string;
}

export interface MarketDataProvider {
  /** A short name for diagnostics & caching keys (e.g. "yahoo", "stub"). */
  readonly name: string;
  /** Fetch an ordered series of adjusted close bars for a ticker. */
  getHistoricalPrices(params: GetHistoricalPricesParams): Promise<PriceSeries>;
  /** Fetch a latest quote snapshot. */
  getQuote(ticker: string): Promise<Quote>;
}
