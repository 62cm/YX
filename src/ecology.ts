/**
 * 生态池与日/年循环
 *
 * ## 现状管线局限（生成时一次性，无反馈）
 * main.ts: 构造 → assignHeights → computeElements → computeSurfaceClimate → 渲染
 * - elements 是归一化浓度，不是可增减的储量池
 * - humidity / waterFresh 逐格独立计算，生成后不再扩散
 * - vegetation 由 classifyVegetation 阈值表决定，与矿脉/凋落物/时间无关
 * - oxidation / reduction 写入后不再参与后续计算
 *
 * ## 本模块：千万年初始条件 + 日累计循环
 * - lithoStock（慢池）：来自 elements，代表百万年地质储量
 * - bioavailable / biomass / litter / soilOrganic（快池）：日吸收·淋溶·凋落物
 * - 生成后 equilibriumPass 邻格扩散水热；tickEcology 日更新；tickEcologyYear 基质慢变
 */

import type { Cell, ElementKey, SurfaceKind, VegetationKind } from "./types";
import { ELEMENT_KEYS } from "./types";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const STOCK_SCALE = 48;

const SUBSTRATE_BIO_FACTOR: Record<SurfaceKind, number> = {
  saltSea: 0,
  freshLake: 0.05,
  wetland: 0.42,
  saltFlat: 0.04,
  sand: 0.06,
  alluvial: 0.48,
  soil: 0.36,
  bareRock: 0.03,
  rockySlope: 0.05,
  ice: 0,
  permafrost: 0.05,
  volcanicRock: 0.02,
  beach: 0.08,
};

interface VegEcologyParams {
  waterMin: number;
  nMin: number;
  growth: number;
  turnover: number;
  waterUse: number;
  nUse: number;
  feUse: number;
  caUse: number;
  solubilize: number;
  transpire: number;
  biomassSeed: number;
  upgradeBiomass: number;
}

const VEG_ECO: Record<VegetationKind, VegEcologyParams> = {
  none: {
    waterMin: 0,
    nMin: 0,
    growth: 0,
    turnover: 0,
    waterUse: 0,
    nUse: 0,
    feUse: 0,
    caUse: 0,
    solubilize: 1,
    transpire: 0,
    biomassSeed: 0,
    upgradeBiomass: 1,
  },
  moss: {
    waterMin: 0.1,
    nMin: 0.012,
    growth: 0.006,
    turnover: 0.012,
    waterUse: 0.0015,
    nUse: 0.0008,
    feUse: 0.00005,
    caUse: 0.00005,
    solubilize: 1.2,
    transpire: 0.0008,
    biomassSeed: 0.12,
    upgradeBiomass: 0.22,
  },
  shrub: {
    waterMin: 0.14,
    nMin: 0.018,
    growth: 0.009,
    turnover: 0.018,
    waterUse: 0.0025,
    nUse: 0.0012,
    feUse: 0.0001,
    caUse: 0.00012,
    solubilize: 1.5,
    transpire: 0.0015,
    biomassSeed: 0.22,
    upgradeBiomass: 0.32,
  },
  grass: {
    waterMin: 0.16,
    nMin: 0.022,
    growth: 0.011,
    turnover: 0.02,
    waterUse: 0.003,
    nUse: 0.0016,
    feUse: 0.00015,
    caUse: 0.00018,
    solubilize: 1.8,
    transpire: 0.002,
    biomassSeed: 0.32,
    upgradeBiomass: 0.38,
  },
  forest: {
    waterMin: 0.22,
    nMin: 0.032,
    growth: 0.013,
    turnover: 0.025,
    waterUse: 0.005,
    nUse: 0.0028,
    feUse: 0.0002,
    caUse: 0.00022,
    solubilize: 2.5,
    transpire: 0.004,
    biomassSeed: 0.48,
    upgradeBiomass: 0.42,
  },
};

const VEG_ORDER: VegetationKind[] = ["none", "moss", "shrub", "grass", "forest"];

function coastalFactor(cell: Cell, cells: Cell[]): number {
  for (const nb of cell.neighbors) {
    if (cells[nb].height < 0) return 1;
  }
  return 0;
}

export function emptyPools(): Cell["pools"] {
  const litho = {} as Record<ElementKey, number>;
  for (const k of ELEMENT_KEYS) litho[k] = 0;
  return {
    lithoStock: litho,
    bioavailable: { N: 0, Fe: 0, Ca: 0 },
    biomass: 0,
    litter: 0,
    soilOrganic: 0,
    biomassMetal: { Fe: 0, Ca: 0 },
    surfaceAgeYears: 0,
  };
}

