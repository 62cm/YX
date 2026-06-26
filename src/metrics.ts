import { cellAreaKm2 } from "./cellArea";
import type { Cell, ElementKey } from "./types";
import { ELEMENT_KEYS } from "./types";
import type { HeightDiagnostics } from "./terrain";

export type MetricScope = "land" | "full";
export type EcologyMetric = "humidity" | "biomass" | "bioFe" | "bioN";
export type ClimateMetric =
  | "insolationGround"
  | "albedo"
  | "temperature"
  | "cloudWater"
  | "precip"
  | "pressure"
  | "windExposure";
export type MetricDimension = "height" | ElementKey | EcologyMetric | ClimateMetric;

export const METRIC_DIMENSIONS: { id: MetricDimension; label: string }[] = [
  { id: "height", label: "高度 (m)" },
  { id: "humidity", label: "湿度" },
  { id: "biomass", label: "生物量" },
  { id: "bioN", label: "可交换 N" },
  { id: "bioFe", label: "可交换 Fe" },
  { id: "insolationGround", label: "地面日照" },
  { id: "albedo", label: "反照率" },
  { id: "temperature", label: "气温 °C" },
  { id: "cloudWater", label: "物理云水" },
  { id: "precip", label: "降水" },
  { id: "pressure", label: "气压 hPa" },
  { id: "windExposure", label: "辐合抬升" },
  ...ELEMENT_KEYS.map((k) => ({ id: k as MetricDimension, label: `元素 ${k}` })),
];

export function metricValue(cell: Cell, dim: MetricDimension): number {
  if (dim === "height") return cell.height;
  if (dim === "humidity") return cell.humidity;
  if (dim === "biomass") return cell.pools?.biomass ?? 0;
  if (dim === "bioN") return cell.pools?.bioavailable.N ?? 0;
  if (dim === "bioFe") return cell.pools?.bioavailable.Fe ?? 0;
  if (dim === "insolationGround") return cell.insolationGround;
  if (dim === "albedo") return cell.albedo;
  if (dim === "temperature") return cell.temperature;
  if (dim === "cloudWater") return cell.cloudWater;
  if (dim === "precip") return cell.precip;
  if (dim === "pressure") return cell.pressure;
  if (dim === "windExposure") return cell.windExposure;
  return cell.elements[dim] ?? 0;
}

export function scopeCells(cells: Cell[], scope: MetricScope): Cell[] {
  if (scope === "full") return cells;
  return cells.filter((c) => c.height >= 0);
}

export interface ValueRange {
  min: number;
  max: number;
}

export function metricRange(cells: Cell[], dim: MetricDimension): ValueRange {
  let min = Infinity;
  let max = -Infinity;
  for (const c of cells) {
    const v = metricValue(c, dim);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 0.5, max: max + 0.5 };
  return { min, max };
}

export interface AreaHistogram {
  binCenters: number[];
  areas: number[];
  totalArea: number;
  unit: string;
  vmin: number;
  vmax: number;
}

/** 强度 → 面积（km²）分布 */
export function buildAreaHistogram(
  cells: Cell[],
  dim: MetricDimension,
  scope: MetricScope,
  binCount = 48
): AreaHistogram {
  const subset = scopeCells(cells, scope);
  const { min, max } = metricRange(subset, dim);
  const span = Math.max(1e-9, max - min);
  const bins = Math.max(8, binCount);
  const areas = new Float64Array(bins);
  let total = 0;

  for (const cell of subset) {
    const v = metricValue(cell, dim);
    const t = Math.max(0, Math.min(0.999999, (v - min) / span));
    const idx = Math.floor(t * bins);
    const a = cellAreaKm2(cell);
    areas[idx] += a;
    total += a;
  }

  const step = span / bins;
  const binCenters: number[] = [];
  for (let i = 0; i < bins; i++) binCenters.push(min + (i + 0.5) * step);

  return {
    binCenters,
    areas: Array.from(areas),
    totalArea: total,
    unit: dim === "height" ? "km²" : "km²·frac",
    vmin: min,
    vmax: max,
  };
}

export interface JitterBin {
  center: number;
  /** 邻域方差（格均值 vs 邻格差异） */
  neighborVar: number;
  /** 最大邻接梯度 |Δ| */
  edgeGrad: number;
  /** 平滑前后残差（仅高度且有诊断时） */
  smoothResidual: number;
  weight: number;
}

