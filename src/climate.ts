/**
 * 植被地貌 · 日照反射 · 气候运动 日尺度耦合
 * 温压场 → 局地风 → 辐合/锋面/地形抬升 → 云水；混合云形变见 clouds.ts
 */

import type { Cell, CloudParams } from "./types";
import {
  hourOfDayFromDay,
  solarDeclinationRad,
  insolationInstantAt,
  localTemperatureDetail,
  latitudeSpanDeg,
  surfaceThermalInertia,
  cellLatitudeRad,
  cellLatitudeNorm,
  cellLongitudeRad,
} from "./surface";
import { advectAirMassByOceanCurrents, updateOceanSSTIce } from "./polarOcean";
import { tickEcology, type EcologyTickSummary } from "./ecology";
import {
  seedCyclonesFromPressure,
  syncCyclonesFromPressure,
  cycloneWindAt,
  cycloneCloudFactor,
  cycloneTempDelta,
  cycloneHumidityBoost,
  cycloneSummary,
} from "./cyclones";
import {
  applyCoriolisDeflection,
  geoClimateFooter,
  initCellAtmColumns,
  refreshCellAtmFromSurface,
} from "./geoFrame";
import type { PlanetTileContext } from "./types";

export { cycloneSummary };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 气团温/湿异常（随风平流，与气候背景分离） */
let airMassT: Float64Array | null = null;
let airMassH: Float64Array | null = null;
/** 气压异常（随风平流，使高低压系统移动） */
let pAnom: Float64Array | null = null;

function ensureAirMassBuffers(n: number): void {
  if (!airMassT || airMassT.length !== n) {
    airMassT = new Float64Array(n);
    airMassH = new Float64Array(n);
  }
}

function ensurePAnom(n: number): void {
  if (!pAnom || pAnom.length !== n) pAnom = new Float64Array(n);
}

function initPAnom(n: number): void {
  ensurePAnom(n);
  pAnom!.fill(0);
}

/** 气压异常随风平流（synoptic 尺度移动） */
function advectPressureAnomaly(cells: Cell[], dtDays: number): void {
  if (!pAnom) return;
  const n = cells.length;
  const next = Float64Array.from(pAnom);
  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const spd = Math.hypot(cell.windU, cell.windV);
    if (spd < 0.2) continue;
    const up = upwindNeighbor(cell, cells, cell.windU, cell.windV);
    if (up === null) continue;
    const blend = 1 - Math.exp(-0.16 * dtDays * Math.min(spd, 26) * 0.14);
    next[i] += blend * (pAnom[up] - next[i]);
  }
  const damp = 1 - Math.exp(-0.05 * dtDays);
  for (let i = 0; i < n; i++) {
    pAnom[i] = clamp(next[i] * (1 - damp * 0.05), -16, 16);
  }
}

function relaxPressureAnomalyToThermal(
  cells: Cell[],
  bounds: [number, number, number, number],
  day: number,
  dtDays: number
): void {
  if (!pAnom) return;
  const k = 1 - Math.exp(-0.18 * dtDays);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const anchor = seasonalTemperatureAnchor(cell, cells, bounds, day);
    const target = -4.2 * (cell.temperature - anchor);
    pAnom[i] += (target - pAnom[i]) * k * 0.4;
  }
}

/** 气候态湿度（气团异常的归零参考） */
function climaticHumidity(
  cell: Cell,
  bounds: [number, number, number, number]
): number {
  if (cell.height < 0) return clamp01(0.72 + 0.08 * (1 - cellLatitudeNorm(cell, bounds)));
  const lat = cellLatitudeNorm(cell, bounds);
  let h = 0.48 - lat * 0.18;
  if (cell.surface === "wetland" || cell.surface === "freshLake") h += 0.22;
  if (cell.surface === "sand" || cell.surface === "saltFlat") h -= 0.18;
  if (cell.vegetation === "forest") h += 0.12;
  return clamp01(h);
}

function initAirMassFromCells(
  cells: Cell[],
  bounds: [number, number, number, number],
  day: number
): void {
  ensureAirMassBuffers(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const anchor = seasonalTemperatureAnchor(cell, cells, bounds, day);
    const ch = climaticHumidity(cell, bounds);
    airMassT![i] = clamp(cell.temperature - anchor, -12, 12);
    airMassH![i] = clamp(cell.humidity - ch, -0.32, 0.38);
  }
}

function upwindNeighbor(
  cell: Cell,
  cells: Cell[],
  windU: number,
  windV: number
): number | null {
  if (Math.abs(windU) < 0.05 && Math.abs(windV) < 0.05) return null;
  let best = -1;
  let bestDot = -Infinity;
  const [x0, y0] = cell.site;
  const wLen = Math.hypot(windU, windV) || 1;
  const wx = windU / wLen;
  const wy = windV / wLen;
  for (const nb of cell.neighbors) {
    const [x1, y1] = cells[nb].site;
    const dx = x0 - x1;
    const dy = y0 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const dot = (dx / len) * wx + (dy / len) * wy;
    if (dot > bestDot) {
      bestDot = dot;
      best = nb;
    }
  }
  return bestDot > 0.08 ? best : null;
}

