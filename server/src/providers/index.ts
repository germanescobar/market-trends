import type { MarketDataProvider } from "@market-trends/shared";
import { createStubProvider } from "@market-trends/shared";
import { AlphaVantageProvider } from "./alphavantage.js";
import { EtoroProvider } from "./etoro.js";
import { YahooFinanceProvider } from "./yahoo.js";

/** Build a provider based on env. */
export function createProvider(): MarketDataProvider {
  const which = (process.env.MARKET_DATA_PROVIDER ?? "yahoo").toLowerCase();
  switch (which) {
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
      console.warn(`[provider] unknown MARKET_DATA_PROVIDER=${which}, falling back to yahoo`);
      return new YahooFinanceProvider();
  }
}
