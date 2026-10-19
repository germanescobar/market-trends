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
 * Failure handling:
 *  - HTTP 429 (RateLimitError) → write a cooldown (`nextBackfillAt`) of
 *    RATE_LIMIT_COOLDOWN_HOURS into the future, then bail. The tick
 *    (and any future startup drain) will skip this ticker until the
 *    cooldown expires. This is the key fix for the "429 every hour,
 *    forever" problem: without it, the cron plus the startup drain
 *    together hammer the provider indefinitely.
 *  - Other failures (5xx, network) → write a short cooldown so we don't
 *    busy-loop, but the next cron tick (1h away) will retry naturally.
 *  - On success, clear any cooldown so a future restart can re-check.
 *
 * We deliberately do NOT retry with backoff inside a single tick — if
 * Yahoo is rate-limiting us, hammering it won't help and would just
 * extend the block.
 */

import { schedule as cronSchedule, type ScheduledTask } from "node-cron";
import { RateLimitError } from "@market-trends/shared";
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

// How long to park a ticker after the provider signals rate limiting.
// 6h is conservative — Yahoo's public API usually unblocks within 1-2h
// once you stop hammering, but a 6h floor means we never burn more than
// 4 requests per ticker per day even if the block lasts the full window.
const RATE_LIMIT_COOLDOWN_HOURS = 6;

// Short cooldown for non-429 failures (5xx, network, malformed JSON).
// The next cron tick is at most 1h away, so 30 minutes means the ticker
// is still considered "ready to try" on the next pass — we just don't
// retry inside the same tick after a single failure.
const TRANSIENT_COOLDOWN_MINUTES = 30;

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

  /** Filter helper: return only tickers that are eligible to be retried
   *  right now. A ticker is ineligible if it's in a cooldown window
   *  (set after the last failed attempt) or if it's still marked as
   *  "backfilling" by another worker. */
  private isEligible(t: TrackedTicker, now: number): boolean {
    const status: BackfillStatus = t.backfillStatus ?? "pending";
    if (status !== "pending" && status !== "failed") return false;
    if (t.nextBackfillAt) {
      const until = Date.parse(t.nextBackfillAt);
      if (Number.isFinite(until) && until > now) return false;
    }
    return true;
  }

  /** Process the queue continuously until the first failure. Used on
   *  startup so a server restart catches up immediately; falls back to
   *  the conservative cron cadence after the first 429. */
  private async drainUntilFirstFailure(): Promise<void> {
    while (true) {
      const now = Date.now();
      const tickers = await this.storage.listTickers();
      const candidates = tickers.filter((t) => this.isEligible(t, now));
      if (candidates.length === 0) return;

      const ticker = candidates[0]!;
      const before = ticker.backfillStatus;
      await this.backfillTicker(ticker);
      const after = (await this.storage.listTickers()).find(
        (t) => t.ticker === ticker.ticker,
      );
      // If the ticker is still failed (or didn't move to ok), assume
      // the provider is rate-limiting us and stop draining. The cron
      // will retry on the next tick, and the cooldown we just wrote
      // will keep both the next drain and the next cron from hammering
      // it before the rate limit window expires.
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
    const now = Date.now();
    const tickers = await this.storage.listTickers();
    const candidates = tickers.filter((t) => this.isEligible(t, now));
    if (candidates.length === 0) return;

    const batch = candidates.slice(0, TICKERS_PER_CRON);
    for (const ticker of batch) {
      await this.backfillTicker(ticker);
    }
  }

  /** Run one ticker immediately (used by tests and the dev endpoint).
   *  Returns true if backfill succeeded. Bypasses the cooldown so the
   *  dev endpoint can force a retry when the user is debugging. */
  async backfillNow(symbol: string): Promise<boolean> {
    const upper = symbol.toUpperCase();
    const tickers = await this.storage.listTickers();
    const ticker = tickers.find((t) => t.ticker === upper);
    if (!ticker) return false;
    const status: BackfillStatus = ticker.backfillStatus ?? "pending";
    if (status === "backfilling") return false;
    // Clear any cooldown before running so the dev endpoint isn't
    // silently no-op'd by a leftover 429.
    await this.storage.updateTicker(upper, { nextBackfillAt: undefined });
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
        // Clear any leftover cooldown so a future failure (e.g. a stale
        // Yahoo response) starts from a clean state.
        nextBackfillAt: undefined,
      });
      // eslint-disable-next-line no-console
      log(
        `[backfill] ${ticker.ticker} OK (${totalBars} bars across ${FREQUENCIES.length} frequencies)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      // RateLimitError gets a long cooldown; everything else (5xx,
      // network, malformed response) gets a short cooldown to avoid a
      // busy-loop within the same tick. The cron tick is 1h away so
      // 30 minutes is just a guardrail against the drain loop.
      const cooldownMs = RateLimitError.is(err)
        ? RATE_LIMIT_COOLDOWN_HOURS * 3_600_000
        : TRANSIENT_COOLDOWN_MINUTES * 60_000;
      const nextBackfillAt = new Date(Date.now() + cooldownMs).toISOString();
      await this.storage.updateTicker(ticker.ticker, {
        backfillStatus: "failed",
        lastBackfillError: message,
        nextBackfillAt,
      });
      // eslint-disable-next-line no-console
      log(
        `[backfill] ${ticker.ticker} FAILED: ${message}` +
          (RateLimitError.is(err)
            ? ` (cooldown ${RATE_LIMIT_COOLDOWN_HOURS}h)`
            : ` (cooldown ${TRANSIENT_COOLDOWN_MINUTES}m)`),
      );
    }
  }
}
