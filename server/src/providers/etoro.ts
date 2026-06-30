/**
 * eToro market data provider.
 *
 * eToro uses numeric instrument IDs for market-data endpoints, so ticker
 * symbols are resolved once via the search endpoint and cached for
 * subsequent calls. The lookup uses `GET /market-data/search` with the
 * `internalSymbolFull` parameter (per the official docs at
 * https://api-portal.etoro.com/); the `text` parameter is ignored by the
 * server and returns a paginated catalog regardless of the query.
 *
 * IMPORTANT — raw `bid`/`ask` and `lastExecution` are NOT in USD for
 * crypto. They are denominated in an internal unit (likely sats for
 * BTC/ETH) and must be multiplied by `conversionRateBid` /
 * `conversionRateAsk` to get USD. Stocks/ETFs return conversionRate ≈ 1.0,
 * so the same formula is correct for them too.
 *
 * USD-base FX (USDCOP, USDJPY, USDCHF, ...) is a special case: the raw
 * `bid` already represents quote-currency-per-USD (e.g. 3475 COP), and
 * `bid × conversionRateBid ≈ 1.0` (since the "underlying" is USD itself).
 * We detect this and report the raw `bid` with the quote currency so the
 * UI can show meaningful FX rates instead of "$1.00".
 *
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

// Shape of items returned by `/market-data/search` with `internalSymbolFull`.
// At minimum, each row carries `instrumentId`; the other fields arrive when
// requested via the `fields` param. We keep them optional because the docs
// do not guarantee a stable shape across versions.
interface EtoroSearchItem {
  instrumentId?: number;
  internalSymbolFull?: string;
  displayname?: string;
  instrumentTypeId?: number;
}

interface SearchResponse {
  items?: EtoroSearchItem[];
}

interface RatesResponse {
  rates?: EtoroRate[];
}

interface EtoroRate {
  instrumentID?: number;
  instrumentId?: number;
  ask?: number;
  bid?: number;
  // Conversion factor for crypto (raw bid/ask are in an internal unit,
  // typically sats; multiply by these to get USD). Stocks/ETFs return ~1.0.
  conversionRateAsk?: number;
  conversionRateBid?: number;
  lastExecution?: number;
  date?: string;
  // Symbol of the instrument this rate belongs to. Attached by the
  // provider so the price-interpretation helper can detect FX pairs.
  symbol?: string;
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
    const [json, rate] = await Promise.all([
      this.request<CandlesResponse>(
        `/market-data/instruments/${instrument.id}/history/candles/asc/${candleFrequency.interval}/${count}`,
      ),
      this.fetchRate(instrument.id, instrument.ticker),
    ]);
    // Decide how to interpret the OHLC values. For crypto, eToro's candle
    // close/high/low are in the same internal unit as the live rates
    // (sats for BTC/ETH) and need the spot conversion rate applied as a
    // constant multiplier. For USD-base FX the raw values are already in
    // the quote currency (e.g. COP), so no conversion is applied. Stocks
    // have conversionRate ≈ 1.0, which is also a no-op.
    const ctx = rate ? priceContext(rate) : { multiplier: 1, currency: "USD" };
    const candles = json.candles?.flatMap((group) => group.candles ?? []) ?? [];
    const bars: PriceBar[] = [];
    for (const candle of candles) {
      const rawClose = pickNumber(candle.close);
      if (rawClose === undefined || !candle.fromDate) continue;
      const date = candle.fromDate.slice(0, 10);
      if (startDate && date < startDate) continue;
      if (endDate && date > endDate) continue;
      const close = rawClose * ctx.multiplier;
      const rawHigh = pickNumber(candle.high);
      const rawLow = pickNumber(candle.low);
      const high = rawHigh !== undefined ? rawHigh * ctx.multiplier : undefined;
      const low = rawLow !== undefined ? rawLow * ctx.multiplier : undefined;
      // Drop bars whose OHLC relationship is invalid (close outside
      // [low, high]). eToro's historical feed has been observed to return
      // corrupt candles for BTC in 2018-02 to 2018-08 where H/L and C are
      // inconsistent — the regression then produces nonsense bands. A
      // missing `high` or `low` is treated as invalid here; if we ever
      // want to allow partial bars, this check can be relaxed.
      if (
        high === undefined ||
        low === undefined ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        close < low - 0.01 ||
        close > high + 0.01
      ) {
        continue;
      }
      bars.push({
        date,
        close,
        adjustedClose: close,
        high,
        low,
        volume: pickNumber(candle.volume),
      });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));

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
    const rate = await this.fetchRate(instrument.id, instrument.ticker);
    if (!rate) {
      throw new Error(`eToro returned no quote for ${instrument.ticker}`);
    }
    const ctx = priceContext(rate);
    const price = ctx.price;
    if (price === undefined) {
      throw new Error(`eToro quote for ${instrument.ticker} did not include a usable price`);
    }
    return {
      ticker: instrument.ticker,
      price,
      currency: ctx.currency,
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

    // `internalSymbolFull` is the documented lookup parameter; `text` is
    // ignored by the server (it returns a paginated catalog regardless of
    // the value). The `fields` param asks for the metadata we care about.
    const qs = new URLSearchParams({
      internalSymbolFull: normalized,
      fields: "instrumentId,internalSymbolFull,displayname,instrumentTypeId",
    });
    const search = await this.request<SearchResponse>(
      `/market-data/search?${qs.toString()}`,
    );
    const items = search.items ?? [];
    const first = items.find((item) => typeof item.instrumentId === "number");
    if (!first || typeof first.instrumentId !== "number") {
      throw new Error(`Could not resolve ${normalized} via eToro search`);
    }

    const resolved: ResolvedInstrument = {
      id: first.instrumentId,
      ticker: normalized,
      name: first.displayname,
    };
    this.instrumentCache.set(normalized, resolved);
    return resolved;
  }

  private async fetchRate(
    instrumentId: number,
    symbol?: string,
  ): Promise<EtoroRate | undefined> {
    const qs = new URLSearchParams({ instrumentIds: String(instrumentId) });
    const json = await this.request<RatesResponse>(
      `/market-data/instruments/rates?${qs.toString()}`,
    );
    const rate = json.rates?.find((item) => getRateInstrumentId(item) === instrumentId);
    if (rate && symbol) rate.symbol = symbol;
    return rate;
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

/**
 * Interpretation of a live rate, used by both `getQuote` and the candle
 * multiplier in `getHistoricalPrices`. Three cases:
 *
 * 1. USD-base FX (e.g. USDCOP): `bid × conversionRateBid ≈ 1.0` because
 *    the instrument's underlying is USD itself. Return the raw `bid` in the
 *    parsed quote currency (COP) so the UI shows a meaningful FX rate like
 *    "3475 COP per USD" instead of "$1.00". No multiplier applied to candles.
 *
 * 2. Crypto (e.g. BTC): `bid × conversionRateBid ≈ 59000`. The raw values
 *    are in an internal unit (sats); the conversion rate is applied to
 *    land in USD. multiplier = conversionRateBid.
 *
 * 3. Stocks / ETFs / non-USD-base FX (e.g. AAPL, EURUSD): conversion rate
 *    ≈ 1.0 and the raw values are already USD. multiplier = 1.
 *
 * The threshold for case 1 is generous (0.5..1.5) so normal FX spread does
 * not push a USD-base pair back into case 2/3.
 */
