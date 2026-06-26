import type { Cell } from "./types";
import { mapKmScale, mapPhaseScale } from "./geoFrame";
import type {
  BoundaryEdge,
  CellEdge,
  PlateRegion,
  TectonicPolyline,
  TectonicState,
} from "./cellGraph";
import { buildCellEdges, edgeKey } from "./cellGraph";

/**
 * 板块共演化之后的地质结构层（第二步）：
 *   边界力学 → 构造过程（褶/断/节）→ 构造单元（造山/弧火山/裂谷/地盾）
 * 高度在第三步才从隆升 u 派生。
 */

export interface GeologyParams {
  seed: number;
  orogenAmp: number;
  riftAmp: number;
}

interface CellSpatialGrid {
  cellSize: number;
  buckets: Map<string, number[]>;
}

function buildCellSpatialGrid(cells: Cell[], cellSize: number): CellSpatialGrid {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < cells.length; i++) {
    const [x, y] = cells[i].site;
    const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    const list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  }
  return { cellSize, buckets };
}

function diffuseField(field: Float64Array, cells: Cell[], passes: number): void {
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

function bumpFieldAt(
  field: Float64Array,
  cells: Cell[],
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  mask?: (cellIndex: number) => boolean,
  grid?: CellSpatialGrid
): void {
  const r2 = radius * radius;
  const reach = radius * 2;
  const visit = (i: number) => {
    if (mask && !mask(i)) return;
    const [x, y] = cells[i].site;
    const dx = x - cx;
    const dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2 * 4) return;
    const v = strength * Math.exp(-d2 / (2 * r2));
    if (v > field[i]) field[i] = v;
  };

  if (!grid) {
    for (let i = 0; i < cells.length; i++) visit(i);
    return;
  }

  const cs = grid.cellSize;
  const x0 = Math.floor((cx - reach) / cs);
  const x1 = Math.floor((cx + reach) / cs);
  const y0 = Math.floor((cy - reach) / cs);
  const y1 = Math.floor((cy + reach) / cs);
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const list = grid.buckets.get(`${gx},${gy}`);
      if (!list) continue;
      for (const i of list) visit(i);
    }
  }
}

function bumpAlongSegment(
  field: Float64Array,
  cells: Cell[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  spacing: number,
  radius: number,
  strength: number,
  mask?: (cellIndex: number) => boolean,
  grid?: CellSpatialGrid
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) {
    bumpFieldAt(field, cells, ax, ay, radius, strength, mask, grid);
    return;
  }
  const steps = Math.max(1, Math.ceil(len / spacing));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    bumpFieldAt(field, cells, ax + dx * t, ay + dy * t, radius, strength, mask, grid);
  }
}

