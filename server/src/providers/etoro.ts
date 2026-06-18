/**
 * eToro market data provider.
 *
 * eToro uses numeric instrument IDs for market-data endpoints, so ticker
 * symbols are resolved once via the instrument endpoint and cached for
 * subsequent calls.
 * Historical candles are raw close prices; eToro does not document them as
 * split/dividend-adjusted, so `adjustedClose` mirrors `close`.
 */

import {
  type GetHistoricalPricesParams,
  type MarketDataProvider,
  type PriceBar,
  type PriceFrequency,
  type PriceSeries,
  type Quote,
} from "@market-trends/shared";
import { randomUUID } from "node:crypto";

const BASE_URL = "https://public-api.etoro.com/api/v1";
const DEFAULT_DAILY_CANDLES = 1000;
const DEFAULT_WEEKLY_CANDLES = 1000;

interface EtoroProviderOptions {
  apiKey: string;
  userKey: string;
}

interface EtoroInstrument {
  instrumentId?: number;
  displayname?: string;
  symbol?: string;
  isDelisted?: boolean;
  isCurrentlyTradable?: boolean;
}

interface RatesResponse {
  rates?: EtoroRate[];
}

interface EtoroRate {
  instrumentID?: number;
  instrumentId?: number;
  ask?: number;
  bid?: number;
  lastExecution?: number;
  date?: string;
}

interface CandlesResponse {
  candles?: Array<{
    instrumentId?: number;
    candles?: EtoroCandle[];
  }>;
}

interface EtoroCandle {
  fromDate?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

interface ResolvedInstrument {
  id: number;
  ticker: string;
  name?: string;
}

export class EtoroProvider implements MarketDataProvider {
  readonly name = "etoro";

  private readonly instrumentCache = new Map<string, ResolvedInstrument>();

  constructor(private readonly options: EtoroProviderOptions) {
    if (!options.apiKey || !options.userKey) {
      throw new Error("ETORO_API_KEY and ETORO_USER_KEY are required for MARKET_DATA_PROVIDER=etoro");
    }
  }

  async getHistoricalPrices({
    ticker,
    frequency = "daily",
    startDate,
    endDate,
  }: GetHistoricalPricesParams): Promise<PriceSeries> {
    const instrument = await this.resolveInstrument(ticker);
    const candleFrequency = toEtoroCandleFrequency(frequency);
    const count = calculateCandleCount(candleFrequency.frequency, startDate, endDate);
    const json = await this.request<CandlesResponse>(
      `/market-data/instruments/${instrument.id}/history/candles/asc/${candleFrequency.interval}/${count}`,
    );
    const candles = json.candles?.flatMap((group) => group.candles ?? []) ?? [];
    const bars = candles
      .map((candle): PriceBar | undefined => {
        const close = pickNumber(candle.close);
        if (close === undefined || !candle.fromDate) return undefined;
        const date = candle.fromDate.slice(0, 10);
        if (startDate && date < startDate) return undefined;
        if (endDate && date > endDate) return undefined;
        return {
          date,
          close,
          adjustedClose: close,
          high: pickNumber(candle.high),
          low: pickNumber(candle.low),
          volume: pickNumber(candle.volume),
        };
      })
      .filter((bar): bar is PriceBar => bar !== undefined)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (bars.length === 0) {
      throw new Error(`eToro returned no candles for ${instrument.ticker}`);
    }

    const first = bars[0]!;
    const last = bars[bars.length - 1]!;
    return {
      ticker: instrument.ticker,
      bars,
      startDate: first.date,
      endDate: last.date,
      source: this.name,
      frequency: candleFrequency.frequency,
    };
  }

  async getQuote(ticker: string): Promise<Quote> {
    const instrument = await this.resolveInstrument(ticker);
    const qs = new URLSearchParams({ instrumentIds: String(instrument.id) });
    const json = await this.request<RatesResponse>(`/market-data/instruments/rates?${qs.toString()}`);
    const rate = json.rates?.find((item) => getRateInstrumentId(item) === instrument.id);
    if (!rate) {
      throw new Error(`eToro returned no quote for ${instrument.ticker}`);
    }
    const price = pickNumber(rate.lastExecution) ?? midpoint(rate.bid, rate.ask);
    if (price === undefined) {
      throw new Error(`eToro quote for ${instrument.ticker} did not include a usable price`);
    }
    return {
      ticker: instrument.ticker,
      price,
      currency: "USD",
      asOf: rate.date ? new Date(rate.date).toISOString() : new Date().toISOString(),
    };
  }

  async getName(ticker: string): Promise<string | undefined> {
    const instrument = await this.resolveInstrument(ticker);
    return instrument.name;
  }

  private async resolveInstrument(ticker: string): Promise<ResolvedInstrument> {
    const normalized = normalizeTicker(ticker);
    const cached = this.instrumentCache.get(normalized);
    if (cached) return cached;

    const qs = new URLSearchParams({
      fields: [
        "instrumentId",
        "displayname",
        "symbol",
        "isDelisted",
        "isCurrentlyTradable",
      ].join(","),
    });
    const instrument = await this.request<EtoroInstrument>(
      `/instruments/${encodeURIComponent(normalized)}?${qs.toString()}`,
    );
    if (instrument.isDelisted || typeof instrument.instrumentId !== "number") {
      throw new Error(`Could not resolve ${normalized} to an eToro instrument`);
    }

    const resolved = {
      id: instrument.instrumentId,
      ticker: normalized,
      name: instrument.displayname,
    };
    this.instrumentCache.set(normalized, resolved);
    return resolved;
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        "x-api-key": this.options.apiKey,
        "x-user-key": this.options.userKey,
        "x-request-id": randomUUID(),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      const details = text ? `: ${text.slice(0, 300)}` : "";
      throw new Error(`eToro request failed (${res.status}) for ${path}${details}`);
    }
    return (await res.json()) as T;
  }
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function toEtoroCandleFrequency(frequency: PriceFrequency): {
  frequency: PriceFrequency;
  interval: "OneDay" | "OneWeek";
} {
  if (frequency === "daily") return { frequency: "daily", interval: "OneDay" };
  return { frequency: "weekly", interval: "OneWeek" };
}

function calculateCandleCount(
  frequency: PriceFrequency,
  startDate?: string,
  endDate?: string,
): number {
  const fallback = frequency === "daily" ? DEFAULT_DAILY_CANDLES : DEFAULT_WEEKLY_CANDLES;
  if (!startDate) return fallback;
  const start = Date.parse(startDate);
  const end = endDate ? Date.parse(endDate) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fallback;
  const days = Math.ceil((end - start) / 86_400_000) + 10;
  const bars = frequency === "daily" ? days : Math.ceil(days / 7) + 2;
  return Math.min(Math.max(bars, 1), fallback);
}

function getRateInstrumentId(rate: EtoroRate): number | undefined {
  return rate.instrumentID ?? rate.instrumentId;
}

function midpoint(bid: number | undefined, ask: number | undefined): number | undefined {
  if (bid === undefined || ask === undefined) return undefined;
  return (bid + ask) / 2;
}

function pickNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
