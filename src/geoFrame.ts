/**
 * 行星瓦片坐标 · 模拟时钟 · 科氏参数
 * 10×20 瓦片，每块 2000×2000 km → 纬向 2 万 km × 经向 4 万 km（经向环接）
 */

import type { Cell, MapLayer, GeoFrame, PlanetTileContext } from "./types";
import {
  VERTICAL_LEVEL_COUNT,
  createAtmColumn,
  syncAtmColumnFromSurface,
} from "./verticalGrid";

export const PLANET_TILES_LAT = 10;
export const PLANET_TILES_LON = 20;
export const PLANET_TILE_COUNT = PLANET_TILES_LAT * PLANET_TILES_LON;
export const PLANET_TILE_KM = 2000;
export const EARTH_OMEGA_RAD_S = 7.2921e-5;

/** 地质/构造算法标定的参考地图边长（原局部瓦片 km） */
export const GEOLOGY_REF_MAP_SPAN_KM = 2000;

/**
 * 相对参考瓦片的距离缩放。Voronoi 胞元间距随 √(面积) 增长，
 * 造山/弧火山等固定 km 半径需同比例放大，否则行星尺度下特征会缩成点。
 */
export function mapKmScale(bounds: [number, number, number, number]): number {
  const [x0, y0, x1, y1] = bounds;
  const area = (x1 - x0) * (y1 - y0);
  const refArea = GEOLOGY_REF_MAP_SPAN_KM * GEOLOGY_REF_MAP_SPAN_KM;
  return Math.sqrt(area / refArea);
}

/** 世界坐标相位频率：除以 mapKmScale 可保持物理波长不变 */
export function mapPhaseScale(bounds: [number, number, number, number]): number {
  return 1 / Math.max(1e-6, mapKmScale(bounds));
}

/** 行星地图外廓 [x0,y0,x1,y1] km（宽=经向，高=纬向） */
export function planetBoundsKm(): [number, number, number, number] {
  return [0, 0, PLANET_TILES_LON * PLANET_TILE_KM, PLANET_TILES_LAT * PLANET_TILE_KM];
}

/** 默认：中纬偏北瓦片 */
export const DEFAULT_PLANET_TILE = {
  tileCol: 10,
  tileRow: 7,
} as const;

export const DEFAULT_GEO_FRAME: GeoFrame = {
  planet: {
    tilesLat: PLANET_TILES_LAT,
    tilesLon: PLANET_TILES_LON,
    tileKm: PLANET_TILE_KM,
    ...DEFAULT_PLANET_TILE,
  },
  clock: {
    simDay: 0,
    epochLabel: "春分日 00:00 UTC",
  },
};

export function tileLatSpanDeg(tilesLat = PLANET_TILES_LAT): number {
  return 180 / tilesLat;
}

export function tileLonSpanDeg(tilesLon = PLANET_TILES_LON): number {
  return 360 / tilesLon;
}

export function tileCenterLatDeg(tileRow: number, tilesLat = PLANET_TILES_LAT): number {
  const span = tileLatSpanDeg(tilesLat);
  return -90 + (tileRow + 0.5) * span;
}

export function tileCenterLonDeg(tileCol: number, tilesLon = PLANET_TILES_LON): number {
  const span = tileLonSpanDeg(tilesLon);
  return -180 + (tileCol + 0.5) * span;
}

/** 全球图宽高比（经向 : 纬向 km） */
export function worldMapAspectRatio(): number {
  return (PLANET_TILES_LON * PLANET_TILE_KM) / (PLANET_TILES_LAT * PLANET_TILE_KM);
}

export function localKmToLatLon(
  xKm: number,
  yKm: number,
  bounds: [number, number, number, number],
  planet: PlanetTileContext
): { latDeg: number; lonDeg: number } {
  const [x0, y0, x1, y1] = bounds;
  const latSpan = tileLatSpanDeg(planet.tilesLat);
  const lonSpan = tileLonSpanDeg(planet.tilesLon);
  const tileSouth = -90 + planet.tileRow * latSpan;
  const tileWest = -180 + planet.tileCol * lonSpan;
  const fx = (xKm - x0) / Math.max(1e-6, x1 - x0);
  const fy = (yKm - y0) / Math.max(1e-6, y1 - y0);
  return {
    latDeg: tileSouth + fy * latSpan,
    lonDeg: tileWest + fx * lonSpan,
  };
}

export function assignPlanetGeography(
  cells: Cell[],
  bounds: [number, number, number, number]
): void {
  const [x0, y0, x1, y1] = bounds;
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  for (const cell of cells) {
    const [x, y] = cell.site;
    cell.lonDeg = -180 + ((x - x0) / w) * 360;
    cell.latDeg = -90 + ((y - y0) / h) * 180;
  }
}