/** 第一步：褶皱隆升/沉降、断层破碎、节理密度（构造过程，不是构造单元标签） */
function buildStructuralFields(
  cells: Cell[],
  plateId: Int32Array,
  plates: PlateRegion[],
  boundaries: BoundaryEdge[],
  continentalCrust: Float64Array,
  bounds: [number, number, number, number],
  seed: number,
  orogenAmp: number,
  riftAmp: number
): {
  foldUp: Float64Array;
  foldDown: Float64Array;
  faultBreak: Float64Array;
  jointDensity: Float64Array;
  foldPhase: Float64Array;
  continental: Uint8Array;
} {
  const n = cells.length;
  const foldUp = new Float64Array(n);
  const foldDown = new Float64Array(n);
  const faultBreak = new Float64Array(n);
  const jointDensity = new Float64Array(n);
  const foldPhase = new Float64Array(n);
  const continental = new Uint8Array(n);
  const landCrust = (i: number) => continentalCrust[i] > 0.5;
  const crustAt = (i: number) => (landCrust(i) ? continentalCrust[i] : 0);

  for (let i = 0; i < n; i++) {
    continental[i] = landCrust(i) ? 1 : 0;
  }

  const km = mapKmScale(bounds);
  const ph = mapPhaseScale(bounds);
  const S = (d: number) => d * km;
  const grid = buildCellSpatialGrid(cells, S(55));

  for (const b of boundaries) {
    const { edge, kind, compression, marginType } = b;
    if (compression < 0.06) continue;

    const crustA = crustAt(edge.a);
    const crustB = crustAt(edge.b);
    const landA = plates[plateId[edge.a]].continental;
    const landB = plates[plateId[edge.b]].continental;
    const [ax, ay] = cells[edge.a].site;
    const [bx, by] = cells[edge.b].site;
    const mx = (ax + bx) * 0.5;
    const my = (ay + by) * 0.5;

    const phase = Math.sin((mx * 0.108 * ph + my * 0.071 * ph + seed * 0.13) * Math.PI * 2);
    const str =
      kind === "convergent"
        ? compression * orogenAmp
        : kind === "divergent"
          ? compression * riftAmp
          : compression * orogenAmp * 0.35;

    if (kind === "convergent") {
      const orogenEligible =
        marginType === "activeMargin" ||
        (marginType === "contCont" && compression > 0.22);
      if (!orogenEligible) continue;
      const anticline = Math.max(0, phase);
      const syncline = Math.max(0, -phase);
      bumpAlongSegment(
        foldUp,
        cells,
        ax,
        ay,
        bx,
        by,
        S(22),
        S(38),
        str * 0.62 * anticline,
        (i) => landCrust(i),
        grid
      );
      bumpAlongSegment(
        foldDown,
        cells,
        ax,
        ay,
        bx,
        by,
        S(24),
        S(42),
        str * 0.48 * syncline,
        undefined,
        grid
      );
      for (const ci of [edge.a, edge.b]) {
        foldPhase[ci] = phase;
      }

      if (compression > 0.28) {
        const weakSide = landA && !landB ? edge.b : landB && !landA ? edge.a : crustA < crustB ? edge.a : edge.b;
        const [wx, wy] = cells[weakSide].site;
        bumpFieldAt(faultBreak, cells, wx, wy, S(28), str * 0.72, undefined, grid);
        bumpAlongSegment(
          jointDensity,
          cells,
          ax,
          ay,
          bx,
          by,
          S(18),
          S(32),
          str * 0.35,
          undefined,
          grid
        );
      }
    } else if (kind === "divergent") {
      if (!landA && !landB) continue;
      bumpAlongSegment(
        foldDown,
        cells,
        ax,
        ay,
        bx,
        by,
        S(26),
        S(44),
        str * 0.55,
        (i) => landCrust(i),
        grid
      );
      bumpAlongSegment(
        jointDensity,
        cells,
        ax,
        ay,
        bx,
        by,
        S(20),
        S(36),
        str * 0.42,
        undefined,
        grid
      );
    } else if (kind === "transform" && compression > 0.18) {
      bumpAlongSegment(
        faultBreak,
        cells,
        ax,
        ay,
        bx,
        by,
        S(16),
        S(24),
        str * 0.58,
        undefined,
        grid
      );
      bumpAlongSegment(
        jointDensity,
        cells,
        ax,
        ay,
        bx,
        by,
        S(14),
        S(28),
        str * 0.3,
        undefined,
        grid
      );
    }
  }

  return { foldUp, foldDown, faultBreak, jointDensity, foldPhase, continental };
}

/** 第二步：由构造过程派生威尔逊构造单元场 */
function buildConstructionUnits(
  cells: Cell[],
  plateId: Int32Array,
  plates: PlateRegion[],
  boundaries: BoundaryEdge[],
  _ridges: TectonicPolyline[],
  structural: ReturnType<typeof buildStructuralFields>,
  continentalCrust: Float64Array,
  bounds: [number, number, number, number],
  orogenAmp: number,
  riftAmp: number,
  seed: number
): Pick<
  TectonicState,
  "orogenField" | "arcField" | "riftField" | "shieldField" | "foldPhase" | "continental" | "cratonStrength"
