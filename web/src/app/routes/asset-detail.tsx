import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { InfoTip } from "@/components/InfoTip";
import { LogTrendChart, ResidualChart } from "@/components/charts";
import { api } from "@/lib/api";
import {
  deviationTone,
  formatCurrency,
  formatPercent,
  formatZScore,
} from "@/lib/utils";
import {
  ALLOCATION_LABELS,
  allocationTone,
} from "@/lib/allocation-presentation";
import type {
  AllocationLabel,
  LogTrendRegression,
  LogTrendSeries,
  LookbackYears,
  PriceFrequency,
  TickerSnapshot,
} from "@market-trends/shared";

const LOOKBACKS: Array<LookbackYears> = [5, 10, 15, 20, "max"];
const FREQUENCIES: Array<PriceFrequency> = ["daily", "weekly", "monthly"];
const LOOKBACK_LABELS: Record<LookbackYears, string> = {
  5: "5Y",
  10: "10Y",
  15: "15Y",
  20: "20Y",
  max: "Max",
};

export function AssetDetailPage() {
  const [params, setParams] = useSearchParams();
  const ticker = (params.get("symbol") ?? "QQQ").toUpperCase();
  const lookback = (parseLookback(params.get("lookback")) ?? 10) as LookbackYears;
  const frequency = parseFrequency(params.get("frequency")) ?? "monthly";

  const [snapshot, setSnapshot] = useState<TickerSnapshot | null>(null);
  const [series, setSeries] = useState<LogTrendSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.snapshot(ticker, { lookback, frequency }),
      api.series(ticker, { lookback, frequency }),
    ])
      .then(([snap, ser]) => {
        if (cancelled) return;
        setSnapshot(snap);
        setSeries(ser);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "unknown error");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ticker, lookback, frequency]);

  function setQuery(next: Partial<{ symbol: string; lookback: LookbackYears; frequency: PriceFrequency }>) {
    const p = new URLSearchParams(params);
    if (next.symbol !== undefined) p.set("symbol", next.symbol);
    if (next.lookback !== undefined) p.set("lookback", String(next.lookback));
    if (next.frequency !== undefined) p.set("frequency", next.frequency);
    setParams(p, { replace: true });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <TickerSearch
          value={ticker}
          onChange={(v) => setQuery({ symbol: v })}
        />
      </div>

      {error ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      ) : loading || !snapshot || !series ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </CardContent>
        </Card>
      ) : (
        <AssetDetailContent
          ticker={ticker}
          snapshot={snapshot}
          series={series}
          lookback={lookback}
          frequency={frequency}
          onLookbackChange={(v) => setQuery({ lookback: v })}
          onFrequencyChange={(v) => setQuery({ frequency: v })}
        />
      )}
    </div>
  );
}

function TickerSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onChange(draft.trim().toUpperCase());
      }}
      className="flex items-center gap-2"
    >
      <input
        aria-label="Ticker"
        value={draft}
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        className="h-8 w-28 rounded-md border bg-background px-2 text-sm uppercase tracking-wide"
      />
      <Button size="sm" variant="outline" type="submit">
        Go
      </Button>
    </form>
  );
}

