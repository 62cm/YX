/**
 * 日照 → 海表温度(SST) → 洋流混合 → 海冰（波浪状边界）
 */

import type { Cell } from "./types";
import { isOceanCell } from "./attribution";
import {
  cellLatitudeNorm,
  insolationTopAt,
  solarDeclinationRad,
} from "./surface";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function hash2(x: number, y: number, seed: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 43758.5453) * 43758.5453;
  return s - Math.floor(s);
}

/** 海冰/极地冰盖有效纬度阈值（波浪形，非水平带） */
export function polarMarginLatNorm(latNorm: number, lonDeg: number, seed: number): number {
  const lonR = (lonDeg * Math.PI) / 180;
  const w1 = Math.sin(lonR * 3.1 + seed * 0.11) * 0.065;
  const w2 = Math.sin(lonR * 5.7 - latNorm * 11 + seed * 0.19) * 0.042;
  const w3 = (hash2(lonDeg * 0.7, latNorm * 100, seed) - 0.5) * 0.055;
  return clamp01(0.76 + w1 + w2 + w3);
}

export function seaIceFraction(
  sst: number,
  latNorm: number,
  lonDeg: number,
  seed: number,
  day: number
): number {
  if (sst > 1.5 && latNorm < 0.72) return 0;
  const margin = polarMarginLatNorm(latNorm, lonDeg, seed);
  const decl = solarDeclinationRad(day);
  const seasonal = Math.sin(decl * 1.6) * 0.035 * clamp01((latNorm - 0.55) / 0.35);
  const latExcess = latNorm - margin + seasonal;
  if (latExcess <= -0.02) return 0;
  const thermal = clamp01((-1.5 - sst) / 5);
  return clamp01(latExcess * 9 + thermal * 0.55);
}

export function polarLandIceLikely(
  latNorm: number,
  lonDeg: number,
  temp: number,
  height: number,
  seed: number
): boolean {
  if (height < 0) return false;
  const margin = polarMarginLatNorm(latNorm, lonDeg, seed);
  if (latNorm <= margin) return false;
  const excess = latNorm - margin;
  return temp < 6 - excess * 28;
}

let sstField: Float64Array | null = null;

export function oceanSSTAt(i: number): number {
  return sstField ? sstField[i] : 15;
}

function oceanGyreVector(latRad: number, lonRad: number): [number, number] {
  const curl = Math.sin(latRad * 1.7 + lonRad * 0.4);
  const u = 0.42 * Math.sign(latRad || 1) + 0.58 * curl;
  const v = 0.24 * Math.cos(latRad * 1.35 + lonRad * 0.25);
  const len = Math.hypot(u, v) || 1;
  return [u / len, v / len];
}

/** 更新洋面 SST、海冰与洋面气温 */
export function updateOceanSSTIce(
  cells: Cell[],
  bounds: [number, number, number, number],
  day: number,
  seed: number
): void {
  const n = cells.length;
  if (!sstField || sstField.length !== n) sstField = new Float64Array(n);

  const decl = solarDeclinationRad(day);

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    if (cell.height >= 0) continue;
    const latNorm = cellLatitudeNorm(cell, bounds);
    const latR = (Math.abs(cell.latDeg) * Math.PI) / 180;
    const insol = insolationTopAt(latR, decl);
    const depthCool = Math.min(8, Math.max(0, -cell.height) * 0.008);
    const base = 27 - latNorm * 48;
    sstField[i] = base + insol * 7 - depthCool;
  }

  const mixed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    if (cell.height >= 0) continue;
    const latR = (cell.latDeg * Math.PI) / 180;
    const lonR = (cell.lonDeg * Math.PI) / 180;
    const [gx, gy] = oceanGyreVector(latR, lonR);
    const [x0, y0] = cell.site;

    let upwind = i;
    let bestDot = -Infinity;
    for (const nb of cell.neighbors) {
      if (cells[nb].height >= 0) continue;
      const [x1, y1] = cells[nb].site;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const dot = (dx / len) * gx + (dy / len) * gy;
      if (dot > bestDot) {
        bestDot = dot;
        upwind = nb;
      }
    }

    let sum = sstField[i];
    let cnt = 1;
    for (const nb of cell.neighbors) {
      if (cells[nb].height >= 0) continue;
      sum += sstField[nb];
      cnt++;
    }
    const avg = sum / cnt;
    const advect = sstField[upwind];
    mixed[i] = sstField[i] * 0.45 + avg * 0.35 + advect * 0.2;
  }
  sstField = mixed;

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    if (cell.height >= 0) continue;
    const latNorm = cellLatitudeNorm(cell, bounds);
    const sst = sstField[i];
    const ice = seaIceFraction(sst, latNorm, cell.lonDeg, seed, day);

    if (ice > 0.25) {
      cell.fillKind = "ice";
      cell.surface = "ice";
      cell.temperature = -6 - ice * 18;
      cell.albedo = 0.72 + ice * 0.2;
    } else if (isOceanCell(cell) || cell.crustKind === "oceanic") {
      cell.fillKind = "saltWater";
      cell.surface = "saltSea";
      cell.temperature = sst;
      cell.albedo = 0.06;
    }
    sstField[i] = sst * (1 - ice) + (-1.8) * ice;
  }
}

/** 洋流将 SST 异常传递给大气（替换原简化洋流） */
export function advectAirMassByOceanCurrents(
  cells: Cell[],
  _bounds: [number, number, number, number],
  dtDays: number,
  airMassT: Float64Array
): void {
  const n = cells.length;
  const tNext = Float64Array.from(airMassT);
  const blend = 1 - Math.exp(-0.035 * dtDays);

  for (let i = 0; i < n; i++) {
    if (cells[i].height >= 0) continue;
    const sstAnom = oceanSSTAt(i) - 15;
    tNext[i] += blend * 0.12 * sstAnom;

    const latR = (cells[i].latDeg * Math.PI) / 180;
    const lonR = (cells[i].lonDeg * Math.PI) / 180;
    const [gx, gy] = oceanGyreVector(latR, lonR);
    const [x0, y0] = cells[i].site;

    let best = -1;
    let bestDot = -Infinity;
    for (const nb of cells[i].neighbors) {
      if (cells[nb].height >= 0) continue;
      const [x1, y1] = cells[nb].site;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const dot = (dx / len) * gx + (dy / len) * gy;
      if (dot > bestDot) {
        bestDot = dot;
        best = nb;
      }
    }
    if (best < 0) continue;
    tNext[i] += blend * 0.32 * (airMassT[best] - tNext[i]);
  }

  for (let i = 0; i < n; i++) {
    airMassT[i] = Math.max(-14, Math.min(14, tNext[i]));
  }
}
