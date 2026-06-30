import type { MarketDataProvider } from "@market-trends/shared";
import { createStubProvider } from "@market-trends/shared";
import { AlphaVantageProvider } from "./alphavantage.js";
import { EtoroProvider } from "./etoro.js";
import { YahooFinanceProvider } from "./yahoo.js";

export type ProviderKind = "yahoo" | "etoro" | "alphavantage" | "stub";

interface CreateProviderOptions {
  kind: ProviderKind;
}

/**
 * Build a provider of a specific kind. The server uses this to instantiate
 * three separate provider instances (one per cron service) so each can
 * have its own auth state, caching, and rate-limit behavior.
 *
 * The historical-only `kind` parameter overrides the legacy
 * `MARKET_DATA_PROVIDER` env var. When `kind` is omitted, the env var
 * picks a default for backward compatibility with one-off scripts.
 */
export function createProvider(options?: CreateProviderOptions): MarketDataProvider {
  const kind = options?.kind ?? (process.env.MARKET_DATA_PROVIDER ?? "yahoo").toLowerCase();
  switch (kind) {
    case "yahoo":
      return new YahooFinanceProvider();
    case "etoro":
      return new EtoroProvider({
        apiKey: process.env.ETORO_API_KEY ?? "",
        userKey: process.env.ETORO_USER_KEY ?? "",
      });
    case "alphavantage":
      return new AlphaVantageProvider({
        apiKey: process.env.ALPHAVANTAGE_API_KEY ?? "",
      });
    case "stub":
      return createStubProvider({
        drift: 0.08,
        volatility: 0.2,
        startPrice: 100,
      });
    default:
      // eslint-disable-next-line no-console
      console.warn(`[provider] unknown kind=${kind}, falling back to yahoo`);
      return new YahooFinanceProvider();
  }
}