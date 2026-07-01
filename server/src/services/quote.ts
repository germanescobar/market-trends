/**
 * QuoteService: keeps a per-ticker "last quote" row in storage. The
 * dashboard reads from this row rather than calling a provider per
 * dashboard load, so provider rate limits never affect UI latency.
 *
 * Cadence: every 5 minutes. eToro's generous free tier (≈ 600 req/min)
 * comfortably handles one call per ticker every 5 min for an 8-ticker
 * portfolio.
 */

import { schedule as cronSchedule, type ScheduledTask } from "node-cron";
import type { LastQuote, MarketDataProvider, TrackedTicker } from "@market-trends/shared";
import type { Storage } from "../storage/types.js";
import { log } from "./logger.js";

const QUOTE_CRON = "*/5 * * * *"; // every 5 minutes

export class QuoteService {
  private task: ScheduledTask | null = null;

  constructor(
    private storage: Storage,
    private provider: MarketDataProvider,
  ) {}

  start(): void {
    if (this.task) return;
    this.task = cronSchedule(QUOTE_CRON, () => {
      void this.tick().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[quote] tick failed", err);
      });
    });
    // eslint-disable-next-line no-console
    console.error(`[quote] scheduled '${QUOTE_CRON}' using provider '${this.provider.name}'`);
    void this.tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[quote] initial tick failed", err);
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async tick(): Promise<void> {
    const tickers = await this.storage.listTickers();
    // Quote every ticker except those whose backfill is already in
    // flight. We deliberately do this for `pending` and `failed`
    // tickers too: the user added the ticker to *see* the price, and
    // a 429 on the historical backfill shouldn't also mean no
    // current price. The current price lives independently of the
    // historical series, so we can populate it whenever eToro is up.
    const ready = tickers.filter((t: TrackedTicker) => {
      const status = t.backfillStatus ?? "pending";
      return status !== "backfilling";
    });
    for (const ticker of ready) {
      await this.refreshOne(ticker);
    }
  }

  private async refreshOne(ticker: TrackedTicker): Promise<void> {
    try {
      const quote = await this.provider.getQuote(ticker.ticker);
      const row: LastQuote = {
        ticker: quote.ticker.toUpperCase(),
        price: quote.price,
        currency: quote.currency,
        asOf: quote.asOf,
        source: this.provider.name,
        fetchedAt: new Date().toISOString(),
      };
      await this.storage.upsertLastQuote(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown message";
      // eslint-disable-next-line no-console
      log(`[quote] ${ticker.ticker} FAILED: ${message}`);
    }
  }
}