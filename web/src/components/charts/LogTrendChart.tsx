/**
 * Price-vs-trend chart for a single ticker.
 *
 * Renders four series:
 *   - actual adjusted close
 *   - regression trend (exp(a + b*t))
 *   - ±1σ and ±2σ bands in price space
 *
 * Uses a log y-axis so equal percentage moves look equal — this is the
 * natural scale for log-price regression. The bands widen visually with
 * time because trend grows exponentially while the residual std-dev is
 * constant in log space.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { LogTrendSeries } from "@market-trends/shared";
import { useMemo } from "react";
import { formatCurrency, formatNumber } from "@/lib/utils";

interface Props {
  series: LogTrendSeries;
  /** Show ±2σ bands. Default true. */
  showTwoSigma?: boolean;
  /** Height in pixels. */
  height?: number;
  /** Force a specific currency for axis ticks. */
  currency?: string;
}

export function LogTrendChart({
  series,
  showTwoSigma = true,
  height = 380,
  currency,
}: Props) {
  const data = useMemo(
    () =>
      series.points.map((p) => ({
        date: p.date,
        actual: p.actual,
        trend: p.trend,
        upper1: p.upperBand1,
        lower1: p.lowerBand1,
        upper2: p.upperBand2,
        lower2: p.lowerBand2,
      })),
    [series],
  );

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
        <defs>
          <linearGradient id="trendBand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.18} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.06} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tickFormatter={tickYear}
          minTickGap={48}
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
        />
        <YAxis
          scale="log"
          domain={["auto", "auto"]}
          tickFormatter={(v) => formatTick(v, currency)}
          width={64}
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
        />
        <Tooltip
          content={<ChartTooltip currency={currency} />}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 4 }}
          iconType="plainline"
        />
        {/* ±2σ band */}
        {showTwoSigma && (
          <Area
            type="monotone"
            dataKey="upper2"
            stroke="none"
            fill="url(#trendBand)"
            name="+2σ"
            isAnimationActive={false}
            legendType="none"
          />
        )}
        {showTwoSigma && (
          <Area
            type="monotone"
            dataKey="lower2"
            stroke="none"
            fill="hsl(var(--background))"
            name="−2σ"
            isAnimationActive={false}
            legendType="none"
          />
        )}
        <Area
          type="monotone"
          dataKey="upper1"
          stroke="hsl(var(--primary))"
          fill="none"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
          name="+1σ"
          isAnimationActive={false}
          dot={false}
        />
        <Area
          type="monotone"
          dataKey="lower1"
          stroke="hsl(var(--primary))"
          fill="none"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
          name="−1σ"
          isAnimationActive={false}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="trend"
          stroke="hsl(var(--primary))"
          strokeWidth={1.5}
          name="Trend"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="actual"
          stroke="hsl(var(--foreground))"
          strokeWidth={1.5}
          name="Actual"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function tickYear(value: string): string {
  return value.slice(0, 7);
}

function formatTick(v: number, currency?: string): string {
  if (!Number.isFinite(v)) return "";
  if (v >= 1000) return formatNumber(v, 0);
  if (v >= 10) return formatNumber(v, 1);
  return formatCurrency(v, { currency, digits: 2 });
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { date: string; actual: number; trend: number; upper1: number; lower1: number; upper2: number; lower2: number } }>;
  label?: string;
  currency?: string;
}

function ChartTooltip({ active, payload, currency }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]!.payload;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{p.date}</div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">Actual</dt>
        <dd className="text-right text-mono">{formatCurrency(p.actual, { currency })}</dd>
        <dt className="text-muted-foreground">Trend</dt>
        <dd className="text-right text-mono">{formatCurrency(p.trend, { currency })}</dd>
        <dt className="text-muted-foreground">±1σ</dt>
        <dd className="text-right text-mono">
          {formatCurrency(p.lower1, { currency })} – {formatCurrency(p.upper1, { currency })}
        </dd>
        <dt className="text-muted-foreground">±2σ</dt>
        <dd className="text-right text-mono">
          {formatCurrency(p.lower2, { currency })} – {formatCurrency(p.upper2, { currency })}
        </dd>
      </dl>
    </div>
  );
}