> {
  const n = cells.length;
  const { foldUp, foldDown, jointDensity, foldPhase, continental } = structural;
  const orogenField = new Float64Array(n);
  const arcField = new Float64Array(n);
  const riftField = new Float64Array(n);
  const shieldField = new Float64Array(n);
  const cratonStrength = new Float64Array(n);
  const km = mapKmScale(bounds);
  const ph = mapPhaseScale(bounds);
  const S = (d: number) => d * km;
  const grid = buildCellSpatialGrid(cells, S(55));

  const landOnly = (i: number) => continental[i] === 1;

  for (let i = 0; i < n; i++) {
    orogenField[i] = Math.min(1, foldUp[i] * 1.05 + jointDensity[i] * 0.12);
    riftField[i] = Math.min(1, foldDown[i] * 0.95);
    cratonStrength[i] = continental[i] ? 0.08 : 0;
  }

  const arcSeeds: [number, number][] = [];
  const ARC_OFFSET = S(72);
  const ARC_SPACING = S(105);

  for (const b of boundaries) {
    const { edge, kind, compression, marginType } = b;
    if (compression < 0.08) continue;

    const contA = plates[plateId[edge.a]].continental;
    const contB = plates[plateId[edge.b]].continental;
    const [ax, ay] = cells[edge.a].site;
    const [bx, by] = cells[edge.b].site;
    const mx = (ax + bx) * 0.5;
    const my = (ay + by) * 0.5;
    const tx = bx - ax;
    const ty = by - ay;
    const tlen = Math.hypot(tx, ty) || 1;
    const tux = tx / tlen;
    const tuy = ty / tlen;
    const nx = -tuy;
    const ny = tux;

    if (kind === "convergent") {
      const orogenEligible =
        marginType === "activeMargin" ||
        (marginType === "contCont" && compression > 0.22);
      if (!orogenEligible) continue;

      const uStrength = 0.58 * compression * orogenAmp;
      if (contA && !contB) {
        const lx = ax + nx * S(18);
        const ly = ay + ny * S(18);
        bumpAlongSegment(orogenField, cells, lx, ly, lx + tux * tlen, ly + tuy * tlen, S(24), S(40), uStrength, landOnly, grid);
      } else if (contB && !contA) {
        const lx = bx - nx * S(18);
        const ly = by - ny * S(18);
        bumpAlongSegment(orogenField, cells, lx, ly, lx + tux * tlen, ly + tuy * tlen, S(24), S(40), uStrength, landOnly, grid);
      } else if (contA && contB) {
        bumpAlongSegment(orogenField, cells, ax, ay, bx, by, S(26), S(44), uStrength * 0.95, landOnly, grid);
      }

      if ((contA && !contB) || (contB && !contA)) {
        const landId = contA ? edge.a : edge.b;
        const arcCx = mx + nx * (contA ? 1 : -1) * ARC_OFFSET;
        const arcCy = my + ny * (contA ? 1 : -1) * ARC_OFFSET;
        const segLen = Math.max(ARC_SPACING, tlen);
        const steps = Math.max(1, Math.floor(segLen / ARC_SPACING));
        for (let s = 0; s <= steps; s++) {
          const t = steps === 0 ? 0.5 : s / steps;
          const sx = arcCx + (t - 0.5) * tux * segLen * 0.9;
          const sy = arcCy + (t - 0.5) * tuy * segLen * 0.9;
          const jitter = ((((landId * 17 + s * 131) ^ seed) % 1000) / 1000 - 0.5) * S(18);
          arcSeeds.push([sx + nx * jitter * 0.3, sy + ny * jitter * 0.3]);
        }
      } else if (!contA && !contB) {
        // 洋-洋俯冲岛弧：仅高压缩段，稀疏布点
        if (compression < 0.22) continue;
        const steps = Math.max(1, Math.floor(tlen / (ARC_SPACING * 1.4)));
        for (let s = 0; s <= steps; s++) {
          const t = steps === 0 ? 0.5 : s / steps;
          const sx = mx + (t - 0.5) * tux * tlen;
          const sy = my + (t - 0.5) * tuy * tlen;
          const pick = ((((edge.a * 19 + edge.b * 23 + s * 97) ^ seed) % 1000) / 1000);
          if (pick < 0.45) arcSeeds.push([sx + nx * S(35), sy + ny * S(35)]);
        }
      }
    } else if (kind === "divergent") {
      if (!contA && !contB) continue;
      const rStrength = 0.62 * compression * riftAmp;
      if (contA || contB) {
        // 大陆裂谷：拉张沉降（裂谷盆地，威尔逊循环的「新海盆」前身）
        bumpAlongSegment(riftField, cells, ax, ay, bx, by, S(28), S(48), rStrength, landOnly, grid);
      }
      // 洋-洋离散 = 洋中脊：仅作脊线（仍在海面下），不计入造山隆升
    }
  }
  // 注意：洋中脊隆升由 ridgeField 单独承载（小幅、海面下），不灌入 orogenField，
  // 否则洋壳会被抬出海面误判为火山岛。

  // 陆-陆碰撞缝合带只造山、不产岛弧；零散洋壳火山种子已移除

  for (const [sx, sy] of arcSeeds) {
    bumpFieldAt(arcField, cells, sx, sy, S(22), 0.92, undefined, grid);
  }

  for (let i = 0; i < n; i++) {
    if (orogenField[i] > 0.08) {
      const [x, y] = cells[i].site;
      const phase = foldPhase[i] || Math.sin((x * 0.108 * ph + y * 0.071 * ph + seed * 0.13) * Math.PI * 2);
      orogenField[i] *= 0.84 + 0.16 * phase;
      foldPhase[i] = phase;
    }
    if (!continental[i]) continue;
    const activity = Math.max(orogenField[i], riftField[i], arcField[i] * 0.5);
    shieldField[i] = Math.max(0, continentalCrust[i] * (1 - activity * 1.15));
    cratonStrength[i] = shieldField[i];
  }

  // 打散沿板块边界涂抹的条带，避免 Voronoi 棱线印在高度上
  diffuseField(orogenField, cells, 1);
  diffuseField(riftField, cells, 1);
  diffuseField(arcField, cells, 1);

  return { orogenField, arcField, riftField, shieldField, foldPhase, continental, cratonStrength };
}

