import type { Cell, GeologyKind, SurfaceKind, VegetationKind } from "./types";
import { SURFACE, VEGETATION } from "./types";
import { isOceanCell } from "./attribution";
import { polarLandIceLikely, polarMarginLatNorm } from "./polarOcean";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 永冻土略低于冰盖边界 */
function polarMarginForPermafrost(latNorm: number, lonDeg: number, seed: number): number {
  return Math.max(0.55, polarMarginLatNorm(latNorm, lonDeg, seed) - 0.06);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** 纬度归一化：0=赤道，1=极地（按 y 坐标） */
export function latitudeNorm(y: number, bounds: [number, number, number, number]): number {
  const [, y0, , y1] = bounds;
  const mid = (y0 + y1) * 0.5;
  const half = Math.max(1e-6, (y1 - y0) * 0.5);
  return clamp01(Math.abs(y - mid) / half);
}

/** 纬度弧度：南负北正（优先用行星坐标 latDeg） */
export function latitudeRad(y: number, bounds: [number, number, number, number]): number {
  const [, y0, , y1] = bounds;
  const mid = (y0 + y1) * 0.5;
  const half = Math.max(1e-6, (y1 - y0) * 0.5);
  const t = (y - mid) / half;
  return Math.max(-Math.PI / 2, Math.min(Math.PI / 2, t * (Math.PI / 2)));
}

export function cellLatitudeRad(cell: Cell, bounds: [number, number, number, number]): number {
  if (Number.isFinite(cell.latDeg)) return (cell.latDeg * Math.PI) / 180;
  return latitudeRad(cell.site[1], bounds);
}

export function cellLongitudeRad(cell: Cell, bounds: [number, number, number, number]): number {
  if (Number.isFinite(cell.lonDeg)) return (cell.lonDeg * Math.PI) / 180;
  return longitudeRad(cell.site[0], bounds);
}

/** 归一化纬度 0=赤道 1=极地（用绝对纬度） */
export function cellLatitudeNorm(cell: Cell, bounds: [number, number, number, number]): number {
  if (Number.isFinite(cell.latDeg)) return clamp01(Math.abs(cell.latDeg) / 90);
  return latitudeNorm(cell.site[1], bounds);
}

/** 太阳赤纬（弧度）；day≈80 为春分 */
export function solarDeclinationRad(day: number): number {
  const doy = ((day % 365.25) + 365.25) % 365.25;
  return ((23.45 * Math.PI) / 180) * Math.sin((2 * Math.PI * (doy - 80)) / 365.25);
}

/** 日照：赤道最强、两极最弱（静态纬度余弦，无季节） */
export function insolationFromLat(latNorm: number): number {
  const latRad = latNorm * Math.PI * 0.5;
  return clamp01(0.15 + 0.85 * Math.cos(latRad));
}

/** 经度弧度：x 向西为负、向东为正（域中心为 0） */
export function longitudeRad(x: number, bounds: [number, number, number, number]): number {
  const [x0, , x1] = bounds;
  const mid = (x0 + x1) * 0.5;
  const half = Math.max(1e-6, (x1 - x0) * 0.5);
  return Math.max(-Math.PI, Math.min(Math.PI, ((x - mid) / half) * Math.PI));
}

/** 模拟时刻 → 地方时 0~24（day 可为小数） */
export function hourOfDayFromDay(day: number): number {
  const frac = ((day % 1) + 1) % 1;
  return frac * 24;
}

/**
 * 瞬时大气顶日照 0~1：纬度 + 经度 + 日序 + 地方时
 * 太阳随地球自转扫过各经度，产生昼夜明暗带
 */
export function insolationInstantAt(
  latRad: number,
  lonRad: number,
  declRad: number,
  hourOfDay: number
): number {
  const solarFrac = hourOfDay / 24;
  const subsolarLon = (solarFrac - 0.5) * 2 * Math.PI;
  const hourAngle = lonRad - subsolarLon;

  const sinElev =
    Math.sin(latRad) * Math.sin(declRad) +
    Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngle);
  if (sinElev <= 0.001) return 0;

  const twilight = clamp01(sinElev / 0.08);
  return clamp01(0.01 + 0.99 * sinElev * twilight);
}

