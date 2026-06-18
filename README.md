# Market Trends

A systematic trend/valuation analysis dashboard for indices, ETFs, and stocks.

The app fetches historical adjusted close prices, runs a log-price linear
regression over configurable lookback windows (5Y / 10Y / 15Y / 20Y / Max),
and reports how far the current price is from its long-term exponential
trend (deviation %, residual, z-score). A staircase allocation model maps
z-scores to deployment suggestions.

This is a research/decision-support tool. **It is not financial advice.**

## Stack

- **Frontend** – Vite + React + TypeScript + Tailwind + Recharts
- **Backend** – Hono (typed) on Node
- **Shared** – Pure TypeScript finance + regression modules, unit tested with Vitest
- **Storage** – Postgres (with an in-memory fallback for local dev)
- **Data** – Pluggable `MarketDataProvider` interface. Default implementation:
  Yahoo Finance via `yahoo-finance2`.

## Layout

```
.
├── shared/        Pure finance + regression code (used by web + server)
├── server/        Hono API: tickers, prices, regression snapshots, backtest
├── web/           Vite/React dashboard
└── docs/          Notes
```

## Quick start

```bash
# Install deps for each workspace
cd shared && npm install
cd ../server && npm install
cd ../web && npm install

# Run unit tests for the math
cd ../shared && npm test

# Start the API (defaults to in-memory storage)
cd ../server && npm run dev

# In another terminal, start the web app
cd ../web && npm run dev
```

The web app expects the API at `http://localhost:8987` by default.

## Environment variables

A `.env.example` at the repo root documents every variable. Copy it to `.env`
to override the defaults — `.env` is git-ignored. The server loads `.env` on
startup with **override semantics**, so file values always win over the shell.

Server:

- `PORT` – API port (default `8987`)
- `DATABASE_URL` – Postgres connection string. If unset, the server uses an
  in-memory store (data is lost on restart).
- `MARKET_DATA_PROVIDER` – `yahoo` (default) | `stub`
- `CACHE_TTL_SECONDS` – cache price responses (default `3600`)

Web:

- `VITE_API_URL` – API base URL (default `http://localhost:8987`)

### Local Postgres setup

Postgres.app on macOS listens on a Unix socket at `/tmp` and the `postgres`
superuser has no password by default. A working local `.env` looks like:

```
DATABASE_URL=postgres://postgres@/market_trends?host=/tmp
MARKET_DATA_PROVIDER=stub
```

Create the database once with:

```
psql -h /tmp -U postgres -d postgres -c "CREATE DATABASE market_trends;"
```

The server creates the `tracked_tickers` table on first run.