function buildPolylineFromPath(
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

/** 陆壳造山场局部峰链 → 山脊折线（与边界折线互补） */
function traceMountainRidges(
  cells: Cell[],
  orogenField: Float64Array,
  continental: Uint8Array,
  bounds: [number, number, number, number],
  threshold = 0.2
): TectonicPolyline[] {
  const n = cells.length;
  const edgeMap = buildCellEdges(cells);
  const isRidge = new Uint8Array(n);
  const land = (i: number) => continental[i] === 1;

  for (let i = 0; i < n; i++) {
    if (!land(i) || orogenField[i] < threshold) continue;
    let peak = true;
    for (const nb of cells[i].neighbors) {
      if (land(nb) && orogenField[nb] > orogenField[i] + 0.02) {
        peak = false;
        break;
      }
    }
    if (peak) isRidge[i] = 1;
  }

  const lines: TectonicPolyline[] = [];
  const used = new Set<number>();
  for (let start = 0; start < n; start++) {
    if (!isRidge[start] || used.has(start)) continue;
    const path = [start];
    used.add(start);
    let cur = start;
    for (let step = 0; step < 22; step++) {
      let best = -1;
      let bestV = orogenField[cur];
      for (const nb of cells[cur].neighbors) {
        if (used.has(nb) || !land(nb) || orogenField[nb] < threshold * 0.65) continue;
        if (orogenField[nb] >= bestV - 0.04) {
          bestV = orogenField[nb];
          best = nb;
        }
      }
      if (best < 0) break;
      path.push(best);
      used.add(best);
      cur = best;
    }
    if (path.length >= 3) {
      lines.push(buildPolylineFromPath(cells, path, "mountainRidge", edgeMap));
    }
  }

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
    return !((dx / len > 0.9 || dy / len > 0.9) && edgeN >= pts.length * 0.65);
  });
}

/**
 * 板块共演化完成后调用：生成地质结构场（构造过程 + 构造单元）。
 */
export function generateGeologicalStructures(
  cells: Cell[],
  kinematics: TectonicState,
  params: GeologyParams,
  continentalCrust: Float64Array
): TectonicState {
  const structural = buildStructuralFields(
    cells,
    kinematics.plateId,
    kinematics.plates,
    kinematics.boundaries,
    continentalCrust,
    kinematics.mapBounds,
    params.seed,
    params.orogenAmp,
    params.riftAmp
  );
  const units = buildConstructionUnits(
    cells,
    kinematics.plateId,
    kinematics.plates,
    kinematics.boundaries,
    kinematics.ridges,
    structural,
    continentalCrust,
    kinematics.mapBounds,
    params.orogenAmp,
    params.riftAmp,
    params.seed
  );
  const mountainRidges = traceMountainRidges(
    cells,
    units.orogenField,
    units.continental,
    kinematics.mapBounds
  );
  return {
    ...kinematics,
    ...units,
    mountainRidges,
    foldUpField: structural.foldUp,
    foldDownField: structural.foldDown,
    faultBreakField: structural.faultBreak,
    jointDensityField: structural.jointDensity,
    orogenAmp: params.orogenAmp,
    riftAmp: params.riftAmp,
    compressionAmp: params.orogenAmp,
  };
}

/** 隆升趋势 u（第三步高度由此派生） */
export function upliftAt(state: TectonicState, cellIndex: number): number {
  const oAmp = state.orogenAmp ?? state.compressionAmp ?? 1;
  const rAmp = state.riftAmp ?? state.compressionAmp ?? 1;
  const isLand = state.continental[cellIndex] === 1;
  let u = isLand ? 0.1 + state.shieldField[cellIndex] * 0.08 : 0.04;
  u += state.orogenField[cellIndex] * 0.52 * oAmp;
  u += state.arcField[cellIndex] * (isLand ? 0.28 : 0.34) * oAmp;
  // 洋中脊只是海面下的浅隆，权重很小，不把洋壳抬出海面
  u += state.ridgeField[cellIndex] * (isLand ? 0.04 : 0.05) * oAmp;
  u -= state.trenchField[cellIndex] * 0.22 * oAmp;
  u -= state.riftField[cellIndex] * (isLand ? 0.52 : 0.08) * rAmp;
  const fold = state.foldPhase[cellIndex];
  if (state.orogenField[cellIndex] > 0.15) {
    u += fold * 0.1 * state.orogenField[cellIndex];
  }
  return u;
}

export function orogenProximity(state: TectonicState, i: number): number {
  return state.orogenField[i];
}

export function arcProximity(state: TectonicState, i: number): number {
  return state.arcField[i];
}

export function riftProximity(state: TectonicState, i: number): number {
  return state.riftField[i];
}

export function shieldProximity(state: TectonicState, i: number): number {
  return state.shieldField[i];
}

export function ridgeProximity(state: TectonicState, i: number): number {
  return state.ridgeField[i];
}

export function trenchProximity(state: TectonicState, i: number): number {
  return state.trenchField[i];
}
