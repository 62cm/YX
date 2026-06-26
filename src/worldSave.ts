/**
 * 世界存档：全球完成后固化 800 区摘要，支持 localStorage 持久化
 */

import type { MapLayer, TerrainParams } from "./types";
import type { TectonicState } from "./cellGraph";
import { planetBoundsKm } from "./geoFrame";
import {
  extractRegionSummaries,
  regionId,
  type RegionSummary,
  REGION_COUNT,
} from "./regionGrid";

export const WORLD_SAVE_KEY = "wanwu-world-save-v1";

export interface WorldSave {
  version: 1;
  seed: number;
  terrainParams: TerrainParams;
  planetBounds: [number, number, number, number];
  regions: RegionSummary[];
  savedAt: string;
}

export function buildWorldSave(
  planetLayer: MapLayer,
  terrainParams: TerrainParams,
  tectonic: TectonicState | null
): WorldSave {
  return {
    version: 1,
    seed: terrainParams.seed,
    terrainParams: { ...terrainParams },
    planetBounds: [...planetBoundsKm()],
    regions: extractRegionSummaries(planetLayer, tectonic),
    savedAt: new Date().toISOString(),
  };
}

export function saveWorldToStorage(save: WorldSave): void {
  try {
    localStorage.setItem(WORLD_SAVE_KEY, JSON.stringify(save));
  } catch (e) {
    console.warn("world save failed", e);
  }
}

export function loadWorldFromStorage(): WorldSave | null {
  try {
    const raw = localStorage.getItem(WORLD_SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as WorldSave;
    if (data.version !== 1 || !data.regions || data.regions.length !== REGION_COUNT) return null;
    return data;
  } catch {
    return null;
  }
}

export function markRegionGenerated(save: WorldSave, col: number, row: number): void {
  const id = regionId(col, row);
  for (const r of save.regions) {
    if (regionId(r.col, r.row) === id) {
      r.generated = true;
      break;
    }
  }
}

export function getRegionSummary(
  save: WorldSave,
  col: number,
  row: number
): RegionSummary | undefined {
  return save.regions.find((r) => r.col === col && r.row === row);
}