/** 气团平流：上风带来 T′、q′，形成区域性冷暖湿干块 */
function advectAirMassFields(cells: Cell[], dtDays: number): void {
  if (!airMassT || !airMassH) return;
  const n = cells.length;
  const tNext = Float64Array.from(airMassT);
  const hNext = Float64Array.from(airMassH);

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const spd = Math.hypot(cell.windU, cell.windV);
    if (spd < 0.35) continue;
    const up = upwindNeighbor(cell, cells, cell.windU, cell.windV);
    if (up === null) continue;
    const blend = 1 - Math.exp(-0.07 * dtDays * Math.min(spd, 22) * 0.1);
    tNext[i] += blend * (airMassT[up] - tNext[i]);
    hNext[i] += blend * (airMassH[up] - hNext[i]);
  }

  const damp = 1 - Math.exp(-0.035 * dtDays);
  for (let i = 0; i < n; i++) {
    tNext[i] *= 1 - damp * 0.08;
    hNext[i] *= 1 - damp * 0.06;
    airMassT[i] = clamp(tNext[i], -14, 14);
    airMassH[i] = clamp(hNext[i], -0.38, 0.42);
  }
}

function airMassSurfaceExchange(
  cells: Cell[],
  bounds: [number, number, number, number],
  day: number,
  dtDays: number
): void {
  if (!airMassT || !airMassH) return;
  const decl = solarDeclinationRad(day);
  const hour = hourOfDayFromDay(day);
  const daylight = hour >= 5 && hour <= 19;
  const dayPhase = daylight ? Math.sin(((hour - 5) / 14) * Math.PI) : 0;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const latR = cellLatitudeRad(cell, bounds);
    const hemisphere = latR >= 0 ? 1 : -1;
    const winter = Math.sign(decl) * hemisphere < -0.05;

    if (cell.height < 0) {
      const sat = saturationHumidity(cell.temperature);
      airMassH[i] += 0.022 * dtDays * clamp01(1 - (climaticHumidity(cell, bounds) + airMassH[i]) / sat);
      airMassT[i] += 0.004 * dtDays * Math.max(0, 26 - cell.temperature) * 0.15;
    } else if (cell.surface === "sand" || cell.surface === "saltFlat") {
      if (daylight) airMassT[i] += 0.012 * dtDays * dayPhase;
      airMassH[i] -= 0.008 * dtDays;
    } else if (cell.surface === "ice" || cell.surface === "permafrost") {
      airMassT[i] -= 0.014 * dtDays;
      airMassH[i] -= 0.004 * dtDays;
    } else if (winter && cell.height >= 0) {
      airMassT[i] -= 0.006 * dtDays;
    }

    if (cell.surface === "wetland" || cell.surface === "freshLake") {
      airMassH[i] += 0.01 * dtDays;
    }

    airMassT[i] = clamp(airMassT[i], -14, 14);
    airMassH[i] = clamp(airMassH[i], -0.38, 0.42);
  }
}

function applyOceanCurrentsToAirMass(
  cells: Cell[],
  bounds: [number, number, number, number],
  dtDays: number
): void {
  if (!airMassT) return;
  advectAirMassByOceanCurrents(cells, bounds, dtDays, airMassT);
}

function airMassFrontStrength(cells: Cell[], i: number, meteoFront: number): number {
  if (!airMassT || !airMassH) return meteoFront;
  let tGrad = 0;
  let hGrad = 0;
  for (const nb of cells[i].neighbors) {
    tGrad = Math.max(tGrad, Math.abs(airMassT[i] - airMassT[nb]));
    hGrad = Math.max(hGrad, Math.abs(airMassH[i] - airMassH[nb]));
  }
  return clamp01(Math.max(meteoFront, tGrad / 7 + hGrad / 0.22));
}

function applyAirMassToState(
  cells: Cell[],
  bounds: [number, number, number, number]
): void {
  if (!airMassH) return;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    cell.humidity = clamp01(climaticHumidity(cell, bounds) + airMassH[i]);
  }
}

/** 大跨度推进时的步长（天） */
export function climateStepDaysForSpan(totalDays: number): number {
  if (totalDays > 3650) return 30;
  if (totalDays > 90) return 7;
  return 1;
}

function updateInsolationTop(
  cell: Cell,
  bounds: [number, number, number, number],
  day: number
): void {
  const latR = cellLatitudeRad(cell, bounds);
  const lonR = cellLongitudeRad(cell, bounds);
  const decl = solarDeclinationRad(day);
  const hour = hourOfDayFromDay(day);
  cell.insolationTop = insolationInstantAt(latR, lonR, decl, hour);
}