/**
 * 大气顶日照 0~1：赤纬 + 纬度 → 日照带随季节南北移动（日平均）
 * 高纬冬季可近 0，夏季可强；赤道年较差小
 */
export function insolationTopAt(latRad: number, declRad: number): number {
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const sinDecl = Math.sin(declRad);
  const cosDecl = Math.cos(declRad);

  const sinElev = sinLat * sinDecl + cosLat * cosDecl;
  if (sinElev <= -0.02) return 0.02;

  const tanProd = Math.abs(cosLat) < 1e-5 ? 0 : Math.tan(latRad) * Math.tan(declRad);
  let daylightFrac = 0.5;
  if (tanProd < -1) daylightFrac = 1;
  else if (tanProd > 1) daylightFrac = 0;
  else daylightFrac = Math.acos(-tanProd) / Math.PI;

  const intensity = Math.max(0, sinElev);
  return clamp01(0.04 + 0.96 * intensity * (0.25 + 0.75 * daylightFrac));
}

/** 地表热惯性（比热代理）：越大升温/降温越慢 */
export function surfaceThermalInertia(cell: Cell): number {
  if (cell.height < 0) return 4.5;

  switch (cell.surface) {
    case "sand":
    case "saltFlat":
      return 0.32;
    case "beach":
      return 0.55;
    case "ice":
      return 2.2;
    case "permafrost":
      return 1.6;
    case "wetland":
    case "freshLake":
      return 2.6;
    case "saltSea":
      return 4.5;
    default:
      break;
  }

  switch (cell.vegetation) {
    case "forest":
      return 1.55;
    case "grass":
      return 1.05;
    case "shrub":
      return 0.85;
    case "moss":
      return 1.2;
    default:
      return 0.7;
  }
}

export function hoBinding(H: number, O: number): number {
  if (H + O < 1e-6) return 0;
  return clamp01((2 * Math.min(H, O)) / (H + O));
}

export function oxidationIndex(H: number, O: number, _C: number, Si: number): number {
  const waterO = Math.min(H * 0.5, O);
  const mineralO = Math.max(0, O - waterO);
  const silicateO = Si * 0.4;
  return clamp01((mineralO + silicateO) / (O + 1e-6));
}

export function reductionIndex(H: number, O: number, C: number, geology: GeologyKind): number {
  let r = C * 1.8 + Math.max(0, H - O * 0.25) * 0.5;
  if (geology === "basin") r += 0.12;
  if (geology === "volcanic") r += 0.08;
  return clamp01(r);
}

function coastalFactor(cell: Cell, cells: Cell[]): number {
  for (const nb of cell.neighbors) {
    if (cells[nb].height < 0) return 1;
  }
  return 0;
}

/** 到最近海域的格跳数（0=海岸），上限 8 */
function hopsToOcean(cell: Cell, cells: Cell[], maxHops = 8): number {
  if (cell.height < 0) return 0;
  const visited = new Set<number>([cell.id]);
  let frontier = [cell.id];
  for (let hop = 1; hop <= maxHops; hop++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const nb of cells[id].neighbors) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        if (cells[nb].height < 0) return hop;
        next.push(nb);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return maxHops;
}

/** 地图南北跨度折合纬度（°），约 111 km/° */
export function latitudeSpanDeg(bounds: [number, number, number, number]): number {
  return Math.max(1, (bounds[3] - bounds[1]) / 111);
}

