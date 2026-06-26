import type { Cell } from "./types";
import { mapKmScale } from "./geoFrame";
import { seededRandom } from "./voronoi";
import { rebuildVoronoiTopology } from "./voronoi";
import {
  buildCellEdges,
  edgeKey,
  polygonCentroid,
  type BoundaryEdge,
  type BoundaryKind,
  type CellEdge,
  type MarginType,
  type PlateRegion,
  type TectonicPolyline,
  type TectonicState,
} from "./cellGraph";

export interface TectonicLoopParams {
  seed: number;
  iterations: number;
  /** 鏉垮潡绉嶅瓙鏁帮紙闄嗘牳锛?*/
  continentCount: number;
  /** 姹囪仛鎸ゅ帇鍋忕疆 0~1锛屾潵鑷?mountainCount */
  convergentBias: number;
  /** 鎷夊紶瑁傝胺鍋忕疆 0~1锛屾潵鑷?basinCount */
  riftBias: number;
  /** 格网均匀化 0~1 */
  meshUniformity: number;
  /** 活动陆缘造山强度 */
  orogenAmp: number;
  /** 大陆裂谷强度 */
  riftAmp: number;
  bounds: [number, number, number, number];
  /** 0~1 闄嗘牳鍋忎腑蹇冦€佹磱澹冲亸澶栫紭 */
  landCentric: number;
  singleContinent: boolean;
  oceanRing: boolean;
  /** 目标海洋比例 0~1：用于把陆壳面积调到 ≈1-oceanRatio，使海平面落在陆/洋壳之间 */
  oceanRatio: number;
  /** 陆地离散度 0~1（高=更多岛屿/碎裂陆块） */
  decay: number;
  /** 经向环接（行星图左右贴合） */
  toroidalLon?: boolean;
}

function toroidalDelta(dx: number, spanX: number, toroidalLon: boolean): number {
  if (!toroidalLon) return dx;
  if (Math.abs(dx) > spanX * 0.5) return dx - Math.sign(dx) * spanX;
  return dx;
}

function toroidalDist(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  spanX: number,
  toroidalLon: boolean
): number {
  const dx = toroidalDelta(x1 - x2, spanX, toroidalLon);
  const dy = y1 - y2;
  return Math.hypot(dx, dy);
}

/** 瀹為檯鍙備笌鍏辨紨鍖栫殑闄嗗３鍧楁暟 */
export function effectiveContinentCount(params: {
  continentCount: number;
  singleContinent: boolean;
}): number {
  return params.singleContinent ? 1 : Math.max(1, params.continentCount);
}

export function orogenAmplifier(mountainCount: number): number {
  return 0.75 + mountainCount * 0.45;
}

export function riftAmplifier(basinCount: number): number {
  return 0.7 + basinCount * 0.5;
}

/** @deprecated 使用 orogenAmplifier / riftAmplifier */
export function compressionAmplifier(mountainCount: number, basinCount: number): number {
  return 0.9 + mountainCount * 0.14 + basinCount * 0.07;
}

