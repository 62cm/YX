import type { Cell } from "./types";
import { syncMeteoCloudDisplay } from "./climate";

/** 云图显示与物理云水/气压场同步（见 climate.syncMeteoCloudDisplay） */
export function updateCycloneCloudVisual(cells: Cell[]): void {
  syncMeteoCloudDisplay(cells);
}

export function clearClouds(cells: Cell[]): void {
  for (const cell of cells) cell.cloud = 0;
}