export function updateAlbedo(cell: Cell): void {
  if (cell.height < 0) {
    cell.albedo = 0.06;
    return;
  }

  const s = cell.surface;
  const v = cell.vegetation;
  const bio = cell.pools?.biomass ?? 0;

  let base: number;
  switch (s) {
    case "ice":
      base = 0.75;
      break;
    case "sand":
    case "saltFlat":
      base = 0.32;
      break;
    case "bareRock":
    case "volcanicRock":
    case "rockySlope":
      base = 0.22;
      break;
    case "freshLake":
    case "wetland":
      base = 0.08;
      break;
    case "beach":
      base = 0.28;
      break;
    default:
      base = 0.2;
  }

  if (v === "forest") base = 0.12 + 0.08 * bio;
  else if (v === "grass") base = 0.18 + 0.04 * bio;
  else if (v === "shrub") base = 0.22;
  else if (v === "moss") base = 0.16;

  cell.albedo = clamp01(base);
}

export function initClimateFields(
  cells: Cell[],
  bounds: [number, number, number, number],
  _cloud: CloudParams,
  day = 0,
  worldSeed = 42
): void {
  climateWorldSeed = worldSeed;
  for (const cell of cells) {
    updateInsolationTop(cell, bounds, day);
    updateAlbedo(cell);
    cell.insolationGround = clamp01(cell.insolationTop * (1 - cell.albedo) * 0.85);
    cell.insolation = cell.insolationGround;
    cell.cloudWater = cell.height < 0 ? cell.humidity * 0.35 : cell.humidity * 0.18;
    cell.precip = 0;
    cell.pressure = 1013;
    cell.windU = 0;
    cell.windV = 0;
    cell.windExposure = 0;
    cell.cloud = cell.cloudWater * 0.6;
  }
  const meteo = buildMeteoFields(cells, bounds, day, worldSeed);
  initCellAtmColumns(cells);
  initPAnom(cells.length);
  seedCyclonesFromPressure(cells, meteo.pBase, bounds);
  initAirMassFromCells(cells, bounds, day);
  syncMeteoCloudDisplay(cells);
}

function seasonalTemperatureAnchor(
  cell: Cell,
  cells: Cell[],
  bounds: [number, number, number, number],
  day: number
): number {
  const base = localTemperatureDetail(cell, cells, bounds);
  const latR = cellLatitudeRad(cell, bounds);
  const decl = solarDeclinationRad(day);
  const inertia = surfaceThermalInertia(cell);

  const span = latitudeSpanDeg(bounds);
  const spanScale = clamp01(span / 45);

  const hemisphere = latR >= 0 ? 1 : -1;
  const seasonSign = Math.sign(decl) * hemisphere;
  const seasonStrength = Math.abs(Math.sin(decl)) * (0.35 + 0.65 * Math.abs(Math.sin(latR)));

  let amp = 0;
  if (cell.height < 0) amp = (2 + 1.5 * spanScale) / inertia;
  else if (cell.surface === "sand" || cell.surface === "saltFlat") amp = (5 + 4 * spanScale) / inertia;
  else amp = (4 + 3 * spanScale) / Math.sqrt(inertia);

  return base + seasonSign * seasonStrength * amp;
}

const PRESSURE_BANDS = 16;

let climateWorldSeed = 42;

/** 纬向气压带有效纬度扰动（罗斯贝波状曲线，使槽脊沿经向弯曲） */
function pressureBeltLatWave(lonDeg: number, latNorm: number, seed: number): number {
  const lonR = (lonDeg * Math.PI) / 180;
  const s = seed * 0.017;
  // 全纬度连续扰动，中纬略强、赤道/极地弱
  const amp = 0.05 + 0.07 * Math.pow(Math.sin(latNorm * Math.PI), 1.3);
  const w1 = Math.sin(lonR * 2.4 + s) * amp;
  const w2 = Math.sin(lonR * 3.8 - latNorm * 5.2 + s * 1.3) * amp * 0.6;
  const w3 = Math.sin(lonR * 1.6 + latNorm * 8.5 + s * 0.7) * amp * 0.4;
  return w1 + w2 + w3;
}

/** 槽脊型气压扰动（hPa），中纬最强 */
function pressureSynopticWave(lonDeg: number, latNorm: number, seed: number): number {
  const lonR = (lonDeg * Math.PI) / 180;
  const s = seed * 0.013;
  const beltW = 0.35 + 0.65 * Math.pow(Math.sin(latNorm * Math.PI), 1.4);
  const trough =
    Math.sin(lonR * 2.9 + latNorm * 5.5 + s) * 2.4 +
    Math.sin(lonR * 5.2 - latNorm * 3.8 + s * 1.7) * 1.5;
  const ridge =
    Math.cos(lonR * 2.1 + latNorm * 8.2 - s * 0.9) * 1.8 +
    Math.cos(lonR * 3.7 - latNorm * 4.5 + s * 2.1) * 1.1;
  return (trough - ridge * 0.55) * beltW;
}

function latNormFromCell(cell: Cell, bounds: [number, number, number, number]): number {
  if (Number.isFinite(cell.latDeg)) return clamp01(Math.abs(cell.latDeg) / 90);
  return cellLatitudeNorm(cell, bounds);
}

