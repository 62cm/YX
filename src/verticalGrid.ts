/**
 * 垂直高度分层：近地面细、高空粗（0–10 km）
 * 0–10 m: 1 m · 10–100 m: 10 m · 100–1000 m: 100 m · 1000–10000 m: 1000 m
 */

export interface VerticalLevel {
  index: number;
  /** 层底高度 m */
  bottom: number;
  /** 层顶高度 m */
  top: number;
  /** 层厚 m */
  dz: number;
  /** 层中心 m */
  mid: number;
}

function pushRange(
  levels: VerticalLevel[],
  start: number,
  end: number,
  dz: number
): void {
  for (let z = start; z < end; z += dz) {
    levels.push({
      index: levels.length,
      bottom: z,
      top: z + dz,
      dz,
      mid: z + dz * 0.5,
    });
  }
}

/** 37 层：10 + 9 + 9 + 9 */
export function buildVerticalGrid(): VerticalLevel[] {
  const levels: VerticalLevel[] = [];
  pushRange(levels, 0, 10, 1);
  pushRange(levels, 10, 100, 10);
  pushRange(levels, 100, 1000, 100);
  pushRange(levels, 1000, 10000, 1000);
  return levels;
}

export const VERTICAL_LEVELS: readonly VerticalLevel[] = buildVerticalGrid();
export const VERTICAL_LEVEL_COUNT = VERTICAL_LEVELS.length;

/** 海拔所在层索引（地表可在层内） */
export function levelIndexForElevation(zM: number): number {
  const z = Math.max(0, Math.min(9999.9, zM));
  for (let i = VERTICAL_LEVELS.length - 1; i >= 0; i--) {
    if (z >= VERTICAL_LEVELS[i]!.bottom) return i;
  }
  return 0;
}

/** 格点垂直大气剖面（各层 T/q/u/v/p） */
export interface AtmColumn {
  levelZ: Float32Array;
  T: Float32Array;
  q: Float32Array;
  u: Float32Array;
  v: Float32Array;
  p: Float32Array;
  /** 近地面层索引（由 elevation 决定） */
  surfaceLevel: number;
}

export function createAtmColumn(): AtmColumn {
  const n = VERTICAL_LEVEL_COUNT;
  const levelZ = new Float32Array(n);
  for (let i = 0; i < n; i++) levelZ[i] = VERTICAL_LEVELS[i]!.mid;
  return {
    levelZ,
    T: new Float32Array(n),
    q: new Float32Array(n),
    u: new Float32Array(n),
    v: new Float32Array(n),
    p: new Float32Array(n),
    surfaceLevel: 0,
  };
}

/** 用格点地面状态填充整列（简化：各层按高度递减率外推） */
export function syncAtmColumnFromSurface(
  col: AtmColumn,
  surfaceElevM: number,
  surfaceT: number,
  surfaceQ: number,
  surfaceU: number,
  surfaceV: number,
  surfaceP: number
): void {
  col.surfaceLevel = levelIndexForElevation(surfaceElevM);
  const lapse = 0.0065; // K/m
  for (let i = 0; i < VERTICAL_LEVEL_COUNT; i++) {
    const z = col.levelZ[i]!;
    const dz = Math.max(0, z - surfaceElevM);
    col.T[i] = surfaceT - lapse * dz;
    col.q[i] = Math.max(0, surfaceQ * Math.exp(-dz / 2800));
    col.u[i] = surfaceU;
    col.v[i] = surfaceV;
    col.p[i] = surfaceP * Math.exp(-dz / 8400);
  }
}