interface PriceContext {
  price?: number;
  multiplier: number;
  currency: string;
}

const FX_UNIT_THRESHOLD = 0.5; // |bid × convBid - 1| < FX_UNIT_THRESHOLD → USD-base FX

function priceContext(rate: EtoroRate): PriceContext {
  const bid = rate.bid;
  const ask = rate.ask;
  const convBid = rate.conversionRateBid ?? 1;
  const convAsk = rate.conversionRateAsk ?? 1;

  if (bid === undefined) return { multiplier: convBid, currency: "USD" };

  const impliedUsd = bid * convBid;
  if (Math.abs(impliedUsd - 1) < FX_UNIT_THRESHOLD) {
    // USD-base FX: report raw bid in the quote currency parsed from the
    // symbol suffix; candles are already in the quote currency, so the
    // multiplier is 1.
    const sym = (rate.symbol ?? "").toUpperCase();
    return {
      price: bid,
      multiplier: 1,
      currency: fxQuoteCurrency(sym),
    };
  }

  if (bid === undefined || ask === undefined) return { multiplier: convBid, currency: "USD" };
  const bidUsd = bid * convBid;
  const askUsd = ask * convAsk;
  return {
    price: (bidUsd + askUsd) / 2,
    multiplier: convBid,
    currency: "USD",
  };
}

/**
 * Extract the quote currency from an eToro symbol that follows the FX
 * convention `BASEQUOTE` (both 3 letters). Falls back to "USD" when the
 * symbol doesn't look like an FX pair.
 */
function fxQuoteCurrency(symbol: string): string {
  if (symbol.length === 6) {
    const base = symbol.slice(0, 3);
    const quote = symbol.slice(3, 6);
    const codes = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "COP", "MXN", "BRL", "INR", "ZAR", "SEK", "NOK", "DKK", "SGD", "TRY", "PLN"]);
    if (codes.has(base) && codes.has(quote)) return quote;
  }
  return "USD";
}

function pickNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
