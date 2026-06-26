import type { AreaHistogram, JitterBin, ProfileHeatmap } from "./metrics";
import type { MetricDimension } from "./metrics";

const FONT = "9px Segoe UI, system-ui, sans-serif";
const TICK_FONT = "8px Segoe UI, system-ui, sans-serif";

interface PlotRect {
  plotX: number;
  plotY: number;
  plotW: number;
  plotH: number;
}

function niceStep(span: number, targetTicks: number): number {
  if (span <= 0) return 1;
  const raw = span / Math.max(2, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1.5) return mag;
  if (norm <= 3) return 2 * mag;
  if (norm <= 7) return 5 * mag;
  return 10 * mag;
}

function niceTicks(min: number, max: number, targetTicks = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) return [min];
  const step = niceStep(max - min, targetTicks);
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  if (ticks.length === 0) ticks.push(min, max);
  return ticks;
}

function formatIntensity(v: number, dim: MetricDimension | "generic"): string {
  if (dim === "pressure") {
    if (!Number.isFinite(v)) return "—";
    const p = Math.max(980, Math.min(1050, v));
    return `${Math.round(p)}`;
  }
  if (dim === "height") {
    const r = Math.round(v);
    if (Math.abs(r) >= 10000) return `${(r / 1000).toFixed(0)}k`;
    if (Math.abs(r) >= 1000) return `${(r / 1000).toFixed(1)}k`;
    return `${r}`;
  }
  if (Math.abs(v) < 0.001) return v.toExponential(1);
  if (Math.abs(v) < 1) return v.toFixed(2);
  if (Math.abs(v) < 100) return v.toFixed(1);
  return `${Math.round(v)}`;
}

function formatAreaY(v: number): string {
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return `${Math.round(v)}`;
  if (v >= 10) return v.toFixed(0);
  return v.toFixed(1);
}

function formatJitterY(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  if (v >= 0.01) return v.toFixed(2);
  return v.toExponential(1);
}

function formatPosKm(v: number): string {
  if (v >= 1000) return "1000";
  if (v % 250 === 0) return `${v}`;
  return `${Math.round(v)}`;
}

function prepCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  cssW: number;
  cssH: number;
} {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, cssW: rect.width, cssH: rect.height };
}

function measureLeftMargin(
  ctx: CanvasRenderingContext2D,
  yTicks: number[],
  formatY: (v: number) => string
): number {
  ctx.font = TICK_FONT;
  let maxW = 0;
  for (const t of yTicks) {
    maxW = Math.max(maxW, ctx.measureText(formatY(t)).width);
  }
  return Math.max(34, maxW + 8);
}

function beginPlot(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  title: string,
  leftMargin: number
): PlotRect {
  ctx.fillStyle = "#141820";
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#8a9aaa";
  ctx.font = FONT;
  ctx.textAlign = "left";
  ctx.fillText(title, 6, 11);

  const margin = { l: leftMargin, r: 6, t: 16, b: 20 };
  return {
    plotX: margin.l,
    plotY: margin.t,
    plotW: cssW - margin.l - margin.r,
    plotH: cssH - margin.t - margin.b,
  };
}

function valToX(v: number, vmin: number, vmax: number, plot: PlotRect): number {
  const span = Math.max(1e-9, vmax - vmin);
  return plot.plotX + ((v - vmin) / span) * plot.plotW;
}

function valToY(v: number, vmin: number, vmax: number, plot: PlotRect): number {
  const span = Math.max(1e-9, vmax - vmin);
  return plot.plotY + plot.plotH - ((v - vmin) / span) * plot.plotH;
}

