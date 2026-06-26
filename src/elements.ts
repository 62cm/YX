import type { Cell, ElementKey, GeologyKind } from "./types";
import { isOceanCell } from "./attribution";
import { ELEMENT_KEYS, MATRIX_ELEMENT_KEYS, RESOURCE_ELEMENT_KEYS, VEIN_RULES } from "./types";
import type { GeoFeature } from "./geoFeatures";
import { contributionsAt } from "./geoFeatures";
import type { TectonicState } from "./cellGraph";
import {
  arcProximity,
  orogenProximity,
  riftProximity,
  shieldProximity,
} from "./geologyFromTectonics";
import { seededRandom } from "./voronoi";

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(seed | 0, 83492791);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = smoothstep(x - x0);
  const yf = smoothstep(y - y0);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);
  const a = v00 + (v10 - v00) * xf;
  const b = v01 + (v11 - v01) * xf;
  return a + (b - a) * yf;
}

function fbm2(x: number, y: number, seed: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const PROV_FREQ = 1 / 230;

function backgroundWeights(
  kind: GeologyKind,
  elevN: number,
  noise: number
): Record<ElementKey, number> {
  const w = {} as Record<ElementKey, number>;
  const lowland = 1 - elevN;
  switch (kind) {
    case "ocean":
      w.H = 2.0; w.O = 1.2; w.Na = 0.25; w.Ca = 0.12; w.C = 0.1; w.Si = 0.05; w.Fe = 0.03; w.N = 0.05;
      break;
    case "shield":
      w.O = 1.5; w.Si = 1.1 + 0.4 * noise; w.Fe = 0.15; w.Ca = 0.18; w.Na = 0.18; w.H = 0.10; w.C = 0.05; w.N = 0.03;
      break;
    case "mountain":
      w.O = 1.5; w.Si = 1.15 + 0.4 * noise; w.Fe = 0.15; w.Ca = 0.15; w.Na = 0.15; w.H = 0.08; w.C = 0.03; w.N = 0.02;
      break;
    case "basin":
      w.O = 1.3; w.Si = 0.75 + 0.3 * noise; w.Ca = 0.30; w.C = 0.10 + 0.15 * lowland; w.Na = 0.28; w.Fe = 0.10; w.H = 0.20 + 0.2 * lowland; w.N = 0.06;
      break;
    case "volcanic":
      w.O = 1.3; w.Si = 0.95 + 0.3 * noise; w.Fe = 0.30; w.Ca = 0.2; w.Na = 0.2; w.H = 0.1; w.C = 0.03; w.N = 0.02;
      break;
  }
  return w;
}

interface Deposit {
  x: number;
  y: number;
  key: ElementKey;
  r: number;
  intensity: number;
  angle: number;
  aspect: number;
}

/** 岛弧热点：格点 arc 场局部峰（点状火山，非条带） */
function isArcHotspot(cells: Cell[], tectonic: TectonicState, id: number, arc: number): boolean {
  if (arc < 0.58) return false;
  for (const nb of cells[id].neighbors) {
    if (tectonic.arcField[nb] > arc + 0.015) return false;
  }
  return true;
}

/** 构造单元标签：由两壳 + 威尔逊阶段场判定（非高度反推） */
function classifyGeology(cells: Cell[], features: GeoFeature[], tectonic: TectonicState | null): void {
  // 陆地高度分位：低地（沉积汇水区）→ 盆地，高地稳定 → 地盾
  const landH: number[] = [];
  for (const c of cells) if (c.height >= 0) landH.push(c.height);
  landH.sort((a, b) => a - b);
  const lowlandCut = landH.length > 0 ? landH[Math.floor(landH.length * 0.12)] : 0;

  for (const c of cells) {
    // 海面以下：海盆（威尔逊循环起止端）
    if (isOceanCell(c) || (c.crustKind === "oceanic" && c.height < 0)) {
      c.geology = "ocean";
      continue;
    }

    const [x, y] = c.site;
    const contribs = contributionsAt(features, x, y);
    const shieldCore = tectonic ? 0 : contribs.plateau;
    const onOceanCrust = tectonic ? tectonic.continental[c.id] === 0 : false;
    const orogen = tectonic ? orogenProximity(tectonic, c.id) : 0;
    const arc = tectonic ? arcProximity(tectonic, c.id) : 0;
    const rift = tectonic ? riftProximity(tectonic, c.id) : 0;
    const shield = tectonic ? shieldProximity(tectonic, c.id) : shieldCore;
    const sed = c.sedimentCover;

    // 地盾为陆壳默认；火山/造山/盆地为局部例外
    let kind: GeologyKind = "shield";

    if (tectonic && isArcHotspot(cells, tectonic, c.id, arc) && arc > 0.52) {
      kind = "volcanic";
    } else if (orogen > 0.28) {
      kind = "mountain";
    } else if (onOceanCrust) {
      kind = arc > 0.42 ? "volcanic" : "ocean";
    } else if (rift > 0.22) {
      kind = "basin";
    } else if (sed > 0.38 || (orogen > 0.12 && sed > 0.18)) {
      kind = "basin";
    } else if (c.height < lowlandCut && sed > 0.22) {
      kind = "basin";
    } else if (shield > 0.2 || shieldCore > 0.02) {
      kind = "shield";
    } else {
      kind = "shield";
    }

    c.geology = kind;
  }
}

function veinDensityFactors(density: number): { countMult: number; intensityMult: number; radiusMult: number } {
  const t = Math.max(0, Math.min(1, density));
  // 分散(0)：矿点更多、更弱、范围略大 → 贫矿；密集(1)：矿点更少、更强、范围更小 → 富矿
  return {
    countMult: 1.65 - t * 1.2,
    intensityMult: 0.55 + t * 2.05,
    radiusMult: 1.12 - t * 0.37,
  };
}

function generateDeposits(cells: Cell[], seed: number, veinDensity: number): Deposit[] {
  const rand = seededRandom(seed + 333);
  const deposits: Deposit[] = [];
  const { countMult, intensityMult, radiusMult } = veinDensityFactors(veinDensity);

  const byKind: Record<GeologyKind, number[]> = {
    ocean: [], shield: [], mountain: [], basin: [], volcanic: [],
  };
  for (const c of cells) byKind[c.geology].push(c.id);

  function placeFromPool(
    pool: number[],
    count: number,
    key: ElementKey,
    rRange: [number, number],
    intensity: number,
    aspect: number
  ) {
    if (pool.length === 0 || count <= 0) return;
    for (let i = 0; i < count; i++) {
      const id = pool[Math.floor(rand() * pool.length)];
      const [x, y] = cells[id].site;
      const r0 = rRange[0] * radiusMult;
      const r1 = rRange[1] * radiusMult;
      const r = r0 + rand() * (r1 - r0);
      deposits.push({
        x, y, key, r,
        intensity: intensity * intensityMult * (0.6 + 0.8 * rand()),
        angle: rand() * Math.PI,
        aspect: aspect > 1 ? aspect * (0.7 + 0.6 * rand()) : 1,
      });
    }
  }

  const n = cells.length;
  const frac = (kind: GeologyKind) => byKind[kind].length / n;

  for (const rule of VEIN_RULES) {
    const pool = byKind[rule.geology];
    let count: number;
    if (rule.countPerVolcanicCell !== undefined) {
      count = Math.round(pool.length * rule.countPerVolcanicCell * countMult) + rule.countBase;
    } else {
      count = Math.round(frac(rule.geology) * rule.countPerFrac * countMult) + rule.countBase;
    }
    placeFromPool(
      pool,
      count,
      rule.element,
      [rule.rMin, rule.rMax],
      rule.intensity,
      rule.aspect
    );
  }

  return deposits;
}

function depositValue(d: Deposit, x: number, y: number): number {
  const dx = x - d.x;
  const dy = y - d.y;
  const ca = Math.cos(d.angle);
  const sa = Math.sin(d.angle);
  const u = (dx * ca + dy * sa) / (d.r * d.aspect);
  const v = (-dx * sa + dy * ca) / d.r;
  const d2 = u * u + v * v;
  if (d2 > 9) return 0;
  return d.intensity * Math.exp(-0.5 * d2);
}

export function computeElements(
  cells: Cell[],
  seed: number,
  features: GeoFeature[],
  veinDensity = 0.5,
  tectonic: TectonicState | null = null
): void {
  classifyGeology(cells, features, tectonic);
  const deposits = generateDeposits(cells, seed, veinDensity);

  let landMax = 1;
  for (const c of cells) if (c.height > landMax) landMax = c.height;

  for (const cell of cells) {
    const [x, y] = cell.site;
    const elevN = cell.height > 0 ? Math.min(1, cell.height / landMax) : 0;
    const noise = fbm2(x * PROV_FREQ, y * PROV_FREQ, seed + 17, 4);
    const w = backgroundWeights(cell.geology, elevN, noise);

    for (const d of deposits) {
      const add = depositValue(d, x, y);
      if (add > 0) w[d.key] += add;
    }

    let sum = 0;
    for (const k of ELEMENT_KEYS) sum += w[k] ?? 0;
    if (sum <= 0) sum = 1;
    for (const k of ELEMENT_KEYS) cell.elements[k] = (w[k] ?? 0) / sum;
  }
}

export function geologyStats(cells: Cell[]): Record<GeologyKind, number> {
  const counts: Record<GeologyKind, number> = {
    ocean: 0,
    shield: 0,
    mountain: 0,
    basin: 0,
    volcanic: 0,
  };
  for (const c of cells) counts[c.geology]++;
  const n = cells.length || 1;
  const frac = {} as Record<GeologyKind, number>;
  for (const k of Object.keys(counts) as GeologyKind[]) {
    frac[k] = counts[k] / n;
  }
  return frac;
}

export function dominantElement(cell: Cell): ElementKey {
  return dominantResourceElement(cell);
}

/** 资源主导元素（排除基质 O/Si） */
export function dominantResourceElement(cell: Cell): ElementKey {
  let best: ElementKey = RESOURCE_ELEMENT_KEYS[0];
  let bestV = -1;
  for (const k of RESOURCE_ELEMENT_KEYS) {
    const v = cell.elements[k];
    if (v > bestV) {
      bestV = v;
      best = k;
    }
  }
  return best;
}

/** 基质主导（O 或 Si，用于调试） */
export function dominantMatrixElement(cell: Cell): ElementKey {
  let best: ElementKey = MATRIX_ELEMENT_KEYS[0];
  let bestV = -1;
  for (const k of MATRIX_ELEMENT_KEYS) {
    const v = cell.elements[k];
    if (v > bestV) {
      bestV = v;
      best = k;
    }
  }
  return best;
}

export function elementMaxima(cells: Cell[]): Record<ElementKey, number> {
  const max = {} as Record<ElementKey, number>;
  for (const k of ELEMENT_KEYS) max[k] = 1e-6;
  for (const cell of cells) {
    for (const k of ELEMENT_KEYS) {
      const v = cell.elements[k];
      if (v > max[k]) max[k] = v;
    }
  }
  return max;
}
