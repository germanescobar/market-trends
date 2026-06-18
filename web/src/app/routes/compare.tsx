import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, X, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import {
  annualizedSharpe,
  annualizedVolatility,
  cagr,
  deviationTone,
  formatNumber,
  formatPercent,
  formatZScore,
  returns,
} from "@/lib/utils";
import type { LookbackYears, PriceFrequency, TickerSnapshot } from "@market-trends/shared";

const DEFAULT_TICKERS = ["QQQ", "SPY", "VGT", "SMH", "AAPL", "MSFT"];
const LOOKBACKS: Array<LookbackYears> = [5, 10, 15, 20, "max"];
const FREQUENCIES: Array<PriceFrequency> = ["daily", "weekly", "monthly"];
const LOOKBACK_LABELS: Record<LookbackYears, string> = {
  5: "5Y",
  10: "10Y",
  15: "15Y",
  20: "20Y",
  max: "Max",
};

export function ComparePage() {
  const [tickers, setTickers] = useState<string[]>(DEFAULT_TICKERS);
  const [draft, setDraft] = useState("");
  const [lookback, setLookback] = useState<LookbackYears>(10);
  const [frequency, setFrequency] = useState<PriceFrequency>("monthly");
  const [rows, setRows] = useState<Array<{ ticker: string; snapshot?: TickerSnapshot; error?: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tickers.length === 0) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .compare(tickers, { lookback, frequency })
      .then((res) => !cancelled && setRows(res.rows))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "unknown"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [tickers, lookback, frequency]);

  function add() {
    const v = draft.trim().toUpperCase();
    if (!v) return;
    if (!tickers.includes(v)) setTickers((prev) => [...prev, v]);
    setDraft("");
  }
  function remove(t: string) {
    setTickers((prev) => prev.filter((x) => x !== t));
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compare</h1>
          <p className="text-sm text-muted-foreground">
            Side-by-side trend signals and risk metrics for any set of tickers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LookbackTabs value={lookback} onChange={setLookback} />
          <FrequencyTabs value={frequency} onChange={setFrequency} />
        </div>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tickers</CardTitle>
          <CardDescription>
            Compare any mix of indices, ETFs and stocks. The table refreshes
            automatically as you change the set.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              placeholder="Add ticker"
              className="max-w-[200px] uppercase"
            />
            <Button type="submit" size="sm" variant="outline" className="gap-1">
              <Plus className="h-4 w-4" /> Add
            </Button>
          </form>
          <div className="flex flex-wrap gap-2">
            {tickers.map((t) => (
              <button
                key={t}
                onClick={() => remove(t)}
                className="group inline-flex items-center gap-1 rounded-full border bg-secondary px-3 py-1 text-xs font-medium hover:bg-secondary/70"
              >
                {t}
                <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Current</TableHead>
                  <TableHead className="text-right">Trend price</TableHead>
                  <TableHead className="text-right">Dev %</TableHead>
                  <TableHead className="text-right">Z-score</TableHead>
                  <TableHead className="text-right">CAGR</TableHead>
                  <TableHead className="text-right">Max DD</TableHead>
                  <TableHead className="text-right">Volatility</TableHead>
                  <TableHead className="text-right">Sharpe</TableHead>
                  <TableHead>Signal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <CompareRow key={row.ticker} row={row} lookback={lookback} frequency={frequency} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CompareRow({
  row,
  lookback,
  frequency,
}: {
  row: { ticker: string; snapshot?: TickerSnapshot; error?: string };
  lookback: LookbackYears;
  frequency: PriceFrequency;
}) {
  if (!row.snapshot) {
    return (
      <TableRow>
        <TableCell className="font-medium">{row.ticker}</TableCell>
        <TableCell colSpan={9} className="text-sm text-destructive">
          {row.error ?? "no data"}
        </TableCell>
      </TableRow>
    );
  }
  const snap = row.snapshot;
  const trend = snap.trends[String(lookback)] ?? snap.defaultTrend;
  const series = snap.series.bars.map((b) => b.adjustedClose);
  const rets = returns(series);
  const periodsPerYear = frequency === "daily" ? 252 : frequency === "weekly" ? 52 : 12;
  const years =
    (Date.parse(snap.series.endDate) - Date.parse(snap.series.startDate)) /
    (365.25 * 86_400_000);
  const startValue = series[0];
  const endValue = series[series.length - 1];
  const totalCagr =
    startValue && endValue && startValue > 0 && years > 0
      ? cagr(startValue, endValue, years)
      : 0;
  // Drawdown is computed off the equity curve.
  let peak = series[0] ?? 0;
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = v / peak - 1;
      if (dd < worst) worst = dd;
    }
  }
  const vol = annualizedVolatility(rets, periodsPerYear);
  const sharpe = annualizedSharpe(rets, periodsPerYear, 0);
  const tone = deviationTone(trend.deviationPercent);

  return (
    <TableRow>
      <TableCell className="font-medium">{snap.ticker}</TableCell>
      <TableCell className="text-right text-mono">
        {formatPercent(0, { sign: false, digits: 0 }).slice(0, 0)}
        {snap.quote
          ? new Intl.NumberFormat("en-US", { style: "currency", currency: snap.currency ?? "USD" }).format(snap.quote.price)
          : "—"}
      </TableCell>
      <TableCell className="text-right text-mono">
        {formatNumber(trend.lastTrendPrice, 2)}
      </TableCell>
      <TableCell className={`text-right text-mono text-${tone}`}>
        {formatPercent(trend.deviationPercent, { sign: true })}
      </TableCell>
      <TableCell className={`text-right text-mono text-${tone}`}>
        {formatZScore(trend.lastZScore)}
      </TableCell>
      <TableCell className="text-right text-mono">{formatPercent(trend.annualizedCagr, { sign: false })}</TableCell>
      <TableCell className="text-right text-mono text-bear">
        {formatPercent(worst, { sign: true })}
      </TableCell>
      <TableCell className="text-right text-mono">{formatPercent(vol, { sign: false })}</TableCell>
      <TableCell className="text-right text-mono">{sharpe.toFixed(2)}</TableCell>
      <TableCell>
        <Badge variant={tone === "bull" ? "bull" : tone === "bear" ? "bear" : "neutral"}>
          {LOOKBACK_LABELS[lookback]} z {trend.lastZScore.toFixed(2)}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function LookbackTabs({
  value,
  onChange,
}: {
  value: LookbackYears;
  onChange: (v: LookbackYears) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border p-0.5">
      {LOOKBACKS.map((lk) => (
        <button
          key={lk}
          onClick={() => onChange(lk)}
          className={`rounded px-2 py-1 text-xs ${value === lk ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {LOOKBACK_LABELS[lk]}
        </button>
      ))}
    </div>
  );
}
function FrequencyTabs({
  value,
  onChange,
}: {
  value: PriceFrequency;
  onChange: (v: PriceFrequency) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border p-0.5">
      {FREQUENCIES.map((f) => (
        <button
          key={f}
          onClick={() => onChange(f)}
          className={`rounded px-2 py-1 text-xs capitalize ${value === f ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {f}
        </button>
      ))}
    </div>
  );
}

// (no extra imports)