/** 纬度+海拔基准气温（0=赤道暖，1=极地冷） */
export function latitudeBaseTemperature(
  cell: Cell,
  bounds: [number, number, number, number]
): number {
  const lat = cellLatitudeNorm(cell, bounds);
  const span = latitudeSpanDeg(bounds);
  const delta = lat * span * 0.28;
  const lapse = -6.2 * (Math.max(0, cell.height) / 1000);
  return 26 - delta + lapse;
}

/** 局地调制：海岸、内陆、地表、植被、微地形噪声 */
export function localTemperatureDetail(
  cell: Cell,
  cells: Cell[],
  bounds: [number, number, number, number]
): number {
  const lat = cellLatitudeNorm(cell, bounds);
  let t = latitudeBaseTemperature(cell, bounds);

  if (cell.height < 0) {
    const depthN = clamp01(-cell.height / 4000);
    const span = latitudeSpanDeg(bounds);
    const delta = lat * span * 0.22;
    return 18 - delta - depthN * 5;
  }

  const coastal = coastalFactor(cell, cells);
  const inlandN = clamp01(hopsToOcean(cell, cells) / 8);

  t += coastal * (2.5 - lat * 5);
  t += inlandN * (1.2 + 2 * lat * (1 - lat) * 4);
  // 迎风坡略湿冷、背风坡略暖（邻域高度差粗估）
  let leeWarm = 0;
  for (const nb of cell.neighbors) {
    const dh = cells[nb].height - cell.height;
    if (dh < -200) leeWarm += 0.4;
    if (dh > 400) leeWarm -= 0.5;
  }
  t += Math.max(-2, Math.min(2, leeWarm));

  switch (cell.surface) {
    case "sand":
    case "saltFlat":
      t += 6;
      break;
    case "ice":
      t -= 18;
      break;
    case "permafrost":
      t -= 12;
      break;
    case "wetland":
    case "freshLake":
      t -= 2.5;
      break;
    case "beach":
      t += 1;
      break;
    case "volcanicRock":
      t += 2;
      break;
    case "rockySlope":
      t -= 1.5 * clamp01(cell.height / 2500);
      break;
  }

  if (cell.vegetation === "forest") t -= 2;
  else if (cell.vegetation === "grass") t -= 0.8;
  else if (cell.vegetation === "moss") t -= 1.2;

  const [x, cy] = cell.site;
  const micro =
    Math.sin(x * 0.071 + cy * 0.053) * 2.2 +
    Math.sin(x * 0.17 - cy * 0.13) * 1.4 +
    Math.cos(x * 0.31 + cy * 0.27) * 0.9;
  t += micro;

  return t;
}

/** 生成后写入细腻初始气温 */
export function enrichCellTemperatures(
  cells: Cell[],
  bounds: [number, number, number, number]
): void {
  for (const cell of cells) {
    cell.temperature = localTemperatureDetail(cell, cells, bounds);
  }
}

/** 雪线高度 (m)：赤道 ~5200m，极地 ~400m */
export function snowLineM(latNorm: number): number {
  return 400 + (1 - latNorm) * 4800;
}

const NO_VEG_SUBSTRATES = new Set<SurfaceKind>([
  "saltSea",
  "freshLake",
  "saltFlat",
  "bareRock",
  "ice",
  "beach",
]);

