/**
 * RefreshService: keeps the right edge of each ticker's stored series
 * fresh. Runs on a tighter cadence than backfill (every 15 min) and
 * asks the recent-data provider (eToro) for the last 14 days of bars.
 * Falls back to Alpha Vantage if eToro fails for a ticker.
 *
 * Why "last 14 days": refresh needs only enough to cover weekends and
 * long weekends; 14 days gives us 2 weeks of slack against the cron
 * missing a tick. We deliberately do NOT use Yahoo here — Yahoo is
 * rate-limited and we want to reserve its budget for backfills.
 *
 * Skips tickers whose bars are already fresh (< REFRESH_SKIP_HOURS
 * old), so a stable market doesn't burn through eToro quota.
 */

import { schedule as cronSchedule, type ScheduledTask } from "node-cron";
import type {
  MarketDataProvider,
  PriceFrequency,
  TrackedTicker,
} from "@market-trends/shared";
import type { Storage } from "../storage/types.js";

const REFRESH_CRON = "*/15 * * * *"; // every 15 minutes
const REFRESH_SKIP_HOURS = 12;
const REFRESH_WINDOW_DAYS = 14;
const FREQUENCIES: PriceFrequency[] = ["daily"];

export class RefreshService {
  private task: ScheduledTask | null = null;

  constructor(
    private storage: Storage,
    /** Primary: eToro. Best free history for recent bars + graceful under load. */
    private primary: MarketDataProvider,
    /** Fallback: Alpha Vantage. Free tier is too thin for backfill but
     *  fine for a last-14-days refresh. */
    private fallback: MarketDataProvider | null,
  ) {}

  start(): void {
    if (this.task) return;
    this.task = cronSchedule(REFRESH_CRON, () => {
      void this.tick().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[refresh] tick failed", err);
      });
    });
    // eslint-disable-next-line no-console
    console.log(`[refresh] scheduled '${REFRESH_CRON}' (primary=${this.primary.name}, fallback=${this.fallback?.name ?? "none"})`);
    void this.tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[refresh] initial tick failed", err);
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async tick(): Promise<void> {
    const tickers = await this.storage.listTickers();
    // Only refresh tickers that have already been backfilled successfully.
    // Pending tickers are still in flight; failed tickers will retry on
    // the next backfill pass.
    const ready = tickers.filter((t: TrackedTicker) => t.backfillStatus === "ok");
    for (const ticker of ready) {
      if (await this.isFresh(ticker.ticker)) continue;
      await this.refreshTicker(ticker);
    }
  }

  /** Refresh one ticker on demand, bypassing the freshness check. Used
   *  by the dev endpoint to force a re-fetch even for tickers whose
   *  bars are recent. */
  async refreshNow(symbol: string): Promise<boolean> {
    const tickers = await this.storage.listTickers();
    const ticker = tickers.find((t) => t.ticker === symbol.toUpperCase());
    if (!ticker || ticker.backfillStatus !== "ok") return false;
    await this.refreshTicker(ticker);
    return true;
  }

  private async isFresh(ticker: string): Promise<boolean> {
    const latest = await this.storage.getLatestFetchedAt(ticker, "daily");
    if (!latest) return false;
    const ageMs = Date.now() - Date.parse(latest);
    return Number.isFinite(ageMs) && ageMs < REFRESH_SKIP_HOURS * 3_600_000;
  }

  private async refreshTicker(ticker: TrackedTicker): Promise<void> {
    const startDate = new Date(
      Date.now() - REFRESH_WINDOW_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    // Try primary; fall back to Alpha Vantage on failure. We do NOT
    // retry inside the tick — the next cron run will retry.
    let provider = this.primary;
    let series;
    try {
      for (const frequency of FREQUENCIES) {
        series = await provider.getHistoricalPrices({
          ticker: ticker.ticker,
          frequency,
          startDate,
        });
        if (series.bars.length > 0) {
          await this.storage.upsertBars({
            ticker: ticker.ticker,
            frequency,
            sourceProvider: provider.name,
            bars: series.bars,
          });
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[refresh] ${ticker.ticker} OK via ${provider.name} (${series?.bars.length ?? 0} bars)`);
    } catch (err) {
      if (this.fallback && this.fallback.name !== provider.name) {
        const message = err instanceof Error ? err.message : "unknown error";
        // eslint-disable-next-line no-console
        console.warn(`[refresh] ${ticker.ticker} primary failed (${message}); trying ${this.fallback.name}`);
        try {
          for (const frequency of FREQUENCIES) {
            const fallbackSeries = await this.fallback.getHistoricalPrices({
              ticker: ticker.ticker,
              frequency,
              startDate,
            });
            if (fallbackSeries.bars.length > 0) {
              await this.storage.upsertBars({
                ticker: ticker.ticker,
                frequency,
                sourceProvider: this.fallback.name,
                bars: fallbackSeries.bars,
              });
            }
          }
          // eslint-disable-next-line no-console
          console.log(`[refresh] ${ticker.ticker} OK via fallback ${this.fallback.name}`);
        } catch (fallbackErr) {
          const fbMessage = fallbackErr instanceof Error ? fallbackErr.message : "unknown error";
          // eslint-disable-next-line no-console
          console.warn(`[refresh] ${ticker.ticker} FAILED: primary: ${message}; fallback: ${fbMessage}`);
        }
      } else {
        const message = err instanceof Error ? err.message : "unknown error";
        // eslint-disable-next-line no-console
        console.warn(`[refresh] ${ticker.ticker} FAILED: ${message}`);
      }
    }
  }
}