/** 绘制带数值的横纵标尺 */
function drawAxisRulers(
  ctx: CanvasRenderingContext2D,
  plot: PlotRect,
  xTicks: number[],
  yTicks: number[],
  formatX: (v: number) => string,
  formatY: (v: number) => string,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
): void {
  ctx.strokeStyle = "#3a4a5c";
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.plotX, plot.plotY, plot.plotW, plot.plotH);

  ctx.font = TICK_FONT;
  ctx.fillStyle = "#7a8a9a";
  ctx.strokeStyle = "#2e3a48";
  ctx.lineWidth = 1;

  for (const xv of xTicks) {
    const x = valToX(xv, xMin, xMax, plot);
    ctx.beginPath();
    ctx.moveTo(x, plot.plotY + plot.plotH);
    ctx.lineTo(x, plot.plotY + plot.plotH + 3);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(formatX(xv), x, plot.plotY + plot.plotH + 4);
    ctx.beginPath();
    ctx.moveTo(x, plot.plotY);
    ctx.lineTo(x, plot.plotY + plot.plotH);
    ctx.strokeStyle = "rgba(46,58,72,0.45)";
    ctx.stroke();
    ctx.strokeStyle = "#2e3a48";
  }

  for (const yv of yTicks) {
    const y = valToY(yv, yMin, yMax, plot);
    ctx.beginPath();
    ctx.moveTo(plot.plotX - 3, y);
    ctx.lineTo(plot.plotX, y);
    ctx.strokeStyle = "#2e3a48";
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(formatY(yv), plot.plotX - 5, y);
    ctx.beginPath();
    ctx.moveTo(plot.plotX, y);
    ctx.lineTo(plot.plotX + plot.plotW, y);
    ctx.strokeStyle = "rgba(46,58,72,0.45)";
    ctx.stroke();
    ctx.strokeStyle = "#2e3a48";
  }
}

/** 强度 × 面积 柱状分布 */
export function drawAreaHistogram(
  canvas: HTMLCanvasElement,
  data: AreaHistogram,
  dimLabel: string,
  dim: MetricDimension = "height"
): void {
  const { ctx, cssW, cssH } = prepCanvas(canvas);
  const maxA = Math.max(...data.areas, 1e-9);
  const yTicks = niceTicks(0, maxA, 4);
  const xTicks = niceTicks(data.vmin, data.vmax, 4);
  const plot = beginPlot(
    ctx,
    cssW,
    cssH,
    `面积分布 · ${dimLabel}`,
    measureLeftMargin(ctx, yTicks, formatAreaY)
  );

  drawAxisRulers(
    ctx,
    plot,
    xTicks,
    yTicks,
    (v) => formatIntensity(v, dim),
    formatAreaY,
    data.vmin,
    data.vmax,
    0,
    maxA
  );

  const n = data.areas.length;
  const span = Math.max(1e-9, data.vmax - data.vmin);
  const binW = span / n;
  const barPixW = plot.plotW / n;

  for (let i = 0; i < n; i++) {
    const a = data.areas[i];
    if (a <= 0) continue;
    const bh = (a / maxA) * plot.plotH;
    const binLo = data.vmin + i * binW;
    const x = valToX(binLo, data.vmin, data.vmax, plot);
    const y = plot.plotY + plot.plotH - bh;
    const t = i / Math.max(1, n - 1);
    ctx.fillStyle = `hsla(${28 + t * 40}, 55%, 58%, 0.85)`;
    ctx.fillRect(x, y, Math.max(1, barPixW - 0.5), bh);
  }
}

