/**

 * 气旋/反气旋：从基础气压场识别极值，按半球科氏方向旋转，随风移动与生消

 */



import type { Cell } from "./types";

import { cycloneSpinSign } from "./geoFrame";



function clamp01(v: number): number {

  return Math.max(0, Math.min(1, v));

}



/** 中尺度气旋半径 km（非木星斑） */

const CYCLONE_RADIUS_BASE_KM = 8;
const CYCLONE_RADIUS_PER_HPA = 1.1;
const CYCLONE_MIN_SEP_KM = 48;



export interface Cyclone {

  id: number;

  x: number;

  y: number;

  cellIdx: number;

  radius: number;

  dp: number;

  spin: 1 | -1;

  latDeg: number;

  age: number;

  maxAge: number;

  intensity: number;

  missed: number;

}



interface Extremum {

  cellIdx: number;

  x: number;

  y: number;

  p: number;

  dev: number;

  isLow: boolean;

  latDeg: number;

}



let active: Cyclone[] = [];

let nextId = 1;



function findLocalExtrema(cells: Cell[], pBase: Float64Array): Extremum[] {

  const raw: Extremum[] = [];

  for (let i = 0; i < cells.length; i++) {

    const p = pBase[i];

    if (!Number.isFinite(p)) continue;

    let isMin = true;

    let isMax = true;

    for (const nb of cells[i].neighbors) {

      if (pBase[nb] < p) isMin = false;

      if (pBase[nb] > p) isMax = false;

    }

    const lowDev = 1013 - p;

    const highDev = p - 1013;

    if (isMin && lowDev >= 1.0) {

      raw.push({

        cellIdx: i,

        x: cells[i].site[0],

        y: cells[i].site[1],

        p,

        dev: lowDev,

        isLow: true,

        latDeg: cells[i].latDeg,

      });

    } else if (isMax && highDev >= 1.0) {

      raw.push({

        cellIdx: i,

        x: cells[i].site[0],

        y: cells[i].site[1],

        p,

        dev: highDev,

        isLow: false,

        latDeg: cells[i].latDeg,

      });

    }

  }

  raw.sort((a, b) => b.dev - a.dev);

  return raw;

}



function pickSeparated(extrema: Extremum[], minSep: number, maxCount: number): Extremum[] {

  const picked: Extremum[] = [];

  for (const e of extrema) {

    if (picked.some((p) => Math.hypot(p.x - e.x, p.y - e.y) < minSep)) continue;

    picked.push(e);

    if (picked.length >= maxCount) break;

  }

  return picked;

}



function cycloneFromExtremum(e: Extremum): Cyclone {

  const isLow = e.isLow;

  return {

    id: nextId++,

    x: e.x,

    y: e.y,

    cellIdx: e.cellIdx,

    radius: CYCLONE_RADIUS_BASE_KM + e.dev * CYCLONE_RADIUS_PER_HPA,

    dp: isLow ? -e.dev : e.dev,

    spin: cycloneSpinSign(isLow, e.latDeg),

    latDeg: e.latDeg,

    age: 0,

    maxAge: 35 + e.dev * 8,

    intensity: clamp01(e.dev / 9),

    missed: 0,

  };

}



export function syncCyclonesFromPressure(

  cells: Cell[],

  pBase: Float64Array,

  _bounds: [number, number, number, number],

  dtDays: number

): void {

  const minSep = CYCLONE_MIN_SEP_KM;

  const dt = Math.max(dtDays, 1 / 24);

  const maxDrift = minSep * 2.8 + dt * 200;



  const extrema = pickSeparated(findLocalExtrema(cells, pBase), minSep, 6);

  const used = new Set<number>();

  const next: Cyclone[] = [];



  for (const c of active) {

    let bestIdx = -1;

    let bestScore = -Infinity;

    for (let ei = 0; ei < extrema.length; ei++) {

      if (used.has(ei)) continue;

      const e = extrema[ei];

      if ((c.dp < 0) !== e.isLow) continue;

      const d = Math.hypot(e.x - c.x, e.y - c.y);

      if (d > maxDrift) continue;

      const score = e.dev - d * 0.018;

      if (score > bestScore) {

        bestScore = score;

        bestIdx = ei;

      }

    }



    if (bestIdx >= 0) {

      used.add(bestIdx);

      const e = extrema[bestIdx];

      const cell = cells[e.cellIdx];

      const steerU = cell.windU;

      const steerV = cell.windV;

      const cellChanged = e.cellIdx !== c.cellIdx;

      const snap = cellChanged ? Math.min(1, 0.65 + dt * 22) : 1 - Math.exp(-8 * dt);

      const nc: Cyclone = {

        ...c,

        x: c.x + (e.x - c.x) * snap + steerU * dt * 1.15,

        y: c.y + (e.y - c.y) * snap + steerV * dt * 1.15,

        cellIdx: e.cellIdx,

        dp: e.isLow ? -e.dev : e.dev,

        radius: CYCLONE_RADIUS_BASE_KM + e.dev * CYCLONE_RADIUS_PER_HPA,

        intensity: clamp01(e.dev / 9),

        latDeg: e.latDeg,

        spin: cycloneSpinSign(e.isLow, e.latDeg),

        age: c.age + dtDays,

        maxAge: Math.max(c.maxAge, 30 + e.dev * 9),

        missed: 0,

      };

      const life = nc.age / nc.maxAge;

      if (life < 1.15 && nc.intensity > 0.1) next.push(nc);

    } else {

      const fade = { ...c, age: c.age + dtDays, missed: c.missed + 1 };

      fade.intensity = clamp01(fade.intensity * (1 - 0.14 * dt));

      if (fade.missed < 4 && fade.intensity > 0.07 && fade.age / fade.maxAge < 1.2) {

        const cell = cells[fade.cellIdx];

        if (cell) {

          fade.x += cell.windU * dt * 1.1;

          fade.y += cell.windV * dt * 1.1;

        }

        next.push(fade);

      }

    }

  }



  for (let ei = 0; ei < extrema.length; ei++) {

    if (used.has(ei)) continue;

    const e = extrema[ei];

    if (e.dev < 1.45) continue;

    if (next.some((c) => Math.hypot(c.x - e.x, c.y - e.y) < minSep * 0.55)) continue;

    next.push(cycloneFromExtremum(e));

  }



  active = next;

}



