import { Delaunay } from "d3-delaunay";
import type { Cell, ElementKey, MapLayer, SurfaceKind, VoronoiConfig } from "./types";
import { ELEMENT_KEYS } from "./types";
import { emptyPools } from "./ecology";

/** 创建一个全零的元素组成记录 */
function emptyElements(): Record<ElementKey, number> {
  const e = {} as Record<ElementKey, number>;
  for (const k of ELEMENT_KEYS) e[k] = 0;
  return e;
}

/** 可复现的伪随机数生成器 (mulberry32) */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 计算多边形质心 */
function polygonCentroid(polygon: [number, number][]): [number, number] {
  let cx = 0;
  let cy = 0;
  let area = 0;

  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i];
    const [x1, y1] = polygon[(i + 1) % polygon.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }

  area *= 0.5;
  if (Math.abs(area) < 1e-10) {
    const xs = polygon.map((p) => p[0]);
    const ys = polygon.map((p) => p[1]);
    return [
      xs.reduce((a, b) => a + b, 0) / polygon.length,
      ys.reduce((a, b) => a + b, 0) / polygon.length,
    ];
  }

  const f = 1 / (6 * area);
  return [cx * f, cy * f];
}

/** 在域内随机撒点，返回 [x,y] 数组 */
function scatterPoints(
  count: number,
  bounds: [number, number, number, number],
  rand: () => number
): [number, number][] {
  const [x0, y0, x1, y1] = bounds;
  const points: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    points.push([x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)]);
  }
  return points;
}

/** Lloyd 松弛：将点移到各自 cell 质心 */
function lloydRelax(
  points: [number, number][],
  bounds: [number, number, number, number],
  iterations: number
): [number, number][] {
  const [x0, y0, x1, y1] = bounds;
  let current = points;

  for (let iter = 0; iter < iterations; iter++) {
    const delaunay = Delaunay.from(current);
    const voronoi = delaunay.voronoi([x0, y0, x1, y1]);
    const next: [number, number][] = [];

    for (let i = 0; i < current.length; i++) {
      const poly = voronoi.cellPolygon(i);
      if (!poly || poly.length < 3) {
        next.push(current[i]);
        continue;
      }
      const verts: [number, number][] = [];
      for (let j = 0; j < poly.length; j++) {
        verts.push([poly[j][0], poly[j][1]]);
      }
      const [cx, cy] = polygonCentroid(verts);
      next.push([
        Math.max(x0, Math.min(x1, cx)),
        Math.max(y0, Math.min(y1, cy)),
      ]);
    }
    current = next;
  }

  return current;
}

/** 从 Delaunay 构建邻接表 */
function buildNeighbors(delaunay: Delaunay<[number, number]>, count: number): number[][] {
  const neighbors: number[][] = Array.from({ length: count }, () => []);

  for (let i = 0; i < count; i++) {
    const nbrs = delaunay.neighbors(i);
    for (const j of nbrs) {
      if (!neighbors[i].includes(j)) {
        neighbors[i].push(j);
      }
    }
  }

  return neighbors;
}

/** 生成维诺图 cells */
export function generateVoronoi(config: VoronoiConfig): Cell[] {
  const { cellCount, bounds, lloydIterations, seed } = config;
  const rand = seededRandom(seed);

  let points = scatterPoints(cellCount, bounds, rand);
  points = lloydRelax(points, bounds, lloydIterations);

  const delaunay = Delaunay.from(points);
  const voronoi = delaunay.voronoi(bounds);
  const neighborLists = buildNeighbors(delaunay, cellCount);

  const cells: Cell[] = [];

  for (let i = 0; i < cellCount; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly || poly.length < 3) continue;

    const polygon: [number, number][] = [];
    for (let j = 0; j < poly.length; j++) {
      polygon.push([poly[j][0], poly[j][1]]);
    }

    cells.push({
      id: i,
      site: points[i],
      latDeg: 0,
      lonDeg: 0,
      polygon,
      neighbors: neighborLists[i],
      height: 0,
      elevation: 0,
      fillKind: "none" as const,
      basement: "rock" as const,
      cloud: 0,
      geology: "ocean",
      crustKind: "oceanic",
      bedrockHardness: 0.45,
      weathering: 0,
      sedimentCover: 0,
      elements: emptyElements(),
      surface: "soil" as SurfaceKind,
      vegetation: "none" as const,
      waterFresh: 0,
      waterSalt: 0,
      hoBind: 0,
      oxidation: 0.5,
      reduction: 0,
      insolation: 0.5,
      temperature: 15,
      humidity: 0.5,
      albedo: 0.2,
      insolationTop: 0.5,
      insolationGround: 0.35,
      cloudWater: 0,
      precip: 0,
      pressure: 1013,
      windU: 0,
      windV: 0,
      windExposure: 0,
      hardness: 0.5,
      erodibility: 0.35,
      permeability: 0.5,
      pools: emptyPools(),
    });
  }

  return cells;
}

/** 按种子重建格网拓扑与格心（共演化前必须调用，避免在已变形格网上累积漂移） */
export function resetCellMeshFromSeed(config: VoronoiConfig): Cell[] {
  return generateVoronoi({ ...config, seed: config.seed });
}

/** 保留格数据，仅根据当前 site 重建拓扑（共演化循环用） */
export function rebuildVoronoiTopology(
  cells: Cell[],
  bounds: [number, number, number, number]
): void {
  const points = cells.map((c) => c.site);
  const delaunay = Delaunay.from(points);
  const voronoi = delaunay.voronoi(bounds);
  const neighborLists = buildNeighbors(delaunay, cells.length);

  for (let i = 0; i < cells.length; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly || poly.length < 3) continue;
    const polygon: [number, number][] = [];
    for (let j = 0; j < poly.length; j++) {
      polygon.push([poly[j][0], poly[j][1]]);
    }
    cells[i].polygon = polygon;
    cells[i].neighbors = neighborLists[i];
  }
}

/** 构建宏观层 MapLayer */
export function createMacroLayer(cells: Cell[], config: VoronoiConfig): MapLayer {
  return {
    id: "macro-root",
    level: "macro",
    parentId: null,
    children: [],
    bounds: config.bounds,
    cells,
  };
}

/** 构建区域块层（1000×1000 km 下钻） */
export function createBlockLayer(
  cells: Cell[],
  config: VoronoiConfig,
  id: string,
  parentId: string
): MapLayer {
  return {
    id,
    level: "block",
    parentId,
    children: [],
    bounds: config.bounds,
    cells,
  };
}