function neighborStats(cell: Cell, cells: Cell[], dim: MetricDimension): { variance: number; edgeGrad: number } {
  const v0 = metricValue(cell, dim);
  const nbs = cell.neighbors;
  if (nbs.length === 0) return { variance: 0, edgeGrad: 0 };

  let sum = v0;
  let sumSq = v0 * v0;
  let n = 1;
  let maxGrad = 0;

  for (const nbId of nbs) {
    const nv = metricValue(cells[nbId], dim);
    sum += nv;
    sumSq += nv * nv;
    n++;
    maxGrad = Math.max(maxGrad, Math.abs(nv - v0));
  }

  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { variance, edgeGrad: maxGrad };
}

/** 强度 → 抖动程度（按强度分箱的面积加权统计） */
export function buildJitterProfile(
  cells: Cell[],
  dim: MetricDimension,
  scope: MetricScope,
  binCount = 40,
  diagnostics: HeightDiagnostics | null = null
): JitterBin[] {
  const subset = scopeCells(cells, scope);
  const { min, max } = metricRange(subset, dim);
  const span = Math.max(1e-9, max - min);
  const bins = Math.max(8, binCount);

  const varSum = new Float64Array(bins);
  const gradSum = new Float64Array(bins);
  const resSum = new Float64Array(bins);
  const weight = new Float64Array(bins);

  for (const cell of subset) {
    const v = metricValue(cell, dim);
    const t = Math.max(0, Math.min(0.999999, (v - min) / span));
    const idx = Math.floor(t * bins);
    const a = cellAreaKm2(cell);
    const { variance, edgeGrad } = neighborStats(cell, cells, dim);
    varSum[idx] += variance * a;
    gradSum[idx] += edgeGrad * a;
    if (dim === "height" && diagnostics) {
      resSum[idx] += Math.abs(diagnostics.smoothResidual[cell.id]) * a;
    }
    weight[idx] += a;
  }

  const step = span / bins;
  const out: JitterBin[] = [];
  for (let i = 0; i < bins; i++) {
    const w = weight[i];
    out.push({
      center: min + (i + 0.5) * step,
      neighborVar: w > 0 ? varSum[i] / w : 0,
      edgeGrad: w > 0 ? gradSum[i] / w : 0,
      smoothResidual: w > 0 ? resSum[i] / w : 0,
      weight: w,
    });
  }
  return out;
}

export interface ProfileHeatmap {
  axis: "x" | "y";
  posBins: number;
  valBins: number;
  /** row-major: pos * valBins + val */
  matrix: Float64Array;
  maxCell: number;
  vmin: number;
  vmax: number;
  bounds: [number, number, number, number];
  dimLabel: string;
}

/** 地图横向/纵向位置 × 强度 的二维面积密度（类似示波器 RGB 分布） */
export function buildProfileHeatmap(
  cells: Cell[],
  dim: MetricDimension,
  scope: MetricScope,
  bounds: [number, number, number, number],
  axis: "x" | "y" = "x",
  posBins = 72,
  valBins = 40
): ProfileHeatmap {
  const subset = scopeCells(cells, scope);
  const [x0, y0, x1, y1] = bounds;
  const { min, max } = metricRange(subset, dim);
  const vSpan = Math.max(1e-9, max - min);
  const matrix = new Float64Array(posBins * valBins);
  let maxCell = 0;

  const posMin = axis === "x" ? x0 : y0;
  const posMax = axis === "x" ? x1 : y1;
  const posSpan = Math.max(1e-9, posMax - posMin);

  for (const cell of subset) {
    const pos = axis === "x" ? cell.site[0] : cell.site[1];
    const v = metricValue(cell, dim);
    const pi = Math.max(0, Math.min(posBins - 1, Math.floor(((pos - posMin) / posSpan) * posBins)));
    const vi = Math.max(0, Math.min(valBins - 1, Math.floor(((v - min) / vSpan) * valBins)));
    const idx = pi * valBins + vi;
    matrix[idx] += cellAreaKm2(cell);
    if (matrix[idx] > maxCell) maxCell = matrix[idx];
  }

  return {
    axis,
    posBins,
    valBins,
    matrix,
    maxCell: maxCell || 1,
    vmin: min,
    vmax: max,
    bounds: [x0, y0, x1, y1],
    dimLabel: dim === "height" ? "高度 m" : dim === "humidity" ? "湿度" : dim === "biomass" ? "生物量" : dim === "bioN" ? "可交换 N" : dim === "bioFe" ? "可交换 Fe" : `${dim} 浓度`,
  };
}