function initPoolsForCell(cell: Cell): void {
  const p = cell.pools;
  for (const k of ELEMENT_KEYS) {
    p.lithoStock[k] = cell.elements[k] * STOCK_SCALE;
  }

  const subFactor = SUBSTRATE_BIO_FACTOR[cell.surface];
  const reducBoost = cell.reduction * 0.12;
  p.bioavailable.N = clamp01(
    p.lithoStock.N * subFactor * 0.55 + cell.humidity * 0.08 + reducBoost
  );
  p.bioavailable.Fe = clamp01(p.lithoStock.Fe * subFactor * 0.35);
  p.bioavailable.Ca = clamp01(p.lithoStock.Ca * subFactor * 0.4);

  if (cell.geology === "basin") {
    p.soilOrganic = clamp01(0.12 + cell.elements.C * 0.35 + cell.reduction * 0.15);
    p.bioavailable.N += 0.04;
  }

  const veg = cell.vegetation;
  const eco = VEG_ECO[veg];
  p.biomass = eco.biomassSeed;
  p.litter = veg !== "none" ? eco.biomassSeed * 0.15 : 0;

  if (p.bioavailable.Fe > 0.35 && veg === "forest") {
    p.bioavailable.Fe *= 0.82;
  }
}

/** 从地表/元素状态初始化池，并均衡扩散水热 */
export function initEcology(cells: Cell[], equilibriumRounds = 8): void {
  for (const cell of cells) {
    initPoolsForCell(cell);
  }
  equilibriumPass(cells, equilibriumRounds);
}

/** 邻格扩散湿度与淡水至近似均衡 */
export function equilibriumPass(cells: Cell[], rounds = 8): void {
  const n = cells.length;
  const humBuf = new Float64Array(n);
  const waterBuf = new Float64Array(n);
  const kBase = 0.14;

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (c.height < 0) {
        humBuf[i] = c.humidity;
        waterBuf[i] = c.waterFresh;
        continue;
      }
      const coastal = coastalFactor(c, cells);
      let hSum = c.humidity;
      let wSum = c.waterFresh;
      let cnt = 1;
      for (const nb of c.neighbors) {
        hSum += cells[nb].humidity;
        wSum += cells[nb].waterFresh;
        cnt++;
      }
      const k = kBase * c.permeability;
      humBuf[i] = clamp01(c.humidity + k * (hSum / cnt - c.humidity));
      waterBuf[i] = clamp01(c.waterFresh + k * (wSum / cnt - c.waterFresh));
      if (coastal > 0) humBuf[i] = Math.max(humBuf[i], 0.42);
    }
    for (let i = 0; i < n; i++) {
      cells[i].humidity = humBuf[i];
      cells[i].waterFresh = waterBuf[i];
    }
  }
}

export interface EcologyTickSummary {
  landCells: number;
  vegCounts: Record<VegetationKind, number>;
  avgBiomass: number;
  avgBioN: number;
}

function growthFactor(cell: Cell): number {
  const tempOk = cell.temperature > -8 && cell.temperature < 38 ? 1 : 0.35;
  const light = cell.insolationGround > 0 ? cell.insolationGround : cell.insolation;
  return clamp01(light * 0.55 + cell.humidity * 0.3) * tempOk;
}

function tryUpgradeVegetation(cell: Cell): void {
  const idx = VEG_ORDER.indexOf(cell.vegetation);
  if (idx >= VEG_ORDER.length - 1) return;
  const next = VEG_ORDER[idx + 1];
  const eco = VEG_ECO[next];
  if (
    cell.waterFresh >= eco.waterMin &&
    cell.pools.bioavailable.N >= eco.nMin &&
    cell.pools.biomass >= eco.upgradeBiomass &&
    cell.temperature > -6
  ) {
    if (next === "forest" && (cell.humidity < 0.38 || cell.pools.bioavailable.Fe > 0.42)) return;
    cell.vegetation = next;
  }
}

function tryDowngradeVegetation(cell: Cell): void {
  const veg = cell.vegetation;
  if (veg === "none") return;
  const eco = VEG_ECO[veg];
  if (cell.waterFresh < eco.waterMin * 0.65 || cell.pools.bioavailable.N < eco.nMin * 0.55) {
    const idx = VEG_ORDER.indexOf(veg);
    cell.vegetation = VEG_ORDER[Math.max(0, idx - 1)];
    cell.pools.biomass *= 0.55;
  }
}

