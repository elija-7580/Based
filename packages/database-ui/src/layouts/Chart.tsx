// BSD-155: Diagramm-Ansicht (Swift ChartLayout): Balken (vertikal/horizontal), Linie, Fläche, Kreis, Donut,
// Zahl. Daten aus chartPoints/chartNumber im Kern; SVG mit Token-Farben.
import { useEffect, useMemo, useRef, useState } from "react";
import { chartNumber, chartPoints, formatNumber, propertyOf, type ChartPoint, type DatabaseView, type QueryResult } from "@based/core";
import { useDB } from "../context.js";
import { optionTone } from "../logic/values.js";
import { EmptyState } from "./shared.js";

const DEFAULT_CHART: NonNullable<DatabaseView["chart"]> = { kind: "bar", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false };
// Notion/Swift: small / medium / large / extra_large („xlarge“ aus älteren TS-Ständen gilt weiter)
const HEIGHTS: Record<string, number> = { small: 200, medium: 300, large: 420, extra_large: 560, xlarge: 560 };

/** BSD-216: Farbschema wie Notion/Swift `colorTheme` – „auto“ = Optionsfarben, „colorful“ = je Wert eine Farbe, sonst eine Farbe für alles. */
export const CHART_THEMES: { id: string; label: string }[] = [
  { id: "auto", label: "Auto" }, { id: "colorful", label: "Colorful" }, { id: "gray", label: "Gray" }, { id: "blue", label: "Blue" },
  { id: "green", label: "Green" }, { id: "orange", label: "Orange" }, { id: "pink", label: "Pink" }, { id: "red", label: "Red" },
];
const CYCLE = ["blue", "green", "orange", "pink", "red", "gray"];
export function themedPoints(pts: ChartPoint[], theme: string | undefined): ChartPoint[] {
  if (!theme || theme === "auto") return pts;
  if (theme === "colorful") return pts.map((p, i) => ({ ...p, color: CYCLE[i % CYCLE.length]! }));
  return pts.map((p) => ({ ...p, color: theme }));
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(160, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const tone = (p: ChartPoint) => (p.color ? `tone-${optionTone(p.color)}` : "tone-ink");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function Bars({ pts, w, h, fmt, values }: { pts: ChartPoint[]; w: number; h: number; fmt: (n: number) => string; values: boolean }) {
  const max = Math.max(1, ...pts.map((p) => p.value));
  const padB = 28, padT = 18, bw = w / Math.max(1, pts.length);
  return (
    <svg width={w} height={h} role="img" aria-label="Bar chart" className="dbui-chart-svg">
      <line x1={0} x2={w} y1={h - padB} y2={h - padB} className="axis" />
      {pts.map((p, i) => {
        const bh = ((h - padB - padT) * Math.max(0, p.value)) / max;
        const barW = Math.min(bw * 0.7, 56);
        const cx = i * bw + bw / 2, x = cx - barW / 2;
        return (
          <g key={p.key} data-testid="chart-bar">
            <title>{`${p.label}: ${fmt(p.value)}`}</title>
            <rect x={x} y={h - padB - bh} width={barW} height={bh} rx={4} className={"mark " + tone(p)} />
            {values && <text x={cx} y={h - padB - bh - 4} textAnchor="middle" className="value">{fmt(p.value)}</text>}
            <text x={cx} y={h - 8} textAnchor="middle" className="label">{clip(p.label, Math.max(3, Math.floor(bw / 7)))}</text>
          </g>
        );
      })}
    </svg>
  );
}

function HBars({ pts, w, fmt, values }: { pts: ChartPoint[]; w: number; fmt: (n: number) => string; values: boolean }) {
  const max = Math.max(1, ...pts.map((p) => p.value));
  const row = 28, labelW = Math.min(160, w * 0.3), h = pts.length * row + 8;
  return (
    <svg width={w} height={h} role="img" aria-label="Horizontal bar chart" className="dbui-chart-svg">
      {pts.map((p, i) => {
        const bw = ((w - labelW - 60) * Math.max(0, p.value)) / max;
        return (
          <g key={p.key} data-testid="chart-bar">
            <title>{`${p.label}: ${fmt(p.value)}`}</title>
            <text x={labelW - 8} y={i * row + 19} textAnchor="end" className="label">{clip(p.label, 22)}</text>
            <rect x={labelW} y={i * row + 6} width={bw} height={row - 10} rx={4} className={"mark " + tone(p)} />
            {values && <text x={labelW + bw + 6} y={i * row + 19} className="value">{fmt(p.value)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function Lines({ pts, w, h, fmt, values, area }: { pts: ChartPoint[]; w: number; h: number; fmt: (n: number) => string; values: boolean; area: boolean }) {
  const max = Math.max(1, ...pts.map((p) => p.value));
  const padB = 28, padT = 18, padX = 24;
  const x = (i: number) => padX + (pts.length <= 1 ? (w - 2 * padX) / 2 : (i * (w - 2 * padX)) / (pts.length - 1));
  const y = (v: number) => h - padB - ((h - padB - padT) * Math.max(0, v)) / max;
  const line = pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const step = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(w / 80))));
  return (
    <svg width={w} height={h} role="img" aria-label={area ? "Area chart" : "Line chart"} className="dbui-chart-svg">
      <line x1={0} x2={w} y1={h - padB} y2={h - padB} className="axis" />
      {area && pts.length > 0 && <polygon points={`${x(0)},${h - padB} ${line} ${x(pts.length - 1)},${h - padB}`} className="area" />}
      <polyline points={line} className="line" />
      {pts.map((p, i) => (
        <g key={p.key} data-testid="chart-point">
          <title>{`${p.label}: ${fmt(p.value)}`}</title>
          <circle cx={x(i)} cy={y(p.value)} r={3.5} className="dot" />
          {values && <text x={x(i)} y={y(p.value) - 8} textAnchor="middle" className="value">{fmt(p.value)}</text>}
          {i % step === 0 && <text x={x(i)} y={h - 8} textAnchor="middle" className="label">{clip(p.label, 12)}</text>}
        </g>
      ))}
    </svg>
  );
}

function Pie({ pts, h, fmt, donut, values }: { pts: ChartPoint[]; h: number; fmt: (n: number) => string; donut: boolean; values: boolean }) {
  const total = pts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  const r = h / 2 - 8, cx = h / 2, cy = h / 2, inner = donut ? r * 0.58 : 0;
  let a0 = -Math.PI / 2;
  const arc = (a: number, rr: number) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] as const;
  return (
    <svg width={h} height={h} role="img" aria-label={donut ? "Donut chart" : "Pie chart"} className="dbui-chart-svg">
      {pts.map((p, i) => {
        const frac = Math.max(0, p.value) / total;
        const a1 = a0 + frac * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const [x0, y0] = arc(a0, r), [x1, y1] = arc(Math.min(a1, a0 + Math.PI * 2 - 1e-4), r);
        const [ix1, iy1] = arc(Math.min(a1, a0 + Math.PI * 2 - 1e-4), inner), [ix0, iy0] = arc(a0, inner);
        const d = donut
          ? `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${ix1},${iy1} A${inner},${inner} 0 ${large} 0 ${ix0},${iy0} Z`
          : `M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`;
        a0 = a1;
        return <path key={p.key} d={d} className={"mark slice " + (p.color ? tone(p) : `tone-cycle-${i % 6}`)} data-testid="chart-slice"><title>{`${p.label}: ${fmt(p.value)}`}</title></path>;
      })}
      {donut && values && <text x={cx} y={cy + 6} textAnchor="middle" className="total">{fmt(total)}</text>}
    </svg>
  );
}

export function ChartLayout({ view, result, height }: { view: DatabaseView; result: QueryResult; height?: number }) {
  const { engine, db } = useDB();
  const [ref, w] = useWidth();
  const c = view.chart ?? DEFAULT_CHART;
  const yProp = c.yPropertyID ? propertyOf(db, c.yPropertyID) : undefined;
  const fmt = (n: number) => (yProp ? formatNumber(Math.round(n * 100) / 100, yProp.numberFormat) : formatNumber(Math.round(n * 100) / 100));
  const pts = useMemo(() => (c.kind === "number" ? [] : themedPoints(chartPoints(engine, result.rows, db, c), c.colorTheme)), [engine, result, db, c]);
  const h = height ?? HEIGHTS[c.height ?? "medium"] ?? 300;
  let body: React.ReactNode;
  if (c.kind === "number") {
    body = (
      <div className="dbui-chart-number" data-testid="chart-number">
        <span className="dbui-chart-big">{fmt(chartNumber(engine, result.rows, db, c))}</span>
        <span className="dbui-field-label">{yProp ? `${c.aggregate} of ${yProp.name}` : "Count"}</span>
      </div>
    );
  } else if (pts.length === 0) body = <EmptyState>No data to chart.</EmptyState>;
  else if (c.kind === "horizontalBar") body = <HBars pts={pts} w={w} fmt={fmt} values={c.showValues} />;
  else if (c.kind === "line" || c.kind === "area") body = <Lines pts={pts} w={w} h={h} fmt={fmt} values={c.showValues} area={c.kind === "area"} />;
  else if (c.kind === "pie" || c.kind === "donut") {
    body = (
      <div className="dbui-pie">
        <Pie pts={pts} h={Math.min(h, w)} fmt={fmt} donut={c.kind === "donut"} values={c.showValues} />
        {c.showLegend && (
          <ul className="dbui-legend" aria-label="Legend">
            {pts.map((p, i) => <li key={p.key}><span className={"swatch " + (p.color ? tone(p) : `tone-cycle-${i % 6}`)} aria-hidden />{p.label}{c.showValues && <span className="dbui-data">{fmt(p.value)}</span>}</li>)}
          </ul>
        )}
      </div>
    );
  } else body = <Bars pts={pts} w={w} h={h} fmt={fmt} values={c.showValues} />;
  return (
    <div className="dbui-chart" data-testid="chart" data-theme={c.colorTheme ?? "auto"} data-height={c.height ?? "medium"}>
      <div ref={ref}>{body}</div>
      {c.caption && <p className="dbui-hint">{c.caption}</p>}
    </div>
  );
}
