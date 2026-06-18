import { Pool } from "pg";
import type { TrackedTicker } from "@market-trends/shared";
import type { Storage } from "./types.js";

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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
