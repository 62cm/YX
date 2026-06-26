import type { Cell } from "./types";

/** 无向格边 a < b */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export interface CellEdge {
  a: number;
  b: number;
  /** 共享棱中点（维诺对偶边，天然曲线折线的一段） */
  midpoint: [number, number];
  /** 共享棱端点 */
  v0: [number, number];
  v1: [number, number];
  length: number;
}

/** 从邻接关系 + 多边形提取对偶边中点 */
export function buildCellEdges(cells: Cell[]): Map<string, CellEdge> {
  const edges = new Map<string, CellEdge>();
  const eps = 1.5;

  for (const cell of cells) {
    const poly = cell.polygon;
    for (const nb of cell.neighbors) {
      if (cell.id >= nb) continue;
      const other = cells[nb];
      if (!other) continue;

      let best: [number, number] | null = null;
      let bestV0: [number, number] = poly[0];
      let bestV1: [number, number] = poly[1];
      let bestLen = 0;

      for (let i = 0; i < poly.length; i++) {
        const p0 = poly[i];
        const p1 = poly[(i + 1) % poly.length];
        const mx = (p0[0] + p1[0]) * 0.5;
        const my = (p0[1] + p1[1]) * 0.5;
        if (!pointNearPolygon([mx, my], other.polygon, eps)) continue;
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        if (len > bestLen) {
          bestLen = len;
          best = [mx, my];
          bestV0 = p0;
          bestV1 = p1;
        }
      }

      const mid: [number, number] = best ?? [
        (cell.site[0] + other.site[0]) * 0.5,
        (cell.site[1] + other.site[1]) * 0.5,
      ];
      const length = bestLen > 0 ? bestLen : Math.hypot(cell.site[0] - other.site[0], cell.site[1] - other.site[1]);

      edges.set(edgeKey(cell.id, nb), {
        a: cell.id,
        b: nb,
        midpoint: mid,
        v0: bestLen > 0 ? bestV0 : mid,
        v1: bestLen > 0 ? bestV1 : mid,
        length,
      });
    }
  }
  return edges;
}

/** 两格共享的维诺棱（用于等高线落在格界上） */
export function getSharedPolygonEdge(
  cell: Cell,
  other: Cell,
  eps = 1.5
): [[number, number], [number, number]] | null {
  const poly = cell.polygon;
  let bestV0: [number, number] | null = null;
  let bestV1: [number, number] | null = null;
  let bestLen = 0;

  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    const mx = (p0[0] + p1[0]) * 0.5;
    const my = (p0[1] + p1[1]) * 0.5;
    if (!pointNearPolygon([mx, my], other.polygon, eps)) continue;
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (len > bestLen) {
      bestLen = len;
      bestV0 = p0;
      bestV1 = p1;
    }
  }

  if (!bestV0 || !bestV1) return null;
  return [bestV0, bestV1];
}

function pointNearPolygon(p: [number, number], poly: [number, number][], eps: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (distToSegment(p, a, b) <= eps) return true;
  }
  return false;
}

function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-8) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}

export type BoundaryKind = "convergent" | "divergent" | "transform";

export type MarginType =
  | "activeMargin"
  | "contCont"
  | "oceanOcean"
  | "passive"
  | "transform";

export interface BoundaryEdge {
  edge: CellEdge;
  kind: BoundaryKind;
  /** 挤压/拉张应变 0~1 */
  compression: number;
  /** 边界构造类型（门控造山/裂谷） */
  marginType: MarginType;
  /** 相对汇聚速度（带符号） */
  approach: number;
}

/** 沿格网邻接走出的折线（脊线 / 海沟 / 板块边界） */
export interface TectonicPolyline {
  kind: "ridge" | "trench" | "plateBoundary" | "landRift" | "orogenBelt" | "mountainRidge";
  /** 经过的 cell id */
  cells: number[];
  /** 折线采样点（对偶边中点串联，天然弯曲） */
  points: [number, number][];
}

export interface PlateRegion {
  id: number;
  cellIds: number[];
  seedCell: number;
  centroid: [number, number];
  /** 板块运动向量 km 单位 */
  velocity: [number, number];
  /** 陆壳(高) vs 洋壳(低) */
  continental: boolean;
  /** 所属大陆团簇（陆壳板块共享漂移方向；-1=洋壳） */
  continentGroup: number;
}

export interface TectonicState {
  plates: PlateRegion[];
  /** 每格所属板块 */
  plateId: Int32Array;
  boundaries: BoundaryEdge[];
  ridges: TectonicPolyline[];
  trenches: TectonicPolyline[];
  /** 活动陆缘 / 陆陆缝合造山带折线 */
  orogenBelts: TectonicPolyline[];
  /** 大陆裂谷折线 */
  landRifts: TectonicPolyline[];
  /** 造山场脊线（陆壳 orogen 局部峰链） */
  mountainRidges: TectonicPolyline[];
  /** 格心到最近脊线强度 0~1 */
  ridgeField: Float64Array;
  /** 格心到最近海沟强度 0~1 */
  trenchField: Float64Array;
  /** 造山带挤压隆升场 0~1（褶皱/逆断层带，陆壳汇聚边界） */
  orogenField: Float64Array;
  /** 岛弧火山热点场 0~1（俯冲带陆侧弧状点源，非海沟环带） */
  arcField: Float64Array;
  /** 裂谷/拉张沉降场 0~1（大陆裂谷、盆地沉降） */
  riftField: Float64Array;
  /** 克拉通稳定度 0~1（古老陆核内部，低构造活动） */
  shieldField: Float64Array;
  /** 褶皱相位（沿挤压方向的正弦调制） */
  foldPhase: Float64Array;
  /** 1=陆壳 0=洋壳（由板块壳类型决定，在地质结构步写入） */
  continental: Uint8Array;
  /** 克拉通强度 0~1 */
  cratonStrength: Float64Array;
  /** 褶皱隆升场（构造过程） */
  foldUpField: Float64Array;
  /** 褶皱沉降场 */
  foldDownField: Float64Array;
  /** 断层破碎带 */
  faultBreakField: Float64Array;
  /** 节理密度（风化入口） */
  jointDensityField: Float64Array;
  /** 共演化时使用的域边界 */
  mapBounds: [number, number, number, number];
  landCentric: number;
  iterations: number;
  /** 汇聚造山强度（mountainCount） */
  orogenAmp: number;
  /** 大陆裂谷强度（basinCount） */
  riftAmp: number;
  /** @deprecated 兼容旧字段 */
  compressionAmp: number;
}

export function polygonCentroid(poly: [number, number][]): [number, number] {
  let cx = 0;
  let cy = 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-10) {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    return [xs.reduce((a, b) => a + b, 0) / poly.length, ys.reduce((a, b) => a + b, 0) / poly.length];
  }
  const f = 1 / (6 * area);
  return [cx * f, cy * f];
}