function pickSpreadSeeds(
  cells: Cell[],
  count: number,
  rand: () => number,
  avoid: number[] = [],
  minDist = 120,
  bounds: [number, number, number, number] = [0, 0, 1000, 1000],
  weightFn?: (x: number, y: number) => number,
  pinnedFirst?: number
): number[] {
  const [x0, y0, x1, y1] = bounds;
  const margin = 80;
  const out: number[] = pinnedFirst !== undefined ? [pinnedFirst] : [];
  let attempts = 0;
  const target = count;

  while (out.length < target && attempts < target * 400) {
    attempts++;
    const id = Math.floor(rand() * cells.length);
    if (out.includes(id) || avoid.includes(id)) continue;
    const [x, y] = cells[id].site;
    if (x < x0 + margin || y < y0 + margin || x > x1 - margin || y > y1 - margin) continue;

    if (weightFn) {
      const w = weightFn(x, y);
      if (rand() > Math.min(1, w / 3.5)) continue;
    }

    let ok = true;
    for (const s of out) {
      const [sx, sy] = cells[s].site;
      if (Math.hypot(x - sx, y - sy) < minDist) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    out.push(id);
  }
  return out;
}

/** 娲嬪３鏉垮潡鏁帮細闅忓ぇ闄嗗潡鏁拌ˉ瓒筹紝淇濊瘉娲嬮檰瀵瑰硻 */
export function oceanPlateCount(continentCount: number): number {
  // 多块洋壳围合 → 多向汇聚 + 洋-洋俯冲（岛弧），单大陆也要 5~6 块洋壳
  return Math.max(5, Math.round(continentCount * 1.5) + 3);
}

/** 闅忔満鎵撲贡鍝嚑鍧楁澘鍧椾负闄嗗３銆佸摢鍑犲潡涓烘磱澹?*/
function nearestCellTo(cells: Cell[], x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const d = Math.hypot(cells[i].site[0] - x, cells[i].site[1] - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * 全局漂移：各大陆团簇有统一漂移向量，洋壳整体慢速漂移。
 * 迎流侧=汇聚（活动陆缘），背流侧=离散（被动陆缘），不再全体洋壳冲向大陆。
 */
function orientPlateVelocities(
  plates: PlateRegion[],
  _convergentBias: number,
  rand: () => number
): void {
  const groupDrift = new Map<number, [number, number]>();
  for (const p of plates) {
    if (!p.continental) continue;
    const g = p.continentGroup;
    if (groupDrift.has(g)) continue;
    const angle = rand() * Math.PI * 2;
    const speed = 0.11 + rand() * 0.14;
    groupDrift.set(g, [Math.cos(angle) * speed, Math.sin(angle) * speed]);
  }

  for (const p of plates) {
    if (p.continental) {
      const drift = groupDrift.get(p.continentGroup) ?? [0, 0];
      const pert = 0.025;
      p.velocity = [
        drift[0] + (rand() - 0.5) * pert,
        drift[1] + (rand() - 0.5) * pert,
      ];
      continue;
    }
    const baseAngle = rand() * Math.PI * 2;
    const oceanBase = 0.05 + rand() * 0.04;
    p.velocity = [
      Math.cos(baseAngle) * oceanBase + (rand() - 0.5) * 0.07,
      Math.sin(baseAngle) * oceanBase + (rand() - 0.5) * 0.07,
    ];
  }
}

/** 在中心附近拾取陆核团簇种子（2~4 个相邻点 → 不规则陆块） */
function pickCratonCluster(
  cells: Cell[],
  centerX: number,
  centerY: number,
  clusterSize: number,
  rand: () => number,
  avoid: number[],
  bounds: [number, number, number, number]
): number[] {
  const [x0, y0, x1, y1] = bounds;
  const margin = 70;
  const clusterR = 55 + rand() * 95;
  const out: number[] = [];
  let attempts = 0;
  while (out.length < clusterSize && attempts < clusterSize * 300) {
    attempts++;
    const id = Math.floor(rand() * cells.length);
    if (out.includes(id) || avoid.includes(id)) continue;
    const [x, y] = cells[id].site;
    if (x < x0 + margin || y < y0 + margin || x > x1 - margin || y > y1 - margin) continue;
    if (Math.hypot(x - centerX, y - centerY) > clusterR) continue;
    let ok = true;
    for (const s of out) {
      const [sx, sy] = cells[s].site;
      if (Math.hypot(x - sx, y - sy) < 28) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    out.push(id);
  }
  if (out.length === 0) {
    out.push(nearestCellTo(cells, centerX, centerY));
  }
  return out;
}

function pickPlateSeeds(
  cells: Cell[],
  params: TectonicLoopParams,
  rand: () => number
): { seeds: number[]; continentalFlags: boolean[]; seedContinentGroup: number[] } {
  const [x0, y0, x1, y1] = params.bounds;
  const cx = (x0 + x1) * 0.5;
  const cy = (y0 + y1) * 0.5;
  const half = Math.min(x1 - x0, y1 - y0) * 0.5;
  const nContinents = effectiveContinentCount(params);
  const nOcean = oceanPlateCount(nContinents);
  const lc = Math.max(0, Math.min(1, params.landCentric));
  const decay = Math.max(0, Math.min(1, params.decay ?? 0.5));
  const spanX = x1 - x0;
  const toroidalLon = params.toroidalLon ?? false;

  const continentalSeeds: number[] = [];
  const seedContinentGroup: number[] = [];
  const usedCells: number[] = [];

  const continentCenters: [number, number][] = [];
  if (params.singleContinent) {
    continentCenters.push([cx, cy]);
  } else {
    const minSepFar = half * (0.38 + decay * 0.32);
    const minSepNear = half * (0.14 + decay * 0.12);
    const collideProb = 0.05 + (1 - decay) * 0.38;
    for (let c = 0; c < nContinents; c++) {
      let placed = false;
      for (let att = 0; att < 400 && !placed; att++) {
        const x = x0 + 80 + rand() * (x1 - x0 - 160);
        const y = y0 + 80 + rand() * (y1 - y0 - 160);
        const collide = c > 0 && rand() < collideProb;
        let ok = true;
        for (let j = 0; j < continentCenters.length; j++) {
          const d = toroidalDist(
            x,
            y,
            continentCenters[j][0],
            continentCenters[j][1],
            spanX,
            toroidalLon
          );
          const need = collide ? minSepNear : minSepFar;
          if (d < need) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const w = 1 + lc * 1.8 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (half * half * 0.5));
        if (rand() > Math.min(1, w / 2.8)) continue;
        continentCenters.push([x, y]);
        placed = true;
      }
      if (!placed) {
        const angle = (c / nContinents) * Math.PI * 2 + rand() * 0.5;
        continentCenters.push([cx + Math.cos(angle) * half * 0.35, cy + Math.sin(angle) * half * 0.35]);
      }
    }
  }

  for (let g = 0; g < continentCenters.length; g++) {
    const [gx, gy] = continentCenters[g];
    const clusterSize = params.singleContinent ? 2 + Math.floor(rand() * 3) : 2 + Math.floor(rand() * 3);
    const cluster = pickCratonCluster(cells, gx, gy, clusterSize, rand, usedCells, params.bounds);
    for (const id of cluster) {
      continentalSeeds.push(id);
      seedContinentGroup.push(g);
      usedCells.push(id);
    }
  }

  const oceanWeight = params.oceanRing
    ? (x: number, y: number) => {
        const edgeDist = Math.min(x - x0, x1 - x, y - y0, y1 - y);
        const edgeN = edgeDist / Math.max(1, half * 0.32);
        return 0.35 + (1 - edgeN) * 2.8;
      }
    : undefined;

  const oceanSeeds = pickSpreadSeeds(
    cells,
    nOcean,
    rand,
    continentalSeeds,
    90,
    params.bounds,
    oceanWeight
  );

  const seeds = [...continentalSeeds, ...oceanSeeds];
  const continentalFlags = seeds.map((_, id) => id < continentalSeeds.length);
  for (let i = continentalSeeds.length; i < seeds.length; i++) {
    seedContinentGroup.push(-1);
  }
  return { seeds, continentalFlags, seedContinentGroup };
}

export function tnRidged(x: number, y: number, seed: number, octaves: number): number {
  const v = tnFbm(x, y, seed, octaves);
  return 1 - Math.abs(2 * v - 1);
}

// ---- 域扭曲噪声（让板块边界像蛋壳裂纹一样蜿蜒，而非直线） ----
function tnHash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(seed | 0, 83492791);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

function tnValue(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const v00 = tnHash(x0, y0, seed);
  const v10 = tnHash(x0 + 1, y0, seed);
  const v01 = tnHash(x0, y0 + 1, seed);
  const v11 = tnHash(x0 + 1, y0 + 1, seed);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

export function tnFbm(x: number, y: number, seed: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tnValue(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** 蛋壳裂纹域扭曲：多倍频 fBm + 脊状噪声 + 各向异性 */
export function warpPoint(
  x: number,
  y: number,
  seed: number,
  half: number
): [number, number] {
  const fLow = 1 / (half * 0.55);
  const fMid = 1 / (half * 0.2);
  const fHigh = 1 / (half * 0.085);
  const ampLow = half * 0.32;
  const ampMid = half * 0.16;
  const ampHigh = half * 0.06;
  const aniso = Math.cos((x * 0.0041 + y * 0.0027 + seed * 0.017) * Math.PI * 2);

  const wx =
    ((tnFbm(x * fLow, y * fLow, seed, 4) - 0.5) * 2 * ampLow +
      (tnRidged(x * fMid, y * fMid, seed + 313, 4) - 0.5) * 2 * ampMid * (0.85 + aniso * 0.3) +
      (tnFbm(x * fHigh, y * fHigh, seed + 547, 3) - 0.5) * 2 * ampHigh) *
    (1 + aniso * 0.12);
  const wy =
    ((tnFbm(x * fLow + 4.7, y * fLow + 2.3, seed + 91, 4) - 0.5) * 2 * ampLow +
      (tnRidged(x * fMid + 1.9, y * fMid + 5.1, seed + 811, 4) - 0.5) * 2 * ampMid * (0.85 - aniso * 0.3) +
      (tnFbm(x * fHigh + 1.9, y * fHigh + 5.1, seed + 1201, 3) - 0.5) * 2 * ampHigh) *
    (1 - aniso * 0.12);
  return [x + wx, y + wy];
}

/**
 * 板块归属 = 域扭曲后的最近种子（warped Worley）。
 * 直线垂直平分线被 fbm 弯成蛋壳裂纹；远离种子的边界摆动最大。
 * 沿边界自然裂出的小碎块即微陆块/岛屿。
 */
function assignPlates(
  cells: Cell[],
  seeds: number[],
  continentalFlags: boolean[],
  _rand: () => number,
  seed: number,
  bounds: [number, number, number, number],
  continentalBias = 0,
  seedContinentGroup: number[] = [],
  toroidalLon = false
): { plates: PlateRegion[]; plateId: Int32Array } {
  const n = cells.length;
  const plateId = new Int32Array(n);
  const [x0, y0, x1, y1] = bounds;
  const spanX = x1 - x0;
  const half = Math.min(spanX, y1 - y0) * 0.5;

  const plates: PlateRegion[] = seeds.map((seedCell, id) => ({
    id,
    cellIds: [],
    seedCell,
    centroid: cells[seedCell].site,
    velocity: [0, 0] as [number, number],
    continental: continentalFlags[id] ?? false,
    continentGroup: seedContinentGroup[id] ?? (continentalFlags[id] ? 0 : -1),
  }));

  const seedPos = seeds.map((s) => cells[s].site);
  // 陆壳种子的有效距离减去 bias²（等效扩大陆壳吸引半径）→ 控制陆壳面积
  const biasSq = continentalBias * Math.abs(continentalBias);

  for (let i = 0; i < n; i++) {
    const [x, y] = cells[i].site;
    const [wx, wy] = warpPoint(x, y, seed, half);
    let best = 0;
    let bestD = Infinity;
    for (let s = 0; s < seedPos.length; s++) {
      const dx = toroidalDelta(wx - seedPos[s][0], spanX, toroidalLon);
      const dy = wy - seedPos[s][1];
      let d = dx * dx + dy * dy;
      if (continentalFlags[s]) d -= biasSq;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    plateId[i] = best;
    plates[best].cellIds.push(i);
  }

  // 澶氭簮 Dijkstra锛堟姘忚窛绂伙級鈫?鏉垮潡闈?= 杩炵画 Voronoi锛屼笉鏄牸璺虫暟鏂瑰潡
  for (const p of plates) {
    let sx = 0;
    let sy = 0;
    for (const id of p.cellIds) {
      sx += cells[id].site[0];
      sy += cells[id].site[1];
    }
    const k = p.cellIds.length || 1;
    p.centroid = [sx / k, sy / k];
  }

  return { plates, plateId };
}

function classifyBoundaries(
  cells: Cell[],
  plateId: Int32Array,
  plates: PlateRegion[],
  edges: ReturnType<typeof buildCellEdges>,
  _convergentBias: number,
  _riftBias: number,
  seed: number
): BoundaryEdge[] {
  const out: BoundaryEdge[] = [];
  for (const edge of edges.values()) {
    const pa = plateId[edge.a];
    const pb = plateId[edge.b];
    if (pa === pb) continue;

    const [ax, ay] = cells[edge.a].site;
    const [bx, by] = cells[edge.b].site;
    const nx = by - ay;
    const ny = -(bx - ax);
    const nlen = Math.hypot(nx, ny) || 1;
    const nux = nx / nlen;
    const nuy = ny / nlen;

    const va = plates[pa].velocity;
    const vb = plates[pb].velocity;
    const rel = [va[0] - vb[0], va[1] - vb[1]];
    const approach = rel[0] * nux + rel[1] * nuy;
    const h = ((edge.a * 73856093) ^ (edge.b * 19349663) ^ seed) >>> 0;
    const jitter = ((h % 1000) / 1000 - 0.5) * 0.12;

    const contA = plates[pa].continental;
    const contB = plates[pb].continental;
    const adj = approach + jitter;

    let kind: BoundaryKind = "transform";
    let compression = Math.max(0, Math.abs(adj) * 0.55);

    if (adj > 0.18) {
      kind = "convergent";
      compression = Math.min(1, (adj + 0.12) * 0.9);
    } else if (adj < -0.14) {
      kind = "divergent";
      compression = Math.min(1, (-adj + 0.1) * 0.9);
    }

    let marginType: MarginType = "transform";
    if (kind === "transform") {
      marginType = "transform";
    } else if (contA && contB) {
      marginType = "contCont";
    } else if (contA !== contB) {
      marginType = kind === "convergent" ? "activeMargin" : "passive";
    } else {
      marginType = "oceanOcean";
    }

    out.push({ edge, kind, compression, marginType, approach: adj });
  }
  return out;
}

function computeRawHeights(
  cells: Cell[],
  plateId: Int32Array,
  plates: PlateRegion[],
  boundaries: BoundaryEdge[],
  orogenAmp: number,
  riftAmp: number
): Float64Array {
  const n = cells.length;
  const raw = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const p = plates[plateId[i]];
    raw[i] = p.continental ? 0.42 : 0.08;
  }

  const edgeMap = new Map<string, BoundaryEdge>();
  for (const b of boundaries) edgeMap.set(edgeKey(b.edge.a, b.edge.b), b);

  for (const b of boundaries) {
    const { edge, kind, compression } = b;
    const pa = plateId[edge.a];
    const pb = plateId[edge.b];
    const contA = plates[pa].continental;
    const contB = plates[pb].continental;

    if (kind === "convergent") {
      const upliftSide = contA && !contB ? edge.a : contB && !contA ? edge.b : edge.a;
      const trenchSide = upliftSide === edge.a ? edge.b : edge.a;
      const u = 0.42 * compression * orogenAmp;
      const t = 0.52 * compression * orogenAmp;
      raw[upliftSide] += u;
      raw[trenchSide] -= t;
    } else if (kind === "divergent") {
      const r = 0.34 * compression * riftAmp;
      raw[edge.a] -= r;
      raw[edge.b] -= r;
    }
  }

  return raw;
}

function filterEdgePolylines(
  lines: TectonicPolyline[],
  bounds: [number, number, number, number]
): TectonicPolyline[] {
  const [x0, y0, x1, y1] = bounds;
  const span = Math.min(x1 - x0, y1 - y0);
  const m = span * 0.035;
  return lines.filter((line) => {
    const pts = line.points;
    if (pts.length < 2) return false;
    let edgeN = 0;
    for (const [x, y] of pts) {
      if (x - x0 < m || x1 - x < m || y - y0 < m || y1 - y < m) edgeN++;
    }
    if (edgeN < pts.length * 0.65) return true;
    const [xA, yA] = pts[0];
    const [xB, yB] = pts[pts.length - 1];
    const dx = Math.abs(xB - xA);
    const dy = Math.abs(yB - yA);
    const len = Math.hypot(dx, dy) || 1;
    if ((dx / len > 0.9 || dy / len > 0.9) && edgeN >= pts.length * 0.65) return false;
    return true;
  });
}

function traceRidgesAndTrenches(
  cells: Cell[],
  raw: Float64Array,
  boundaries: BoundaryEdge[],
  edgeMap: Map<string, CellEdge>,
  plateId: Int32Array,
  plates: PlateRegion[],
  bounds: [number, number, number, number]
): { ridges: TectonicPolyline[]; trenches: TectonicPolyline[] } {
  const n = cells.length;
  const isPeak = new Uint8Array(n);
  const oceanAt = (i: number) => !plates[plateId[i]].continental;

  for (let i = 0; i < n; i++) {
    if (!oceanAt(i)) continue;
    let maxN = raw[i];
    for (const nb of cells[i].neighbors) {
      if (raw[nb] > maxN) maxN = raw[nb];
    }
    if (raw[i] >= maxN - 1e-6 && raw[i] > 0.25) isPeak[i] = 1;
  }

  const ridges: TectonicPolyline[] = [];
  const visitedR = new Set<number>();

  for (let start = 0; start < n; start++) {
    if (!isPeak[start] || visitedR.has(start)) continue;
    const path = [start];
    visitedR.add(start);
    let cur = start;
    for (let step = 0; step < 16; step++) {
      let best = -1;
      let bestH = raw[cur];
      for (const nb of cells[cur].neighbors) {
        if (visitedR.has(nb)) continue;
        if (raw[nb] >= bestH - 0.02 && raw[nb] > 0.25) {
          bestH = raw[nb];
          best = nb;
        }
      }
      if (best < 0) break;
      path.push(best);
      visitedR.add(best);
      cur = best;
    }
    if (path.length >= 3) {
      ridges.push(buildPolyline(cells, path, "ridge", edgeMap));
    }
  }

  const trenches: TectonicPolyline[] = [];
  const usedE = new Set<string>();

  for (const b of boundaries) {
    if (b.kind !== "convergent" || b.compression < 0.25) continue;
    if (b.marginType === "contCont") continue;
    const contA = plates[plateId[b.edge.a]].continental;
    const contB = plates[plateId[b.edge.b]].continental;
    if (contA && contB) continue;

    const k = edgeKey(b.edge.a, b.edge.b);
    if (usedE.has(k)) continue;
    usedE.add(k);

    const chain = [b.edge.a, b.edge.b];
    extendChain(cells, chain, b.edge.b, boundaries, usedE);
    extendChain(cells, chain, b.edge.a, boundaries, usedE, true);
    if (chain.length >= 2) {
      trenches.push(buildPolyline(cells, chain, "trench", edgeMap));
    }
  }

  return {
    ridges: filterEdgePolylines(ridges, bounds),
    trenches: filterEdgePolylines(trenches, bounds),
  };
}

function traceLandRifts(
  cells: Cell[],
  plateId: Int32Array,
  plates: PlateRegion[],
  boundaries: BoundaryEdge[],
  edgeMap: Map<string, CellEdge>,
  bounds: [number, number, number, number]
): TectonicPolyline[] {
  const landRifts: TectonicPolyline[] = [];
  const usedE = new Set<string>();

  for (const b of boundaries) {
    if (b.kind !== "divergent" || b.compression < 0.22) continue;
    const contA = plates[plateId[b.edge.a]].continental;
    const contB = plates[plateId[b.edge.b]].continental;
    if (!contA || !contB) continue;

    const k = edgeKey(b.edge.a, b.edge.b);
    if (usedE.has(k)) continue;
    usedE.add(k);

    const chain = [b.edge.a, b.edge.b];
    extendChain(cells, chain, b.edge.b, boundaries, usedE, false, "divergent");
    extendChain(cells, chain, b.edge.a, boundaries, usedE, true, "divergent");
    if (chain.length >= 2) {
      landRifts.push(buildPolyline(cells, chain, "landRift", edgeMap));
    }
  }
  return filterEdgePolylines(landRifts, bounds);
}

function isOrogenBoundary(b: BoundaryEdge): boolean {
  if (b.kind !== "convergent" || b.compression < 0.12) return false;
  return (
    b.marginType === "activeMargin" ||
    (b.marginType === "contCont" && b.compression > 0.22)
  );
}

function extendOrogenChain(
  cells: Cell[],
  chain: number[],
  from: number,
  boundaries: BoundaryEdge[],
  usedE: Set<string>,
  prepend = false
): void {
  let cur = from;
  for (let step = 0; step < 14; step++) {
    let next = -1;
    let bestC = 0;
    for (const nb of cells[cur].neighbors) {
      const k = edgeKey(cur, nb);
      if (usedE.has(k)) continue;
      const b = boundaries.find((x) => edgeKey(x.edge.a, x.edge.b) === k);
      if (!b || !isOrogenBoundary(b)) continue;
      if (b.compression > bestC) {
        bestC = b.compression;
        next = nb;
      }
    }
    if (next < 0) break;
    usedE.add(edgeKey(cur, next));
    if (prepend) chain.unshift(next);
    else chain.push(next);
    cur = next;
  }
}

/** 沿门控后的汇聚边界串联造山带折线（非 raw 场峰值） */
function traceOrogenBelts(
  cells: Cell[],
  boundaries: BoundaryEdge[],
  edgeMap: Map<string, CellEdge>,
  bounds: [number, number, number, number]
): TectonicPolyline[] {
  const belts: TectonicPolyline[] = [];
  const usedE = new Set<string>();
  for (const b of boundaries) {
    if (!isOrogenBoundary(b)) continue;
    const k = edgeKey(b.edge.a, b.edge.b);
    if (usedE.has(k)) continue;
    usedE.add(k);
    const chain = [b.edge.a, b.edge.b];
    extendOrogenChain(cells, chain, b.edge.b, boundaries, usedE);
    extendOrogenChain(cells, chain, b.edge.a, boundaries, usedE, true);
    if (chain.length >= 2) {
      belts.push(buildPolyline(cells, chain, "orogenBelt", edgeMap));
    }
  }
  return filterEdgePolylines(belts, bounds);
}

function extendChain(
  cells: Cell[],
  chain: number[],
  from: number,
  boundaries: BoundaryEdge[],
  usedE: Set<string>,
  prepend = false,
  kindFilter: BoundaryKind = "convergent"
): void {
  let cur = from;
  const maxSteps = 10;
  for (let step = 0; step < maxSteps; step++) {
    let next = -1;
    let bestC = 0;
    for (const nb of cells[cur].neighbors) {
      const k = edgeKey(cur, nb);
      if (usedE.has(k)) continue;
      const b = boundaries.find((x) => edgeKey(x.edge.a, x.edge.b) === k);
      if (!b || b.kind !== kindFilter) continue;
      if (b.compression > bestC) {
        bestC = b.compression;
        next = nb;
      }
    }
    if (next < 0) break;
    usedE.add(edgeKey(cur, next));
    if (prepend) chain.unshift(next);
    else chain.push(next);
    cur = next;
  }
}

function buildPolyline(
  cells: Cell[],
  path: number[],
  kind: TectonicPolyline["kind"],
  edgeMap: Map<string, CellEdge>
): TectonicPolyline {
  const points: [number, number][] = [];
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const e = edgeMap.get(edgeKey(path[i - 1], path[i]));
      if (e) points.push(e.midpoint);
    }
    points.push(cells[path[i]].site);
  }
  return { kind, cells: path, points };
}

function diffuseScalarField(
  field: Float64Array,
  cells: Cell[],
  passes: number
): void {
  const n = field.length;
  const buf = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let sum = field[i] * 2;
      let w = 2;
      for (const nb of cells[i].neighbors) {
        sum += field[nb];
        w++;
      }
      buf[i] = sum / w;
    }
    for (let i = 0; i < n; i++) field[i] = buf[i];
  }
}

function buildProximityField(
  cells: Cell[],
  lines: TectonicPolyline[],
  falloff: number
): Float64Array {
  const n = cells.length;
  const field = new Float64Array(n);
  const inv2f2 = 1 / (2 * falloff * falloff);
  const segments: { ax: number; ay: number; bx: number; by: number }[] = [];
  for (const line of lines) {
    const pts = line.points;
    for (let j = 1; j < pts.length; j++) {
      segments.push({ ax: pts[j - 1][0], ay: pts[j - 1][1], bx: pts[j][0], by: pts[j][1] });
    }
  }
  if (segments.length === 0) return field;

  for (let i = 0; i < n; i++) {
    const [x, y] = cells[i].site;
    let best = 0;
    for (const s of segments) {
      const abx = s.bx - s.ax;
      const aby = s.by - s.ay;
      const len2 = abx * abx + aby * aby;
      let d2: number;
      if (len2 < 1e-8) {
        const dx = x - s.ax;
        const dy = y - s.ay;
        d2 = dx * dx + dy * dy;
      } else {
        let t = ((x - s.ax) * abx + (y - s.ay) * aby) / len2;
        t = Math.max(0, Math.min(1, t));
        const dx = x - (s.ax + t * abx);
        const dy = y - (s.ay + t * aby);
        d2 = dx * dx + dy * dy;
      }
      const v = Math.exp(-d2 * inv2f2);
      if (v > best) best = v;
    }
    field[i] = best;
  }
  return field;
}

/** 鍙洿鏂版眹鑱?瑁傝胺鍋忕疆锛堜笉绉诲姩鏍肩偣銆佷笉閲嶈窇鍏辨紨鍖栬凯浠ｏ級鈥?婊戝潡绉掔骇鍝嶅簲 */
export function refreshTectonicBias(
  cells: Cell[],
  state: TectonicState,
  params: Pick<TectonicLoopParams, "convergentBias" | "riftBias" | "seed" | "orogenAmp" | "riftAmp">
): TectonicState {
  const edges = buildCellEdges(cells);
  const boundaries = classifyBoundaries(
    cells,
    state.plateId,
    state.plates,
    edges,
    params.convergentBias,
    params.riftBias,
    params.seed
  );
  const raw = computeRawHeights(
    cells,
    state.plateId,
    state.plates,
    boundaries,
    params.orogenAmp,
    params.riftAmp
  );
  const traced = traceRidgesAndTrenches(
    cells,
    raw,
    boundaries,
    edges,
    state.plateId,
    state.plates,
    state.mapBounds
  );
  const landRifts = traceLandRifts(
    cells,
    state.plateId,
    state.plates,
    boundaries,
    edges,
    state.mapBounds
  );
  const orogenBelts = traceOrogenBelts(cells, boundaries, edges, state.mapBounds);
  const km = mapKmScale(state.mapBounds);
  return {
    ...state,
    boundaries,
    ridges: traced.ridges,
    trenches: traced.trenches,
    landRifts,
    orogenBelts,
    ridgeField: (() => {
      const f = buildProximityField(cells, traced.ridges, 38 * km);
      diffuseScalarField(f, cells, 2);
      return f;
    })(),
    trenchField: (() => {
      const f = buildProximityField(cells, traced.trenches, 32 * km);
      diffuseScalarField(f, cells, 2);
      return f;
    })(),
    orogenAmp: params.orogenAmp,
    riftAmp: params.riftAmp,
    compressionAmp: params.orogenAmp,
  };
}

function emptyGeologyFields(n: number): Pick<
  TectonicState,
  | "orogenField"
  | "arcField"
  | "riftField"
  | "shieldField"
  | "foldPhase"
  | "continental"
  | "cratonStrength"
  | "foldUpField"
  | "foldDownField"
  | "faultBreakField"
  | "jointDensityField"
> {
  return {
    orogenField: new Float64Array(n),
    arcField: new Float64Array(n),
    riftField: new Float64Array(n),
    shieldField: new Float64Array(n),
    foldPhase: new Float64Array(n),
    continental: new Uint8Array(n),
    cratonStrength: new Float64Array(n),
    foldUpField: new Float64Array(n),
    foldDownField: new Float64Array(n),
    faultBreakField: new Float64Array(n),
    jointDensityField: new Float64Array(n),
  };
}

function coEvolveSites(
  cells: Cell[],
  plateId: Int32Array,
  plates: PlateRegion[],
  boundaries: BoundaryEdge[],
  bounds: [number, number, number, number],
  raw: Float64Array,
  alpha: number,
  baselineSites: [number, number][],
  meshUniformity: number
): void {
  const [x0, y0, x1, y1] = bounds;
  const uni = Math.max(0, Math.min(1, meshUniformity));
  const tectonicScale = 1 - uni * 0.9;
  const maxDrift = 5 + (1 - uni) * 42;
  const boundaryCells = new Set<number>();
  for (const b of boundaries) {
    boundaryCells.add(b.edge.a);
    boundaryCells.add(b.edge.b);
  }

  const boundaryByKey = new Map<string, BoundaryEdge>();
  for (const b of boundaries) boundaryByKey.set(edgeKey(b.edge.a, b.edge.b), b);

  const newSites: [number, number][] = [];

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const lloyd = polygonCentroid(c.polygon);
    const plate = plates[plateId[i]];

    let tx = lloyd[0];
    let ty = lloyd[1];

    const dx = plate.centroid[0] - c.site[0];
    const dy = plate.centroid[1] - c.site[1];
    const interiorPull = (boundaryCells.has(i) ? 0.08 : 0.22) * tectonicScale;
    tx += dx * interiorPull;
    ty += dy * interiorPull;

    if (boundaryCells.has(i)) {
      for (const nb of c.neighbors) {
        if (plateId[nb] === plateId[i]) continue;
        const k = edgeKey(i, nb);
        const b = boundaryByKey.get(k);
        if (!b) continue;
        const mx = b.edge.midpoint[0];
        const my = b.edge.midpoint[1];
        const pull =
          (b.kind === "convergent" ? 0.35 * b.compression : b.kind === "divergent" ? -0.12 : 0.15) *
          tectonicScale;
        tx += (mx - c.site[0]) * pull;
        ty += (my - c.site[1]) * pull;
      }
    }

    const heightBias = (raw[i] - 0.3) * 2.5 * tectonicScale;
    tx += (lloyd[0] - c.site[0]) * heightBias * 0.04;
    ty += (lloyd[1] - c.site[1]) * heightBias * 0.04;

    tx = tx * (1 - uni * 0.55) + lloyd[0] * (uni * 0.55);
    ty = ty * (1 - uni * 0.55) + lloyd[1] * (uni * 0.55);

    let nx = c.site[0] * (1 - alpha) + tx * alpha;
    let ny = c.site[1] * (1 - alpha) + ty * alpha;

    const [bx, by] = baselineSites[i];
    const ddx = nx - bx;
    const ddy = ny - by;
    const drift = Math.hypot(ddx, ddy);
    if (drift > maxDrift) {
      nx = bx + (ddx / drift) * maxDrift;
      ny = by + (ddy / drift) * maxDrift;
    }
    newSites.push([
      Math.max(x0 + 2, Math.min(x1 - 2, nx)),
      Math.max(y0 + 2, Math.min(y1 - 2, ny)),
    ]);
  }

  for (let i = 0; i < cells.length; i++) {
    cells[i].site = newSites[i];
  }
}

/**
 * 缁磋 鈫?鏉垮潡 鍏辨紨鍖栵紙绗竴姝ワ級锛? * 闄嗗３/娲嬪３鏉垮潡绉嶅瓙 鈫?杈圭晫鍒嗙被 鈫?鎸ゅ帇搴斿姏绉诲姩鏍肩偣 鈫?閲嶅缓缁磋銆? * 鍦拌川缁撴瀯鍦哄湪 generateGeologicalStructures 涓敓鎴愶紝涓嶅湪姝ゆ銆? */
/**
 * 缁磋 鈫?鏉垮潡 鍏辨紨鍖栵紙绗竴姝ワ級
 */
export function coEvolveTectonics(cells: Cell[], params: TectonicLoopParams): TectonicState {
  const rand = seededRandom(params.seed + 3307);
  const toroidalLon = params.toroidalLon ?? false;

  const { seeds, continentalFlags, seedContinentGroup } = pickPlateSeeds(cells, params, rand);

  const [bx0, by0, bx1, by1] = params.bounds;
  const bhalf = Math.min(bx1 - bx0, by1 - by0) * 0.5;
  const targetLand = 1 - Math.max(0.05, Math.min(0.92, params.oceanRatio));
  let continentalBias = 0;
  {
    let lo = -bhalf * 0.9;
    let hi = bhalf * 1.4;
    for (let it = 0; it < 16; it++) {
      const mid = (lo + hi) * 0.5;
      const probe = assignPlates(
        cells,
        seeds,
        continentalFlags,
        rand,
        params.seed,
        params.bounds,
        mid,
        seedContinentGroup,
        toroidalLon
      );
      let landCells = 0;
      for (let i = 0; i < cells.length; i++) {
        if (probe.plates[probe.plateId[i]].continental) landCells++;
      }
      const frac = landCells / cells.length;
      if (frac < targetLand) lo = mid;
      else hi = mid;
      continentalBias = mid;
    }
  }

  let { plates, plateId } = assignPlates(
    cells,
    seeds,
    continentalFlags,
    rand,
    params.seed,
    params.bounds,
    continentalBias,
    seedContinentGroup,
    toroidalLon
  );
  orientPlateVelocities(plates, params.convergentBias, rand);
  // 速度固定一次，迭代间不再随机重置（否则差速碰撞失效）
  const plateVelocities: [number, number][] = plates.map((p) => [
    p.velocity[0],
    p.velocity[1],
  ]);

  const baselineSites: [number, number][] = cells.map((c) => [c.site[0], c.site[1]]);

  let boundaries: BoundaryEdge[] = [];
  let raw: Float64Array = new Float64Array(cells.length);
  let ridges: TectonicPolyline[] = [];
  let trenches: TectonicPolyline[] = [];
  let landRifts: TectonicPolyline[] = [];
  let orogenBelts: TectonicPolyline[] = [];

  const iters = Math.max(1, params.iterations);

  for (let iter = 0; iter < iters; iter++) {
    const edges = buildCellEdges(cells);
    boundaries = classifyBoundaries(
      cells,
      plateId,
      plates,
      edges,
      params.convergentBias,
      params.riftBias,
      params.seed + iter * 17
    );
    raw = computeRawHeights(
      cells,
      plateId,
      plates,
      boundaries,
      params.orogenAmp,
      params.riftAmp
    );
    const traced = traceRidgesAndTrenches(
      cells,
      raw,
      boundaries,
      edges,
      plateId,
      plates,
      params.bounds
    );
    ridges = traced.ridges;
    trenches = traced.trenches;
    landRifts = traceLandRifts(cells, plateId, plates, boundaries, edges, params.bounds);
    orogenBelts = traceOrogenBelts(cells, boundaries, edges, params.bounds);

    const t = (iter + 1) / iters;
    const alpha = 0.12 + t * 0.28;
    coEvolveSites(
      cells,
      plateId,
      plates,
      boundaries,
      params.bounds,
      raw,
      alpha,
      baselineSites,
      params.meshUniformity
    );
    rebuildVoronoiTopology(cells, params.bounds);

    ({ plates, plateId } = assignPlates(
      cells,
      seeds,
      continentalFlags,
      rand,
      params.seed,
      params.bounds,
      continentalBias,
      seedContinentGroup,
      toroidalLon
    ));
    for (let pi = 0; pi < plates.length; pi++) {
      plates[pi].velocity = plateVelocities[pi] ?? [0, 0];
    }
  }

  const km = mapKmScale(params.bounds);
  const ridgeField = buildProximityField(cells, ridges, 38 * km);
  const trenchField = buildProximityField(cells, trenches, 32 * km);
  diffuseScalarField(ridgeField, cells, 2);
  diffuseScalarField(trenchField, cells, 2);
  const geology = emptyGeologyFields(cells.length);

  return {
    plates,
    plateId,
    boundaries,
    ridges,
    trenches,
    landRifts,
    orogenBelts,
    mountainRidges: [],
    ridgeField,
    trenchField,
    ...geology,
    iterations: iters,
    orogenAmp: params.orogenAmp,
    riftAmp: params.riftAmp,
    compressionAmp: params.orogenAmp,
    mapBounds: params.bounds,
    landCentric: params.landCentric ?? 0,
  };
}