function lonDegFromCell(cell: Cell, bounds: [number, number, number, number]): number {
  if (Number.isFinite(cell.lonDeg)) return cell.lonDeg;
  return (cellLongitudeRad(cell, bounds) * 180) / Math.PI;
}

/** 基础气压场（温压关系 + 纬向带，不含气旋人工项） */
export function computeBasePressureField(
  cells: Cell[],
  bounds: [number, number, number, number],
  seed = climateWorldSeed
): Float64Array {
  return computePressureRaw(cells, bounds, seed);
}

function computePressureRaw(
  cells: Cell[],
  bounds: [number, number, number, number],
  seed = climateWorldSeed
): Float64Array {
  const n = cells.length;
  const pRaw = new Float64Array(n);
  const landBandSum = new Float64Array(PRESSURE_BANDS);
  const landBandCnt = new Float64Array(PRESSURE_BANDS);
  const oceanBandSum = new Float64Array(PRESSURE_BANDS);
  const oceanBandCnt = new Float64Array(PRESSURE_BANDS);

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const lat = cellLatitudeNorm(cell, bounds);
    const b = Math.min(PRESSURE_BANDS - 1, Math.floor(lat * PRESSURE_BANDS));
    if (cell.height < 0) {
      oceanBandSum[b] += cell.temperature;
      oceanBandCnt[b]++;
    } else {
      landBandSum[b] += cell.temperature;
      landBandCnt[b]++;
    }
  }

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const lat = latNormFromCell(cell, bounds);
    const lonDeg = lonDegFromCell(cell, bounds);
    const latWave = pressureBeltLatWave(lonDeg, lat, seed);
    const latEff = clamp01(lat + latWave * 1.3);
    const b = Math.min(PRESSURE_BANDS - 1, Math.floor(latEff * PRESSURE_BANDS));

    let refT = cell.temperature;
    if (cell.height < 0) {
      if (oceanBandCnt[b] > 0) refT = oceanBandSum[b] / oceanBandCnt[b];
    } else if (landBandCnt[b] > 0) {
      refT = landBandSum[b] / landBandCnt[b];
    }

    // 暖相对同纬度带偏低压、冷偏高压；纬向环流带沿经向弯曲
    const belt =
      -5 * Math.exp(-Math.pow((latEff - 0.12) / 0.1, 2)) +
      7 * Math.exp(-Math.pow((latEff - 0.32) / 0.09, 2)) -
      4 * Math.exp(-Math.pow((latEff - 0.58) / 0.11, 2));
    let p = 1013 - 4.2 * (cell.temperature - refT) + belt + pressureSynopticWave(lonDeg, lat, seed);

    if (cell.height < 0) p += 1.8;
    if (cell.surface === "ice" || cell.surface === "permafrost") p += 5;
    if (cell.surface === "sand" || cell.surface === "saltFlat") p -= 4;
    if (cell.height >= 2000) p += 2.5;
    p -= 0.001 * Math.max(0, cell.height);

    pRaw[i] = p;
  }

  return pRaw;
}

interface MeteoFields {
  convergence: Float64Array;
  front: Float64Array;
  pBase: Float64Array;
}

/** 地形阻挡与绕流：高山削减迎风风速，部分沿切向偏转 */
function applyTerrainWindBlock(
  cells: Cell[],
  i: number,
  ux: number,
  uy: number
): { u: number; v: number } {
  const cell = cells[i];
  const spd0 = Math.hypot(ux, uy);
  if (spd0 < 0.2) return { u: ux, v: uy };

  const wx = ux / spd0;
  const wy = uy / spd0;
  let block = 1;
  let du = 0;
  let dv = 0;
  const [x0, y0] = cell.site;

  for (const nb of cell.neighbors) {
    const ncell = cells[nb];
    const dh = ncell.height - cell.height;
    if (dh < 100) continue;
    const [x1, y1] = ncell.site;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    const approach = wx * nx + wy * ny;
    if (approach <= 0.2) continue;
    const barrier = clamp01(dh / 2400) * approach;
    block *= 1 - barrier * 0.72;
    du += -ny * barrier * spd0 * 0.42;
    dv += nx * barrier * spd0 * 0.42;
  }

  const ridge = clamp01(Math.max(0, cell.height - 350) / 3200);
  block *= 1 - ridge * 0.38;

  let u = ux * block + du;
  let v = uy * block + dv;
  const spd = Math.hypot(u, v);
  const cap = spd0 * 0.92 + 3.5;
  if (spd > cap && spd > 0) {
    u = (u * cap) / spd;
    v = (v * cap) / spd;
  }
  return { u, v };
}