function layerWithinPlanet(bounds: [number, number, number, number]): boolean {
  const pb = planetBoundsKm();
  return (
    bounds[0] >= pb[0] &&
    bounds[1] >= pb[1] &&
    bounds[2] <= pb[2] &&
    bounds[3] <= pb[3]
  );
}

export function assignCellGeography(
  cells: Cell[],
  bounds: [number, number, number, number],
  planet: PlanetTileContext
): void {
  for (const cell of cells) {
    const [x, y] = cell.site;
    const { latDeg, lonDeg } = localKmToLatLon(x, y, bounds, planet);
    cell.latDeg = latDeg;
    cell.lonDeg = lonDeg;
  }
}

export function initCellAtmColumns(cells: Cell[]): void {
  for (const cell of cells) {
    if (!cell.atm) cell.atm = createAtmColumn();
    refreshCellAtmFromSurface(cell);
  }
}

export function refreshCellAtmFromSurface(cell: Cell): void {
  if (!cell.atm) cell.atm = createAtmColumn();
  const elev = Math.max(0, cell.height);
  syncAtmColumnFromSurface(
    cell.atm,
    elev,
    cell.temperature,
    cell.humidity,
    cell.windU,
    cell.windV,
    cell.pressure
  );
}

export function coriolisRadS(latDeg: number): number {
  return 2 * EARTH_OMEGA_RAD_S * Math.sin((latDeg * Math.PI) / 180);
}

export function applyCoriolisDeflection(
  latDeg: number,
  ux: number,
  uy: number,
  scale = 1
): { u: number; v: number } {
  const f = coriolisRadS(latDeg);
  const fEff = Math.sign(f || 1) * Math.min(Math.abs(f) * 1.15e6 * scale, 0.72);
  const c = Math.cos(fEff);
  const s = Math.sin(fEff);
  return { u: ux * c - uy * s, v: ux * s + uy * c };
}

export function cycloneSpinSign(isLow: boolean, latDeg: number): 1 | -1 {
  const nh = latDeg >= 0;
  if (isLow) return nh ? 1 : -1;
  return nh ? -1 : 1;
}

export function attachGeoFrame(layer: MapLayer, frame: GeoFrame = DEFAULT_GEO_FRAME): void {
  layer.geoFrame = frame;
  const pb = planetBoundsKm();
  const b = layer.bounds;
  if (b[0] === pb[0] && b[1] === pb[1] && b[2] === pb[2] && b[3] === pb[3]) {
    assignPlanetGeography(layer.cells, pb);
  } else if (layerWithinPlanet(b)) {
    assignPlanetGeography(layer.cells, pb);
  } else {
    assignCellGeography(layer.cells, b, frame.planet);
  }
}

export function formatPlanetTileLabel(planet: PlanetTileContext): string {
  const lat = tileCenterLatDeg(planet.tileRow, planet.tilesLat);
  const lon = tileCenterLonDeg(planet.tileCol, planet.tilesLon);
  const latH = lat >= 0 ? `${lat.toFixed(1)}°N` : `${(-lat).toFixed(1)}°S`;
  const lonH = lon >= 0 ? `${lon.toFixed(1)}°E` : `${(-lon).toFixed(1)}°W`;
  return `瓦片 ${planet.tileCol},${planet.tileRow} · 中心 ${latH} ${lonH}`;
}

export function formatSimClockLabel(day: number, epochLabel = DEFAULT_GEO_FRAME.clock.epochLabel): string {
  const d = Math.floor(day);
  const hour = Math.floor(((day % 1) + 1) % 1 * 24);
  return `模拟日 ${d} · ${hour}:00 · ${epochLabel}`;
}

export function geoClimateFooter(
  cells: Cell[],
  day: number,
  planet: PlanetTileContext
): string {
  if (cells.length === 0) return "";
  let latMin = Infinity;
  let latMax = -Infinity;
  for (const c of cells) {
    if (c.latDeg < latMin) latMin = c.latDeg;
    if (c.latDeg > latMax) latMax = c.latDeg;
  }
  const tile = formatPlanetTileLabel(planet);
  const latBand =
    latMin <= latMax ? `纬度 ${latMin.toFixed(1)}°–${latMax.toFixed(1)}°` : "";
  return `${tile} · ${latBand} · 垂直 ${VERTICAL_LEVEL_COUNT} 层 · ${formatSimClockLabel(day)}`;
}
