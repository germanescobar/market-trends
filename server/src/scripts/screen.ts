/**
 * Quantitative screen: compute the latest z-score (deviation from the
 * 10-year monthly log-price trend) for every tracked ticker that has
 * CSV-sourced bars, and print them sorted from "most under trend" to
 * "most over trend". The intent is to surface *candidates* — a low
 * z-score is necessary but not sufficient for a buy decision.
 *
 * Run with: cd server && npx tsx src/scripts/screen.ts
 */

import { calculateLogTrendSeries } from "@market-trends/shared";
import * as path from "node:path";
import { loadEnv } from "../env.js";
import { createStorage } from "../storage/index.js";
import type { TrackedTicker } from "@market-trends/shared";

// Load .env from the repo root so DATABASE_URL points at Postgres, not
// the in-memory store. Mirrors what server/src/index.ts does at boot.
loadEnv(path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", ".env"), {
  override: true,
});

interface Row {
  ticker: string;
  status: string;
  bars: number;
  firstDate: string;
  lastDate: string;
  cagr10y: number;
  zScore: number;
  deviationPct: number;
  trendPrice: number;
  actualPrice: number;
}

async function main(): Promise<void> {
  const storage = createStorage();
  const tickers: TrackedTicker[] = await storage.listTickers();
  const frequency = "monthly";

  for (const lookback of [10, 5] as const) {
    // eslint-disable-next-line no-console
    console.log(
      `\n=== ${lookback}Y monthly log-price screen — sorted by z-score ===`,
    );
    // eslint-disable-next-line no-console
    console.log(
      "ticker  | status | CAGR  | z-score | dev   | trend   | actual  | signal",
    );
    // eslint-disable-next-line no-console
    console.log(
      "--------|--------|-------|---------|-------|---------|---------|--------",
    );
    const rows: Row[] = [];

    for (const t of tickers) {
      // Pull daily bars — the regression module resamples to monthly internally.
      const stored = await storage.getBars({ ticker: t.ticker, frequency: "daily" });
      if (!stored || stored.bars.length < 24) continue;
      const series_result = calculateLogTrendSeries(
        {
          ticker: stored.ticker,
          bars: stored.bars,
          startDate: stored.startDate,
          endDate: stored.endDate,
          source: stored.sources[0] ?? "unknown",
          frequency: "daily",
        },
        lookback,
        frequency,
      );
      if (series_result.points.length < 12) continue;
      const last = series_result.points[series_result.points.length - 1]!;
      rows.push({
        ticker: t.ticker,
        status: t.backfillStatus ?? "unknown",
        bars: stored.bars.length,
        firstDate: stored.startDate,
        lastDate: stored.endDate,
        cagr10y: series_result.annualizedCagr,
        zScore: last.zScore,
        deviationPct: (last.actual - last.trend) / last.trend,
        trendPrice: last.trend,
        actualPrice: last.actual,
      });
    }

  rows.sort((a, b) => a.zScore - b.zScore);
    for (const r of rows) {
      const signal =
        r.zScore < -1.5
          ? "deeply under trend"
          : r.zScore < -0.5
            ? "under trend"
            : r.zScore > 1.5
              ? "deeply over trend"
              : r.zScore > 0.5
                ? "over trend"
                : "near trend";
      // eslint-disable-next-line no-console
      console.log(
        `${r.ticker.padEnd(7)} | ${r.status.padEnd(6)} | ${(r.cagr10y * 100).toFixed(1).padStart(5)}% | ${r.zScore.toFixed(2).padStart(7)} | ${(r.deviationPct * 100).toFixed(1).padStart(5)}% | ${r.trendPrice.toFixed(2).padStart(7)} | ${r.actualPrice.toFixed(2).padStart(7)} | ${signal}`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log(
    "Reminder: z-score is one input. A low z-score in a long-running bear market may be a value trap, not a buy. Pair with fundamentals and a forward view of the underlying economy/asset class.",
  );
  await storage.close?.();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("screen failed:", err);
  process.exit(1);
});