function classifySubstrate(
  cell: Cell,
  latNorm: number,
  humidity: number,
  waterFresh: number,
  waterSalt: number,
  coastal: number,
  worldSeed = 42
): SurfaceKind {
  const { height, geology, temperature, fillKind, crustKind } = cell;
  const snowLine = snowLineM(latNorm);

  if (isOceanCell(cell) || (crustKind === "oceanic" && height < 0)) return "saltSea";
  if (height < 0 && fillKind === "ice") return "ice";
  if (height < 0 && fillKind === "freshWater") {
    return waterFresh > 0.72 ? "freshLake" : "wetland";
  }
  if (height < 0 && fillKind === "air") return "bareRock";
  if (waterSalt > 0.55 && cell.geology === "basin") return "saltFlat";
  if (waterFresh > 0.72) return waterFresh > 0.85 ? "freshLake" : "wetland";
  if (waterFresh > 0.48 && (coastal > 0.35 || cell.geology === "basin")) {
    return waterFresh > 0.65 ? "freshLake" : "wetland";
  }
  if (coastal > 0 && height < 80) return "beach";

  if (geology === "volcanic") return "volcanicRock";

  const isHighAlpine = height >= snowLine - 500;

  if (geology === "mountain" || height >= 2000) {
    if (height >= snowLine - 200 && temperature < 5) return "ice";
    if (height >= snowLine && temperature < 8) return "ice";
    if (height >= 3000 || (geology === "mountain" && height >= 2200)) return "bareRock";
    if (height >= 1200) return "rockySlope";
  }

  if (height >= snowLine - 300 && temperature < 2) return "ice";

  if (polarLandIceLikely(latNorm, cell.lonDeg, temperature, height, worldSeed)) return "ice";
  const polarPermafrost =
    latNorm > polarMarginForPermafrost(latNorm, cell.lonDeg, worldSeed) && temperature < 0;
  const alpinePermafrost =
    height >= snowLine - 700 && height < snowLine && temperature < -4 && latNorm > 0.45;
  if (polarPermafrost || alpinePermafrost) return "permafrost";

  if (humidity < 0.22 && cell.insolation > 0.58 && temperature > 5) return "sand";
  if (cell.sedimentCover > 0.42) return "alluvial";
  if (geology === "basin" && humidity > 0.32) return "alluvial";
  if (cell.sedimentCover > 0.22 && humidity > 0.3) return "alluvial";
  if (isHighAlpine && height >= 1600) return "bareRock";

  return "soil";
}

function classifyVegetation(
  substrate: SurfaceKind,
  cell: Cell,
  latNorm: number,
  humidity: number
): VegetationKind {
  if (NO_VEG_SUBSTRATES.has(substrate)) return "none";
  if (substrate === "rockySlope") return "none";

  const { temperature, insolation, geology } = cell;

  if (substrate === "volcanicRock") {
    if (humidity > 0.45 && temperature > 2) return "moss";
    return "none";
  }

  if (substrate === "permafrost") {
    return temperature > -14 && humidity > 0.35 ? "moss" : "none";
  }

  if (substrate === "sand") {
    if (humidity > 0.18 && temperature > -5) return "shrub";
    return "none";
  }

  if (substrate === "wetland") {
    return temperature > -8 ? "grass" : "none";
  }

  if (substrate === "soil" || substrate === "alluvial") {
    if (
      humidity > 0.42 &&
      temperature > 6 &&
      temperature < 33 &&
      latNorm < 0.75 &&
      insolation > 0.32 &&
      geology !== "volcanic"
    ) {
      return "forest";
    }
    if (humidity > 0.26 && temperature > -4) {
      if (humidity < 0.38 && temperature > 10 && insolation > 0.55) return "shrub";
      return "grass";
    }
  }

  return "none";
}

/** 岩性可侵蚀性 K：节理/断层/风化高，克拉通/硬基底低 */
function erodibilityFor(cell: Cell): number {
  let k = 0.35;
  switch (cell.geology) {
    case "shield":
      k = 0.12;
      break;
    case "mountain":
      k = 0.52;
      break;
    case "basin":
      k = 0.48;
      break;
    case "volcanic":
      k = 0.68;
      break;
    case "ocean":
      k = 0.05;
      break;
  }
  if (cell.crustKind === "oceanic") k = k * 0.55 + 0.22;
  else k = k * 0.7 + (1 - cell.bedrockHardness) * 0.35;

  k += cell.weathering * 0.28;
  k += cell.sedimentCover * 0.18;

  const surfK: Partial<Record<SurfaceKind, number>> = {
    bareRock: 0.38,
    rockySlope: 0.44,
    volcanicRock: 0.72,
    sand: 0.62,
    alluvial: 0.55,
    soil: 0.42,
    wetland: 0.5,
    permafrost: 0.28,
    ice: 0.08,
  };
  if (surfK[cell.surface] !== undefined) {
    k = k * 0.45 + (surfK[cell.surface] as number) * 0.55;
  }
  return clamp01(k);
}

