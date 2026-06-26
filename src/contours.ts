import type { Cell } from "./types";
import { getSharedPolygonEdge } from "./cellGraph";

export interface ContourSegment {
  level: number;
  p0: [number, number];
  p1: [number, number];
  /** 海平面或陆海交界 */
  isCoastline: boolean;
  /** 主等高线（每 3 条加粗一档） */
  isIndex: boolean;
}

export interface ScalarContourSegment {
  level: number;
  p0: [number, number];
  p1: [number, number];
  /** 主等值线（加粗并标注） */
  isIndex: boolean;
}

/** 连续等值线路径（marching squares + 拼接） */
export interface ContourPath {
  level: number;
  isIndex: boolean;
  points: [number, number][];
  closed: boolean;
}

type Pt = [number, number];

function contourLevels(minV: number, maxV: number, step: number): number[] {
  const lo = Math.floor(minV / step) * step;
  const hi = Math.ceil(maxV / step) * step;
  const levels: number[] = [];
  for (let L = lo; L <= hi + step * 0.5; L += step) levels.push(L);
  return levels;
}

function ptKey(p: Pt): string {
  return `${Math.round(p[0] * 120)}:${Math.round(p[1] * 120)}`;
}

function interp1d(v0: number, v1: number, p0: number, p1: number, level: number): number {
  if (Math.abs(v1 - v0) < 1e-9) return (p0 + p1) * 0.5;
  const t = (level - v0) / (v1 - v0);
  return p0 + t * (p1 - p0);
}

/** 场值采样到规则网格（分桶近邻 + 轻度平滑） */
function sampleFieldGrid(
  cells: Cell[],
  bounds: [number, number, number, number],
  valueOf: (c: Cell) => number,
  gw: number,
  gh: number
): Float64Array {
  const [x0, y0, x1, y1] = bounds;
  const bucketN = 36;
  const buckets: number[][] = Array.from({ length: bucketN * bucketN }, () => []);
  const spanX = Math.max(1e-6, x1 - x0);
  const spanY = Math.max(1e-6, y1 - y0);

  for (const c of cells) {
    const bx = Math.min(bucketN - 1, Math.max(0, Math.floor(((c.site[0] - x0) / spanX) * bucketN)));
    const by = Math.min(bucketN - 1, Math.max(0, Math.floor(((c.site[1] - y0) / spanY) * bucketN)));
    buckets[by * bucketN + bx].push(c.id);
  }

  const grid = new Float64Array(gw * gh);
  const dx = spanX / Math.max(1, gw - 1);
  const dy = spanY / Math.max(1, gh - 1);

  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const x = x0 + i * dx;
      const y = y0 + j * dy;
      const bx = Math.min(bucketN - 1, Math.max(0, Math.floor(((x - x0) / spanX) * bucketN)));
      const by = Math.min(bucketN - 1, Math.max(0, Math.floor(((y - y0) / spanY) * bucketN)));

      let best = -1;
      let bestD = Infinity;
      for (let by2 = by - 1; by2 <= by + 1; by2++) {
        for (let bx2 = bx - 1; bx2 <= bx + 1; bx2++) {
          if (by2 < 0 || by2 >= bucketN || bx2 < 0 || bx2 >= bucketN) continue;
          for (const id of buckets[by2 * bucketN + bx2]) {
            const c = cells[id];
            const d = (c.site[0] - x) ** 2 + (c.site[1] - y) ** 2;
            if (d < bestD) {
              bestD = d;
              best = id;
            }
          }
        }
      }
      grid[j * gw + i] = best >= 0 ? valueOf(cells[best]) : 0;
    }
  }

  const tmp = new Float64Array(gw * gh);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        let s = grid[j * gw + i] * 2;
        let n = 2;
        if (i > 0) {
          s += grid[j * gw + i - 1];
          n++;
        }
        if (i < gw - 1) {
          s += grid[j * gw + i + 1];
          n++;
        }
        if (j > 0) {
          s += grid[(j - 1) * gw + i];
          n++;
        }
        if (j < gh - 1) {
          s += grid[(j + 1) * gw + i];
          n++;
        }
        tmp[j * gw + i] = s / n;
      }
    }
    grid.set(tmp);
  }

  return grid;
}

