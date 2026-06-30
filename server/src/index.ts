import { serve } from "@hono/node-server";
import { AnalyticsService } from "./analytics.js";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createProvider } from "./providers/index.js";
import { BackfillService } from "./services/backfill.js";
import { QuoteService } from "./services/quote.js";
import { RefreshService } from "./services/refresh.js";
import { createStorage } from "./storage/index.js";

// Load .env from the repo root, overriding any pre-existing shell values.
// This makes the local-dev story predictable even when the user's shell
// exports unrelated variables like PORT.
loadEnv("../.env", { override: true });

const port = Number(process.env.PORT ?? 8987);

const storage = createStorage();

// Three independent providers, one for each cron service. They are
// independent because each service has a different cost model:
// - Yahoo is rate-limited (≈ 100/hr) and reserved for deep backfills.
// - eToro is generous (≈ 600/min) and used for refresh + quotes.
// - Alpha Vantage is too thin (100 days free) for backfill but works
//   for last-14-days refresh as a fallback when eToro is down.
const yahoo = createProvider({ kind: "yahoo" });
const etoro = createProvider({ kind: "etoro" });
const alphaVantage = createProvider({ kind: "alphavantage" });

const analytics = new AnalyticsService(storage, {
  defaultFrequency: "monthly",
  storage,
});

const app = buildApp({
  storage,
  analytics,
  backfill: { backfillNow: (s) => backfill.backfillNow(s) },
  refresh: { refreshNow: (s) => refresh.refreshNow(s) },
});

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${info.port}`);
});

// Wire the data pipeline. Each service runs in-process; `node-cron`
// keeps them alive while the server is running. They share no state
// other than the storage layer, so a failure in one does not affect
// the others.
// Yahoo is reserved for backfill because it gives the deepest free
// history (decades for stocks, ~12 years for crypto). eToro handles
// refresh + quote; Alpha Vantage is a thin fallback for refresh.
const backfill = new BackfillService(storage, yahoo);
const refresh = new RefreshService(storage, etoro, alphaVantage);
const quotes = new QuoteService(storage, etoro);

backfill.start();
refresh.start();
quotes.start();

// Graceful shutdown: stop the crons and close the storage pool so the
// process doesn't hang on Postgres connections during a restart.
const shutdown = async (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`[server] received ${signal}, shutting down`);
  backfill.stop();
  refresh.stop();
  quotes.stop();
  await storage.close?.();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));