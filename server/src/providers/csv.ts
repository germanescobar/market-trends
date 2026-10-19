/**
 * CSV-backed market data provider.
 *
 * Reads a pre-fetched daily history from `data/{TICKER}.csv` on disk.
 * Used to backfill tickers when the live Yahoo API is rate-limiting us:
 * the operator pulls a CSV out-of-band (e.g. by driving the controller
 * browser through chart API windows — see data/fetch_via_browser.py),
 * drops it into `data/`, and then the import script routes it through
 * this provider.
 *
 * The CSV format matches the PriceBar shape the rest of the app uses:
 *
 *   date,adjustedClose,close,high,low,volume
 *   1999-03-10,43.027050,51.062500,51.156250,50.281250,5232000
 *   ...
 *
 * Lines with empty numeric columns are tolerated. The file is read
 * lazily on the first call per process and cached in memory.
 *
 * The provider is read-only and synchronous-on-disk; it never throws on
 * rate limits. Failures come from a missing file or a malformed row.
 */

import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  type GetHistoricalPricesParams,
  type MarketDataProvider,
  type PriceBar,
  type PriceSeries,
  type Quote,
} from "@market-trends/shared";

export interface CsvProviderOptions {
  /** Directory containing `{TICKER}.csv` files. Default: `<cwd>/data`. */
  dataDir?: string;
  /** Provider name reported via `name` and used as the source in storage. */
  sourceName?: string;
}

export class CsvProvider implements MarketDataProvider {
  readonly name: string;
  private readonly dataDir: string;
  private cache: Map<string, PriceBar[]> | null = null;

  constructor(options: CsvProviderOptions = {}) {
    this.dataDir = options.dataDir ?? defaultDataDir();
    this.name = options.sourceName ?? "csv";
  }

  private loadAll(): Map<string, PriceBar[]> {
    if (this.cache) return this.cache;
    const map = new Map<string, PriceBar[]>();
    let entries: string[];
    try {
      entries = readdirSync(this.dataDir);
    } catch (err) {
      throw new Error(
        `CsvProvider: cannot read dataDir ${this.dataDir}: ${(err as Error).message}`,
      );
    }
    for (const file of entries) {
      const m = file.match(/^([A-Z0-9.\-:=]+)\.csv$/i);
      if (!m) continue;
      const ticker = m[1]!.toUpperCase();
      const bars = parseCsv(path.join(this.dataDir, file));
      map.set(ticker, bars);
    }
    this.cache = map;
    return map;
  }

  async getHistoricalPrices({
    ticker,
    startDate,
    endDate,
  }: GetHistoricalPricesParams): Promise<PriceSeries> {
    const upper = ticker.toUpperCase();
    const all = this.loadAll().get(upper);
    if (!all) {
      throw new Error(`CsvProvider: no CSV for ${upper} in ${this.dataDir}`);
    }
    let bars = all;
    if (startDate) {
      const start = startDate;
      bars = bars.filter((b) => b.date >= start);
    }
    if (endDate) {
      const end = endDate;
      bars = bars.filter((b) => b.date <= end);
    }
    if (bars.length === 0) {
      throw new Error(`CsvProvider: no bars for ${upper} after date filter`);
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
    const all = this.loadAll().get(upper);
    if (!all || all.length === 0) {
      throw new Error(`CsvProvider: no data for ${upper}`);
    }
    const last = all[all.length - 1]!;
    return {
      ticker: upper,
      price: last.close,
      currency: "USD",
      asOf: `${last.date}T00:00:00.000Z`,
    };
  }
}

function defaultDataDir(): string {
  // Resolve relative to this file's location. Works regardless of
  // `process.cwd()` because callers usually run via `tsx` from the
  // server/ directory.
  //
  // Path: <repo>/server/src/providers/csv.ts → ../../data
  const here = new URL(".", import.meta.url).pathname;
  return path.resolve(here, "..", "..", "..", "data");
}

function parseCsv(filePath: string): PriceBar[] {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error(`CsvProvider: ${filePath} is empty or has no data rows`);
  }
  const header = lines[0]!.split(",").map((h) => h.trim());
  const expected = ["date", "adjustedClose", "close", "high", "low", "volume"];
  for (const col of expected) {
    if (!header.includes(col)) {
      throw new Error(
        `CsvProvider: ${filePath} is missing required column '${col}' (header: ${header.join(",")})`,
      );
    }
  }
  const idx = (col: string) => header.indexOf(col);
  const iDate = idx("date");
  const iAdj = idx("adjustedClose");
  const iClose = idx("close");
  const iHigh = idx("high");
  const iLow = idx("low");
  const iVol = idx("volume");

  const bars: PriceBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i]!.split(",");
    const date = row[iDate]?.trim();
    if (!date) continue;
    const adj = Number(row[iAdj]);
    if (!Number.isFinite(adj)) continue;
    const closeRaw = row[iClose];
    const highRaw = row[iHigh];
    const lowRaw = row[iLow];
    const volRaw = row[iVol];
    bars.push({
      date,
      adjustedClose: adj,
      close: closeRaw && closeRaw.length > 0 ? Number(closeRaw) : adj,
      high: highRaw && highRaw.length > 0 ? Number(highRaw) : undefined,
      low: lowRaw && lowRaw.length > 0 ? Number(lowRaw) : undefined,
      volume: volRaw && volRaw.length > 0 ? Number(volRaw) : undefined,
    });
  }
  if (bars.length === 0) {
    throw new Error(`CsvProvider: ${filePath} contained no usable rows`);
  }
  return bars;
}

