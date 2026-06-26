import type { Cell, TerrainParams } from "./types";
import type { GeoFeature } from "./geoFeatures";
import { featureContribution } from "./geoFeatures";
import { assignCellAttribution, setElevation } from "./attribution";

// ---------------------------------------------------------------------------
// 高度由构造隆升 u 派生（第三步；u 来自地质结构层）
//   u = 陆/洋壳基底 + 造山带 + 岛弧 + 洋中脊 − 海沟 − 裂谷 + 地盾微隆 + 噪声
//   陆地：h = z_max · u^γ  （γ>1 幂律：多低地、少高峰）
//   海洋：h = −z_max · d^γ
// ---------------------------------------------------------------------------

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(seed | 0, 83492791);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);
  const sx = smoothstep(xf);
  const sy = smoothstep(yf);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** 幂律 hypsometry：u∈[0,1] → 归一化高度，γ≈2.3 接近陆地面积-高度分布 */
function hypsometry(u: number, gamma: number): number {
  const t = Math.max(0, Math.min(1, u));
  return Math.pow(t, gamma);
}

/** 沿维诺邻接关系混合高度，削弱格网棱线（在 assignHeights 末尾调用） */
function smoothVoronoiEdges(cells: Cell[], amount: number): void {
  if (amount <= 0) return;
  const passes = Math.max(1, Math.round(amount * 8));
  const blend = 0.12 + amount * 0.38;
  const count = cells.length;
  const buf = new Float64Array(count);

  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < count; i++) {
      const c = cells[i];
      const nbs = c.neighbors;
      if (nbs.length === 0) {
        buf[i] = c.height;
        continue;
      }
      const land = c.height >= 0;
      let sum = c.height;
      let n = 1;
      for (const nb of nbs) {
        const nh = cells[nb].height;
        if ((nh >= 0) !== land) continue;
        sum += nh;
        n++;
      }
      const avg = sum / n;
      buf[i] = c.height * (1 - blend) + avg * blend;
    }
    for (let i = 0; i < count; i++) cells[i].height = buf[i];
  }
}

import type { TectonicState } from "./cellGraph";
import type { CrustEvolutionState } from "./crustEvolution";

/** 中心抬升 + 边缘下沉，形成「陆地居中 / 环海」构图 */
function landCentricField(
  x: number,
  y: number,
  bounds: [number, number, number, number],
  landCentric: number,
  oceanRing: boolean
): number {
  const [x0, y0, x1, y1] = bounds;
  const cx = (x0 + x1) * 0.5;
  const cy = (y0 + y1) * 0.5;
  const half = Math.min(x1 - x0, y1 - y0) * 0.5;
  const d = Math.hypot(x - cx, y - cy) / half;
  const edgeDist = Math.min(x - x0, x1 - x, y - y0, y1 - y);
  const ringBand = oceanRing ? 0.3 : 0.22;
  const edgeSink = smoothstep(Math.min(1, edgeDist / (half * ringBand)));

  let f = 1;
  if (landCentric > 0) {
    const centerBoost = Math.exp(-(d * d) / (2 * 0.4 * 0.4));
    f *= 1 + landCentric * 0.35 * centerBoost;
  }
  if (oceanRing || landCentric > 0) {
    const sinkAmt = oceanRing ? 1 : landCentric;
    const sinkStr = oceanRing ? 0.78 : 0.42;
    f *= 1 - sinkAmt * sinkStr * (1 - edgeSink);
  }
  return Math.max(0.08, f);
}

export function assignHeights(
  cells: Cell[],
  params: TerrainParams,
  features: GeoFeature[],
  tectonic: TectonicState | null,
  bounds: [number, number, number, number] = [0, 0, 1000, 1000],
  crustState?: CrustEvolutionState | null
): void {
  const count = cells.length;
  if (count === 0) return;

  // 维诺格只承载已算好的高度场（结果离散化），不再在此反推 u
  if (crustState) {
    const preSmooth = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      preSmooth[i] = crustState.elevation[i];
      setElevation(cells[i], crustState.elevation[i]);
    }
    smoothVoronoiEdges(cells, params.edgeSmooth);
    const smoothResidual = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      smoothResidual[i] = cells[i].height - preSmooth[i];
      assignCellAttribution(cells[i], bounds, tectonic ?? null);
    }
    lastHeightDiagnostics = { preSmooth, smoothResidual };
    return;
  }

  const { maxHeight, localDecay, seed, oceanRatio, landCentric, oceanRing, hypsometryGamma } =
    params;
  const gamma = hypsometryGamma ?? 2.35;

  const noiseWeight = 0.12 + 0.35 * localDecay;
  const noiseFreq = (1 / 280) * (1 + 1.8 * localDecay);
  const octaves = Math.round(3 + localDecay * 3);

  const raw = new Float64Array(count);
  let rawMax = -Infinity;
  let rawMin = Infinity;

  for (let i = 0; i < count; i++) {
    const [x, y] = cells[i].site;

    let u = 0.12;

    for (const f of features) {
      u += featureContribution(f, x, y);
    }

    const n = fbm(x * noiseFreq, y * noiseFreq, seed, octaves) * 2 - 1;
    const isLandCrust = tectonic ? tectonic.continental[i] === 1 : u > 0.1;
    u += noiseWeight * n * (isLandCrust ? 0.14 : 0.06);

    u *= landCentricField(x, y, bounds, landCentric, oceanRing);

    raw[i] = u;
    if (u > rawMax) rawMax = u;
    if (u < rawMin) rawMin = u;
  }

  const sorted = Array.from(raw).sort((a, b) => a - b);
  const clampedRatio = Math.max(0, Math.min(1, oceanRatio));
  const qIndex = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(clampedRatio * sorted.length))
  );
  const seaLevel = sorted[qIndex];

  const landSpan = Math.max(1e-6, rawMax - seaLevel);
  const oceanSpan = Math.max(1e-6, seaLevel - rawMin);
  const depthScale = maxHeight * 0.92;

  const preSmooth = new Float64Array(count);
  const smoothResidual = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const u = raw[i];
    let h: number;
    if (u >= seaLevel) {
      const t = (u - seaLevel) / landSpan;
      h = maxHeight * hypsometry(t, gamma);
    } else {
      const t = (seaLevel - u) / oceanSpan;
      h = -depthScale * hypsometry(t, gamma * 0.85);
    }
    preSmooth[i] = h;
    cells[i].height = h;
  }

  smoothVoronoiEdges(cells, params.edgeSmooth);

  for (let i = 0; i < count; i++) {
    smoothResidual[i] = cells[i].height - preSmooth[i];
  }

  lastHeightDiagnostics = { preSmooth, smoothResidual };
}

export interface HeightDiagnostics {
  preSmooth: Float64Array;
  smoothResidual: Float64Array;
}

let lastHeightDiagnostics: HeightDiagnostics | null = null;

export function getHeightDiagnostics(): HeightDiagnostics | null {
  return lastHeightDiagnostics;
}

export function heightStats(cells: Cell[]): {
  min: number;
  max: number;
  maxAbs: number;
  landRatio: number;
} {
  let min = Infinity;
  let max = -Infinity;
  let land = 0;
  for (const cell of cells) {
    if (cell.height < min) min = cell.height;
    if (cell.height > max) max = cell.height;
    if (cell.height >= 0) land++;
  }
  const maxAbs = Math.max(Math.abs(min), Math.abs(max), 1);
  const landRatio = cells.length > 0 ? land / cells.length : 0;
  return { min, max, maxAbs, landRatio };
}