/** 暖低压、冷高压；风沿气压梯度 + 科氏 + 地形阻挡 + 季风 + 气旋 */
export function buildMeteoFields(
  cells: Cell[],
  bounds: [number, number, number, number],
  day = 0,
  seed = climateWorldSeed
): MeteoFields {
  const n = cells.length;
  const pSmooth = new Float64Array(n);
  const windU = new Float64Array(n);
  const windV = new Float64Array(n);
  const convergence = new Float64Array(n);
  const front = new Float64Array(n);

  const pRaw = computePressureRaw(cells, bounds, seed);
  const decl = solarDeclinationRad(day);
  const landSum = new Float64Array(PRESSURE_BANDS);
  const oceanSum = new Float64Array(PRESSURE_BANDS);
  const landCnt = new Float64Array(PRESSURE_BANDS);
  const oceanCnt = new Float64Array(PRESSURE_BANDS);
  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const b = Math.min(
      PRESSURE_BANDS - 1,
      Math.floor(cellLatitudeNorm(cell, bounds) * PRESSURE_BANDS)
    );
    if (cell.height < 0) {
      oceanSum[b] += cell.temperature;
      oceanCnt[b]++;
    } else {
      landSum[b] += cell.temperature;
      landCnt[b]++;
    }
  }

  // 多次邻域扩散：行星尺度格距大，单次平均不足以让等压线平滑成曲线
  const pBase = new Float64Array(n);
  for (let i = 0; i < n; i++) pBase[i] = pRaw[i] + (pAnom ? pAnom[i] : 0);
  for (let pass = 0; pass < 3; pass++) {
    const buf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = pBase[i] * 2;
      let cnt = 2;
      for (const nb of cells[i].neighbors) {
        sum += pBase[nb];
        cnt++;
      }
      buf[i] = sum / cnt;
    }
    pBase.set(buf);
  }
  for (let i = 0; i < n; i++) pSmooth[i] = pBase[i];

  const hour = hourOfDayFromDay(day);
  const dayPhaseWind = day * 0.38;
  const daylight = hour >= 5 && hour <= 19;
  const dayPhase = daylight ? Math.sin(((hour - 5) / 14) * Math.PI) : 0;
  const nightPhase = !daylight ? Math.sin(((hour < 5 ? hour + 19 : hour - 19) / 10) * Math.PI) : 0;

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const [x0, y0] = cell.site;
    const lat = cellLatitudeNorm(cell, bounds);
    const latR = cellLatitudeRad(cell, bounds);
    const b = Math.min(PRESSURE_BANDS - 1, Math.floor(lat * PRESSURE_BANDS));

    let gx = 0;
    let gy = 0;
    let tGrad = 0;
    let hGrad = 0;
    for (const nb of cell.neighbors) {
      const ncell = cells[nb];
      const [x1, y1] = ncell.site;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      gx += (pSmooth[nb] - pSmooth[i]) * ux / dist;
      gy += (pSmooth[nb] - pSmooth[i]) * uy / dist;
      tGrad = Math.max(tGrad, Math.abs(cell.temperature - ncell.temperature) / dist);
      hGrad = Math.max(
        hGrad,
        Math.abs(cell.humidity - ncell.humidity) / dist
      );
    }

    let ux = -gx * 9;
    let uy = -gy * 9;

    const meso =
      Math.sin(x0 * 0.11 + y0 * 0.083 + dayPhaseWind) * 2.2 +
      Math.cos(x0 * 0.19 - y0 * 0.14 + dayPhaseWind * 0.7) * 1.8 +
      Math.sin(x0 * 0.31 + y0 * 0.27 - dayPhaseWind * 0.5) * 1.1;
    ux += meso;
    uy += Math.cos(x0 * 0.13 - y0 * 0.17) * 2.4;

    const cyc = cycloneWindAt(x0, y0, bounds);
    ux += cyc.u;
    uy += cyc.v;

    const blocked = applyTerrainWindBlock(cells, i, ux, uy);
    ux = blocked.u;
    uy = blocked.v;

    const coriolis = applyCoriolisDeflection(cell.latDeg, ux, uy, 1.05);
    ux = coriolis.u;
    uy = coriolis.v;

    // 昼夜海陆风：白昼陆暖海风，夜间陆冷陆风
    if (cell.height >= 0 && landCnt[b] > 0 && oceanCnt[b] > 0) {
      const dT = landSum[b] / landCnt[b] - oceanSum[b] / oceanCnt[b];
      let ox = 0;
      let oy = 0;
      let ow = 0;
      for (const nb of cell.neighbors) {
        if (cells[nb].height >= 0) continue;
        const [xn, yn] = cells[nb].site;
        const dx = xn - x0;
        const dy = yn - y0;
        const dlen = Math.hypot(dx, dy) || 1;
        ox += dx / dlen;
        oy += dy / dlen;
        ow++;
      }
      if (ow > 0) {
        const seaDir = { x: ox / ow, y: oy / ow };
        if (daylight && dT > 0.15 && dayPhase > 0.05) {
          const str = clamp01((dT / 10) * dayPhase) * 9;
          ux += seaDir.x * str;
          uy += seaDir.y * str;
        } else if (!daylight && dT < -0.15 && nightPhase > 0.05) {
          const str = clamp01((-dT / 10) * nightPhase) * 7;
          ux -= seaDir.x * str;
          uy -= seaDir.y * str;
        }
      }
    }

    // 季风：夏季陆暖于海 → 海风（从海洋吹向陆地）
    if (cell.height >= 0 && landCnt[b] > 0 && oceanCnt[b] > 0) {
      const dT = landSum[b] / landCnt[b] - oceanSum[b] / oceanCnt[b];
      const hemisphere = latR >= 0 ? 1 : -1;
      const summer = Math.sign(decl) * hemisphere > 0.05;
      if (summer && dT > 0.4) {
        let ox = 0;
        let oy = 0;
        let ow = 0;
        for (const nb of cell.neighbors) {
          if (cells[nb].height >= 0) continue;
          const [xn, yn] = cells[nb].site;
          const dx = xn - x0;
          const dy = yn - y0;
          const dlen = Math.hypot(dx, dy) || 1;
          ox += dx / dlen;
          oy += dy / dlen;
          ow++;
        }
        if (ow > 0) {
          const str = clamp01((dT / 14) * Math.abs(Math.sin(decl))) * 4.5;
          ux += (ox / ow) * str;
          uy += (oy / ow) * str;
        }
      }
    }

    const spd = Math.hypot(ux, uy);
    const cap = cyc.strength > 0.15 ? Math.max(22, 10 + cyc.strength * 28) : 14;
    if (spd > cap) {
      ux = (ux * cap) / spd;
      uy = (uy * cap) / spd;
    }

    windU[i] = ux;
    windV[i] = uy;
    front[i] = clamp01(tGrad / 5.5 + hGrad * 0.35);

    cell.pressure = clampSeaLevelPressure(pSmooth[i]);
    cell.windU = ux;
    cell.windV = uy;
  }

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const [x0, y0] = cell.site;
    let div = 0;
    for (const nb of cell.neighbors) {
      const [x1, y1] = cells[nb].site;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dist = Math.hypot(dx, dy) || 1;
      const outFlux = (windU[i] * dx + windV[i] * dy) / dist;
      const inFlux = (windU[nb] * -dx + windV[nb] * -dy) / dist;
      div += Math.max(0, outFlux) - Math.max(0, inFlux);
    }
    convergence[i] = clamp01(Math.max(0, -div * 0.12));
  }

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const oro = orographicLift(cells, i, windU[i], windV[i]);
    cell.windExposure = clamp01(
      oro * 0.4 + convergence[i] * 0.38 + front[i] * 0.28
    );
    refreshCellAtmFromSurface(cell);
  }

  return { convergence, front, pBase: pSmooth };
}