function chainSegments(segs: { a: Pt; b: Pt }[]): Pt[][] {
  const unused = new Set<number>(segs.map((_, i) => i));
  const paths: Pt[][] = [];

  const extend = (path: Pt[], fromEnd: boolean): void => {
    for (;;) {
      const tip = fromEnd ? path[path.length - 1] : path[0];
      const k = ptKey(tip);
      let found = -1;
      let rev = false;
      for (const i of unused) {
        const s = segs[i];
        if (ptKey(s.a) === k) {
          found = i;
          rev = false;
          break;
        }
        if (ptKey(s.b) === k) {
          found = i;
          rev = true;
          break;
        }
      }
      if (found < 0) break;
      unused.delete(found);
      const s = segs[found];
      if (fromEnd) path.push(rev ? s.a : s.b);
      else path.unshift(rev ? s.b : s.a);
    }
  };

  while (unused.size > 0) {
    const start = unused.values().next().value as number;
    unused.delete(start);
    const s = segs[start];
    const path: Pt[] = [s.a, s.b];
    extend(path, true);
    extend(path, false);
    if (path.length >= 2) paths.push(path);
  }

  return paths;
}

function marchingSquaresLevel(
  grid: Float64Array,
  gw: number,
  gh: number,
  bounds: [number, number, number, number],
  level: number
): { a: Pt; b: Pt }[] {
  const [x0, y0, x1, y1] = bounds;
  const dx = (x1 - x0) / Math.max(1, gw - 1);
  const dy = (y1 - y0) / Math.max(1, gh - 1);
  const segs: { a: Pt; b: Pt }[] = [];

  const at = (i: number, j: number): number => grid[j * gw + i];
  const pos = (i: number, j: number): Pt => [x0 + i * dx, y0 + j * dy];

  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const v0 = at(i, j);
      const v1 = at(i + 1, j);
      const v2 = at(i + 1, j + 1);
      const v3 = at(i, j + 1);

      let idx = 0;
      if (v0 >= level) idx |= 1;
      if (v1 >= level) idx |= 2;
      if (v2 >= level) idx |= 4;
      if (v3 >= level) idx |= 8;
      if (idx === 0 || idx === 15) continue;

      const p0 = pos(i, j);
      const p1 = pos(i + 1, j);
      const p2 = pos(i + 1, j + 1);
      const p3 = pos(i, j + 1);

      const top: Pt = [interp1d(v0, v1, p0[0], p1[0], level), p0[1]];
      const right: Pt = [p1[0], interp1d(v1, v2, p1[1], p2[1], level)];
      const bottom: Pt = [interp1d(v3, v2, p3[0], p2[0], level), p3[1]];
      const left: Pt = [p0[0], interp1d(v0, v3, p0[1], p3[1], level)];

      const push = (a: Pt, b: Pt) => segs.push({ a, b });

      switch (idx) {
        case 1:
        case 14:
          push(left, top);
          break;
        case 2:
        case 13:
          push(top, right);
          break;
        case 3:
        case 12:
          push(left, right);
          break;
        case 4:
        case 11:
          push(right, bottom);
          break;
        case 5:
          push(left, bottom);
          push(top, right);
          break;
        case 6:
        case 9:
          push(top, bottom);
          break;
        case 7:
        case 8:
          push(left, bottom);
          break;
        case 10:
          push(right, bottom);
          push(left, top);
          break;
      }
    }
  }

  return segs;
}

/**
 * 规则网格 marching squares：同场等值线不相交，可闭合
 */
