/**
 * Thin API client wrapping the Hono backend. All routes use `/api` as the
 * base path; in dev Vite proxies these to the server (see vite.config.ts).
 */
import type {
  BacktestInput,
  BacktestResult,
  BacktestStrategy,
  LogTrendSeries,
  LookbackYears,
  PriceFrequency,
  Quote,
  TickerSnapshot,
  TrackedTicker,
} from "@market-trends/shared";

const BASE = "/api";

async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // ignore parse error
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => jsonFetch<{ status: string; asOf: string }>(`${BASE}/health`),

  tickers: {
    list: () =>
      jsonFetch<{ tickers: TrackedTicker[] }>(`${BASE}/tickers`),
    add: (input: { ticker: string; name?: string; note?: string }) =>
      jsonFetch<TrackedTicker>(`${BASE}/tickers`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    remove: (ticker: string) =>
      jsonFetch<{ ok: true }>(`${BASE}/tickers/${encodeURIComponent(ticker)}`, {
        method: "DELETE",
      }),
    update: (ticker: string, patch: Partial<TrackedTicker>) =>
      jsonFetch<TrackedTicker>(`${BASE}/tickers/${encodeURIComponent(ticker)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
  },

  snapshot: (
    ticker: string,
    options: { lookback?: LookbackYears; frequency?: PriceFrequency } = {},
  ) => {
    const qs = new URLSearchParams();
    if (options.lookback != null) qs.set("lookback", String(options.lookback));
    if (options.frequency) qs.set("frequency", options.frequency);
    return jsonFetch<TickerSnapshot>(
      `${BASE}/tickers/${encodeURIComponent(ticker)}/snapshot?${qs.toString()}`,
    );
  },

  series: (
    ticker: string,
    options: { lookback?: LookbackYears; frequency?: PriceFrequency } = {},
  ) => {
    const qs = new URLSearchParams();
    if (options.lookback != null) qs.set("lookback", String(options.lookback));
    if (options.frequency) qs.set("frequency", options.frequency);
    return jsonFetch<LogTrendSeries>(
      `${BASE}/tickers/${encodeURIComponent(ticker)}/series?${qs.toString()}`,
    );
  },

  quote: (ticker: string) =>
    jsonFetch<Quote>(`${BASE}/tickers/${encodeURIComponent(ticker)}/quote`),

  compare: (tickers: string[], options: { lookback?: LookbackYears; frequency?: PriceFrequency } = {}) => {
    const qs = new URLSearchParams();
    qs.set("tickers", tickers.join(","));
    if (options.lookback != null) qs.set("lookback", String(options.lookback));
    if (options.frequency) qs.set("frequency", options.frequency);
    return jsonFetch<{ rows: Array<{ ticker: string; snapshot?: TickerSnapshot; error?: string }> }>(
      `${BASE}/compare?${qs.toString()}`,
    );
  },

  backtest: (input: BacktestInput & { strategy: BacktestStrategy }) =>
    jsonFetch<BacktestResult>(`${BASE}/backtest`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
