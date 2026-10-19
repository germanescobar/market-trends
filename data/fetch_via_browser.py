#!/usr/bin/env python3
"""
Driver: backfill a single ticker's daily history from Yahoo by chunking
the request into 3-month windows and fetching each via the Controller
preview browser (which is on a non-rate-limited egress).

Writes CSV at data/{TICKER}.csv in the PriceBar shape used by the app:
  date,adjustedClose,close,high,low,volume
"""

import csv
import datetime as dt
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

CONTROLLER = "/Users/germanescobar/Library/Application Support/Controller/bin/controller"
DATA_DIR = Path(__file__).parent

WINDOW_MONTHS = 3
# The browser snapshot is hard-capped at ~8,131 bytes of body. Some
# windows (especially the high-volume 2000-2002 era) push past that.
# When that happens, fall back to a smaller sub-window.
MAX_BODY_BYTES = 7800  # leave a safety margin
SUB_WINDOW_MONTHS = 1

# Per-ticker inception dates. Used as the start of the backfill window
# so we don't waste requests asking for data before the fund existed.
INCEPTIONS: dict[str, dt.date] = {
    "QQQ": dt.date(1999, 3, 10),
    "VGT": dt.date(2004, 1, 26),
    "BTC-USD": dt.date(2014, 9, 17),
    "GLD": dt.date(2004, 11, 18),
    "OIH": dt.date(2001, 4, 16),
    "COP=X": dt.date(2003, 1, 2),
    "SMH": dt.date(2000, 5, 9),
    "EEM": dt.date(2003, 4, 7),
    "SPY": dt.date(1993, 1, 22),
    "IEF": dt.date(2002, 7, 22),
    "VNQ": dt.date(2004, 9, 23),
}


def windows(start: dt.date, end: dt.date, months: int):
    cur = start
    while cur < end:
        # advance by `months` months, snap to last day of month
        m_total = (cur.month - 1) + months
        y, m = divmod(m_total, 12)
        nxt_first = dt.date(cur.year + y, m + 1, 1)
        nxt = nxt_first - dt.timedelta(days=1)
        if nxt > end:
            nxt = end
        if nxt < cur:
            nxt = end
        yield cur, nxt
        cur = nxt + dt.timedelta(days=1)


class BodyTooLargeError(Exception):
    """Snapshot body exceeded the controller's per-snapshot byte cap."""


def fetch_window(ticker: str, p1: int, p2: int, months: int = WINDOW_MONTHS) -> list[dict]:
    bars = _fetch_window_once(ticker, p1, p2)
    # If the body was too big and got truncated, the parse will raise.
    # The retry path catches that and splits the window.
    return bars


def _fetch_window_once(ticker: str, p1: int, p2: int) -> list[dict]:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        f"?period1={p1}&period2={p2}&interval=1d&includeAdjustedClose=true"
    )
    # open
    subprocess.run(
        [CONTROLLER, "browser", "open", url],
        check=True,
        capture_output=True,
    )
    # snapshot — the body is on the last line, line 1 is the URL, line 2 is blank
    out = subprocess.run(
        [CONTROLLER, "browser", "snapshot"],
        check=True,
        capture_output=True,
        text=True,
    )
    body = out.stdout.strip().splitlines()[-1]
    if len(body) > MAX_BODY_BYTES:
        raise BodyTooLargeError(len(body))
    data = json.loads(body)
    r = data["chart"]["result"][0]
    # Yahoo returns an empty result object ({}) when the requested range
    # has no trading days (e.g. a future-only window, or a holiday
    # range). Treat that as "no data" rather than a failure so the
    # caller can stitch windows without an artificial split.
    ts = r.get("timestamp") or []
    if not ts:
        return []
    q = r["indicators"]["quote"][0]
    a = r["indicators"]["adjclose"][0]["adjclose"]
    bars = []
    for i, t in enumerate(ts):
        if i >= len(a):
            break
        adj_close = a[i]
        if adj_close is None:
            continue
        close_i = q["close"][i] if i < len(q["close"]) else None
        high_i = q["high"][i] if i < len(q["high"]) else None
        low_i = q["low"][i] if i < len(q["low"]) else None
        vol_i = q["volume"][i] if i < len(q["volume"]) else None
        bars.append(
            {
                "date": dt.datetime.fromtimestamp(t, tz=dt.timezone.utc).date().isoformat(),
                "adjustedClose": adj_close,
                "close": close_i if close_i is not None else adj_close,
                "high": high_i,
                "low": low_i,
                "volume": int(vol_i) if vol_i is not None else None,
            }
        )
    return bars


