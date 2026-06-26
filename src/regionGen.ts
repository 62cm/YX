/**
 * 子区域生成：在 1000×1000 km 块内细化，边界与全球层一致
 */

import type { Cell, MapLayer, TerrainParams, VoronoiConfig } from "./types";
import { assignPlanetGeography, planetBoundsKm } from "./geoFrame";
import {
  regionBounds,
  regionId,
  regionSeed,
  sampleMacroCell,
  type RegionSummary,
} from "./regionGrid";
import { createBlockLayer, generateVoronoi } from "./voronoi";

const BLOCK_CELL_COUNT = 2500;
const EDGE_BLEND_KM = 45;

function blendEdgeFromMacro(
  childCells: Cell[],
  planetLayer: MapLayer,
  bounds: [number, number, number, number]
): void {
  const [x0, y0, x1, y1] = bounds;
  for (const c of childCells) {
    const [x, y] = c.site;
    const dx = Math.min(x - x0, x1 - x);
    const dy = Math.min(y - y0, y1 - y);
    const edgeDist = Math.min(dx, dy);
    if (edgeDist > EDGE_BLEND_KM) continue;
    const macro = sampleMacroCell(planetLayer, x, y);
    if (!macro) continue;
    const w = 1 - edgeDist / EDGE_BLEND_KM;
    const blend = w * w;
    c.height = c.height * (1 - blend) + macro.height * blend;
    if (blend > 0.55) {
      c.geology = macro.geology;
      c.crustKind = macro.crustKind;
      c.surface = macro.surface;
      c.temperature = macro.temperature;
      c.humidity = macro.humidity;
      c.pressure = macro.pressure;
    }
  }
}

/** 用全球摘要初始化子区气候倾向 */
export function applyParentClimateBias(cells: Cell[], summary: RegionSummary): void {
  for (const c of cells) {
    c.temperature = c.temperature * 0.35 + summary.meanTemp * 0.65;
    c.humidity = c.humidity * 0.4 + summary.meanHumidity * 0.6;
    c.pressure = c.pressure * 0.25 + summary.meanPressure * 0.75;
  }
}

/** 根据陆海比例调整构造参数 */
export function terrainParamsForRegion(
  base: TerrainParams,
  summary: RegionSummary,
  worldSeed: number,
  col: number,
  row: number
): TerrainParams {
  const lf = summary.landFraction;
  let oceanRatio = base.oceanRatio;
  if (lf < 0.08) oceanRatio = Math.max(oceanRatio, 0.92);
  else if (lf > 0.92) oceanRatio = Math.min(oceanRatio, 0.12);
  else oceanRatio = base.oceanRatio * (1 - lf) + (1 - lf) * 0.5;

  return {
    ...base,
    seed: regionSeed(worldSeed, col, row),
    oceanRatio,
    continentCount: lf > 0.5 ? Math.max(1, base.continentCount) : Math.max(1, Math.round(base.continentCount * 0.5)),
    singleContinent: lf > 0.85 ? true : base.singleContinent,
    oceanRing: false,
  };
}

export function createRegionLayer(
  summary: RegionSummary,
  worldSeed: number
): { layer: MapLayer; voronoiConfig: VoronoiConfig } {
  const bounds = regionBounds(summary.col, summary.row);
  const seed = regionSeed(worldSeed, summary.col, summary.row);
  const voronoiConfig: VoronoiConfig = {
    cellCount: BLOCK_CELL_COUNT,
    bounds,
    lloydIterations: 1,
    seed,
  };
  const cells = generateVoronoi(voronoiConfig);
  assignPlanetGeography(cells, planetBoundsKm());
  const layer = createBlockLayer(
    cells,
    voronoiConfig,
    regionId(summary.col, summary.row),
    "macro-root"
  );
  return { layer, voronoiConfig };
}

export function enforceMacroConsistency(
  childLayer: MapLayer,
  planetLayer: MapLayer,
  summary: RegionSummary
): void {
  blendEdgeFromMacro(childLayer.cells, planetLayer, childLayer.bounds);
  applyParentClimateBias(childLayer.cells, summary);
}
