# Notes

## Development quirks

- The shell tool resets `cwd` between calls. Always run `cd <package> && <cmd>` as
  a single command.
- The user's global `npm` config sets `omit=dev`. Each workspace ships a
  `.npmrc` with `include=dev` to override this. If you ever see "audited 1
  package" after an install, the `.npmrc` is missing.
- `yahoo-finance2` v2.14 has dropped historical chart endpoints. The Yahoo
  provider in this repo calls Yahoo's public v8 chart API directly via
  `fetch`. Yahoo's endpoints are unofficial and rate-limited; the stub
  provider (`MARKET_DATA_PROVIDER=stub`) is a practical default for
  development.

## Tests

Run from `shared/`:

```
npm test
```

Coverage:

- `regression.test.ts` – linear regression and log-trend recovery on
  known synthetic series.
- `finance.test.ts` – returns, CAGR, drawdown, volatility, Sharpe, and
  the staircase allocation resolver.
- `backtest.test.ts` – buy-and-hold / DCA / trend-staircase end-to-end on
  synthetic series, including clipping to user-defined allocation bounds.
