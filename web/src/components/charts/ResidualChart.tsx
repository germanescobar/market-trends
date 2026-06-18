/**
 * Residual / z-score over time. Shows the standardised deviation from the
 * log-trend regression, with horizontal reference lines at ±1σ and ±2σ.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { LogTrendSeries } from "@market-trends/shared";
import { useMemo } from "react";
import { formatZScore } from "@/lib/utils";

interface Props {
  series: LogTrendSeries;
  height?: number;
}

export function ResidualChart({ series, height = 220 }: Props) {
  const data = useMemo(
    () => series.points.map((p) => ({ date: p.date, zScore: p.zScore })),
    [series],
  );

  return (
    <ResponsiveContainer width="100%" height={height}>
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
          tickFormatter={(v: number) => `${v.toFixed(1)}σ`}
          domain={["auto", "auto"]}
          width={48}
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
        />
        <Tooltip content={<ZTooltip />} />
        {[-2, -1, 0, 1, 2].map((z) => (
          <ReferenceLine
            key={z}
            y={z}
            stroke={z === 0 ? "hsl(var(--muted-foreground))" : "hsl(var(--border))"}
            strokeDasharray={z === 0 ? undefined : "4 4"}
            strokeWidth={z === 0 ? 1.5 : 1}
            label={
              z !== 0
                ? {
                    value: `${z > 0 ? "+" : ""}${z}σ`,
                    position: "left",
                    fill: "hsl(var(--muted-foreground))",
                    fontSize: 10,
                  }
                : undefined
            }
          />
        ))}
        <Line
          type="monotone"
          dataKey="zScore"
          stroke="hsl(var(--foreground))"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
          name="z-score"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

interface ZTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { date: string; zScore: number } }>;
}
function ZTooltip({ active, payload }: ZTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]!.payload;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium">{p.date}</div>
      <div className="text-muted-foreground">z-score {formatZScore(p.zScore)}</div>
    </div>
  );
}
