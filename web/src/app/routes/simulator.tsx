import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Loader2, AlertCircle, Play } from "lucide-react";
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
  formatCurrency,
  formatNumber,
  formatPercent,
} from "@/lib/utils";
import type {
  BacktestResult,
  BacktestStrategy,
  PriceFrequency,
} from "@market-trends/shared";

interface FormState {
  ticker: string;
  startDate: string;
  endDate: string;
  startingValue: number;
  monthlyContribution: number;
  baseEquityAllocation: number;
  minEquityAllocation: number;
  maxEquityAllocation: number;
  transactionCostBps: number;
  rebalance: "monthly" | "quarterly";
  frequency: PriceFrequency;
}

const DEFAULT_FORM: FormState = {
  ticker: "QQQ",
  startDate: defaultStart(),
  endDate: defaultEnd(),
  startingValue: 10_000,
  monthlyContribution: 500,
  baseEquityAllocation: 0.6,
  minEquityAllocation: 0,
  maxEquityAllocation: 1,
  transactionCostBps: 10,
  rebalance: "monthly",
  frequency: "monthly",
};

function defaultStart(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 15);
  return d.toISOString().slice(0, 10);
}
function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10);
}

export function SimulatorPage() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [results, setResults] = useState<Record<BacktestStrategy, BacktestResult | { error: string } | undefined>>({
    "buy-and-hold": undefined,
    dca: undefined,
    "trend-staircase": undefined,
  });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAll = useCallback(async () => {
    setRunning(true);
    setError(null);
    const input = {
      ticker: form.ticker,
      startDate: form.startDate,
      endDate: form.endDate,
      frequency: form.frequency,
      startingValue: form.startingValue,
      monthlyContribution: form.monthlyContribution,
      baseEquityAllocation: form.baseEquityAllocation,
      minEquityAllocation: form.minEquityAllocation,
      maxEquityAllocation: form.maxEquityAllocation,
      transactionCost: form.transactionCostBps / 10_000,
      rebalance: form.rebalance,
      riskFreeRate: 0,
    };
    const strategies: BacktestStrategy[] = ["buy-and-hold", "dca", "trend-staircase"];
    const next: typeof results = {
      "buy-and-hold": undefined,
      dca: undefined,
      "trend-staircase": undefined,
    };
    await Promise.all(
      strategies.map(async (s) => {
        try {
          next[s] = await api.backtest({ ...input, strategy: s });
        } catch (err) {
          next[s] = { error: err instanceof Error ? err.message : "unknown error" };
        }
      }),
    );
    setResults(next);
    setRunning(false);
  }, [form]);

  // Run once on mount.
  useEffect(() => {
    void runAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const equityData = useMemo(() => buildEquityData(results), [results]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Strategy simulator</h1>
        <p className="text-sm text-muted-foreground">
          Compare buy-and-hold, DCA, and the trend-staircase strategy with the
          same inputs. The trend-staircase recomputes the regression at each
          rebalance using only data available up to that date (no lookahead).
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Inputs</CardTitle>
            <CardDescription>
              Adjust the assumptions and re-run.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Field label="Ticker" htmlFor="ticker">
              <Input
                id="ticker"
                value={form.ticker}
                onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
                className="uppercase"
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Start" htmlFor="start">
                <Input
                  id="start"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                />
              </Field>
              <Field label="End" htmlFor="end">
                <Input
                  id="end"
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Starting value" htmlFor="startValue">
              <NumberInput
                id="startValue"
                value={form.startingValue}
                step={1000}
                onChange={(v) => setForm({ ...form, startingValue: v })}
              />
            </Field>
            <Field label="Monthly contribution" htmlFor="monthly">
              <NumberInput
                id="monthly"
                value={form.monthlyContribution}
                step={50}
                onChange={(v) => setForm({ ...form, monthlyContribution: v })}
              />
            </Field>
            <Field label="Base equity allocation (DCA)" htmlFor="base">
              <NumberInput
                id="base"
                value={form.baseEquityAllocation}
                step={0.05}
                min={0}
                max={1}
                onChange={(v) => setForm({ ...form, baseEquityAllocation: v })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min equity" htmlFor="min">
                <NumberInput
                  id="min"
                  value={form.minEquityAllocation}
                  step={0.05}
                  min={0}
                  max={1}
                  onChange={(v) => setForm({ ...form, minEquityAllocation: v })}
                />
              </Field>
              <Field label="Max equity" htmlFor="max">
                <NumberInput
                  id="max"
                  value={form.maxEquityAllocation}
                  step={0.05}
                  min={0}
                  max={1}
                  onChange={(v) => setForm({ ...form, maxEquityAllocation: v })}
                />
              </Field>
            </div>
            <Field label="Transaction cost (bps)" htmlFor="cost">
              <NumberInput
                id="cost"
                value={form.transactionCostBps}
                step={1}
                min={0}
                onChange={(v) => setForm({ ...form, transactionCostBps: v })}
              />
            </Field>
            <Field label="Rebalance" htmlFor="rebalance">
              <div className="flex items-center gap-1 rounded-md border p-0.5">
                {(["monthly", "quarterly"] as const).map((r) => (
                  <button
                    key={r}
                    id="rebalance"
                    onClick={() => setForm({ ...form, rebalance: r })}
                    className={`flex-1 rounded px-2 py-1 text-xs ${form.rebalance === r ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    type="button"
                  >
                    {r}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Frequency" htmlFor="freq">
              <div className="flex items-center gap-1 rounded-md border p-0.5">
                {(["daily", "weekly", "monthly"] as const).map((f) => (
                  <button
                    key={f}
                    id="freq"
                    onClick={() => setForm({ ...form, frequency: f })}
                    className={`flex-1 rounded px-2 py-1 text-xs capitalize ${form.frequency === f ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    type="button"
                  >
                    {f}
                  </button>
                ))}
              </div>
            </Field>
            <Button onClick={runAll} disabled={running} className="w-full gap-1">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? "Running…" : "Run backtest"}
            </Button>
            {error && (
              <div className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" /> {error}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Equity curves</CardTitle>
              <CardDescription>
                Portfolio value at each rebalance step for the three strategies.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EquityCurveChart data={equityData} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Metrics</CardTitle>
              <CardDescription>
                Side-by-side comparison of the three strategies.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Strategy</TableHead>
                    <TableHead className="text-right">Final value</TableHead>
                    <TableHead className="text-right">CAGR</TableHead>
                    <TableHead className="text-right">Max DD</TableHead>
                    <TableHead className="text-right">Volatility</TableHead>
                    <TableHead className="text-right">Sharpe</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead className="text-right">% invested</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(["buy-and-hold", "dca", "trend-staircase"] as const).map((s) => (
                    <ResultRow key={s} result={results[s]} />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">What this measures</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Final value</span>{" "}
                — portfolio value at the end of the window, including any
                uninvested cash.
              </p>
              <p>
                <span className="font-medium text-foreground">CAGR</span> — the
                annualised compound growth rate of the portfolio value over the
                full window.
              </p>
              <p>
                <span className="font-medium text-foreground">Max drawdown</span>{" "}
                — the worst peak-to-trough decline in portfolio value.
              </p>
              <p>
                <span className="font-medium text-foreground">% invested</span>{" "}
                — average fraction of the portfolio held in the asset (not in
                cash). Higher = more aggressive.
              </p>
              <p>
                <span className="font-medium text-foreground">No lookahead</span>{" "}
                — the trend-staircase recomputes its regression at each
                rebalance using only data available up to that date, so the
                backtest reflects what you would have known in real time.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ResultRow({
  result,
}: {
  result: BacktestResult | { error: string } | undefined;
}) {
  if (!result) {
    return (
      <TableRow>
        <TableCell colSpan={8} className="text-sm text-muted-foreground">—</TableCell>
      </TableRow>
    );
  }
  if ("error" in result) {
    return (
      <TableRow>
        <TableCell colSpan={8} className="text-sm text-destructive">
          {result.error}
        </TableCell>
      </TableRow>
    );
  }
  const m = result.metrics;
  const tone = m.cagr >= 0 ? "bull" : "bear";
  return (
    <TableRow>
      <TableCell>
        <Badge variant={result.strategy === "trend-staircase" ? "default" : "secondary"}>
          {strategyLabel(result.strategy)}
        </Badge>
      </TableCell>
      <TableCell className="text-right text-mono">{formatCurrency(m.finalValue, { digits: 0 })}</TableCell>
      <TableCell className={`text-right text-mono text-${tone}`}>{formatPercent(m.cagr, { sign: true })}</TableCell>
      <TableCell className="text-right text-mono text-bear">{formatPercent(m.maxDrawdown, { sign: true })}</TableCell>
      <TableCell className="text-right text-mono">{formatPercent(m.volatility, { sign: false })}</TableCell>
      <TableCell className="text-right text-mono">{formatNumber(m.sharpe, 2)}</TableCell>
      <TableCell className="text-right text-mono">{m.numberOfTrades}</TableCell>
      <TableCell className="text-right text-mono">{formatPercent(m.percentTimeInvested, { sign: false, digits: 0 })}</TableCell>
    </TableRow>
  );
}

function strategyLabel(s: BacktestStrategy): string {
  switch (s) {
    case "buy-and-hold":
      return "Buy & hold";
    case "dca":
      return "DCA";
    case "trend-staircase":
      return "Trend staircase";
  }
}

function buildEquityData(
  results: Record<BacktestStrategy, BacktestResult | { error: string } | undefined>,
): Array<Record<string, number | string>> {
  // Collect all dates across strategies (assume buy-and-hold covers everything).
  const ref = results["buy-and-hold"];
  if (!ref || "error" in ref) return [];
  const dateIndex = new Map<string, number>();
  ref.equityCurve.forEach((p, i) => dateIndex.set(p.date, i));
  return ref.equityCurve.map((p, i) => {
    const row: Record<string, number | string> = { date: p.date };
    for (const [strategy, r] of Object.entries(results)) {
      if (!r || "error" in r) continue;
      const point = r.equityCurve.find((q) => q.date === p.date);
      if (point) row[strategy] = point.value;
    }
    void i;
    return row;
  });
}

function EquityCurveChart({ data }: { data: Array<Record<string, number | string>> }) {
  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
        Run the backtest to see the equity curves.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tickFormatter={(v: string) => v.slice(0, 7)}
          minTickGap={48}
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
        />
        <YAxis
          tickFormatter={(v: number) => formatNumber(v, 0)}
          width={70}
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
        />
        <Tooltip content={<EquityTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="buy-and-hold"
          stroke="hsl(var(--foreground))"
          strokeWidth={1.5}
          dot={false}
          name="Buy & hold"
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="dca"
          stroke="hsl(220 70% 50%)"
          strokeWidth={1.5}
          dot={false}
          name="DCA"
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="trend-staircase"
          stroke="hsl(142 71% 45%)"
          strokeWidth={2}
          dot={false}
          name="Trend staircase"
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

interface EquityTipProps {
  active?: boolean;
  payload?: Array<{ payload: Record<string, number | string>; dataKey: string; value: number }>;
  label?: string;
}
function EquityTooltip({ active, payload, label }: EquityTipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{label}</div>
      <ul className="space-y-0.5">
        {payload.map((p) => (
          <li key={p.dataKey} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{strategyLabel(p.dataKey as BacktestStrategy)}</span>
            <span className="text-mono">{formatCurrency(p.value, { digits: 0 })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  id,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  id?: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <Input
      id={id}
      type="number"
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