/** 强度 × 抖动（邻域方差 / 棱梯度 / 平滑残差） */
export function drawJitterChart(
  canvas: HTMLCanvasElement,
  bins: JitterBin[],
  dimLabel: string,
  showSmoothResidual: boolean,
  dim: MetricDimension = "height"
): void {
  const { ctx, cssW, cssH } = prepCanvas(canvas);
  const title = showSmoothResidual
    ? `抖动 · ${dimLabel}`
    : `抖动 · ${dimLabel}`;

  const series: { key: keyof JitterBin; color: string; values: number[] }[] = [
    { key: "neighborVar", color: "rgba(230,150,80,0.9)", values: [] },
    { key: "edgeGrad", color: "rgba(80,200,210,0.9)", values: [] },
  ];
  if (showSmoothResidual) {
    series.push({ key: "smoothResidual", color: "rgba(180,120,230,0.9)", values: [] });
  }

  let maxY = 1e-9;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const b of bins) {
    if (b.center < xMin) xMin = b.center;
    if (b.center > xMax) xMax = b.center;
    for (const s of series) {
      const v = b[s.key] as number;
      s.values.push(v);
      if (v > maxY) maxY = v;
    }
  }
  if (!Number.isFinite(xMin)) {
    xMin = 0;
    xMax = 1;
  }

  const yTicks = niceTicks(0, maxY, 4);
  const xTicks = niceTicks(xMin, xMax, 4);
  const plot = beginPlot(
    ctx,
    cssW,
    cssH,
    title,
    measureLeftMargin(ctx, yTicks, formatJitterY)
  );

  drawAxisRulers(
    ctx,
    plot,
    xTicks,
    yTicks,
    (v) => formatIntensity(v, dim),
    formatJitterY,
    xMin,
    xMax,
    0,
    maxY
  );

  const n = bins.length;
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = valToX(bins[i].center, xMin, xMax, plot);
      const y = valToY(s.values[i], 0, maxY, plot);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** 地图位置 × 强度 二维热图 */
export function drawProfileHeatmap(
  canvas: HTMLCanvasElement,
  heat: ProfileHeatmap,
  dim: MetricDimension = "height"
): void {
  const { ctx, cssW, cssH } = prepCanvas(canvas);
  const [bx0, , bx1] = heat.bounds;
  const posMin = heat.axis === "x" ? bx0 : heat.bounds[1];
  const posMax = heat.axis === "x" ? bx1 : heat.bounds[3];

  const yTicks = niceTicks(heat.vmin, heat.vmax, 5);
  const xTicks = niceTicks(posMin, posMax, 4);
  const plot = beginPlot(
    ctx,
    cssW,
    cssH,
    `剖面密度 · ${heat.dimLabel}`,
    measureLeftMargin(ctx, yTicks, (v) => formatIntensity(v, dim))
  );

  drawAxisRulers(
    ctx,
    plot,
    xTicks,
    yTicks,
    formatPosKm,
    (v) => formatIntensity(v, dim),
    posMin,
    posMax,
    heat.vmin,
    heat.vmax
  );

  const { posBins, valBins, matrix, maxCell } = heat;
  const posSpan = Math.max(1e-9, posMax - posMin);
  const valSpan = Math.max(1e-9, heat.vmax - heat.vmin);

  for (let pi = 0; pi < posBins; pi++) {
    for (let vi = 0; vi < valBins; vi++) {
      const v = matrix[pi * valBins + vi];
      if (v <= 0) continue;
      const t = Math.min(1, v / maxCell);
      const hue = 210 - t * 170;
      ctx.fillStyle = `hsla(${hue}, 70%, ${35 + t * 35}%, ${0.25 + t * 0.75})`;

      const posLo = posMin + (pi / posBins) * posSpan;
      const posHi = posMin + ((pi + 1) / posBins) * posSpan;
      const valLo = heat.vmin + (vi / valBins) * valSpan;
      const valHi = heat.vmin + ((vi + 1) / valBins) * valSpan;

      const x = valToX(posLo, posMin, posMax, plot);
      const w = valToX(posHi, posMin, posMax, plot) - x;
      const yTop = valToY(valHi, heat.vmin, heat.vmax, plot);
      const yBot = valToY(valLo, heat.vmin, heat.vmax, plot);
      ctx.fillRect(x, yTop, Math.max(0.5, w), yBot - yTop);
    }
  }
}

export function resizeCharts(...canvases: HTMLCanvasElement[]): void {
  for (const c of canvases) {
    const parent = c.parentElement;
    if (!parent) continue;
    const rect = parent.getBoundingClientRect();
    c.style.width = `${rect.width}px`;
    c.style.height = `${rect.height}px`;
  }
}
