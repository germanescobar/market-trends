/**
 * BackfillService: per tracked ticker, ask the historical provider
 * (Yahoo) for the deepest series it can give. Runs on a cron — the
 * dashboard never waits on this; the ticker row shows "pending" until
 * bars land in storage.
 *
 * Why Yahoo-only here: backfill is a one-shot per ticker and Yahoo
 * gives the longest free history. eToro's recent-only history is used
 * for refresh; Alpha Vantage's 100-day free cap makes it useless for
 * backfill. CoinGecko's free tier is also 365-day-limited, so we
 * don't add it.
 *
 * Failure handling: a 429 or 5xx response parks the ticker in
 * `backfillStatus = failed` with the error message; the next tick
 * retries. We deliberately do NOT retry with backoff inside a single
 * tick — if Yahoo is rate-limiting us, hammering it won't help and
 * would just extend the block.
 */

import { schedule as cronSchedule, type ScheduledTask } from "node-cron";
import type {
  BackfillStatus,
  MarketDataProvider,
  PriceFrequency,
  TrackedTicker,
} from "@market-trends/shared";
import type { Storage } from "../storage/types.js";

const BACKFILL_CRON = "7 * * * *"; // top of every hour, :07
const FREQUENCIES: PriceFrequency[] = ["daily"]; // weekly/monthly are computed downstream

export class BackfillService {
  private task: ScheduledTask | null = null;

  constructor(
    private storage: Storage,
    private historicalProvider: MarketDataProvider,
  ) {}

  start(): void {
    if (this.task) return;
    this.task = cronSchedule(BACKFILL_CRON, () => {
      void this.tick().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[backfill] tick failed", err);
      });
    });
    // eslint-disable-next-line no-console
    console.log(`[backfill] scheduled '${BACKFILL_CRON}' using provider '${this.historicalProvider.name}'`);
    // Run once on startup so a fresh server catches up immediately.
    void this.tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[backfill] initial tick failed", err);
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** One backfill pass. Processes pending/failed tickers one at a time so
   *  we never burst > 1 historical request at Yahoo. */
  async tick(): Promise<void> {
    const tickers = await this.storage.listTickers();
    const candidates = tickers.filter((t: TrackedTicker) => {
      const status: BackfillStatus = t.backfillStatus ?? "pending";
      return status === "pending" || status === "failed";
    });
    if (candidates.length === 0) return;

    // Process one ticker per tick to stay polite. Future improvement:
    // batch within a tick with a small concurrency cap (e.g., 2).
    const ticker = candidates[0]!;
    await this.backfillTicker(ticker);
  }

  /** Run one ticker immediately (used by tests and the dev endpoint).
   *  Returns true if backfill succeeded. */
  async backfillNow(symbol: string): Promise<boolean> {
    const upper = symbol.toUpperCase();
    const tickers = await this.storage.listTickers();
    const ticker = tickers.find((t) => t.ticker === upper);
    if (!ticker) return false;
    const status: BackfillStatus = ticker.backfillStatus ?? "pending";
    if (status === "backfilling") return false;
    await this.backfillTicker(ticker);
    const after = await this.storage.listTickers();
    const next = after.find((t) => t.ticker === upper);
    return next?.backfillStatus === "ok";
  }

  private async backfillTicker(ticker: TrackedTicker): Promise<void> {
    await this.storage.updateTicker(ticker.ticker, {
      backfillStatus: "backfilling",
      lastBackfillError: undefined,
    });
    try {
      let totalBars = 0;
      for (const frequency of FREQUENCIES) {
        const series = await this.historicalProvider.getHistoricalPrices({
          ticker: ticker.ticker,
          frequency,
        });
        if (series.bars.length === 0) {
          throw new Error(`Provider returned no bars for ${ticker.ticker}`);
        }
        const merged = await this.storage.upsertBars({
          ticker: ticker.ticker,
          frequency,
          sourceProvider: this.historicalProvider.name,
          bars: series.bars,
        });
        totalBars += merged.bars.length;
      }
      await this.storage.updateTicker(ticker.ticker, {
        backfillStatus: "ok",
        lastBackfillAt: new Date().toISOString(),
        lastBackfillError: undefined,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[backfill] ${ticker.ticker} OK (${totalBars} bars across ${FREQUENCIES.length} frequencies)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      await this.storage.updateTicker(ticker.ticker, {
        backfillStatus: "failed",
        lastBackfillError: message,
      });
      // eslint-disable-next-line no-console
      console.warn(`[backfill] ${ticker.ticker} FAILED: ${message}`);
    }
  }
}