/**
 * 行星下钻网格：40×20 = 800 个区域，每块 1000×1000 km
 */

import type { Cell, GeologyKind, MapLayer } from "./types";
import { planetBoundsKm } from "./geoFrame";
import type { TectonicState } from "./cellGraph";

export const REGION_GRID_LON = 40;
export const REGION_GRID_LAT = 20;
export const REGION_KM = 1000;
export const REGION_COUNT = REGION_GRID_LON * REGION_GRID_LAT;

/** 区域边界 [x0,y0,x1,y1] km（行星坐标） */
export function regionBounds(col: number, row: number): [number, number, number, number] {
  return [
    col * REGION_KM,
    row * REGION_KM,
    (col + 1) * REGION_KM,
    (row + 1) * REGION_KM,
  ];
}

export function regionId(col: number, row: number): string {
  return `r-${col}-${row}`;
}

export function parseRegionId(id: string): { col: number; row: number } | null {
  const m = /^r-(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  return { col: Number(m[1]), row: Number(m[2]) };
}

export function regionIndexAtKm(xKm: number, yKm: number): { col: number; row: number } {
  const col = Math.min(REGION_GRID_LON - 1, Math.max(0, Math.floor(xKm / REGION_KM)));
  const row = Math.min(REGION_GRID_LAT - 1, Math.max(0, Math.floor(yKm / REGION_KM)));
  return { col, row };
}

export function isPlanetLayer(layer: MapLayer): boolean {
  return layer.level === "macro";
}

export function regionSeed(worldSeed: number, col: number, row: number): number {
  return ((worldSeed * 73856093) ^ (col * 19349663) ^ (row * 83492791)) >>> 0;
}

export interface RegionSummary {
  col: number;
  row: number;
  bounds: [number, number, number, number];
  meanHeight: number;
  landFraction: number;
  meanTemp: number;
  meanPressure: number;
  meanHumidity: number;
  dominantGeology: GeologyKind;
  /** 区域主导板块 id（众数） */
  plateId: number;
  /** 四边平均高度剖面（各 16 点） */
  edgeHeights: {
    west: number[];
    east: number[];
    north: number[];
    south: number[];
  };
  /** 子区域是否已生成 */
  generated: boolean;
}

function dominantGeology(cells: Cell[]): GeologyKind {
  const counts = new Map<GeologyKind, number>();
  for (const c of cells) {
    counts.set(c.geology, (counts.get(c.geology) ?? 0) + 1);
  }
  let best: GeologyKind = "ocean";
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

function sampleEdgeHeights(
  cells: Cell[],
  bounds: [number, number, number, number],
  edge: "west" | "east" | "north" | "south",
  samples = 16
): number[] {
  const [x0, y0, x1, y1] = bounds;
  const out: number[] = [];
  const margin = REGION_KM * 0.04;
  for (let s = 0; s < samples; s++) {
    const t = samples === 1 ? 0.5 : s / (samples - 1);
    let px: number;
    let py: number;
    if (edge === "west") {
      px = x0 + margin;
      py = y0 + t * (y1 - y0);
    } else if (edge === "east") {
      px = x1 - margin;
      py = y0 + t * (y1 - y0);
    } else if (edge === "south") {
      px = x0 + t * (x1 - x0);
      py = y0 + margin;
    } else {
      px = x0 + t * (x1 - x0);
      py = y1 - margin;
    }
    let best = Infinity;
    let h = 0;
    for (const c of cells) {
      const [cx, cy] = c.site;
      const d = (cx - px) ** 2 + (cy - py) ** 2;
      if (d < best) {
        best = d;
        h = c.height;
      }
    }
    out.push(h);
  }
  return out;
}

function cellsInBounds(
  cells: Cell[],
  bounds: [number, number, number, number]
): Cell[] {
  const [x0, y0, x1, y1] = bounds;
  return cells.filter((c) => {
    const [x, y] = c.site;
    return x >= x0 && x < x1 && y >= y0 && y < y1;
  });
}

/** 从全球层提取 800 个区域摘要 */
export function extractRegionSummaries(
  layer: MapLayer,
  tectonic: TectonicState | null
): RegionSummary[] {
  const summaries: RegionSummary[] = [];
  for (let row = 0; row < REGION_GRID_LAT; row++) {
    for (let col = 0; col < REGION_GRID_LON; col++) {
      const bounds = regionBounds(col, row);
      const subset = cellsInBounds(layer.cells, bounds);
      if (subset.length === 0) {
        summaries.push({
          col,
          row,
          bounds,
          meanHeight: 0,
          landFraction: 0,
          meanTemp: 15,
          meanPressure: 1013,
          meanHumidity: 0.5,
          dominantGeology: "ocean",
          plateId: 0,
          edgeHeights: { west: [], east: [], north: [], south: [] },
          generated: false,
        });
        continue;
      }
      let hSum = 0;
      let land = 0;
      let tSum = 0;
      let pSum = 0;
      let humSum = 0;
      const plateCnt = new Map<number, number>();
      for (const c of subset) {
        hSum += c.height;
        if (c.height >= 0) land++;
        tSum += c.temperature;
        pSum += c.pressure;
        humSum += c.humidity;
        if (tectonic) {
          const pid = tectonic.plateId[c.id];
          plateCnt.set(pid, (plateCnt.get(pid) ?? 0) + 1);
        }
      }
      let plateId = 0;
      let plateBest = -1;
      for (const [pid, n] of plateCnt) {
        if (n > plateBest) {
          plateBest = n;
          plateId = pid;
        }
      }
      summaries.push({
        col,
        row,
        bounds,
        meanHeight: hSum / subset.length,
        landFraction: land / subset.length,
        meanTemp: tSum / subset.length,
        meanPressure: pSum / subset.length,
        meanHumidity: humSum / subset.length,
        dominantGeology: dominantGeology(subset),
        plateId,
        edgeHeights: {
          west: sampleEdgeHeights(layer.cells, bounds, "west"),
          east: sampleEdgeHeights(layer.cells, bounds, "east"),
          north: sampleEdgeHeights(layer.cells, bounds, "north"),
          south: sampleEdgeHeights(layer.cells, bounds, "south"),
        },
        generated: false,
      });
    }
  }
  return summaries;
}

/** 在宏观层上查找最近格心 */
export function sampleMacroCell(planetLayer: MapLayer, x: number, y: number): Cell | null {
  let best = Infinity;
  let hit: Cell | null = null;
  for (const c of planetLayer.cells) {
    const [cx, cy] = c.site;
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < best) {
      best = d;
      hit = c;
    }
  }
  return hit;
}

export function isPlanetBounds(bounds: [number, number, number, number]): boolean {
  const pb = planetBoundsKm();
  return (
    bounds[0] === pb[0] &&
    bounds[1] === pb[1] &&
    bounds[2] === pb[2] &&
    bounds[3] === pb[3]
  );
}
