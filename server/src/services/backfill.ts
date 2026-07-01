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
import { log } from "./logger.js";

const BACKFILL_CRON = "7 * * * *"; // top of every hour, :07
const FREQUENCIES: PriceFrequency[] = ["daily"]; // weekly/monthly are computed downstream
// How many tickers to attempt per cron tick. With one ticker per tick,
// a fresh 8-ticker batch needs 8 hours to drain even if Yahoo cooperates.
// Two per tick halves the worst case to 4 hours while still keeping us
// well under Yahoo's ≈100 req/hr ceiling. Failed tickers stay in the
// queue and retry on the next tick.
const TICKERS_PER_CRON = 2;

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
    log(
      `[backfill] scheduled '${BACKFILL_CRON}' (${TICKERS_PER_CRON} ticker(s)/tick) using provider '${this.historicalProvider.name}'`,
    );
    // On startup, drain the queue as fast as the provider allows. The
    // cron tick is conservative (TICKERS_PER_CRON per hour) so we don't
    // burn Yahoo's budget during steady state, but a fresh server with
    // 8 newly added tickers shouldn't have to wait 4 hours to start
    // seeing data. We bail out on the first failure (typically a 429)
    // and let the cron retry on the next tick.
    void this.drainUntilFirstFailure().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[backfill] startup drain failed", err);
    });
  }

  /** Process the queue continuously until the first failure. Used on
   *  startup so a server restart catches up immediately; falls back to
   *  the conservative cron cadence after the first 429. */
  private async drainUntilFirstFailure(): Promise<void> {
    while (true) {
      const tickers = await this.storage.listTickers();
      const candidates = tickers.filter((t: TrackedTicker) => {
        const status: BackfillStatus = t.backfillStatus ?? "pending";
        return status === "pending" || status === "failed";
      });
      if (candidates.length === 0) return;

      const ticker = candidates[0]!;
      const before = ticker.backfillStatus;
      await this.backfillTicker(ticker);
      const after = (await this.storage.listTickers()).find(
        (t) => t.ticker === ticker.ticker,
      );
      // If the ticker is still failed (or didn't move to ok), assume
      // the provider is rate-limiting us and stop draining. The cron
      // will retry on the next tick.
      if (!after || after.backfillStatus === "failed") return;
      // Same status (shouldn't happen with our transitions, but safety
      // belt): break to avoid an infinite loop.
      if (after.backfillStatus === before) return;
    }
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** One backfill pass. Processes up to TICKERS_PER_CRON pending/failed
   *  tickers, sequentially. Series processing (one at a time) keeps us
   *  polite to Yahoo even if it isn't currently throttling us. */
  async tick(): Promise<void> {
    const tickers = await this.storage.listTickers();
    const candidates = tickers.filter((t: TrackedTicker) => {
      const status: BackfillStatus = t.backfillStatus ?? "pending";
      return status === "pending" || status === "failed";
    });
    if (candidates.length === 0) return;

    const batch = candidates.slice(0, TICKERS_PER_CRON);
    for (const ticker of batch) {
      await this.backfillTicker(ticker);
    }
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
      log(
        `[backfill] ${ticker.ticker} OK (${totalBars} bars across ${FREQUENCIES.length} frequencies)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      await this.storage.updateTicker(ticker.ticker, {
        backfillStatus: "failed",
        lastBackfillError: message,
      });
      // eslint-disable-next-line no-console
      log(`[backfill] ${ticker.ticker} FAILED: ${message}`);
    }
  }
}