function AssetDetailContent({
  ticker,
  snapshot,
  series,
  lookback,
  frequency,
  onLookbackChange,
  onFrequencyChange,
}: {
  ticker: string;
  snapshot: TickerSnapshot;
  series: LogTrendSeries;
  lookback: LookbackYears;
  frequency: PriceFrequency;
  onLookbackChange: (v: LookbackYears) => void;
  onFrequencyChange: (v: PriceFrequency) => void;
}) {
  const trend = snapshot.defaultTrend;
  const tone = deviationTone(trend.deviationPercent);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight">
            {ticker}
            {snapshot.name && (
              <span className="text-base font-normal text-muted-foreground">
                {snapshot.name}
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {frequency} · {LOOKBACK_LABELS[lookback]} log-price regression
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LookbackSelect value={lookback} onChange={onLookbackChange} />
          <FrequencySelect value={frequency} onChange={onFrequencyChange} />
        </div>
      </header>

      {snapshot.dataWarning && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {snapshot.dataWarning}
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Current price"
          value={formatCurrency(snapshot.quote?.price ?? trend.lastActualPrice, {
            currency: snapshot.currency,
          })}
          tone={tone}
        />
        <MetricCard
          title="Trend price"
          value={formatCurrency(trend.lastTrendPrice, { currency: snapshot.currency })}
          subtitle={
            <span className="inline-flex items-center gap-1">
              CAGR {formatPercent(trend.annualizedCagr, { sign: false })}
              <InfoTip text="The annualised compound growth rate implied by the regression slope. With log prices, CAGR = exp(slope × periods-per-year) − 1." />
            </span>
          }
          tone={tone}
        />
        <MetricCard
          title="Deviation"
          value={formatPercent(trend.deviationPercent, { sign: true })}
          subtitle={`σ ${trend.residualStdDev.toFixed(3)} (log space)`}
          tone={tone}
        />
        <MetricCard
          title="Z-score"
          value={formatZScore(trend.lastZScore)}
          subtitle={`Residual ${trend.lastResidual.toFixed(3)}`}
          tone={tone}
        />
      </section>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            Allocation suggestion
            <InfoTip text="Staircase model that maps the current z-score to a qualitative signal." />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 pb-6">
          <Badge variant={allocationTone(snapshot.allocation.label)} className="text-sm">
            {ALLOCATION_LABELS[snapshot.allocation.label]}
          </Badge>
          <p className="basis-full text-sm text-muted-foreground">
            {snapshot.allocation.description}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Price vs trend ({LOOKBACK_LABELS[lookback]}, {frequency})
          </CardTitle>
          <CardDescription>
            Log scale. Bands are the regression σ in price space. The trend
            line grows exponentially at the fitted CAGR.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LogTrendChart series={series} currency={snapshot.currency} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Residual / z-score</CardTitle>
          <CardDescription>
            Distance from trend in standard-deviation units. The horizontal
            bands mark the staircase thresholds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResidualChart series={series} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Lookback comparison</CardTitle>
          <CardDescription>
            How the z-score changes as you shorten the regression window.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-5">
          {LOOKBACKS.map((lk) => (
            <LookbackTile key={lk} label={LOOKBACK_LABELS[lk]} regression={snapshot.trends[String(lk)]} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Staircase reference</CardTitle>
        </CardHeader>
        <CardContent>
          <StaircaseLegend current={snapshot.allocation.label} />
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  tone,
}: {
  title: string;
  value: string;
  subtitle?: React.ReactNode;
  tone: "bull" | "bear" | "neutral";
}) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
        <div className={`text-2xl font-semibold text-mono text-${tone}`}>{value}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}

function LookbackSelect({
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

function FrequencySelect({
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

function LookbackTile({ label, regression }: { label: string; regression: LogTrendRegression | undefined }) {
  if (!regression) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground">{label}: no data</div>
    );
  }
  const tone = deviationTone(regression.deviationPercent);
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-mono text-lg font-semibold text-${tone}`}>
        {formatZScore(regression.lastZScore)}
      </div>
      <div className="text-xs text-muted-foreground">
        Dev {formatPercent(regression.deviationPercent, { sign: true })} · CAGR{" "}
        {formatPercent(regression.annualizedCagr, { sign: false })}
      </div>
    </div>
  );
}

const STAIRCASE_ROWS: Array<{ range: string; label: AllocationLabel }> = [
  { range: "z ≤ −2", label: "strong-buy" },
  { range: "−2 < z ≤ −1", label: "buy" },
  { range: "−1 < z ≤ 0", label: "buy-moderate" },
  { range: "0 < z ≤ +1", label: "sell-moderate" },
  { range: "+1 < z ≤ +2", label: "sell" },
  { range: "z > +2", label: "strong-sell" },
];

function StaircaseLegend({ current }: { current: AllocationLabel }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {STAIRCASE_ROWS.map((row) => (
        <div
          key={row.label}
          className={`flex items-center justify-between rounded-md border p-3 text-sm ${current === row.label ? "ring-2 ring-primary" : ""}`}
        >
          <div className="text-mono text-xs uppercase text-muted-foreground">{row.range}</div>
          <Badge variant={allocationTone(row.label)}>{ALLOCATION_LABELS[row.label]}</Badge>
        </div>
      ))}
    </div>
  );
}

function parseLookback(raw: string | null): LookbackYears | null {
  if (raw == null) return null;
  if (raw === "max") return "max";
  const n = Number(raw);
  if (LOOKBACKS.includes(n as LookbackYears)) return n as LookbackYears;
  return null;
}
function parseFrequency(raw: string | null): PriceFrequency | null {
  if (raw === "daily" || raw === "weekly" || raw === "monthly") return raw;
  return null;
}
