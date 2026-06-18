/**
 * Performance & risk metrics used by the comparison page and backtester.
 *
 * All functions are pure, accept a numeric array ordered ascending by date,
 * and return NaN for empty input so callers can render a placeholder.
 */

/** Simple returns from a price/value series. */
export function returns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]!;
    if (prev === 0) {
      out.push(0);
      continue;
    }
    out.push(values[i]! / prev - 1);
  }
  return out;
}

/** Mean of a numeric array. Returns 0 for empty input. */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation. */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Compound annual growth rate between a start and end value over a number of
 * fractional years. Returns 0 for non-positive inputs.
 */
export function cagr(startValue: number, endValue: number, years: number): number {
  if (startValue <= 0 || endValue <= 0 || years <= 0) return 0;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

/**
 * Maximum drawdown of an equity curve. Returns a negative number (or 0)
 * representing the worst peak-to-trough decline.
 */
export function maxDrawdown(values: number[]): number {
  if (values.length === 0) return 0;
  let peak = values[0]!;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = v / peak - 1;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

/** Annualised volatility of returns, given the number of periods per year. */
export function annualizedVolatility(
  returnsSeries: number[],
  periodsPerYear: number,
): number {
  return stddev(returnsSeries) * Math.sqrt(periodsPerYear);
}

/** Annualised Sharpe-like ratio. */
export function annualizedSharpe(
  returnsSeries: number[],
  periodsPerYear: number,
  riskFreeRate: number,
): number {
  const excess = returnsSeries.map((r) => r - riskFreeRate / periodsPerYear);
  const vol = stddev(excess);
  if (vol === 0) return 0;
  return (mean(excess) / vol) * Math.sqrt(periodsPerYear);
}