def main(ticker: str, start_override: Optional[dt.date] = None) -> None:
    start = start_override or INCEPTIONS.get(ticker.upper())
    if start is None:
        # Unknown ticker: assume Max range. Caller can extend the dict.
        print(
            f"warning: no inception date for {ticker}; defaulting to 1970-01-01",
            flush=True,
        )
        start = dt.date(1970, 1, 1)
    end = dt.date.today()

    out_path = DATA_DIR / f"{ticker}.csv"
    rows: list[dict] = []
    seen_dates: set[str] = set()
    wins = list(windows(start, end, WINDOW_MONTHS))
    print(f"Fetching {len(wins)} windows of {ticker} history...", flush=True)
    t0 = time.time()
    for i, (s, e) in enumerate(wins, 1):
        p1 = int(dt.datetime(s.year, s.month, s.day, tzinfo=dt.timezone.utc).timestamp())
        # period2 is exclusive; bump to end-of-day UTC
        p2 = int(dt.datetime(e.year, e.month, e.day, 23, 59, 59, tzinfo=dt.timezone.utc).timestamp())
        try:
            bars = fetch_window(ticker, p1, p2, months=WINDOW_MONTHS)
        except (BodyTooLargeError, json.JSONDecodeError):
            # Window overflowed the snapshot cap. Split into sub-windows
            # of SUB_WINDOW_MONTHS and stitch.
            print(
                f"  [{i:>3}/{len(wins)}] {s} → {e}: window too large, splitting",
                flush=True,
            )
            sub_wins = list(windows(s, e, SUB_WINDOW_MONTHS))
            bars = []
            for ss, se in sub_wins:
                sp1 = int(
                    dt.datetime(ss.year, ss.month, ss.day, tzinfo=dt.timezone.utc).timestamp()
                )
                sp2 = int(
                    dt.datetime(
                        se.year, se.month, se.day, 23, 59, 59, tzinfo=dt.timezone.utc
                    ).timestamp()
                )
                try:
                    sub_bars = _fetch_window_once(ticker, sp1, sp2)
                except (BodyTooLargeError, json.JSONDecodeError):
                    # Single sub-window still too big. Give up rather
                    # than split further — Yahoo is misbehaving.
                    print(
                        f"      {ss} → {se}: SKIPPED (single sub-window > cap)",
                        flush=True,
                    )
                    continue
                bars.extend(sub_bars)
        new = 0
        for b in bars:
            if b["date"] not in seen_dates:
                seen_dates.add(b["date"])
                rows.append(b)
                new += 1
        elapsed = time.time() - t0
        print(
            f"  [{i:>3}/{len(wins)}] {s} → {e}: {len(bars)} bars ({new} new) — {elapsed:.1f}s",
            flush=True,
        )

    rows.sort(key=lambda b: b["date"])
    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "adjustedClose", "close", "high", "low", "volume"])
        for b in rows:
            w.writerow(
                [
                    b["date"],
                    f"{b['adjustedClose']:.6f}",
                    f"{b['close']:.6f}",
                    "" if b["high"] is None else f"{b['high']:.6f}",
                    "" if b["low"] is None else f"{b['low']:.6f}",
                    "" if b["volume"] is None else b["volume"],
                ]
            )
    print(f"\nWrote {len(rows)} bars to {out_path}")


if __name__ == "__main__":
    args = sys.argv[1:]
    # --start YYYY-MM-DD overrides the inception date (e.g. for "last 10
    # years" on a ticker that has been around longer).
    start_override = None
    if "--start" in args:
        i = args.index("--start")
        start_override = dt.date.fromisoformat(args[i + 1])
        del args[i : i + 2]
    ticker = args[0] if args else "VGT"
    main(ticker, start_override=start_override)
