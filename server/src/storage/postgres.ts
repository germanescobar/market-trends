import { Pool } from "pg";
import type { LastQuote, PriceBar, PriceFrequency, TrackedTicker } from "@market-trends/shared";
import type {
  GetStoredBarsInput,
  Storage,
  StoredBars,
  UpsertBarsInput,
} from "./types.js";

/**
 * Postgres-backed store. Creates the required tables on startup if they
 * don't exist. Used when `DATABASE_URL` is set.
 *
 * Note on schema: bars are keyed by (ticker, frequency, date) with
 * `source_provider` as a regular column. This lets multiple providers
 * contribute bars for the same ticker without overwriting each other.
 */
export class PostgresStore implements Storage {
  private pool: Pool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    // Note: legacy migrations were removed. The previous schema (with a
    // `provider` column or a (provider, ticker, frequency, date) PK) was
    // dropped before this code path runs. New deployments only see the
    // CREATE TABLE IF NOT EXISTS statements below; existing deployments
    // that hit a leftover legacy schema should nuke the tables manually
    // (see storage/nuke.sql) before starting the server.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tracked_tickers (
        ticker TEXT PRIMARY KEY,
        name TEXT,
        note TEXT,
        last_updated TIMESTAMPTZ,
        backfill_status TEXT NOT NULL DEFAULT 'pending',
        last_backfill_error TEXT,
        last_backfill_at TIMESTAMPTZ,
        next_backfill_at TIMESTAMPTZ
      );
    `);
    await this.pool.query(`
      ALTER TABLE tracked_tickers ADD COLUMN IF NOT EXISTS next_backfill_at TIMESTAMPTZ;
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS market_price_bars (
        ticker TEXT NOT NULL,
        frequency TEXT NOT NULL,
        date DATE NOT NULL,
        close NUMERIC NOT NULL,
        adjusted_close NUMERIC NOT NULL,
        high NUMERIC,
        low NUMERIC,
        volume NUMERIC,
        source_provider TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (ticker, frequency, date, source_provider)
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS market_price_bars_lookup
        ON market_price_bars (ticker, frequency, date);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS last_quotes (
        ticker TEXT PRIMARY KEY,
        price NUMERIC NOT NULL,
        currency TEXT NOT NULL,
        as_of TIMESTAMPTZ NOT NULL,
        source TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  // ---- Tracked tickers ----

  async listTickers(): Promise<TrackedTicker[]> {
    await this.ready;
    const { rows } = await this.pool.query<{
      ticker: string;
      name: string | null;
      note: string | null;
      last_updated: Date | null;
      backfill_status: string | null;
      last_backfill_error: string | null;
      last_backfill_at: Date | null;
      next_backfill_at: Date | null;
    }>(
      `SELECT ticker, name, note, last_updated, backfill_status,
              last_backfill_error, last_backfill_at, next_backfill_at
         FROM tracked_tickers
         ORDER BY ticker ASC`,
    );
    return rows.map(rowToTrackedTicker);
  }

  async addTicker(ticker: TrackedTicker): Promise<TrackedTicker> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO tracked_tickers
         (ticker, name, note, last_updated, backfill_status, last_backfill_error, last_backfill_at, next_backfill_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (ticker) DO UPDATE
         SET name = EXCLUDED.name,
             note = EXCLUDED.note,
             last_updated = EXCLUDED.last_updated`,
      [
        ticker.ticker.toUpperCase(),
        ticker.name ?? null,
        ticker.note ?? null,
        ticker.lastUpdated ? new Date(ticker.lastUpdated) : null,
        ticker.backfillStatus ?? "pending",
        ticker.lastBackfillError ?? null,
        ticker.lastBackfillAt ? new Date(ticker.lastBackfillAt) : null,
        ticker.nextBackfillAt ? new Date(ticker.nextBackfillAt) : null,
      ],
    );
    return ticker;
  }

  async removeTicker(symbol: string): Promise<void> {
    await this.ready;
    await this.pool.query(`DELETE FROM tracked_tickers WHERE ticker = $1`, [
      symbol.toUpperCase(),
    ]);
  }

  async updateTicker(
    symbol: string,
    patch: Partial<TrackedTicker>,
  ): Promise<TrackedTicker | null> {
    await this.ready;
    const upper = symbol.toUpperCase();
    const existing = await this.pool.query<{
      ticker: string;
      name: string | null;
      note: string | null;
      last_updated: Date | null;
      backfill_status: string | null;
      last_backfill_error: string | null;
      last_backfill_at: Date | null;
      next_backfill_at: Date | null;
    }>(
      `SELECT ticker, name, note, last_updated, backfill_status,
              last_backfill_error, last_backfill_at, next_backfill_at
         FROM tracked_tickers WHERE ticker = $1`,
      [upper],
    );
    if (existing.rowCount === 0) return null;
    const row = existing.rows[0]!;
    // Patch semantics: a field present in `patch` (even as `undefined`)
    // overrides the stored value; a field absent from `patch` keeps the
    // existing value. This mirrors InMemoryStore's `{ ...existing, ...patch }`
    // and lets callers like BackfillService clear a cooldown or stale
    // error message by passing `nextBackfillAt: undefined` /
    // `lastBackfillError: undefined`. Plain `??` would lose that
    // distinction and silently preserve the old value.
    const next: TrackedTicker = {
      ticker: row.ticker,
      name: "name" in patch ? patch.name ?? undefined : row.name ?? undefined,
      note: "note" in patch ? patch.note ?? undefined : row.note ?? undefined,
      lastUpdated: patch.lastUpdated
        ? new Date(patch.lastUpdated).toISOString()
        : row.last_updated?.toISOString(),
      backfillStatus:
        patch.backfillStatus ?? (row.backfill_status as TrackedTicker["backfillStatus"]) ?? "pending",
      lastBackfillError:
        "lastBackfillError" in patch
          ? patch.lastBackfillError
          : row.last_backfill_error ?? undefined,
      lastBackfillAt: patch.lastBackfillAt
        ? new Date(patch.lastBackfillAt).toISOString()
        : row.last_backfill_at?.toISOString(),
      nextBackfillAt:
        "nextBackfillAt" in patch
          ? patch.nextBackfillAt
            ? new Date(patch.nextBackfillAt).toISOString()
            : undefined
          : row.next_backfill_at?.toISOString() ?? undefined,
    };
    await this.pool.query(
      `UPDATE tracked_tickers
          SET name = $2,
              note = $3,
              last_updated = $4,
              backfill_status = $5,
              last_backfill_error = $6,
              last_backfill_at = $7,
              next_backfill_at = $8
        WHERE ticker = $1`,
      [
        upper,
        next.name ?? null,
        next.note ?? null,
        next.lastUpdated ? new Date(next.lastUpdated) : null,
        next.backfillStatus ?? "pending",
        next.lastBackfillError ?? null,
        next.lastBackfillAt ? new Date(next.lastBackfillAt) : null,
        next.nextBackfillAt ? new Date(next.nextBackfillAt) : null,
      ],
    );
    return next;
  }

  // ---- Bars ----

  async getBars({
    ticker,
    frequency,
    startDate,
    endDate,
  }: GetStoredBarsInput): Promise<StoredBars | null> {
    await this.ready;
    const params: Array<string> = [ticker.toUpperCase(), frequency];
    const filters = [`ticker = $1`, `frequency = $2`];
    if (startDate) {
      params.push(startDate);
      filters.push(`date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      filters.push(`date <= $${params.length}`);
    }

    const { rows } = await this.pool.query<{
      date: string;
      close: string;
      adjusted_close: string;
      high: string | null;
      low: string | null;
      volume: string | null;
      source_provider: string;
      fetched_at: Date;
    }>(
      `SELECT date::text, close, adjusted_close, high, low, volume,
              source_provider, fetched_at
         FROM market_price_bars
        WHERE ${filters.join(" AND ")}
        ORDER BY date ASC`,
      params,
    );
    if (rows.length === 0) return null;

    // Merge rows from multiple providers for the same date by preferring
    // the row with the latest fetched_at. The result is one bar per date.
    const byDate = new Map<string, MergedRow>();
    for (const row of rows) {
      const existing = byDate.get(row.date);
      if (!existing || row.fetched_at > existing.fetched_at) {
        byDate.set(row.date, row);
      }
    }
    const sources = new Set<string>();
    let latestFetch: Date | null = null;
    const bars: PriceBar[] = [];
    for (const [, row] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      sources.add(row.source_provider);
      if (!latestFetch || row.fetched_at > latestFetch) latestFetch = row.fetched_at;
      bars.push({
        date: row.date,
        close: Number(row.close),
        adjustedClose: Number(row.adjusted_close),
        high: parseOptionalNumber(row.high),
        low: parseOptionalNumber(row.low),
        volume: parseOptionalNumber(row.volume),
      });
    }
    return {
      ticker: ticker.toUpperCase(),
      frequency,
      bars,
      startDate: bars[0]!.date,
      endDate: bars[bars.length - 1]!.date,
      fetchedAt: (latestFetch ?? new Date()).toISOString(),
      sources: [...sources],
    };
  }

  async upsertBars({
    ticker,
    frequency,
    sourceProvider,
    bars,
  }: UpsertBarsInput): Promise<StoredBars> {
    await this.ready;
    if (bars.length === 0) {
      // Nothing to write; just return whatever is currently in storage.
      const existing = await this.getBars({ ticker, frequency });
      if (existing) return existing;
      return {
        ticker: ticker.toUpperCase(),
        frequency,
        bars: [],
        startDate: "",
        endDate: "",
        fetchedAt: new Date().toISOString(),
        sources: [],
      };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Replace the supplied provider's rows for this (ticker, frequency)
      // and re-insert the supplied bars. We deliberately delete + insert
      // (rather than upsert by (ticker, frequency, date, provider)) so a
      // corrected bar from the same provider overwrites cleanly. Other
      // providers' rows for the same dates are untouched.
      await client.query(
        `DELETE FROM market_price_bars
          WHERE ticker = $1
            AND frequency = $2
            AND source_provider = $3`,
        [ticker.toUpperCase(), frequency, sourceProvider],
      );
      for (const bar of bars) {
        await client.query(
          `INSERT INTO market_price_bars
             (ticker, frequency, date, close, adjusted_close,
              high, low, volume, source_provider, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
          [
            ticker.toUpperCase(),
            frequency,
            bar.date,
            bar.close,
            bar.adjustedClose,
            bar.high ?? null,
            bar.low ?? null,
            bar.volume ?? null,
            sourceProvider,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    const merged = await this.getBars({ ticker, frequency });
    if (!merged) {
      return {
        ticker: ticker.toUpperCase(),
        frequency,
        bars: [],
        startDate: "",
        endDate: "",
        fetchedAt: new Date().toISOString(),
        sources: [sourceProvider],
      };
    }
    return merged;
  }

  async getLatestFetchedAt(
    ticker: string,
    frequency: PriceFrequency,
  ): Promise<string | null> {
    await this.ready;
    const { rows } = await this.pool.query<{ fetched_at: Date }>(
      `SELECT MAX(fetched_at) AS fetched_at
         FROM market_price_bars
        WHERE ticker = $1 AND frequency = $2`,
      [ticker.toUpperCase(), frequency],
    );
    const row = rows[0];
    return row?.fetched_at ? row.fetched_at.toISOString() : null;
  }

  // ---- Last quote ----

  async getLastQuote(symbol: string): Promise<LastQuote | null> {
    await this.ready;
    const { rows } = await this.pool.query<{
      ticker: string;
      price: string;
      currency: string;
      as_of: Date;
      source: string;
      fetched_at: Date;
    }>(
      `SELECT ticker, price, currency, as_of, source, fetched_at
         FROM last_quotes
        WHERE ticker = $1`,
      [symbol.toUpperCase()],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ticker: row.ticker,
      price: Number(row.price),
      currency: row.currency,
      asOf: row.as_of.toISOString(),
      source: row.source,
      fetchedAt: row.fetched_at.toISOString(),
    };
  }

  async upsertLastQuote(quote: LastQuote): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO last_quotes (ticker, price, currency, as_of, source, fetched_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (ticker) DO UPDATE
         SET price = EXCLUDED.price,
             currency = EXCLUDED.currency,
             as_of = EXCLUDED.as_of,
             source = EXCLUDED.source,
             fetched_at = EXCLUDED.fetched_at`,
      [
        quote.ticker.toUpperCase(),
        quote.price,
        quote.currency,
        new Date(quote.asOf),
        quote.source,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface MergedRow {
  date: string;
  close: string;
  adjusted_close: string;
  high: string | null;
  low: string | null;
  volume: string | null;
  source_provider: string;
  fetched_at: Date;
}

function rowToTrackedTicker(row: {
  ticker: string;
  name: string | null;
  note: string | null;
  last_updated: Date | null;
  backfill_status: string | null;
  last_backfill_error: string | null;
  last_backfill_at: Date | null;
  next_backfill_at: Date | null;
}): TrackedTicker {
  return {
    ticker: row.ticker,
    name: row.name ?? undefined,
    note: row.note ?? undefined,
    lastUpdated: row.last_updated ? row.last_updated.toISOString() : undefined,
    backfillStatus: (row.backfill_status ?? "pending") as TrackedTicker["backfillStatus"],
    lastBackfillError: row.last_backfill_error ?? undefined,
    lastBackfillAt: row.last_backfill_at ? row.last_backfill_at.toISOString() : undefined,
    nextBackfillAt: row.next_backfill_at ? row.next_backfill_at.toISOString() : undefined,
  };
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}