import { Pool } from "pg";
import type { PriceBar, PriceSeries, TrackedTicker } from "@market-trends/shared";
import type {
  GetStoredPriceSeriesInput,
  Storage,
  StoredPriceSeries,
} from "./types.js";

/**
 * Postgres-backed store. Creates the `tracked_tickers` table on startup if
 * it doesn't exist. Used when `DATABASE_URL` is set.
 */
export class PostgresStore implements Storage {
  private pool: Pool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tracked_tickers (
        ticker TEXT PRIMARY KEY,
        name TEXT,
        note TEXT,
        last_updated TIMESTAMPTZ
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS market_price_bars (
        provider TEXT NOT NULL,
        ticker TEXT NOT NULL,
        frequency TEXT NOT NULL DEFAULT 'daily',
        date DATE NOT NULL,
        close NUMERIC NOT NULL,
        adjusted_close NUMERIC NOT NULL,
        high NUMERIC,
        low NUMERIC,
        volume NUMERIC,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, ticker, frequency, date)
      );
    `);
    await this.pool.query(`
      ALTER TABLE market_price_bars
      ADD COLUMN IF NOT EXISTS frequency TEXT NOT NULL DEFAULT 'daily';
    `);
    await this.pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'market_price_bars_pkey'
             AND conrelid = 'market_price_bars'::regclass
             AND pg_get_constraintdef(oid) = 'PRIMARY KEY (provider, ticker, date)'
        ) THEN
          ALTER TABLE market_price_bars DROP CONSTRAINT market_price_bars_pkey;
          ALTER TABLE market_price_bars
            ADD PRIMARY KEY (provider, ticker, frequency, date);
        END IF;
      END $$;
    `);
  }

  async listTickers(): Promise<TrackedTicker[]> {
    await this.ready;
    const { rows } = await this.pool.query<{
      ticker: string;
      name: string | null;
      note: string | null;
      last_updated: Date | null;
    }>(
      `SELECT ticker, name, note, last_updated
         FROM tracked_tickers
         ORDER BY ticker ASC`,
    );
    return rows.map((r) => ({
      ticker: r.ticker,
      name: r.name ?? undefined,
      note: r.note ?? undefined,
      lastUpdated: r.last_updated ? r.last_updated.toISOString() : undefined,
    }));
  }

  async addTicker(ticker: TrackedTicker): Promise<TrackedTicker> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO tracked_tickers (ticker, name, note, last_updated)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticker) DO UPDATE
         SET name = EXCLUDED.name,
             note = EXCLUDED.note,
             last_updated = EXCLUDED.last_updated`,
      [
        ticker.ticker.toUpperCase(),
        ticker.name ?? null,
        ticker.note ?? null,
        ticker.lastUpdated ? new Date(ticker.lastUpdated) : null,
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
    const existing = await this.pool.query<{
      ticker: string;
      name: string | null;
      note: string | null;
      last_updated: Date | null;
    }>(`SELECT ticker, name, note, last_updated FROM tracked_tickers WHERE ticker = $1`, [
      symbol.toUpperCase(),
    ]);
    if (existing.rowCount === 0) return null;
    const row = existing.rows[0]!;
    const next = {
      ticker: row.ticker,
      name: patch.name ?? row.name ?? undefined,
      note: patch.note ?? row.note ?? undefined,
      lastUpdated: (patch.lastUpdated
        ? new Date(patch.lastUpdated)
        : row.last_updated
      )?.toISOString(),
    };
    await this.pool.query(
      `UPDATE tracked_tickers SET name = $2, note = $3, last_updated = $4 WHERE ticker = $1`,
      [next.ticker, next.name ?? null, next.note ?? null, next.lastUpdated ?? null],
    );
    return next;
  }

  async getPriceSeries({
    provider,
    ticker,
    frequency,
    startDate,
    endDate,
  }: GetStoredPriceSeriesInput): Promise<StoredPriceSeries | null> {
    await this.ready;
    const params: Array<string> = [provider, ticker.toUpperCase(), frequency];
    const filters = [`provider = $1`, `ticker = $2`, `frequency = $3`];
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
      fetched_at: Date;
    }>(
      `SELECT date::text, close, adjusted_close, high, low, volume, fetched_at
         FROM market_price_bars
        WHERE ${filters.join(" AND ")}
        ORDER BY date ASC`,
      params,
    );
    if (rows.length === 0) return null;

    const bars = rows.map(rowToPriceBar);
    const latestFetch = rows.reduce<Date>(
      (latest, row) => (row.fetched_at > latest ? row.fetched_at : latest),
      rows[0]!.fetched_at,
    );
    return {
      ticker: ticker.toUpperCase(),
      bars,
      startDate: bars[0]!.date,
      endDate: bars[bars.length - 1]!.date,
      source: provider,
      frequency,
      fetchedAt: latestFetch.toISOString(),
    };
  }

  async upsertPriceSeries(series: PriceSeries): Promise<void> {
    await this.ready;
    if (series.bars.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const bar of series.bars) {
        await client.query(
          `INSERT INTO market_price_bars
             (provider, ticker, frequency, date, close, adjusted_close, high, low, volume, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (provider, ticker, frequency, date) DO UPDATE
             SET close = EXCLUDED.close,
                 adjusted_close = EXCLUDED.adjusted_close,
                 high = EXCLUDED.high,
                 low = EXCLUDED.low,
                 volume = EXCLUDED.volume,
                 fetched_at = EXCLUDED.fetched_at`,
          [
            series.source,
            series.ticker.toUpperCase(),
            series.frequency,
            bar.date,
            bar.close,
            bar.adjustedClose,
            bar.high ?? null,
            bar.low ?? null,
            bar.volume ?? null,
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
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToPriceBar(row: {
  date: string;
  close: string;
  adjusted_close: string;
  high: string | null;
  low: string | null;
  volume: string | null;
}): PriceBar {
  return {
    date: row.date,
    close: Number(row.close),
    adjustedClose: Number(row.adjusted_close),
    high: parseOptionalNumber(row.high),
    low: parseOptionalNumber(row.low),
    volume: parseOptionalNumber(row.volume),
  };
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