function saturationHumidity(tempC: number): number {
  return clamp01(0.08 + 0.012 * (tempC + 12));
}

function clampSeaLevelPressure(p: number): number {
  if (!Number.isFinite(p)) return 1013;
  return Math.max(985, Math.min(1040, p));
}

function pLowBoost(pressure: number): number {
  return clamp01((1016 - clampSeaLevelPressure(pressure)) / 24);
}

function cloudCondensation(
  humidity: number,
  tempC: number,
  lift: number,
  convergence: number,
  pressure: number,
  front: number
): number {
  const sat = Math.max(0.06, saturationHumidity(tempC));
  const rh = humidity / sat;
  const supersat = Math.max(0, rh - 0.68);
  const base = supersat * humidity * (0.48 + lift * 1.05) * 2.4;
  const pLow = clamp01((1016 - pressure) / 24);
  const frontal = front * humidity * 0.85;
  return clamp01((base + frontal) * (0.42 + convergence * 0.38 + pLow * 0.42 + lift * 0.35));
}

/** 显示用云量：与云水、气压、湿度、降水一致（气象局云图语义） */
export function syncMeteoCloudDisplay(cells: Cell[]): void {
  for (const cell of cells) {
    const pLow = clamp01((1014 - cell.pressure) / 20);
    const sat = Math.max(0.06, saturationHumidity(cell.temperature));
    const rh = clamp01(cell.humidity / sat);
    const rain = cell.precip > 0.02 ? cell.precip : 0;
    const cw = cell.cloudWater;
    if (cw < 0.06 && pLow < 0.12 && rain < 0.02) {
      cell.cloud = 0;
      continue;
    }
    cell.cloud = clamp01(cw * 0.82 + pLow * rh * 0.18 + rain * 0.35);
  }
}

function cloudShadeFor(cell: Cell): number {
  return clamp01(0.35 * cell.cloudWater + 0.25 * cell.cloud);
}

function groundInsolation(cell: Cell): number {
  const shade = cloudShadeFor(cell);
  return clamp01(cell.insolationTop * (1 - shade) * (1 - cell.albedo * 0.85));
}

function radiativeEquilibrium(
  cell: Cell,
  cells: Cell[],
  bounds: [number, number, number, number],
  cloudShade: number,
  day: number
): number {
  const anchor = seasonalTemperatureAnchor(cell, cells, bounds, day);
  const ig = clamp01(cell.insolationTop * (1 - cloudShade) * (1 - cell.albedo * 0.85));
  const [x, y] = cell.site;
  const cycT = cycloneTempDelta(x, y);
  const rainCool = cell.precip > 0.04 ? -2.5 * cell.precip : 0;
  const cloudCool = cloudShade * 2.5;
  return anchor + (ig - 0.28) * 20 - cloudCool + cycT + rainCool;
}

