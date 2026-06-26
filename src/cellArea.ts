import type { Cell } from "./types";

/** 多边形面积（鞋带公式），单位 km² */
export function polygonAreaKm2(polygon: [number, number][]): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = polygon[i];
    const [x1, y1] = polygon[(i + 1) % n];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) * 0.5;
}

export function cellAreaKm2(cell: Cell): number {
  return polygonAreaKm2(cell.polygon);
}