function hardnessFor(cell: Cell): number {
  const base: Record<SurfaceKind, number> = {
    saltSea: 0,
    freshLake: 0,
    wetland: 0.15,
    saltFlat: 0.55,
    sand: 0.45,
    alluvial: 0.25,
    soil: 0.3,
    bareRock: 0.92,
    rockySlope: 0.78,
    ice: 0.85,
    permafrost: 0.42,
    volcanicRock: 0.72,
    beach: 0.2,
  };
  let h = base[cell.surface];
  h = h * 0.45 + cell.bedrockHardness * 0.55;
  if (cell.geology === "mountain") h += 0.08;
  if (cell.geology === "shield") h += 0.06;
  if (cell.sedimentCover > 0.35) h -= 0.12 * cell.sedimentCover;
  if (cell.weathering > 0.4) h -= 0.08 * (cell.weathering - 0.4);
  return clamp01(h);
}

function permeabilityFor(surface: SurfaceKind): number {
  const map: Record<SurfaceKind, number> = {
    saltSea: 1,
    freshLake: 1,
    wetland: 0.85,
    saltFlat: 0.08,
    sand: 0.55,
    alluvial: 0.72,
    soil: 0.48,
    bareRock: 0.05,
    rockySlope: 0.18,
    ice: 0.02,
    permafrost: 0.32,
    volcanicRock: 0.12,
    beach: 0.9,
  };
  return map[surface];
}

/** 地表图层填色：基质 + 植被半透明叠色 */
export function surfaceDisplayColor(cell: Cell): string {
  const baseHex = SURFACE[cell.surface].color;
  if (cell.vegetation === "none") return baseHex;

  const base = hexToRgb(baseHex);
  const vegHex = VEGETATION[cell.vegetation].color;
  if (vegHex === "transparent") return baseHex;
  const veg = hexToRgb(vegHex);
  const biomassT = 0.4 + 0.6 * (cell.pools?.biomass ?? 0.3);
  const baseT = cell.vegetation === "forest" ? 0.62 : cell.vegetation === "grass" ? 0.52 : 0.45;
  const t = baseT * biomassT;
  const r = Math.round(base.r + (veg.r - base.r) * t);
  const g = Math.round(base.g + (veg.g - base.g) * t);
  const b = Math.round(base.b + (veg.b - base.b) * t);
  return `rgb(${r},${g},${b})`;
}

