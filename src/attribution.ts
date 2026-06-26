/**
 * 海拔与归属分离：elevation/height、crustKind、basement、fillKind
 */

import type { Cell, CrustKind, FillKind } from "./types";
import type { TectonicState } from "./cellGraph";
import { latitudeNorm } from "./surface";

export function setElevation(cell: Cell, meters: number): void {
  cell.elevation = meters;
  cell.height = meters;
}

export function isOceanCell(cell: Cell): boolean {
  return cell.crustKind === "oceanic" && cell.fillKind === "saltWater";
}

export function isLandSurface(cell: Cell): boolean {
  return cell.crustKind === "continental" || cell.fillKind !== "saltWater";
}

/** 根据壳属、海拔、构造场写入 fillKind / basement */
export function assignCellAttribution(
  cell: Cell,
  bounds: [number, number, number, number],
  tectonic?: TectonicState | null,
  seaLevel = 0
): void {
  const i = cell.id;
  const elev = cell.elevation;

  if (cell.crustKind === "oceanic") {
    cell.basement = "rock";
    cell.fillKind = elev < seaLevel ? "saltWater" : "none";
    return;
  }

  const rift = tectonic?.riftField[i] ?? 0;
  const arc = tectonic?.arcField[i] ?? 0;
  const orogen = tectonic?.orogenField[i] ?? 0;

  if (arc > 0.45) cell.basement = "volcanic";
  else if (orogen > 0.35) cell.basement = "rock";
  else cell.basement = "sediment";

  if (elev >= seaLevel) {
    cell.fillKind = "none";
    return;
  }

  const lat = latitudeNorm(cell.site[1], bounds);
  const cold = lat > 0.62;

  if (rift > 0.18) {
    if (cold) cell.fillKind = "ice";
    else cell.fillKind = "freshWater";
    return;
  }

  if (rift > 0.08 || cell.sedimentCover > 0.35) {
    cell.fillKind = "freshWater";
    return;
  }

  cell.fillKind = "air";
}

export function syncAllCellAttribution(
  cells: Cell[],
  bounds: [number, number, number, number],
  tectonic?: TectonicState | null
): void {
  for (const cell of cells) {
    assignCellAttribution(cell, bounds, tectonic);
  }
}

export function crustKindFromMask(continental: boolean): CrustKind {
  return continental ? "continental" : "oceanic";
}

export function fillLabel(kind: FillKind): string {
  switch (kind) {
    case "saltWater":
      return "海水";
    case "freshWater":
      return "淡水";
    case "ice":
      return "冰";
    case "air":
      return "干谷";
    default:
      return "无";
  }
}