/** 日循环：水热交换、吸收、凋落、淋溶、植被状态机 */
export function tickEcology(cells: Cell[], dtDays: number): EcologyTickSummary {
  const n = cells.length;
  const humBuf = new Float64Array(n);
  const waterBuf = new Float64Array(n);
  const nBuf = new Float64Array(n);
  const feBuf = new Float64Array(n);
  const caBuf = new Float64Array(n);
  const nLeak = new Float64Array(n);

  const summary: EcologyTickSummary = {
    landCells: 0,
    vegCounts: { none: 0, moss: 0, shrub: 0, grass: 0, forest: 0 },
    avgBiomass: 0,
    avgBioN: 0,
  };

  const diffuseK = 0.08 * dtDays;
  const rainBase = 0.0028 * dtDays;
  const leachK = 0.012 * dtDays;
  const decomposeK = 0.035 * dtDays;
  const solubilizeK = (2.5e-5 * dtDays) / 365;

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    if (cell.height < 0) continue;

    summary.landCells++;
    const coastal = coastalFactor(cell, cells);
    const p = cell.pools;
    const veg = cell.vegetation;
    const eco = VEG_ECO[veg];

    if (cell.precip < 0.005) {
      cell.waterFresh = clamp01(
        cell.waterFresh + rainBase * (0.4 + cell.humidity * 0.5 + coastal * 0.3)
      );
    }

    if (veg !== "none") {
      const gf = growthFactor(cell);
      const uptakeScale = Math.min(1, p.biomass + 0.2);
      cell.waterFresh = clamp01(cell.waterFresh - eco.waterUse * uptakeScale * dtDays);
      p.bioavailable.N = Math.max(0, p.bioavailable.N - eco.nUse * uptakeScale * dtDays);
      p.bioavailable.Fe = Math.max(0, p.bioavailable.Fe - eco.feUse * uptakeScale * dtDays);
      p.bioavailable.Ca = Math.max(0, p.bioavailable.Ca - eco.caUse * uptakeScale * dtDays);

      const growth =
        eco.growth * gf * dtDays * Math.min(1, p.bioavailable.N / Math.max(0.01, eco.nMin));
      const turnover = eco.turnover * p.biomass * dtDays;
      p.biomass = clamp01(p.biomass + growth - turnover);
      p.litter = clamp01(p.litter + turnover * 0.85);
      p.biomassMetal.Fe = clamp01(p.biomassMetal.Fe + eco.feUse * uptakeScale * dtDays * 0.3);
      p.biomassMetal.Ca = clamp01(p.biomassMetal.Ca + eco.caUse * uptakeScale * dtDays * 0.25);

    }

    const decomp = p.litter * decomposeK * (0.5 + cell.humidity * 0.5);
    p.litter = Math.max(0, p.litter - decomp);
    p.bioavailable.N = clamp01(p.bioavailable.N + decomp * 0.35);
    p.soilOrganic = clamp01(p.soilOrganic + decomp * 0.28);

    const sol =
      solubilizeK *
      eco.solubilize *
      (veg !== "none" ? 1 : 0.15) *
      SUBSTRATE_BIO_FACTOR[cell.surface];
    p.bioavailable.N = clamp01(p.bioavailable.N + p.lithoStock.N * sol * 0.02);
    p.bioavailable.Fe = clamp01(p.bioavailable.Fe + p.lithoStock.Fe * sol * 0.015);
    p.bioavailable.Ca = clamp01(p.bioavailable.Ca + p.lithoStock.Ca * sol * 0.018);

    let hSum = cell.humidity;
    let wSum = cell.waterFresh;
    let cnt = 1;
    for (const nb of cell.neighbors) {
      hSum += cells[nb].humidity;
      wSum += cells[nb].waterFresh;
      cnt++;
    }
    const dk = diffuseK * cell.permeability;
    humBuf[i] = clamp01(cell.humidity + dk * (hSum / cnt - cell.humidity));
    waterBuf[i] = clamp01(cell.waterFresh + dk * (wSum / cnt - cell.waterFresh));

    const lk = leachK * cell.permeability * cell.humidity;
    nBuf[i] = Math.max(0, p.bioavailable.N - lk * p.bioavailable.N * 0.08);
    feBuf[i] = Math.max(0, p.bioavailable.Fe - lk * p.bioavailable.Fe * 0.06);
    caBuf[i] = Math.max(0, p.bioavailable.Ca - lk * p.bioavailable.Ca * 0.06);
    nLeak[i] = lk * 0.04;

    tryDowngradeVegetation(cell);
    tryUpgradeVegetation(cell);
  }

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    if (cell.height < 0) continue;
    cell.humidity = humBuf[i];
    cell.waterFresh = waterBuf[i];
    cell.pools.bioavailable.N = nBuf[i];
    cell.pools.bioavailable.Fe = feBuf[i];
    cell.pools.bioavailable.Ca = caBuf[i];
    if (nLeak[i] > 0 && cell.neighbors.length > 0) {
      const share = nLeak[i] / cell.neighbors.length;
      for (const nb of cell.neighbors) {
        if (cells[nb].height >= 0) {
          cells[nb].pools.bioavailable.N = clamp01(cells[nb].pools.bioavailable.N + share);
        }
      }
    }
  }

  let bioSum = 0;
  let nSum = 0;
  for (const c of cells) {
    if (c.height < 0) continue;
    summary.vegCounts[c.vegetation]++;
    bioSum += c.pools.biomass;
    nSum += c.pools.bioavailable.N;
  }
  if (summary.landCells > 0) {
    summary.avgBiomass = bioSum / summary.landCells;
    summary.avgBioN = nSum / summary.landCells;
  }
  return summary;
}

