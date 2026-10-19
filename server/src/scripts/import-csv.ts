/**
 * Import CSVs from `data/{TICKER}.csv` into Postgres.
 *
 * Used to land historical bars when the live Yahoo API is rate-limiting
 * us and we have to backfill out-of-band (see data/fetch_via_browser.py
 * for how the CSV is produced). The script:
 *
 *   1. Resolves the tickers to import — either every CSV in `data/`, or
 *      the ones named on the command line.
 *   2. Ensures each ticker is in `tracked_tickers` (adds it if missing).
 *   3. Runs `BackfillService.backfillNow(ticker)` against the CsvProvider,
 *      which calls the existing `storage.upsertBars` path and flips
 *      `backfillStatus` to `ok` with the right timestamps.
 *
 * Usage:
 *   tsx src/scripts/import-csv.ts            # import every data/*.csv
 *   tsx src/scripts/import-csv.ts QQQ VGT    # import specific tickers
 *   tsx src/scripts/import-csv.ts --dry-run  # validate CSVs, no writes
 */

import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CsvProvider } from "../providers/csv.js";
import { BackfillService } from "../services/backfill.js";
import { loadEnv } from "../env.js";
import { createStorage } from "../storage/index.js";

// Resolve the script's own directory once, decoding the URL so paths
// with spaces ("Application%20Support") work on macOS / Linux.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the repo root so DATABASE_URL points at Postgres, not
// the in-memory store. Mirrors what server/src/index.ts does at boot.
loadEnv(path.resolve(HERE, "..", "..", "..", ".env"), {
  override: true,
});

const DATA_DIR = path.resolve(HERE, "..", "..", "..", "data");

interface Args {
  dryRun: boolean;
  tickers: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, tickers: [] };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      out.tickers.push(arg.toUpperCase());
    }
  }
  return out;
}

function discoverCsvTickers(): string[] {
  return readdirSync(DATA_DIR)
    .filter((f) => /^[A-Z0-9.\-:]+\.csv$/i.test(f))
    .map((f) => f.replace(/\.csv$/i, "").toUpperCase())
    .sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tickers = args.tickers.length > 0 ? args.tickers : discoverCsvTickers();
  if (tickers.length === 0) {
    // eslint-disable-next-line no-console
    console.log("no CSVs found in data/ and no tickers passed");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `importing ${tickers.length} ticker(s) from ${DATA_DIR}: ${tickers.join(", ")}` +
      (args.dryRun ? " (dry run)" : ""),
  );

  const storage = createStorage();
  const csvProvider = new CsvProvider({ dataDir: DATA_DIR });

  if (args.dryRun) {
    // Validate the CSVs can be parsed; don't write anything.
    for (const ticker of tickers) {
      try {
        const series = await csvProvider.getHistoricalPrices({ ticker });
        // eslint-disable-next-line no-console
        console.log(
          `  [dry] ${ticker}: ${series.bars.length} bars ${series.startDate} → ${series.endDate}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`  [dry] ${ticker}: FAIL: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    }
    await storage.close?.();
    return;
  }

  const backfill = new BackfillService(storage, csvProvider);

  let ok = 0;
  let failed = 0;
  for (const ticker of tickers) {
    // Make sure the ticker is in tracked_tickers so backfillNow can find
    // it. We don't override an existing row's name/note.
    const existing = (await storage.listTickers()).find((t) => t.ticker === ticker);
    if (!existing) {
      await storage.addTicker({
        ticker,
        lastUpdated: new Date().toISOString(),
        backfillStatus: "pending",
      });
      // eslint-disable-next-line no-console
      console.log(`  added ${ticker} to tracked_tickers`);
    }
    const success = await backfill.backfillNow(ticker);
    if (success) {
      const after = (await storage.listTickers()).find((t) => t.ticker === ticker);
      const series = await csvProvider.getHistoricalPrices({ ticker });
      // eslint-disable-next-line no-console
      console.log(
        `  ✓ ${ticker}: ${series.bars.length} bars ${series.startDate} → ${series.endDate}` +
          ` (lastBackfillAt=${after?.lastBackfillAt})`,
      );
      ok++;
    } else {
      const after = (await storage.listTickers()).find((t) => t.ticker === ticker);
      // eslint-disable-next-line no-console
      console.error(
        `  ✗ ${ticker}: FAILED (status=${after?.backfillStatus}, error=${after?.lastBackfillError})`,
      );
      failed++;
    }
  }
  await storage.close?.();
  // eslint-disable-next-line no-console
  console.log(`\n${ok} ok, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("import-csv failed:", err);
  process.exit(1);
});
