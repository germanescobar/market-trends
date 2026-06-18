import type {
  GetHistoricalPricesParams,
  MarketDataProvider,
} from "./types.js";
import type { PriceBar, PriceSeries, Quote } from "../types/index.js";

/**
 * Deterministic synthetic data provider. Useful for development, tests,
 * and offline exploration. Generates a geometric price series with a
 * configurable drift and volatility so charts look realistic.
 */
export interface StubProviderOptions {
  /** Annualised drift (e.g. 0.08 = 8% CAGR). */
  drift?: number;
  /** Annualised volatility (e.g. 0.2 = 20%). */
  volatility?: number;
  /** Starting price. */
  startPrice?: number;
  /** Deterministic seed so two calls with the same ticker agree. */
  seed?: number;
}

export function createStubProvider(
  options: StubProviderOptions = {},
): MarketDataProvider {
  return {
    name: "stub",
    async getHistoricalPrices({
      ticker,
      startDate,
      endDate,
    }: GetHistoricalPricesParams): Promise<PriceSeries> {
      const drift = options.drift ?? 0.08;
      const vol = options.volatility ?? 0.2;
      const start = options.startPrice ?? 100;
      const seed = options.seed ?? hashString(ticker);
      const end = endDate ? Date.parse(endDate) : Date.now();
      const startMs = startDate
        ? Date.parse(startDate)
        : end - 20 * 365 * 86_400_000;

      const bars = generateBars({
        ticker,
        startMs,
        endMs: end,
        drift,
        volatility: vol,
        startPrice: start,
        seed,
      });
      const first = bars[0]!;
      const last = bars[bars.length - 1]!;
      return {
        ticker,
        bars,
        startDate: first.date,
        endDate: last.date,
        source: "stub",
        frequency: "daily",
      };
    },
    async getQuote(ticker: string): Promise<Quote> {
      const series = await this.getHistoricalPrices({ ticker });
      const last = series.bars[series.bars.length - 1]!;
      const prev = series.bars[series.bars.length - 2] ?? last;
      return {
        ticker,
        price: last.adjustedClose,
        currency: "USD",
        asOf: new Date().toISOString(),
        changePercent:
          prev.adjustedClose > 0
            ? last.adjustedClose / prev.adjustedClose - 1
            : 0,
      };
    },
  };
}

interface GenerateOptions {
  ticker: string;
  startMs: number;
  endMs: number;
  drift: number;
  volatility: number;
  startPrice: number;
  seed: number;
}

function generateBars(opts: GenerateOptions): PriceBar[] {
  const dt = 1 / 252; // daily step
  const mu = opts.drift - 0.5 * opts.volatility * opts.volatility;
  const sigma = opts.volatility;
  const rng = mulberry32(opts.seed);
  const bars: PriceBar[] = [];
  let price = opts.startPrice;
  for (let t = opts.startMs; t <= opts.endMs; t += 86_400_000) {
    // Skip weekends so the synthetic data looks like trading days.
    const d = new Date(t);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    const z = randn(rng);
    const step = Math.exp(mu * dt + sigma * Math.sqrt(dt) * z);
    price *= step;
    const iso = d.toISOString().slice(0, 10);
    bars.push({
      date: iso,
      close: price,
      adjustedClose: price,
      volume: Math.floor(1_000_000 + rng() * 5_000_000),
    });
  }
  return bars;
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(rng: () => number): number {
  // Box-Muller transform.
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