function orographicLift(
  cells: Cell[],
  i: number,
  windU: number,
  windV: number
): number {
  const cell = cells[i];
  const wLen = Math.hypot(windU, windV) || 1;
  const wx = windU / wLen;
  const wy = windV / wLen;
  let maxGrad = 0;
  let windward = 0;
  let lee = 0;
  const [x0, y0] = cell.site;
  for (const nb of cell.neighbors) {
    const dh = cells[nb].height - cell.height;
    if (dh > maxGrad) maxGrad = dh;
    const [x1, y1] = cells[nb].site;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const dot = (dx / len) * wx + (dy / len) * wy;
    if (dot > 0.2 && dh > 0) windward += dh * dot;
    if (dot < -0.15 && dh < 0) lee += -dh * -dot;
  }
  const elevLift = clamp01(maxGrad / 1200);
  const windLift = clamp01(windward / 800);
  const leeDry = clamp01(lee / 700);
  return clamp01(0.35 * elevLift + 0.65 * windLift - leeDry * 0.22);
}

export interface ClimateTickParams {
  bounds: [number, number, number, number];
  day: number;
  cloud: CloudParams;
  worldSeed: number;
}

export interface ClimateTickSummary {
  avgTemp: number;
  avgInsolationGround: number;
  precipLandFrac: number;
  ecology: EcologyTickSummary;
}

/** 单日（或一小步）气候+生态 */
export function tickClimateStep(
  cells: Cell[],
  dtDays: number,
  params: ClimateTickParams
): EcologyTickSummary {
  const n = cells.length;
  const { bounds, day, worldSeed } = params;

  advectPressureAnomaly(cells, dtDays);
  relaxPressureAnomalyToThermal(cells, bounds, day, dtDays);

  const meteo = buildMeteoFields(cells, bounds, day, worldSeed);

  advectAirMassFields(cells, dtDays);
  airMassSurfaceExchange(cells, bounds, day, dtDays);
  updateOceanSSTIce(cells, bounds, day, worldSeed);
  applyOceanCurrentsToAirMass(cells, bounds, dtDays);
  applyAirMassToState(cells, bounds);

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    updateInsolationTop(cell, bounds, day);
  }

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const lift = cell.windExposure;
    const conv = meteo.convergence[i];
    const front = airMassFrontStrength(cells, i, meteo.front[i]);

    if (cell.height < 0) {
      cell.humidity = clamp01(
        cell.humidity +
          0.012 * dtDays * clamp01(1 - cell.humidity / saturationHumidity(cell.temperature))
      );
    } else if (cell.surface === "freshLake" || cell.surface === "wetland") {
      cell.humidity = clamp01(cell.humidity + 0.012 * dtDays);
      cell.waterFresh = clamp01(cell.waterFresh + 0.003 * dtDays);
    } else if (cell.vegetation !== "none") {
      const transp = (0.004 + cell.pools.biomass * 0.008) * dtDays;
      cell.waterFresh = clamp01(cell.waterFresh - transp * 0.6);
      cell.humidity = clamp01(cell.humidity + transp * 0.4);
    }

    const [cx, cy] = cell.site;
    const spiral = cycloneCloudFactor(cx, cy);
    cell.humidity = clamp01(cell.humidity + cycloneHumidityBoost(cx, cy) * dtDays * 0.35);

    const baseCw = cloudCondensation(
      cell.humidity,
      cell.temperature,
      lift,
      conv,
      cell.pressure,
      front
    );
    cell.cloudWater = clamp01(baseCw * (1 + spiral * 0.55) + spiral * 0.1);

    const dailyPrecipRate =
      cell.cloudWater * cell.humidity * (0.14 + lift * 0.55) * (0.1 + pLowBoost(cell.pressure) * 0.1);
    const stepPrecip = clamp01(1 - Math.exp(-dailyPrecipRate * dtDays));
    cell.precip = clamp01(dailyPrecipRate * 0.65);
    cell.humidity = clamp01(cell.humidity - stepPrecip * 0.45);
    if (cell.height >= 0) {
      cell.waterFresh = clamp01(cell.waterFresh + stepPrecip * 0.85);
    }

    updateAlbedo(cell);
    cell.insolationGround = groundInsolation(cell);
    cell.insolation = cell.insolationGround;

    const shade = cloudShadeFor(cell);
    const climatic = radiativeEquilibrium(cell, cells, bounds, shade, day);
    const airT = airMassT ? airMassT[i] : 0;
    const tTarget = climatic + airT;
    const inertia = surfaceThermalInertia(cell);
    const relax = 1 - Math.exp((-0.22 * dtDays) / inertia);
    cell.temperature += (tTarget - cell.temperature) * relax;
    if (cell.height >= 2000) {
      cell.temperature -= 0.015 * dtDays * (cell.height / 1000);
    }
  }

  const meteoFinal = buildMeteoFields(cells, bounds, day, worldSeed);
  syncCyclonesFromPressure(cells, meteoFinal.pBase, bounds, dtDays);
  syncMeteoCloudDisplay(cells);

  const ecology = tickEcology(cells, dtDays);

  for (const cell of cells) {
    updateAlbedo(cell);
    cell.insolationGround = groundInsolation(cell);
    cell.insolation = cell.insolationGround;
  }

  return ecology;
}