const SLOW_SURFACES = new Set<SurfaceKind>([
  "saltSea",
  "freshLake",
  "ice",
  "bareRock",
  "beach",
]);

/** 年尺度：火山灰熟化、荒漠化、有机质积累 */
export function tickEcologyYear(cells: Cell[], years = 1): void {
  for (const cell of cells) {
    if (cell.height < 0 || SLOW_SURFACES.has(cell.surface)) continue;

    const p = cell.pools;

    p.soilOrganic = clamp01(p.soilOrganic + p.litter * 0.015 * years + p.biomass * 0.002 * years);

    if (cell.surface === "volcanicRock") {
      p.surfaceAgeYears += years;
      if (cell.vegetation === "none" && cell.humidity > 0.4 && p.surfaceAgeYears >= 12) {
        cell.vegetation = "moss";
      }
      if (p.surfaceAgeYears >= 40 && (p.soilOrganic > 0.1 || p.surfaceAgeYears >= 80)) {
        cell.surface = "soil";
        if (cell.vegetation === "none" && cell.humidity > 0.3) cell.vegetation = "moss";
        p.bioavailable.N = clamp01(p.bioavailable.N + 0.06);
        p.bioavailable.Ca = clamp01(p.bioavailable.Ca + 0.04);
        p.surfaceAgeYears = 0;
      }
    } else if (
      cell.surface === "soil" &&
      cell.humidity < 0.14 &&
      cell.waterFresh < 0.1 &&
      p.biomass < 0.06 &&
      cell.insolation > 0.55
    ) {
      p.surfaceAgeYears += years;
      if (p.surfaceAgeYears >= 60) {
        cell.surface = "sand";
        if (cell.vegetation === "forest") cell.vegetation = "shrub";
        p.bioavailable.N *= 0.6;
        p.surfaceAgeYears = 0;
      }
    } else if (cell.surface === "soil" || cell.surface === "alluvial") {
      p.surfaceAgeYears = Math.max(0, p.surfaceAgeYears - years);
      p.bioavailable.N = clamp01(p.bioavailable.N + p.soilOrganic * 0.008 * years);
    }

    if (cell.surface === "permafrost" && p.soilOrganic > 0.08 && cell.temperature > -12) {
      p.bioavailable.N = clamp01(p.bioavailable.N + 0.003 * years);
    }
  }
}

export function ecologyPoolSummary(cells: Cell[]): string {
  let land = 0;
  let bio = 0;
  let n = 0;
  let fe = 0;
  const veg: Record<VegetationKind, number> = {
    none: 0,
    moss: 0,
    shrub: 0,
    grass: 0,
    forest: 0,
  };
  for (const c of cells) {
    if (c.height < 0) continue;
    land++;
    bio += c.pools.biomass;
    n += c.pools.bioavailable.N;
    fe += c.pools.bioavailable.Fe;
    veg[c.vegetation]++;
  }
  if (land === 0) return "";
  return `生物量 ${((bio / land) * 100).toFixed(0)}% · 可交换N ${((n / land) * 100).toFixed(0)}% · 林 ${((veg.forest / land) * 100).toFixed(0)}% 草 ${((veg.grass / land) * 100).toFixed(0)}% · 可交换Fe ${((fe / land) * 100).toFixed(0)}%`;
}