export function buildGridContourPaths(
  cells: Cell[],
  bounds: [number, number, number, number],
  valueOf: (c: Cell) => number,
  step: number,
  opts?: { gridSize?: number; indexEvery?: number }
): ContourPath[] {
  if (cells.length === 0 || step <= 0) return [];

  let minV = Infinity;
  let maxV = -Infinity;
  for (const c of cells) {
    const v = valueOf(c);
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!Number.isFinite(minV)) return [];

  const gw = opts?.gridSize ?? 128;
  const gh = opts?.gridSize ?? 128;
  const grid = sampleFieldGrid(cells, bounds, valueOf, gw, gh);
  const levels = contourLevels(minV, maxV, step);
  const indexStride = opts?.indexEvery ?? 4;
  const out: ContourPath[] = [];

  for (let li = 0; li < levels.length; li++) {
    const L = levels[li];
    const segs = marchingSquaresLevel(grid, gw, gh, bounds, L);
    const chains = chainSegments(segs);
    for (const pts of chains) {
      if (pts.length < 2) continue;
      const closed = ptKey(pts[0]) === ptKey(pts[pts.length - 1]);
      out.push({
        level: L,
        isIndex: li % indexStride === 0,
        points: closed ? pts.slice(0, -1) : pts,
        closed,
      });
    }
  }

  return out;
}

/** @deprecated 维诺棱分段，易不闭合/假交叉；请用 buildGridContourPaths */
export function buildScalarContourSegments(
  cells: Cell[],
  valueOf: (c: Cell) => number,
  step: number,
  opts?: { indexEvery?: number; landOnly?: boolean }
): ScalarContourSegment[] {
  if (cells.length === 0 || step <= 0) return [];

  let minV = Infinity;
  let maxV = -Infinity;
  for (const c of cells) {
    if (opts?.landOnly && c.height < 0) continue;
    const v = valueOf(c);
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!Number.isFinite(minV)) return [];

  const levels = contourLevels(minV, maxV, step);
  const indexStride = opts?.indexEvery ?? 4;
  const out: ScalarContourSegment[] = [];

  for (const cell of cells) {
    if (opts?.landOnly && cell.height < 0) continue;
    const va = valueOf(cell);

    for (const nbId of cell.neighbors) {
      if (cell.id >= nbId) continue;
      const other = cells[nbId];
      if (!other) continue;
      if (opts?.landOnly && other.height < 0) continue;

      const vb = valueOf(other);
      const edge = getSharedPolygonEdge(cell, other);
      if (!edge) continue;

      const [e0, e1] = edge;

      for (let li = 0; li < levels.length; li++) {
        const L = levels[li];
        if ((va - L) * (vb - L) >= 0) continue;
        out.push({
          level: L,
          p0: e0,
          p1: e1,
          isIndex: li % indexStride === 0,
        });
      }
    }
  }

  return out;
}

/** 在维诺邻接棱上提取等高线段（分片常数高度：等高线落在格界上） */
export function buildContourSegments(cells: Cell[], stepM = 600): ContourSegment[] {
  if (cells.length === 0 || stepM <= 0) return [];

  let minH = Infinity;
  let maxH = -Infinity;
  for (const c of cells) {
    if (c.height < minH) minH = c.height;
    if (c.height > maxH) maxH = c.height;
  }

  const levels: number[] = [0];
  for (let L = stepM; L <= maxH + 1; L += stepM) levels.push(L);
  for (let L = -stepM; L >= minH - 1; L -= stepM) levels.push(L);
  levels.sort((a, b) => a - b);

  const out: ContourSegment[] = [];
  const indexLevels = new Set(levels.filter((_, i) => i % 3 === 0));

  for (const cell of cells) {
    for (const nbId of cell.neighbors) {
      if (cell.id >= nbId) continue;
      const other = cells[nbId];
      if (!other) continue;

      const ha = cell.height;
      const hb = other.height;
      const edge = getSharedPolygonEdge(cell, other);
      if (!edge) continue;

      for (const L of levels) {
        if ((ha - L) * (hb - L) >= 0) continue;
        const isCoastline = L === 0 || ha * hb < 0;
        out.push({
          level: L,
          p0: edge[0],
          p1: edge[1],
          isCoastline,
          isIndex: indexLevels.has(L),
        });
      }
    }
  }

  return out;
}
