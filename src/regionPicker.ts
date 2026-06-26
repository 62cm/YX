/**
 * 主地图片区选区模式（在行星图上直接点选 1000×1000 km 块）
 */

import type { WorldSave } from "./worldSave";
import { regionIndexAtKm } from "./regionGrid";

export interface RegionPickCallbacks {
  onSelect: (col: number, row: number) => void;
  onHover?: (col: number, row: number | null) => void;
}

export function regionHoverAt(
  save: WorldSave | null,
  xKm: number,
  yKm: number
): { col: number; row: number } | null {
  if (!save) return null;
  const { col, row } = regionIndexAtKm(xKm, yKm);
  return { col, row };
}

export function generatedRegionKeys(save: WorldSave | null): Set<string> {
  const set = new Set<string>();
  if (!save) return set;
  for (const r of save.regions) {
    if (r.generated) set.add(`${r.col},${r.row}`);
  }
  return set;
}

export function regionStatusText(
  save: WorldSave | null,
  col: number,
  row: number
): string {
  const r = save?.regions.find((x) => x.col === col && x.row === row);
  if (!r) return `片区 [${col},${row}]`;
  return `片区 [${col},${row}] · 陆比 ${(r.landFraction * 100).toFixed(0)}% · 均高 ${r.meanHeight.toFixed(0)}m${r.generated ? " · 已生成" : ""}`;
}