/** 实时播放：整段 dt 一次积分，避免拆成多日小步拖慢 */
export function tickClimateFrame(
  cells: Cell[],
  dtDays: number,
  params: ClimateTickParams
): ClimateTickSummary {
  if (dtDays <= 0) {
    return {
      avgTemp: 0,
      avgInsolationGround: 0,
      precipLandFrac: 0,
      ecology: {
        landCells: 0,
        vegCounts: { none: 0, moss: 0, shrub: 0, grass: 0, forest: 0 },
        avgBiomass: 0,
        avgBioN: 0,
      },
    };
  }
  const ecology = tickClimateStep(cells, dtDays, params);
  let tSum = 0;
  let iSum = 0;
  let land = 0;
  let precipLand = 0;
  for (const c of cells) {
    if (c.height < 0) continue;
    land++;
    tSum += c.temperature;
    iSum += c.insolationGround;
    if (c.precip > 0.05) precipLand++;
  }
  return {
    avgTemp: land > 0 ? tSum / land : 0,
    avgInsolationGround: land > 0 ? iSum / land : 0,
    precipLandFrac: land > 0 ? precipLand / land : 0,
    ecology,
  };
}

export function tickClimate(
  cells: Cell[],
  dtDays: number,
  params: ClimateTickParams
): ClimateTickSummary {
  const stepDays = climateStepDaysForSpan(dtDays);
  let remaining = dtDays;
  let dayOffset = 0;
  let ecology: EcologyTickSummary = {
    landCells: 0,
    vegCounts: { none: 0, moss: 0, shrub: 0, grass: 0, forest: 0 },
    avgBiomass: 0,
    avgBioN: 0,
  };

  while (remaining > 0) {
    const step = Math.min(stepDays, remaining);
    ecology = tickClimateStep(cells, step, {
      ...params,
      day: params.day + dayOffset,
    });
    remaining -= step;
    dayOffset += step;
  }

  let tSum = 0;
  let iSum = 0;
  let land = 0;
  let precipLand = 0;
  for (const c of cells) {
    if (c.height < 0) continue;
    land++;
    tSum += c.temperature;
    iSum += c.insolationGround;
    if (c.precip > 0.05) precipLand++;
  }

  return {
    avgTemp: land > 0 ? tSum / land : 0,
    avgInsolationGround: land > 0 ? iSum / land : 0,
    precipLandFrac: land > 0 ? precipLand / land : 0,
    ecology,
  };
}

export function warmupClimate(
  cells: Cell[],
  bounds: [number, number, number, number],
  _cloud: CloudParams,
  days = 180,
  worldSeed = 42
): number {
  const step = 10;
  let d = 0;
  while (d < days) {
    const dt = Math.min(step, days - d);
    tickClimateStep(cells, dt, { bounds, day: d, cloud: _cloud, worldSeed });
    d += dt;
  }
  return days;
}

export function climateSummary(
  cells: Cell[],
  day = 0,
  planet?: PlanetTileContext
): string {
  let land = 0;
  let t = 0;
  let ig = 0;
  let cw = 0;
  let pr = 0;
  let pLo = Infinity;
  let pHi = -Infinity;
  let tLo = Infinity;
  let tHi = -Infinity;
  for (const c of cells) {
    if (c.pressure < pLo) pLo = c.pressure;
    if (c.pressure > pHi) pHi = c.pressure;
    if (c.temperature < tLo) tLo = c.temperature;
    if (c.temperature > tHi) tHi = c.temperature;
    if (c.height < 0) continue;
    land++;
    t += c.temperature;
    ig += c.insolationGround;
    cw += c.cloudWater;
    if (c.precip > 0.02) pr++;
  }
  if (land === 0) return "";
  const cyc = cycloneSummary();
  const localH = hourOfDayFromDay(day).toFixed(1);
  const base = `地方时 ${localH}h · 气温 ${tLo.toFixed(0)}~${tHi.toFixed(0)}°C · 气压 ${clampSeaLevelPressure(pLo).toFixed(0)}~${clampSeaLevelPressure(pHi).toFixed(0)} hPa · 地面日照 ${((ig / land) * 100).toFixed(0)}% · 云水 ${((cw / land) * 100).toFixed(0)}% · 降水格 ${((pr / land) * 100).toFixed(0)}%`;
  const met = cyc ? `${base} · ${cyc}` : base;
  if (!planet) return met;
  return `${met} · ${geoClimateFooter(cells, day, planet)}`;
}