export function computeSurfaceClimate(
  cells: Cell[],
  bounds: [number, number, number, number],
  maxHeight: number,
  day = 0,
  worldSeed = 42
): void {
  let landMax = 1;
  for (const c of cells) if (c.height > landMax) landMax = c.height;

  for (const cell of cells) {
    const lat = cellLatitudeNorm(cell, bounds);
    const latR = (cell.latDeg * Math.PI) / 180;
    const decl = solarDeclinationRad(day);
    const insol = insolationTopAt(latR, decl);
    const elevN = cell.height > 0 ? Math.min(1, cell.height / landMax) : 0;

    cell.insolation = insol;
    cell.insolationTop = insol;
    cell.temperature = latitudeBaseTemperature(cell, bounds);

    const H = cell.elements.H;
    const O = cell.elements.O;
    const C = cell.elements.C;
    const Si = cell.elements.Si;

    cell.hoBind = hoBinding(H, O);
    cell.oxidation = oxidationIndex(H, O, C, Si);
    cell.reduction = reductionIndex(H, O, C, cell.geology);

    const coastal = coastalFactor(cell, cells);

    if (isOceanCell(cell) || (cell.crustKind === "oceanic" && cell.height < 0)) {
      const depthN = clamp01(-cell.height / Math.max(1, maxHeight * 0.5));
      const span = latitudeSpanDeg(bounds);
      const delta = lat * span * 0.22;
      cell.temperature = 22 - delta - depthN * 6;
      cell.surface = "saltSea";
      cell.waterSalt = 0.88 + depthN * 0.1;
      cell.waterFresh = Math.max(0, 0.04 * (1 - depthN) * coastal);
      cell.humidity = clamp01(0.75 + depthN * 0.2);
      cell.vegetation = "none";
    } else if (cell.height < 0 && cell.crustKind === "continental") {
      const depthN = clamp01(-cell.height / Math.max(1, maxHeight * 0.35));
      cell.humidity = clamp01(0.42 + (1 - depthN) * 0.28);
      cell.waterSalt = 0;
      if (cell.fillKind === "ice") {
        cell.temperature = Math.min(cell.temperature, -4 - depthN * 8);
        cell.waterFresh = 0.12;
        cell.surface = "ice";
      } else if (cell.fillKind === "freshWater") {
        cell.waterFresh = clamp01(0.55 + (1 - depthN) * 0.35);
        cell.surface = cell.waterFresh > 0.72 ? "freshLake" : "wetland";
      } else {
        cell.waterFresh = 0;
        cell.surface = "bareRock";
      }
      cell.vegetation = "none";
    } else {
      cell.humidity = clamp01(
        cell.hoBind * 0.42 +
          coastal * 0.38 +
          (cell.geology === "basin" ? 0.2 : 0) +
          (1 - elevN) * 0.22 -
          elevN * 0.18 -
          lat * 0.06
      );

      cell.waterFresh = clamp01(
        cell.hoBind * 0.14 * cell.humidity +
          (cell.geology === "basin" ? 0.18 : 0) +
          coastal * 0.12 * (1 - elevN * 0.5) +
          Math.max(0, 0.05 - elevN * 0.05)
      );

      const inland = hopsToOcean(cell, cells);
      const arid = cell.humidity < 0.28 && insol > 0.5;
      cell.waterSalt = clamp01(
        arid && cell.geology === "basin" && inland >= 5
          ? cell.elements.Na * 0.9 + cell.hoBind * 0.08
          : coastal * 0.04
      );

      cell.surface = classifySubstrate(
        cell,
        lat,
        cell.humidity,
        cell.waterFresh,
        cell.waterSalt,
        coastal,
        worldSeed
      );
      cell.vegetation = classifyVegetation(cell.surface, cell, lat, cell.humidity);
    }

    cell.hardness = hardnessFor(cell);
    cell.erodibility = erodibilityFor(cell);
    cell.permeability = permeabilityFor(cell.surface);
  }

  enrichCellTemperatures(cells, bounds);
}

export function surfaceStats(cells: Cell[]): Record<SurfaceKind, number> {
  const counts = {} as Record<SurfaceKind, number>;
  for (const c of cells) counts[c.surface] = (counts[c.surface] ?? 0) + 1;
  const n = cells.length || 1;
  const frac = {} as Record<SurfaceKind, number>;
  for (const k of Object.keys(counts) as SurfaceKind[]) {
    frac[k] = counts[k] / n;
  }
  return frac;
}

export function vegetationStats(cells: Cell[]): Record<VegetationKind, number> {
  const counts = {} as Record<VegetationKind, number>;
  for (const c of cells) {
    if (c.height < 0) continue;
    counts[c.vegetation] = (counts[c.vegetation] ?? 0) + 1;
  }
  const land = cells.filter((c) => c.height >= 0).length || 1;
  const frac = {} as Record<VegetationKind, number>;
  for (const k of Object.keys(counts) as VegetationKind[]) {
    frac[k] = counts[k] / land;
  }
  return frac;
}
