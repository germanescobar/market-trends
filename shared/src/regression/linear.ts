/**
 * Ordinary least-squares linear regression.
 *
 * Fits y = a + b*x to paired observations using the closed-form solution:
 *   b = (n * Σxy - Σx * Σy) / (n * Σx² - (Σx)²)
 *   a = (Σy - b * Σx) / n
 *
 * Returns NaN for empty input so callers can detect it instead of catching
 * a division-by-zero error. Returns intercept=0, slope=0, rSquared=0 for
 * the degenerate single-observation case (no variance to explain).
 */
export interface RegressionResult {
  intercept: number;
  slope: number;
  /** Coefficient of determination in [0, 1] (can be negative if fit is worse than mean). */
  rSquared: number;
  n: number;
  /** Standard error of the residuals. */
  residualStdDev: number;
}

export function linearRegression(x: number[], y: number[]): RegressionResult {
  const n = x.length;
  if (n === 0 || n !== y.length) {
    return { intercept: NaN, slope: NaN, rSquared: NaN, n, residualStdDev: NaN };
  }
  if (n === 1) {
    return {
      intercept: y[0]!,
      slope: 0,
      rSquared: 0,
      n,
      residualStdDev: 0,
    };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i]!;
    const yi = y[i]!;
    sumX += xi;
    sumY += yi;
    sumXY += xi * yi;
    sumXX += xi * xi;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    // All x values identical — fall back to mean prediction.
    return {
      intercept: sumY / n,
      slope: 0,
      rSquared: 0,
      n,
      residualStdDev: 0,
    };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // Residual standard deviation: sqrt(SSR / (n - 2)).
  let ssr = 0;
  let sst = 0;
  const meanY = sumY / n;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * x[i]!;
    const residual = y[i]! - predicted;
    ssr += residual * residual;
    const dev = y[i]! - meanY;
    sst += dev * dev;
  }

  const residualStdDev = n > 2 ? Math.sqrt(ssr / (n - 2)) : 0;
  const rSquared = sst === 0 ? 0 : 1 - ssr / sst;

  return { intercept, slope, rSquared, n, residualStdDev };
}