export function getCyclones(): readonly Cyclone[] {

  return active;

}



export function seedCyclonesFromPressure(

  cells: Cell[],

  pBase: Float64Array,

  _bounds: [number, number, number, number]

): void {

  const extrema = pickSeparated(findLocalExtrema(cells, pBase), CYCLONE_MIN_SEP_KM, 5);

  active = extrema.filter((e) => e.dev >= 1.35).map((e) => cycloneFromExtremum(e));

}



export function cycloneWindAt(x: number, y: number, _bounds: [number, number, number, number]): {

  u: number;

  v: number;

  strength: number;

} {

  let u = 0;

  let v = 0;

  let strength = 0;

  for (const c of active) {

    const dx = x - c.x;

    const dy = y - c.y;

    const r = Math.hypot(dx, dy) || 1;

    const R = c.radius;

    const falloff = Math.exp(-Math.pow(r / (R * 1.35), 2));

    if (falloff < 0.02) continue;



    const tx = -dy / r;

    const ty = dx / r;

    const mag = c.intensity * (3.2 + Math.abs(c.dp) * 0.28) * falloff;

    const tang = c.spin * mag;

    u += tx * tang;

    v += ty * tang;

    strength = Math.max(strength, falloff * c.intensity);

  }

  return { u, v, strength };

}



export function cycloneCloudFactor(x: number, y: number): number {

  let best = 0;

  for (const c of active) {

    if (c.dp > 0) continue;

    const dx = x - c.x;

    const dy = y - c.y;

    const r = Math.hypot(dx, dy);

    const theta = Math.atan2(dy, dx);

    const R = c.radius;

    const radial = Math.exp(-Math.pow(r / (R * 2.4), 2));

    const bands = Math.sin(theta * 2.8 - r / 22 + c.age * 0.12) * 0.5 + 0.5;

    const eye = Math.exp(-Math.pow(r / (R * 0.25), 2)) * 0.5;

    const v = clamp01(radial * (0.35 + 0.65 * bands) - eye);

    best = Math.max(best, v * c.intensity);

  }

  return best;

}



export function anticycloneCloudFactor(x: number, y: number): number {

  let best = 0;

  for (const c of active) {

    if (c.dp < 0) continue;

    const dx = x - c.x;

    const dy = y - c.y;

    const r = Math.hypot(dx, dy);

    const theta = Math.atan2(dy, dx);

    const R = c.radius;

    const radial = Math.exp(-Math.pow(r / (R * 2.8), 2));

    const bands = Math.sin(theta * 2.4 + r / 28 - c.age * 0.06) * 0.5 + 0.5;

    const v = clamp01(radial * (0.18 + 0.42 * bands));

    best = Math.max(best, v * c.intensity * 0.55);

  }

  return best;

}



export function satelliteCloudBrightness(x: number, y: number): number {

  return Math.max(cycloneCloudFactor(x, y), anticycloneCloudFactor(x, y));

}



export function cycloneTempDelta(x: number, y: number): number {

  let dT = 0;

  for (const c of active) {

    const dx = x - c.x;

    const dy = y - c.y;

    const r = Math.hypot(dx, dy);

    const R = c.radius;

    const core = Math.exp(-Math.pow(r / (R * 0.85), 2));

    if (c.dp < 0) dT += c.intensity * core * 3.5;

    else dT -= c.intensity * core * 2;

  }

  return dT;

}



export function cycloneHumidityBoost(x: number, y: number): number {

  let h = 0;

  for (const c of active) {

    if (c.dp > 0) continue;

    const dx = x - c.x;

    const dy = y - c.y;

    const r = Math.hypot(dx, dy);

    const R = c.radius;

    h = Math.max(h, Math.exp(-Math.pow(r / (R * 2), 2)) * c.intensity * 0.5);

  }

  return h;

}



export function cycloneSummary(): string {

  if (active.length === 0) return "";

  let cycl = 0;

  let anti = 0;

  for (const c of active) {

    if (c.dp < 0) cycl++;

    else anti++;

  }

  return `气旋 ${cycl} · 反气旋 ${anti}`;

}


