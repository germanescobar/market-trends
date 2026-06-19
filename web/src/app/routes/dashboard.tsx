import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Trash2, RefreshCw, Plus, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InfoTip } from "@/components/InfoTip";
import { api } from "@/lib/api";
import {
  deviationTone,
  formatCurrency,
  formatPercent,
  formatZScore,
} from "@/lib/utils";
import type { TickerSnapshot, TrackedTicker } from "@market-trends/shared";
import { ALLOCATION_LABELS, allocationTone } from "@/lib/allocation-presentation";

export function DashboardPage() {
  const [tickers, setTickers] = useState<TrackedTicker[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, TickerSnapshot | { error: string }>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newTicker, setNewTicker] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const { tickers } = await api.tickers.list();
      setTickers(tickers);
      const results = await Promise.all(
        tickers.map(async (t) => {
          try {
            const snap = await api.snapshot(t.ticker);
            return [t.ticker, snap] as const;
          } catch (err) {
            return [t.ticker, { error: err instanceof Error ? err.message : "unknown error" }] as const;
          }
        }),
      );
      setSnapshots(Object.fromEntries(results));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onAdd = useCallback(async () => {
    setAddError(null);
    const v = newTicker.trim().toUpperCase();
    if (!v) return;
    try {
      await api.tickers.add({ ticker: v });
      setNewTicker("");
      await reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "failed to add ticker");
    }
  }, [newTicker, reload]);

  const onRemove = useCallback(
    async (t: string) => {
      try {
        await api.tickers.remove(t);
        await reload();
      } catch (err) {
        setAddError(err instanceof Error ? err.message : "failed to remove");
      }
    },
    [reload],
  );

  const rows = useMemo(() => tickers.map((t) => ({ ticker: t, snap: snapshots[t.ticker] })), [
    tickers,
    snapshots,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Track tickers and see how they sit relative to their long-term log-price trend.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={reload}
          disabled={refreshing}
          className="gap-1"
        >
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add a ticker</CardTitle>
          <CardDescription>
            Examples: QQQ, SPY, VGT, SMH, AAPL, MSFT, BTC-USD.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void onAdd();
            }}
          >
            <Input
              placeholder="Ticker symbol"
              value={newTicker}
              onChange={(e) => setNewTicker(e.target.value)}
              className="max-w-[200px] uppercase"
              autoCapitalize="characters"
              spellCheck={false}
            />
            <Button type="submit" className="gap-1">
              <Plus className="h-4 w-4" /> Add
            </Button>
            {addError && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" />
                {addError}
              </span>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              No tickers tracked yet — add one above to get started.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Current</TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1">
                      10Y trend
                      <InfoTip text="The regression-implied trend price for today, computed as exp(a + b*t) from a 10-year monthly log-price regression." />
                    </span>
                  </TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1">
                      Deviation
                      <InfoTip text="(current price / trend price) - 1. Positive means above trend; negative means below." />
                    </span>
                  </TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1">
                      Z-score
                      <InfoTip text="The residual (log price minus predicted log price) divided by the residual standard deviation. ±2σ is historically rare." />
                    </span>
                  </TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ ticker, snap }) => (
                  <DashboardRow
                    key={ticker.ticker}
                    ticker={ticker}
                    snap={snap}
                    onRemove={onRemove}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DashboardRow({
  ticker,
  snap,
  onRemove,
}: {
  ticker: TrackedTicker;
  snap: TickerSnapshot | { error: string } | undefined;
  onRemove: (t: string) => void;
}) {
  if (!snap) {
    return (
      <TableRow>
        <TableCell className="font-medium">{ticker.ticker}</TableCell>
        <TableCell colSpan={7} className="text-sm text-muted-foreground">
          {ticker.ticker}: no data
        </TableCell>
        <TableCell className="text-right">
          <RemoveTickerButton ticker={ticker.ticker} onRemove={onRemove} />
        </TableCell>
      </TableRow>
    );
  }
  if ("error" in snap) {
    return (
      <TableRow>
        <TableCell className="font-medium">{ticker.ticker}</TableCell>
        <TableCell colSpan={7} className="text-sm text-destructive">
          {snap.error}
        </TableCell>
        <TableCell className="text-right">
          <RemoveTickerButton ticker={ticker.ticker} onRemove={onRemove} />
        </TableCell>
      </TableRow>
    );
  }

  const trend = snap.defaultTrend;
  const tone = deviationTone(trend.deviationPercent);

  return (
    <TableRow>
      <TableCell className="font-medium">
        <span className="inline-flex items-center gap-1">
          <Link to={`/ticker?symbol=${encodeURIComponent(ticker.ticker)}`} className="hover:underline">
            {ticker.ticker}
          </Link>
          {snap.dataWarning && (
            <InfoTip text={snap.dataWarning} className="text-amber-600" />
          )}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {snap.name ?? ticker.name ?? "—"}
      </TableCell>
      <TableCell className="text-right text-mono">
        {formatCurrency(snap.quote?.price ?? trend.lastActualPrice, { currency: snap.currency })}
      </TableCell>
      <TableCell className="text-right text-mono">
        {formatCurrency(trend.lastTrendPrice, { currency: snap.currency })}
      </TableCell>
      <TableCell className={`text-right text-mono text-${tone}`}>
        {formatPercent(trend.deviationPercent, { sign: true })}
      </TableCell>
      <TableCell className={`text-right text-mono text-${tone}`}>
        {formatZScore(trend.lastZScore)}
      </TableCell>
      <TableCell>
        <Badge variant={allocationTone(snap.allocation.label)}>
          {ALLOCATION_LABELS[snap.allocation.label]}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {ticker.lastUpdated ? new Date(ticker.lastUpdated).toLocaleString() : "—"}
      </TableCell>
      <TableCell className="text-right">
        <RemoveTickerButton ticker={ticker.ticker} onRemove={onRemove} />
      </TableCell>
    </TableRow>
  );
}

function RemoveTickerButton({
  ticker,
  onRemove,
}: {
  ticker: string;
  onRemove: (ticker: string) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-destructive"
      onClick={() => onRemove(ticker)}
      aria-label={`Remove ${ticker}`}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}
