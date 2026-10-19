import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
  type LookbackYears,
  type PriceFrequency,
} from "@market-trends/shared";
import type { AnalyticsService } from "./analytics.js";
import type { Storage } from "./storage/types.js";

interface Deps {
  storage: Storage;
  analytics: AnalyticsService;
  backfill?: {
    /** Trigger a backfill for one ticker immediately. Returns true if
     *  the ticker's status flipped to "ok" after the call. */
    backfillNow(symbol: string): Promise<boolean>;
  };
  refresh?: {
    /** Refresh one ticker immediately using the recent-data provider. */
    refreshNow(symbol: string): Promise<boolean>;
  };
}

const LOOKBACKS: LookbackYears[] = [5, 10, 15, 20, "max"];

function parseLookback(raw: string | undefined): LookbackYears {
  if (!raw) return 10;
  if (raw === "max") return "max";
  const n = Number(raw);
  if (LOOKBACKS.includes(n as LookbackYears)) return n as LookbackYears;
  return 10;
}

function parseFrequency(raw: string | undefined): PriceFrequency {
  if (raw === "daily" || raw === "weekly" || raw === "monthly") return raw;
  return "monthly";
}

export function buildApp({ storage, analytics, backfill, refresh }: Deps) {
  const app = new Hono();

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/api/health", (c) => c.json({ status: "ok", asOf: new Date().toISOString() }));

  // ---- Tracked tickers ----
  app.get("/api/tickers", async (c) => {
    const tickers = await storage.listTickers();
    return c.json({ tickers });
  });

  app.post("/api/tickers", async (c) => {
    const body = await c.req.json<{ ticker?: string; name?: string; note?: string }>();
    if (!body.ticker || typeof body.ticker !== "string") {
      return c.json({ error: "ticker is required" }, 400);
    }
    const ticker = body.ticker.toUpperCase().trim();
    if (!/^[A-Z0-9.\-:=]{1,16}$/.test(ticker)) {
      return c.json({ error: "invalid ticker symbol" }, 400);
    }
    const created = await storage.addTicker({
      ticker,
      name: body.name,
      note: body.note,
      lastUpdated: new Date().toISOString(),
    });
    return c.json(created, 201);
  });

  app.delete("/api/tickers/:ticker", async (c) => {
    await storage.removeTicker(c.req.param("ticker"));
    return c.json({ ok: true });
  });

  app.patch("/api/tickers/:ticker", async (c) => {
    const patch = await c.req.json<{ name?: string; note?: string }>();
    const next = await storage.updateTicker(c.req.param("ticker"), patch);
    if (!next) return c.json({ error: "not found" }, 404);
    return c.json(next);
  });

  // ---- Single ticker snapshot ----
  app.get("/api/tickers/:ticker/snapshot", async (c) => {
    const ticker = c.req.param("ticker").toUpperCase();
    const lookback = parseLookback(c.req.query("lookback"));
    const frequency = parseFrequency(c.req.query("frequency"));
    try {
      const snap = await analytics.getSnapshot(ticker, { lookback, frequency });
      // Mark as refreshed.
      await storage.updateTicker(ticker, { lastUpdated: snap.asOf });
      return c.json(snap);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return c.json({ error: message }, 502);
    }
  });

  // ---- Chart series ----
  app.get("/api/tickers/:ticker/series", async (c) => {
    const ticker = c.req.param("ticker").toUpperCase();
    const lookback = parseLookback(c.req.query("lookback"));
    const frequency = parseFrequency(c.req.query("frequency"));
    try {
      const series = await analytics.getSeriesForChart(ticker, lookback, frequency);
      return c.json(series);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return c.json({ error: message }, 502);
    }
  });

  // ---- Quote ----
  app.get("/api/tickers/:ticker/quote", async (c) => {
    const ticker = c.req.param("ticker").toUpperCase();
    const quote = await storage.getLastQuote(ticker);
    if (!quote) {
      return c.json(
        { error: "No quote available yet — backfill or refresh is in progress." },
        404,
      );
    }
    return c.json(quote);
  });

  // ---- Comparison table for several tickers ----
  app.get("/api/compare", async (c) => {
    const raw = c.req.query("tickers") ?? "";
    const tickers = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (tickers.length === 0) {
      return c.json({ error: "tickers query param required" }, 400);
    }
    const lookback = parseLookback(c.req.query("lookback"));
    const frequency = parseFrequency(c.req.query("frequency"));
    const rows = await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const snap = await analytics.getSnapshot(ticker, { lookback, frequency });
          return { ticker, snapshot: snap };
        } catch (err) {
          return {
            ticker,
            error: err instanceof Error ? err.message : "unknown error",
          };
        }
      }),
    );
    return c.json({ rows });
  });

  // ---- Dev endpoints: trigger backfill / refresh on demand ----
  // These are useful for local development when you don't want to wait
  // for the cron schedule. In production they should be gated by an
  // admin auth check; for now they're open because the project is dev.
  app.post("/api/dev/backfill/:ticker", async (c) => {
    if (!backfill) return c.json({ error: "backfill service not wired" }, 503);
    const ok = await backfill.backfillNow(c.req.param("ticker"));
    return c.json({ ok });
  });

  app.post("/api/dev/refresh/:ticker", async (c) => {
    if (!refresh) return c.json({ error: "refresh service not wired" }, 503);
    const ok = await refresh.refreshNow(c.req.param("ticker"));
    return c.json({ ok });
  });

  return app;
}
