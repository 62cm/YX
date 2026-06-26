import type { Cell, ClimateScalarLayer, CloudParams, ElementKey, GeologyKind, MapLayer } from "./types";
import { ELEMENTS, GEOLOGY, FLESH, FLESH_INV, COLOR_REF_HEIGHT } from "./types";
import { dominantElement, elementMaxima } from "./elements";
import { buildGridContourPaths, type ContourPath } from "./contours";
import type { TectonicState } from "./cellGraph";
import { edgeKey as cellEdgeKey, getSharedPolygonEdge } from "./cellGraph";
import { isOceanCell } from "./attribution";
import { getCyclones, satelliteCloudBrightness, type Cyclone } from "./cyclones";
import { hourOfDayFromDay, surfaceDisplayColor } from "./surface";
import { REGION_GRID_LAT, REGION_GRID_LON, REGION_KM } from "./regionGrid";

/** 多停靠点渐变（避免红蓝直接插值变紫） */
function multistopRgb(stops: [number, number, number][], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const seg = (stops.length - 1) * x;
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** 气象气压色标：低压红 → 黄绿 → 高压蓝（不经紫，红蓝不直接混） */
function pressureGradientRgb(pressure: number): [number, number, number] {
  const t = clamp01((pressure - 998) / 28);
  return multistopRgb(
    [
      [215, 55, 38],
      [235, 145, 48],
      [228, 215, 78],
      [105, 195, 155],
      [32, 88, 195],
    ],
    t
  );
}

/** 气温色标：深蓝冷 → 青 → 绿黄 → 橙红暖 */
function temperatureGradientRgb(tempC: number): [number, number, number] {
  const t = clamp01((tempC + 28) / 68);
  return multistopRgb(
    [
      [18, 45, 155],
      [55, 145, 210],
      [120, 210, 110],
      [245, 225, 95],
      [215, 55, 35],
    ],
    t
  );
}

/** 气象局风格：淡地形底图 + 等压线 + 降水（无气压填色，与气压层区分） */
export function renderMeteoBureauMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf, "#0a1018");
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  for (const cell of layer.cells) {
    const hex = surfaceDisplayColor(cell);
    const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(hex);
    const r = m ? +m[1] : 80;
    const g = m ? +m[2] : 90;
    const b = m ? +m[3] : 70;
    const alpha = cell.height < 0 ? 0.72 : 0.58;
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.fill(cellPath(cell));
  }

  for (const cell of layer.cells) {
    const precip = cell.precip;
    if (precip < 0.07) continue;
    const pr = Math.pow(clamp01((precip - 0.06) / 0.22), 0.55);
    ctx.fillStyle = `rgba(20,255,95,${0.22 + pr * 0.62})`;
    ctx.fill(cellPath(cell));
  }

  drawPressureIsobars(ctx, layer, scale);
  drawPressureRegionOutlines(ctx, layer, scale);

  ctx.restore();
}

/** 等压线（4 hPa 间隔） */
function drawPressureIsobars(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  scale: number
): void {
  const paths = buildGridContourPaths(
    layer.cells,
    layer.bounds,
    (c) => c.pressure,
    4,
    { gridSize: 120, indexEvery: 4 }
  );
  drawContourPaths(
    ctx,
    paths,
    scale,
    "rgba(70,120,210,0.5)",
    "rgba(235,245,255,0.92)",
    (l) => `${Math.round(l)}`
  );
}

/** 高低压片区轮廓（1008 / 1018 hPa 近似槽脊边界） */
function drawPressureRegionOutlines(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  scale: number
): void {
  const lowPaths = buildGridContourPaths(layer.cells, layer.bounds, (c) => c.pressure, 1008, {
    gridSize: 80,
    indexEvery: 99,
  });
  const highPaths = buildGridContourPaths(layer.cells, layer.bounds, (c) => c.pressure, 1018, {
    gridSize: 80,
    indexEvery: 99,
  });

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const path of lowPaths) {
    if (path.points.length < 2) continue;
    ctx.strokeStyle = "rgba(255,110,70,0.6)";
    ctx.lineWidth = 2.2 / scale;
    ctx.setLineDash([7 / scale, 5 / scale]);
    ctx.beginPath();
    ctx.moveTo(path.points[0][0], path.points[0][1]);
    for (let i = 1; i < path.points.length; i++) ctx.lineTo(path.points[i][0], path.points[i][1]);
    if (path.closed) ctx.closePath();
    ctx.stroke();
  }

  for (const path of highPaths) {
    if (path.points.length < 2) continue;
    ctx.strokeStyle = "rgba(70,150,255,0.6)";
    ctx.lineWidth = 2.2 / scale;
    ctx.setLineDash([7 / scale, 5 / scale]);
    ctx.beginPath();
    ctx.moveTo(path.points[0][0], path.points[0][1]);
    for (let i = 1; i < path.points.length; i++) ctx.lineTo(path.points[i][0], path.points[i][1]);
    if (path.closed) ctx.closePath();
    ctx.stroke();
  }

  ctx.setLineDash([]);
}

/** @deprecated 使用 renderMeteoBureauMap */
export function renderSatelliteCloudMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  renderMeteoBureauMap(ctx, layer, canvasWidth, canvasHeight, zoom, panX, panY);
}

function drawClimateContoursForLayer(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  scalarLayer: ClimateScalarLayer,
  scale: number
): void {
  if (scalarLayer === "pressure") {
    const paths = buildGridContourPaths(
      layer.cells,
      layer.bounds,
      (c) => c.pressure,
      2,
      { gridSize: 150, indexEvery: 4 }
    );
    drawContourPaths(
      ctx,
      paths,
      scale,
      "rgba(90,140,230,0.55)",
      "rgba(240,248,255,0.95)",
      (l) => `${Math.round(l)} hPa`
    );
  } else if (scalarLayer === "temperature") {
    const paths = buildGridContourPaths(
      layer.cells,
      layer.bounds,
      (c) => c.temperature,
      4,
      { gridSize: 150, indexEvery: 3 }
    );
    drawContourPaths(
      ctx,
      paths,
      scale,
      "rgba(255,120,60,0.5)",
      "rgba(255,220,140,0.95)",
      (l) => `${Math.round(l)}°C`
    );
  } else if (scalarLayer === "humidity" || scalarLayer === "cloudWater") {
    const paths = buildGridContourPaths(
      layer.cells,
      layer.bounds,
      (c) => (scalarLayer === "humidity" ? c.humidity : c.cloudWater),
      0.08,
      { gridSize: 150, indexEvery: 3 }
    );
    drawContourPaths(
      ctx,
      paths,
      scale,
      "rgba(120,180,255,0.45)",
      "rgba(200,230,255,0.9)",
      (l) => `${(l * 100).toFixed(0)}%`
    );
  }
}

function lerp3(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number
): string {
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };
/** 肉色带内略深一端，避免过早进黑 */
const FLESH_DARK = { r: 188, g: 138, b: 122 };
const FLESH_INV_DARK = { r: 67, g: 117, b: 133 };

export type HeightColorScale = "linear" | "log" | "balanced";

/** 默认：均衡色标，陆地高度集中在中间灰阶 */
let heightColorScale: HeightColorScale = "balanced";

/**
 * 均衡色标：|h|/ref 的幂次。<1 时中低海拔远离纯白与纯黑。
 * 约 500m→浅肉 · 2km→中肉 · 5km→深肉 · 10km→黑
 */
const BALANCED_GAMMA = 0.68;

/** 主视觉肉色带在 t 轴上的区间（黑仅出现在 t > FLESH_T1） */
const FLESH_T0 = 0.18;
const FLESH_T1 = 0.62;

export function setHeightColorScale(scale: HeightColorScale): void {
  heightColorScale = scale;
}

export function getHeightColorScale(): HeightColorScale {
  return heightColorScale;
}

/** |height| → 归一化色标强度 t∈[0,1] */
export function heightMagnitudeT(
  height: number,
  ref: number = COLOR_REF_HEIGHT,
  scale: HeightColorScale = heightColorScale
): number {
  const u = Math.min(1, Math.abs(height) / ref);
  if (scale === "log") {
    return Math.min(1, Math.log1p(Math.abs(height)) / Math.log1p(ref));
  }
  if (scale === "balanced") {
    return Math.pow(u, BALANCED_GAMMA);
  }
  return u;
}

function applyHeightColorRamp(t: number, positive: boolean): string {
  if (t < 1e-6) return "rgb(255,255,255)";

  const flesh = positive ? FLESH : FLESH_INV;
  const fleshDark = positive ? FLESH_DARK : FLESH_INV_DARK;

  if (t < FLESH_T0) {
    return lerp3(WHITE, flesh, t / FLESH_T0);
  }
  if (t < FLESH_T1) {
    const local = (t - FLESH_T0) / (FLESH_T1 - FLESH_T0);
    return lerp3(flesh, fleshDark, local);
  }
  return lerp3(fleshDark, BLACK, (t - FLESH_T1) / (1 - FLESH_T1));
}

/** 与海拔等高线一致的步长/分带（配色与 overlay 共用） */
export interface HeightContourScale {
  landStep: number;
  oceanStep: number;
  maxLand: number;
  maxDepth: number;
}

export function computeHeightContourScale(cells: Cell[]): HeightContourScale {
  let maxLand = 400;
  let maxDepth = 400;
  for (const c of cells) {
    if (c.height > maxLand) maxLand = c.height;
    if (c.height < 0) maxDepth = Math.max(maxDepth, -c.height);
  }
  const landStep = Math.max(200, Math.round(maxLand / 20));
  return { landStep, oceanStep: landStep, maxLand, maxDepth };
}

/** 按等高线分带量化灰阶（每带一档色，与曲线层级对齐） */
export function heightToContourBandedColor(
  height: number,
  scale: HeightContourScale
): string {
  const { landStep, oceanStep, maxLand, maxDepth } = scale;
  const coastBand = Math.max(25, landStep * 0.05);
  if (Math.abs(height) <= coastBand) {
    return "rgb(255,255,255)";
  }

  if (height > 0) {
    const band = Math.floor(height / landStep);
    const maxBand = Math.max(1, Math.ceil(maxLand / landStep));
    const t = Math.min(1, (band + 0.58) / (maxBand + 0.28));
    return applyHeightColorRamp(t, true);
  }

  const band = Math.floor(-height / oceanStep);
  const maxBand = Math.max(1, Math.ceil(maxDepth / oceanStep));
  const t = Math.min(1, (band + 0.58) / (maxBand + 0.28));
  return applyHeightColorRamp(t, false);
}

/**
 * 高度 → 颜色，绝对绑定到米数（ref=10000m 为最深黑）。
 * 均衡(默认)：0m 白，常见海拔落在肉色灰阶带，仅极高/极深趋黑。
 */
export function heightToColor(
  height: number,
  ref: number = COLOR_REF_HEIGHT,
  scale: HeightColorScale = heightColorScale
): string {
  const t = heightMagnitudeT(height, ref, scale);
  return applyHeightColorRamp(t, height >= 0);
}

/** 陆壳负海拔：冰谷/淡水盆地/干裂谷；干裂谷走等高分带 */
export function cellHeightColor(
  cell: Cell,
  ref: number = COLOR_REF_HEIGHT,
  contourScale?: HeightContourScale
): string {
  if (cell.height < 0 && cell.crustKind === "continental") {
    if (contourScale && cell.fillKind === "air") {
      return heightToContourBandedColor(cell.height, contourScale);
    }
    const depth = clamp01(-cell.height / Math.max(400, ref * 0.22));
    if (cell.fillKind === "ice") {
      return `rgb(${Math.round(150 + depth * 60)},${Math.round(185 + depth * 40)},${Math.round(220 + depth * 25)})`;
    }
    if (cell.fillKind === "freshWater") {
      return `rgb(${Math.round(25 + depth * 30)},${Math.round(95 + depth * 50)},${Math.round(120 + depth * 55)})`;
    }
    return `rgb(${Math.round(130 - depth * 35)},${Math.round(85 - depth * 25)},${Math.round(55 - depth * 15)})`;
  }
  if (contourScale) {
    return heightToContourBandedColor(cell.height, contourScale);
  }
  return heightToColor(cell.height, ref);
}

function polygonToPath(polygon: [number, number][]): Path2D {
  const path = new Path2D();
  if (polygon.length === 0) return path;
  path.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i++) {
    path.lineTo(polygon[i][0], polygon[i][1]);
  }
  path.closePath();
  return path;
}

const cellPathCache = new WeakMap<Cell, Path2D>();

function cellPath(cell: Cell): Path2D {
  let path = cellPathCache.get(cell);
  if (!path) {
    path = polygonToPath(cell.polygon);
    cellPathCache.set(cell, path);
  }
  return path;
}

export interface RenderOptions {
  showBorders?: boolean;
  borderColor?: string;
  borderWidth?: number;
  /** 海洋平铺为单一蓝色（取海洋中位深度的颜色），便于看清大陆边界 */
  flatOcean?: boolean;
  /** 地图长度缩放，1 = 默认铺满 */
  zoom?: number;
  /** 屏幕像素平移（放大后可拖动查看） */
  panX?: number;
  panY?: number;
}

/** 离散缩放档位（非线性） */
export const ZOOM_LEVELS = [0.1, 0.2, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16, 32, 64] as const;

export const DEFAULT_ZOOM_INDEX = ZOOM_LEVELS.indexOf(1);

export function formatZoomLevel(zoom: number): string {
  return `${zoom}×`;
}

/** 限制平移，避免露出过多空白 */
export function clampPan(
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom: number,
  panX: number,
  panY: number
): { panX: number; panY: number } {
  const [x0, y0, x1, y1] = layer.bounds;
  const worldW = x1 - x0;
  const worldH = y1 - y0;
  const margin = Math.min(canvasWidth, canvasHeight) * MAP_MARGIN_RATIO;
  const g = MAP_RULER_GUTTER;
  const availW = canvasWidth - 2 * margin - g.left - g.right;
  const availH = canvasHeight - 2 * margin - g.top - g.bottom;
  const baseScale = Math.min(availW / worldW, availH / worldH);
  const scale = baseScale * zoom;
  const mapW = worldW * scale;
  const mapH = worldH * scale;
  const baseOx = margin + g.left + (availW - mapW) / 2;
  const baseOy = margin + g.top + (availH - mapH) / 2;
  const minPx = canvasWidth - baseOx - mapW;
  const maxPx = -baseOx;
  const minPy = canvasHeight - baseOy - mapH;
  const maxPy = -baseOy;
  let px = panX;
  let py = panY;
  if (minPx > maxPx) px = 0;
  else px = Math.max(minPx, Math.min(maxPx, px));
  if (minPy > maxPy) py = 0;
  else py = Math.max(minPy, Math.min(maxPy, py));
  return { panX: px, panY: py };
}

/** 浅海颜色（浅蓝） */
const SHALLOW_OCEAN = "rgb(150, 205, 235)";
/** 浅海占海洋深度范围的比例（靠近海平面的这一档算浅海） */
const SHALLOW_FRACTION = 0.3;

interface FlatOceanStyle {
  /** 深海平铺色（取海洋中位深度的颜色） */
  deepColor: string;
  /** 浅海阈值（米，负值）：height 高于此值算浅海 */
  shallowThreshold: number;
}

/** 平铺海洋的双色方案；无海洋时返回 null */
function flatOceanStyle(layer: MapLayer): FlatOceanStyle | null {
  const oceanHeights = layer.cells
    .filter((c) => c.height < 0)
    .map((c) => c.height)
    .sort((a, b) => a - b);
  if (oceanHeights.length === 0) return null;
  const mid = oceanHeights[Math.floor(oceanHeights.length / 2)];
  const deepest = oceanHeights[0]; // 最深（最负）
  return {
    deepColor: heightToColor(mid, COLOR_REF_HEIGHT),
    shallowThreshold: deepest * SHALLOW_FRACTION,
  };
}

/** 地图外边留白（约 1%） */
export const MAP_MARGIN_RATIO = 0.01;
export const MAP_MARGIN_COLOR = "#000000";
/** 画布内侧标尺槽（像素） */
export const MAP_RULER_GUTTER = { left: 32, bottom: 26, top: 8, right: 14 };

/** 世界坐标(km) → 画布的等比变换 */
export interface WorldTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  margin: number;
  gutter: typeof MAP_RULER_GUTTER;
}

export function computeTransform(
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): WorldTransform {
  const [x0, y0, x1, y1] = layer.bounds;
  const worldW = x1 - x0;
  const worldH = y1 - y0;
  const margin = Math.min(canvasWidth, canvasHeight) * MAP_MARGIN_RATIO;
  const g = MAP_RULER_GUTTER;
  const availW = canvasWidth - 2 * margin - g.left - g.right;
  const availH = canvasHeight - 2 * margin - g.top - g.bottom;
  const baseScale = Math.min(availW / worldW, availH / worldH);
  const scale = baseScale * zoom;
  const offsetX = margin + g.left + (availW - worldW * scale) / 2 + panX;
  const offsetY = margin + g.top + (availH - worldH * scale) / 2 + panY;
  return { scale, offsetX, offsetY, margin, gutter: g };
}

/** 屏幕像素 → 世界坐标 km（地图外返回 null） */
export function screenToWorldKm(
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  screenX: number,
  screenY: number,
  zoom = 1,
  panX = 0,
  panY = 0
): [number, number] | null {
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const [x0, y0, x1, y1] = layer.bounds;
  const wx = x0 + (screenX - tf.offsetX) / tf.scale;
  const wy = y0 + (screenY - tf.offsetY) / tf.scale;
  if (wx < x0 || wx > x1 || wy < y0 || wy > y1) return null;
  return [wx, wy];
}

/** 在主地图上绘制 40×20 片区网格（下钻选区） */
export function renderRegionGridOverlay(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom: number,
  panX: number,
  panY: number,
  hover: { col: number; row: number } | null,
  generatedCols?: Set<string>
): void {
  const [x0, y0, x1, y1] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  ctx.strokeStyle = "rgba(255,220,80,0.35)";
  ctx.lineWidth = 1.2 / scale;
  for (let c = 0; c <= REGION_GRID_LON; c++) {
    const x = c * REGION_KM;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }
  for (let r = 0; r <= REGION_GRID_LAT; r++) {
    const y = r * REGION_KM;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }

  if (generatedCols) {
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.8 / scale;
    for (let row = 0; row < REGION_GRID_LAT; row++) {
      for (let col = 0; col < REGION_GRID_LON; col++) {
        if (!generatedCols.has(`${col},${row}`)) continue;
        ctx.strokeRect(col * REGION_KM + 2, row * REGION_KM + 2, REGION_KM - 4, REGION_KM - 4);
      }
    }
  }

  if (hover) {
    const hx = hover.col * REGION_KM;
    const hy = hover.row * REGION_KM;
    ctx.fillStyle = "rgba(255,204,68,0.28)";
    ctx.fillRect(hx, hy, REGION_KM, REGION_KM);
    ctx.strokeStyle = "rgba(255,230,120,0.95)";
    ctx.lineWidth = 2.8 / scale;
    ctx.strokeRect(hx, hy, REGION_KM, REGION_KM);
  }

  ctx.restore();
}

/** 留白底 + 地图区深色底 */
export function paintMapBackdrop(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  tf: WorldTransform,
  mapFill = "#000000"
): void {
  const [x0, y0, x1, y1] = layer.bounds;
  const worldW = x1 - x0;
  const worldH = y1 - y0;
  ctx.fillStyle = MAP_MARGIN_COLOR;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = mapFill;
  ctx.fillRect(tf.offsetX, tf.offsetY, worldW * tf.scale, worldH * tf.scale);
}

export function renderLayer(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  options: RenderOptions = {}
): void {
  const {
    showBorders = true,
    borderColor = "rgba(0,0,0,0.15)",
    borderWidth = 0.3,
    flatOcean = false,
    zoom = 1,
    panX = 0,
    panY = 0,
  } = options;

  const flatStyle = flatOcean ? flatOceanStyle(layer) : null;

  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf);

  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  const contourScale = computeHeightContourScale(layer.cells);

  for (const cell of layer.cells) {
    const path = polygonToPath(cell.polygon);
    let fill: string;
    if (flatStyle && cell.height < 0) {
      fill =
        cell.height > flatStyle.shallowThreshold
          ? SHALLOW_OCEAN
          : flatStyle.deepColor;
    } else {
      fill = cellHeightColor(cell, COLOR_REF_HEIGHT, contourScale);
    }
    ctx.fillStyle = fill;
    ctx.fill(path);

    if (showBorders) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderWidth / scale;
      ctx.stroke(path);
    }
  }

  ctx.restore();
}

/** 卫星云图螺旋场：仅在气旋影响圈内采样 */
function drawSatelliteCycloneRaster(
  ctx: CanvasRenderingContext2D,
  bounds: [number, number, number, number],
  coverage: number,
  zoom: number
): void {
  const cov = clamp01(coverage);
  if (cov < 0.02) return;

  const cyclones = getCyclones();
  const gridStep = Math.max(5, 10 / Math.max(0.35, zoom));
  const half = gridStep * 0.5;

  for (const c of cyclones) {
    const R = c.radius * (0.45 + c.intensity * 0.25) * 1.25;
    const [x0, y0, x1, y1] = bounds;
    const xmin = Math.max(x0, c.x - R);
    const xmax = Math.min(x1, c.x + R);
    const ymin = Math.max(y0, c.y - R);
    const ymax = Math.min(y1, c.y + R);

    for (let gx = xmin; gx <= xmax; gx += gridStep) {
      for (let gy = ymin; gy <= ymax; gy += gridStep) {
        if (Math.hypot(gx - c.x, gy - c.y) > R) continue;
        const bright = satelliteCloudBrightness(gx, gy);
        if (bright < 0.12) continue;
        const t = Math.pow(bright, 0.5) * cov;
        const alpha = Math.min(0.82, t * 0.75);
        const tone = 220 + Math.round(bright * 28);
        ctx.fillStyle = `rgba(${tone},${tone + 8},${tone + 16},${alpha})`;
        ctx.fillRect(gx - half, gy - half, gridStep, gridStep);
      }
    }
  }
}

function drawCycloneSpiralArms(
  ctx: CanvasRenderingContext2D,
  c: Cyclone,
  scale: number,
  coverage: number
): void {
  const isCyclone = c.dp < 0;
  const R = c.radius * (0.4 + c.intensity * 0.22);
  const arms = isCyclone ? 4 : 3;
  const turns = isCyclone ? 1.8 : 1.3;
  const steps = 90;
  const spin = c.spin;
  const cov = clamp01(coverage);

  for (let a = 0; a < arms; a++) {
    const phase = (a / arms) * Math.PI * 2 + c.age * 0.06;
    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const r = R * (0.12 + u * 0.72);
      const theta = phase + spin * u * turns * Math.PI * 2;
      const x = c.x + Math.cos(theta) * r;
      const y = c.y + Math.sin(theta) * r;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const fade = (0.45 + c.intensity * 0.45) * cov;
    ctx.strokeStyle = isCyclone
      ? `rgba(252,254,255,${fade})`
      : `rgba(215,235,255,${fade * 0.7})`;
    ctx.lineWidth = ((isCyclone ? 3.6 : 2.4) / scale) * (0.7 + cov * 0.3);
    ctx.lineCap = "round";
    ctx.stroke();
  }

  if (isCyclone) {
    const eyeR = R * 0.12;
    ctx.beginPath();
    ctx.arc(c.x, c.y, eyeR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(6,12,24,0.55)";
    ctx.fill();
    ctx.strokeStyle = `rgba(200,220,245,${0.5 * cov})`;
    ctx.lineWidth = 1.4 / scale;
    ctx.stroke();
  }
}

/** 气旋/反气旋：卫星螺旋云带 + 中心标记 */
export function renderCycloneOverlay(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0,
  coverage = 1,
  meteoMode = false
): void {
  const cyclones = getCyclones();
  if (cyclones.length === 0) return;

  const [x0, y0] = layer.bounds;
  const { scale, offsetX, offsetY } = computeTransform(
    layer,
    canvasWidth,
    canvasHeight,
    zoom,
    panX,
    panY
  );

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  if (!meteoMode) {
    drawSatelliteCycloneRaster(ctx, layer.bounds, coverage, zoom);
  }

  for (const c of cyclones) {
    const isCyclone = c.dp < 0;
    const col = isCyclone ? "rgba(255,90,70,0.72)" : "rgba(90,170,255,0.68)";
    const R = c.radius * (0.4 + c.intensity * 0.22);

    drawCycloneSpiralArms(ctx, c, scale, coverage);

    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * 0.85, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 3.5 / scale, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = `bold ${Math.max(9, 11 / scale)}px Segoe UI, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = isCyclone ? "rgba(255,230,220,0.95)" : "rgba(210,235,255,0.95)";
    ctx.fillText(isCyclone ? "L" : "H", c.x, c.y);
  }

  ctx.restore();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** 从深色底到目标色按 t 混色 */
function mixFromDark(target: { r: number; g: number; b: number }, t: number): string {
  const base = { r: 17, g: 17, b: 17 };
  const tt = Math.max(0, Math.min(1, t));
  return lerp3(base, target, tt);
}

/**
 * 渲染元素层底图。
 * mode = "dominant"：按各 cell 主导元素的类别色填充（成分概览）。
 * mode = 元素键：该元素浓度热图（按全图最大值归一化对比）。
 */
export function renderElementMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  mode: "dominant" | ElementKey,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf);

  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  if (mode === "dominant") {
    for (const cell of layer.cells) {
      const key = dominantElement(cell);
      const rgb = hexToRgb(ELEMENTS[key].color);
      // 主导占比越高越鲜明
      const t = 0.35 + 0.65 * Math.min(1, (cell.elements[key] - 0.1) / 0.5);
      ctx.fillStyle = mixFromDark(rgb, t);
      ctx.fill(polygonToPath(cell.polygon));
    }
  } else {
    const maxima = elementMaxima(layer.cells);
    const rgb = hexToRgb(ELEMENTS[mode].color);
    const max = maxima[mode];
    for (const cell of layer.cells) {
      const t = cell.elements[mode] / max;
      ctx.fillStyle = mixFromDark(rgb, t);
      ctx.fill(polygonToPath(cell.polygon));
    }
  }

  ctx.restore();
}

function heightToGrayscale(
  height: number,
  ref: number = COLOR_REF_HEIGHT,
  scale: HeightColorScale = heightColorScale,
  contourScale?: HeightContourScale
): string {
  if (contourScale) {
    return heightToContourBandedColor(height, contourScale);
  }
  if (height < 0) return "rgb(16, 22, 30)";
  const t = heightMagnitudeT(height, ref, scale);
  // 与高度层一致：中间灰阶带宽，避免低海拔过白
  const g =
    t < FLESH_T0
      ? Math.round(255 - (t / FLESH_T0) * 95)
      : t < FLESH_T1
        ? Math.round(160 - ((t - FLESH_T0) / (FLESH_T1 - FLESH_T0)) * 55)
        : Math.round(105 - ((t - FLESH_T1) / (1 - FLESH_T1)) * 90);
  return `rgb(${g},${g},${g})`;
}

function pointsNear(a: [number, number], b: [number, number], eps = 0.05): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function edgeKey(a: [number, number], b: [number, number]): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const p1 = `${r(a[0])},${r(a[1])}`;
  const p2 = `${r(b[0])},${r(b[1])}`;
  return p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`;
}

function findSharedEdge(
  polyA: [number, number][],
  polyB: [number, number][]
): [[number, number], [number, number]] | null {
  for (let i = 0; i < polyA.length; i++) {
    const a0 = polyA[i];
    const a1 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b0 = polyB[j];
      const b1 = polyB[(j + 1) % polyB.length];
      if (
        (pointsNear(a0, b0) && pointsNear(a1, b1)) ||
        (pointsNear(a0, b1) && pointsNear(a1, b0))
      ) {
        return [a0, a1];
      }
    }
  }
  return null;
}

function collectCoastEdges(layer: MapLayer): Array<[[number, number], [number, number]]> {
  const cells = layer.cells;
  const seen = new Set<string>();
  const out: Array<[[number, number], [number, number]]> = [];

  for (const cell of cells) {
    const land = cell.height >= 0;
    for (const nbId of cell.neighbors) {
      const nb = cells[nbId];
      if ((nb.height >= 0) === land) continue;
      const edge = findSharedEdge(cell.polygon, nb.polygon);
      if (!edge) continue;
      const k = edgeKey(edge[0], edge[1]);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(edge);
    }
  }
  return out;
}

/**
 * 元素查看底图：陆地高度灰阶 + 深海去色 + 海平面海岸线描边。
 * 不做全图羽化；元素浓度仍按维诺 cell 多边形逐格绘制。
 */
export function renderElementContextBase(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf, "#000000");

  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  const contourScale = computeHeightContourScale(layer.cells);

  for (const cell of layer.cells) {
    ctx.fillStyle = heightToGrayscale(cell.height, COLOR_REF_HEIGHT, heightColorScale, contourScale);
    ctx.fill(polygonToPath(cell.polygon));
  }

  const coast = collectCoastEdges(layer);
  ctx.strokeStyle = "rgba(200, 230, 255, 0.92)";
  ctx.lineWidth = 1.4 / scale;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (const [[ax, ay], [bx, by]] of coast) {
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();

  ctx.restore();
}

/** 元素浓度半透明叠加层（可复选，叠在底图之上） */
export function renderElementOverlays(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  keys: ElementKey[],
  zoom = 1,
  panX = 0,
  panY = 0,
  alpha = 0.55
): void {
  if (keys.length === 0) return;

  const maxima = elementMaxima(layer.cells);
  const [x0, y0] = layer.bounds;
  const { scale, offsetX, offsetY } = computeTransform(
    layer,
    canvasWidth,
    canvasHeight,
    zoom,
    panX,
    panY
  );

  const single = keys.length === 1;
  const minT = single ? 0.14 : 0.08;
  const layerAlpha = single ? 0.72 : alpha / Math.sqrt(keys.length);

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  for (const key of keys) {
    const { r, g, b } = hexToRgb(ELEMENTS[key].color);
    const max = maxima[key];
    for (const cell of layer.cells) {
      const t = cell.elements[key] / max;
      if (t < minT) continue;
      const a = layerAlpha * Math.min(1, (t - minT) / (1 - minT + 0.001));
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.fill(polygonToPath(cell.polygon));
    }
  }

  ctx.restore();
}

/** 渲染地质底图（按地质类别色平涂，带细边框便于辨认） */
export function renderGeologyMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf);

  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  for (const cell of layer.cells) {
    const path = polygonToPath(cell.polygon);
    ctx.fillStyle = GEOLOGY[cell.geology].color;
    ctx.fill(path);
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 0.35 / scale;
    ctx.stroke(path);
  }

  ctx.restore();
}

/** 地表材质层 */
export function renderSurfaceMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  for (const cell of layer.cells) {
    ctx.fillStyle = surfaceDisplayColor(cell);
    ctx.fill(polygonToPath(cell.polygon));
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 0.25 / scale;
    ctx.stroke(polygonToPath(cell.polygon));
  }

  ctx.restore();
}

function parseRgb(color: string): { r: number; g: number; b: number } {
  const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  return { r: 128, g: 128, b: 128 };
}

function climateMergedColor(cell: Cell): string {
  if (cell.height < 0) {
    const [r, g, b] = temperatureGradientRgb(cell.temperature);
    const night = clamp01(cell.insolationTop * 2.8);
    const k = 0.22 + night * 0.78;
    return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  }
  const [r, g, b] = temperatureGradientRgb(cell.temperature);
  const shade = clamp01(0.38 * cell.cloudWater + 0.22 * cell.cloud);
  const dayLight = clamp01(cell.insolationTop * 2.2);
  const light = clamp01(dayLight * (1 - shade) * (1 - cell.albedo * 0.85));
  const dark = 0.18 + light * 0.82;
  let nr = r * dark;
  let ng = g * dark;
  let nb = b * dark;
  if (cell.precip > 0.02) {
    const pr = Math.pow(cell.precip, 0.7) * 0.75;
    nr = nr * (1 - pr) + 50 * pr;
    ng = ng * (1 - pr) + 255 * pr;
    nb = nb * (1 - pr) + 90 * pr;
  }
  return `rgb(${Math.round(nr)},${Math.round(ng)},${Math.round(nb)})`;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function drawContourPaths(
  ctx: CanvasRenderingContext2D,
  paths: ContourPath[],
  scale: number,
  minorStyle: string,
  majorStyle: string,
  labelFor: (level: number) => string
): void {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const path of paths) {
    if (path.points.length < 2) continue;
    ctx.strokeStyle = path.isIndex ? majorStyle : minorStyle;
    ctx.lineWidth = (path.isIndex ? 1.9 : 0.9) / scale;
    ctx.beginPath();
    ctx.moveTo(path.points[0][0], path.points[0][1]);
    for (let i = 1; i < path.points.length; i++) {
      ctx.lineTo(path.points[i][0], path.points[i][1]);
    }
    if (path.closed) ctx.closePath();
    ctx.stroke();
  }

  const byLevel = new Map<number, ContourPath[]>();
  for (const path of paths) {
    if (!path.isIndex) continue;
    const list = byLevel.get(path.level) ?? [];
    list.push(path);
    byLevel.set(path.level, list);
  }

  const fontPx = Math.max(8, 11 / scale);
  ctx.font = `600 ${fontPx}px system-ui,sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const [level, levelPaths] of byLevel) {
    let best = levelPaths[0];
    let bestLen = 0;
    for (const p of levelPaths) {
      let len = 0;
      for (let i = 1; i < p.points.length; i++) {
        len += Math.hypot(p.points[i][0] - p.points[i - 1][0], p.points[i][1] - p.points[i - 1][1]);
      }
      if (len > bestLen) {
        bestLen = len;
        best = p;
      }
    }
    if (best.points.length < 2) continue;
    const mid = Math.floor(best.points.length / 2);
    const mx = best.points[mid][0];
    const my = best.points[mid][1];
    const text = labelFor(level);
    ctx.lineWidth = 3.5 / scale;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.strokeText(text, mx, my);
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fillText(text, mx, my);
  }
}

function climateScalarFillColor(
  cell: Cell,
  layer: ClimateScalarLayer,
  vmin: number,
  vmax: number
): string {
  const base = climateScalarColor(cell, layer, vmin, vmax);
  if (layer !== "pressure" && layer !== "temperature") return base;
  const m = base.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return base;
  const a = layer === "pressure" ? 0.88 : 0.85;
  return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
}

function scalarHeatColor(t: number, cold: string, mid: string, hot: string): string {
  const c = parseRgb(cold);
  const m = parseRgb(mid);
  const h = parseRgb(hot);
  const x = Math.max(0, Math.min(1, t));
  const a = x < 0.5 ? lerp3(c, m, x * 2) : lerp3(m, h, (x - 0.5) * 2);
  return a;
}

function climateScalarValue(cell: Cell, layer: ClimateScalarLayer): number {
  switch (layer) {
    case "satelliteCloud":
      return Math.max(cell.cloud, cell.cloudWater);
    case "insolationGround":
      return cell.insolationGround;
    case "albedo":
      return cell.albedo;
    case "temperature":
      return cell.temperature;
    case "humidity":
      return cell.humidity;
    case "cloudWater":
      return cell.cloudWater;
    case "precip":
      return cell.precip;
    case "pressure":
      return cell.pressure;
    case "windExposure":
      return cell.windExposure;
    case "vegetation":
      return cell.pools?.biomass ?? 0;
  }
}

function climateScalarColor(cell: Cell, layer: ClimateScalarLayer, vmin: number, vmax: number): string {
  if (layer === "vegetation") return surfaceDisplayColor(cell);
  const v = climateScalarValue(cell, layer);
  if (layer === "pressure") {
    const [r, g, b] = pressureGradientRgb(v);
    return `rgb(${r},${g},${b})`;
  }
  if (layer === "temperature") {
    const [r, g, b] = temperatureGradientRgb(v);
    return `rgb(${r},${g},${b})`;
  }
  const span = Math.max(1e-6, vmax - vmin);
  let t = (v - vmin) / span;
  if (layer === "precip") {
    const t = Math.pow(clamp01(v / 0.42), 0.7);
    return scalarHeatColor(t, "rgb(8,22,12)", "rgb(55,255,130)", "rgb(200,255,70)");
  }
  if (layer === "cloudWater") {
    const t = Math.pow(clamp01(v / 0.65), 0.6);
    return scalarHeatColor(t, "rgb(12,28,70)", "rgb(80,140,210)", "rgb(220,240,255)");
  }
  if (layer === "humidity") {
    t = Math.pow(Math.max(0, t), 0.75);
    return scalarHeatColor(t, "rgb(12,28,70)", "rgb(80,140,210)", "rgb(220,240,255)");
  }
  if (layer === "insolationGround") {
    t = Math.pow(Math.max(0, t), 0.85);
    return scalarHeatColor(t, "rgb(8,12,40)", "rgb(200,180,90)", "rgb(255,248,220)");
  }
  if (layer === "windExposure") {
    return scalarHeatColor(t, "rgb(240,248,255)", "rgb(100,180,220)", "rgb(180,60,40)");
  }
  if (layer === "albedo") {
    return scalarHeatColor(t, "rgb(30,50,90)", "rgb(180,170,150)", "rgb(250,248,240)");
  }
  return scalarHeatColor(t, "rgb(30,30,40)", "rgb(240,200,80)", "rgb(255,250,200)");
}

/** 气候合并显示：基质+植被+云影压暗+降水痕 */
export function renderClimateMergedMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  for (const cell of layer.cells) {
    const path = polygonToPath(cell.polygon);
    ctx.fillStyle = climateMergedColor(cell);
    ctx.fill(path);
    ctx.strokeStyle = "rgba(0,0,0,0.1)";
    ctx.lineWidth = 0.2 / scale;
    ctx.stroke(path);
  }

  ctx.restore();
}

/** 等高线叠加：仅绘制当前变量 */
export function renderClimateContourOverlay(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  scalarLayer: ClimateScalarLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  if (scalarLayer === "satelliteCloud") return;
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);
  drawClimateContoursForLayer(ctx, layer, scalarLayer, scale);
  ctx.restore();
}

/** 风场箭头：桶索引近邻，避免 O(格点×cell数) */
function buildWindLookupBuckets(
  cells: Cell[],
  bounds: [number, number, number, number],
  bucketN = 24
): Cell[][] {
  const [x0, y0, x1, y1] = bounds;
  const spanX = Math.max(1e-6, x1 - x0);
  const spanY = Math.max(1e-6, y1 - y0);
  const buckets: Cell[][] = Array.from({ length: bucketN * bucketN }, () => []);
  for (const cell of cells) {
    const bx = Math.min(
      bucketN - 1,
      Math.max(0, Math.floor(((cell.site[0] - x0) / spanX) * bucketN))
    );
    const by = Math.min(
      bucketN - 1,
      Math.max(0, Math.floor(((cell.site[1] - y0) / spanY) * bucketN))
    );
    buckets[by * bucketN + bx].push(cell);
  }
  return buckets;
}

function nearestCellInBuckets(
  buckets: Cell[][],
  bounds: [number, number, number, number],
  gx: number,
  gy: number,
  bucketN = 24
): Cell | null {
  const [x0, y0, x1, y1] = bounds;
  const spanX = Math.max(1e-6, x1 - x0);
  const spanY = Math.max(1e-6, y1 - y0);
  const bx = Math.min(bucketN - 1, Math.max(0, Math.floor(((gx - x0) / spanX) * bucketN)));
  const by = Math.min(bucketN - 1, Math.max(0, Math.floor(((gy - y0) / spanY) * bucketN)));

  let best: Cell | null = null;
  let bestDist = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = bx + dx;
      const ny = by + dy;
      if (nx < 0 || ny < 0 || nx >= bucketN || ny >= bucketN) continue;
      for (const cell of buckets[ny * bucketN + nx]) {
        const [cx, cy] = cell.site;
        const d = (cx - gx) ** 2 + (cy - gy) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = cell;
        }
      }
    }
  }
  return best;
}

/** 气候 Tab：风箭头（等高线由 overlay / scalar 层单独绘制） */
export function renderClimateWindField(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  _cloud: CloudParams,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0, x1, y1] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  const step = 56;
  const buckets = buildWindLookupBuckets(layer.cells, layer.bounds);
  for (let gx = x0 + step * 0.5; gx < x1; gx += step) {
    for (let gy = y0 + step * 0.5; gy < y1; gy += step) {
      const best = nearestCellInBuckets(buckets, layer.bounds, gx, gy);
      if (!best) continue;
      const ux = best.windU;
      const uy = best.windV;
      const spd = Math.hypot(ux, uy);
      if (spd < 0.4) continue;

      const tRef = 20;
      const warm = best.temperature > tRef;
      const hue = warm ? 210 : 5;
      const alpha = clamp01(0.5 + spd * 0.04);

      const nx = ux / spd;
      const ny = uy / spd;
      const len = 12 + Math.min(42, spd * 1.6);

      ctx.strokeStyle = `hsla(${hue}, 80%, 55%, ${alpha})`;
      ctx.lineWidth = 1.2 / scale;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + nx * len, gy + ny * len);
      ctx.stroke();

      const tipX = gx + nx * len;
      const tipY = gy + ny * len;
      const px = -ny;
      const py = nx;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - nx * 4 + px * 2.5, tipY - ny * 4 + py * 2.5);
      ctx.lineTo(tipX - nx * 4 - px * 2.5, tipY - ny * 4 - py * 2.5);
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
  }

  ctx.restore();
}

/** 气候分层显示：单变量诊断层 */
export function renderClimateScalarMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  scalarLayer: ClimateScalarLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  if (scalarLayer === "satelliteCloud") {
    renderMeteoBureauMap(ctx, layer, canvasWidth, canvasHeight, zoom, panX, panY);
    return;
  }

  const cells = layer.cells;
  const useFixedScale = scalarLayer === "pressure" || scalarLayer === "temperature";
  let vmin = Infinity;
  let vmax = -Infinity;
  const useAbsScale = scalarLayer === "precip" || scalarLayer === "cloudWater";
  if (!useFixedScale) {
    for (const c of cells) {
      if (
        c.height < 0 &&
        scalarLayer !== "humidity" &&
        scalarLayer !== "cloudWater" &&
        scalarLayer !== "precip" &&
        scalarLayer !== "insolationGround"
      )
        continue;
      const v = climateScalarValue(c, scalarLayer);
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    if (!Number.isFinite(vmin)) {
      vmin = 0;
      vmax = 1;
    }
    if (!useAbsScale && vmin === vmax) {
      vmin -= 0.5;
      vmax += 0.5;
    }
  }

  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  // 气压/气温为独立纯色标层：不叠在地形深底上，避免蓝压红发紫
  const isPureGradientLayer = scalarLayer === "pressure" || scalarLayer === "temperature";
  const backdrop = isPureGradientLayer
    ? undefined
    : scalarLayer === "precip" || scalarLayer === "cloudWater"
      ? "#080c10"
      : undefined;
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf, backdrop);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  for (const cell of cells) {
    const path = polygonToPath(cell.polygon);
    ctx.fillStyle = isPureGradientLayer
      ? climateScalarColor(cell, scalarLayer, vmin, vmax)
      : climateScalarFillColor(cell, scalarLayer, vmin, vmax);
    ctx.fill(path);
    if (!isPureGradientLayer) {
      ctx.strokeStyle = "rgba(0,0,0,0.08)";
      ctx.lineWidth = 0.2 / scale;
      ctx.stroke(path);
    }
  }

  drawClimateContoursForLayer(ctx, layer, scalarLayer, scale);

  ctx.restore();
}

/** 水体分布：淡水(青) / 盐水(深蓝紫)，陆地无水为暗灰 */
export function renderWaterMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf, "#000000");
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  for (const cell of layer.cells) {
    const path = polygonToPath(cell.polygon);
    const standing =
      cell.height < 0 ||
      cell.surface === "freshLake" ||
      cell.surface === "wetland" ||
      cell.surface === "saltSea" ||
      cell.surface === "saltFlat" ||
      cell.surface === "ice";
    if (!standing) {
      ctx.fillStyle = "rgb(42,42,42)";
      ctx.fill(path);
      continue;
    }
    const f = cell.waterFresh;
    const s = cell.waterSalt;
    const total = f + s;
    const freshW = total > 0 ? f / total : cell.fillKind === "freshWater" ? 1 : 0;
    const r = Math.round(20 + freshW * 40 + s * 15);
    const g = Math.round(50 + freshW * 120 + s * 30);
    const b = Math.round(90 + freshW * 140 + s * 80);
    const a = Math.min(1, 0.45 + total * 0.65);
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    ctx.fill(path);
  }

  ctx.restore();
}

/** 海拔等高线叠加 */
export type TerrainContourMode = "none" | "coastline" | "full";

function isOpenOceanCell(cell: Cell): boolean {
  return cell.height < 0 && (isOceanCell(cell) || cell.crustKind === "oceanic");
}

function drawVoronoiCoastline(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  scale: number,
  climateContrast = false
): void {
  const cells = layer.cells;
  const seen = new Set<string>();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (climateContrast) {
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = 3 / scale;
  }
  ctx.strokeStyle = climateContrast ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.92)";
  ctx.lineWidth = (climateContrast ? 2.6 : 2.2) / scale;

  for (const cell of cells) {
    for (const nb of cell.neighbors) {
      if (cell.id >= nb) continue;
      const other = cells[nb];
      if (!other) continue;
      const aSea = isOpenOceanCell(cell);
      const bSea = isOpenOceanCell(other);
      if (aSea === bSea) continue;
      const key = cellEdgeKey(cell.id, nb);
      if (seen.has(key)) continue;
      seen.add(key);
      const edge = getSharedPolygonEdge(cell, other);
      if (!edge) continue;
      ctx.beginPath();
      ctx.moveTo(edge[0][0], edge[0][1]);
      ctx.lineTo(edge[1][0], edge[1][1]);
      ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
}

export function renderTerrainContourOverlay(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  mode: TerrainContourMode,
  zoom = 1,
  panX = 0,
  panY = 0,
  climateContrast = false
): void {
  if (mode === "none") return;

  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  const contourScale = computeHeightContourScale(layer.cells);
  const step = contourScale.landStep;

  if (mode === "coastline") {
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.translate(-x0, -y0);
    drawVoronoiCoastline(ctx, layer, scale, climateContrast);
    ctx.restore();
    return;
  }

  const paths = buildGridContourPaths(
    layer.cells,
    layer.bounds,
    (c) => c.height,
    step,
    { gridSize: 168, indexEvery: 3 }
  );

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const path of paths) {
    if (path.points.length < 2) continue;
    const isCoast = Math.abs(path.level) < Math.max(5, step * 0.04);
    const isLand = path.level >= 0 || isCoast;

    if (isLand) {
      if (isCoast) {
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 2.6 / scale;
      } else if (path.isIndex) {
        ctx.strokeStyle = "rgba(255,255,255,0.88)";
        ctx.lineWidth = 2.0 / scale;
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.58)";
        ctx.lineWidth = 1.4 / scale;
      }
    } else if (path.isIndex) {
      ctx.strokeStyle = "rgba(90,150,220,0.4)";
      ctx.lineWidth = 0.95 / scale;
    } else {
      ctx.strokeStyle = "rgba(90,150,220,0.16)";
      ctx.lineWidth = 0.55 / scale;
    }

    ctx.beginPath();
    ctx.moveTo(path.points[0][0], path.points[0][1]);
    for (let i = 1; i < path.points.length; i++) {
      ctx.lineTo(path.points[i][0], path.points[i][1]);
    }
    if (path.closed) ctx.closePath();
    ctx.stroke();
  }

  ctx.restore();
}

/** @deprecated 使用 renderTerrainContourOverlay */
export function renderHeightContourOverlay(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  renderTerrainContourOverlay(ctx, layer, canvasWidth, canvasHeight, "full", zoom, panX, panY);
}


/** 构造层：地质单元面 + 脊线/海沟/边界折线（等高线见 renderHeightContourOverlay） */
export function renderStructureMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  tectonic: TectonicState | null,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf, "#000000");
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  if (tectonic) {
    for (const cell of layer.cells) {
      const pid = tectonic.plateId[cell.id] ?? 0;
      const pl = tectonic.plates[pid];
      if (pl?.continental) {
        ctx.fillStyle = `hsla(${28 + (pid * 19) % 36}, 42%, 40%, 0.9)`;
      } else {
        ctx.fillStyle = `hsla(212, 48%, ${20 + (pid % 6) * 3}%, 0.94)`;
      }
      ctx.fill(polygonToPath(cell.polygon));
    }

    for (const b of tectonic.boundaries) {
      const e = b.edge;
      const col =
        b.kind === "convergent"
          ? `rgba(220,80,60,${0.22 + b.compression * 0.28})`
          : b.kind === "divergent"
            ? "rgba(80,200,140,0.35)"
            : "rgba(180,180,200,0.22)";
      ctx.strokeStyle = col;
      ctx.lineWidth = (b.kind === "convergent" ? 1.0 : 0.7) / scale;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(e.v0[0], e.v0[1]);
      ctx.lineTo(e.v1[0], e.v1[1]);
      ctx.stroke();
    }

    const drawPolyline = (
      points: [number, number][],
      color: string,
      width: number,
      dashed = false
    ) => {
      if (points.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width / scale;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (dashed) ctx.setLineDash([8 / scale, 5 / scale]);
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.stroke();
      if (dashed) ctx.setLineDash([]);
    };

    // 造山带边界（橙）+ 造山场脊线（红橙）
    for (const belt of tectonic.orogenBelts ?? []) {
      if (belt.points.length >= 2) {
        drawPolyline(belt.points, "rgba(235,120,50,0.85)", 2.6);
      }
    }
    for (const mr of tectonic.mountainRidges ?? []) {
      if (mr.points.length >= 3) {
        drawPolyline(mr.points, "rgba(255,70,35,0.95)", 3.6);
      }
    }
    // 洋中脊：仅海底，虚线
    for (const r of tectonic.ridges) {
      if (r.points.length >= 3) {
        drawPolyline(r.points, "rgba(70,170,210,0.55)", 1.4, true);
      }
    }
    // 海沟：仅洋壳俯冲，实线蓝
    for (const t of tectonic.trenches) {
      if (t.points.length >= 3) drawPolyline(t.points, "rgba(50,120,220,0.72)", 1.8);
    }
    // 陆陆裂谷：紫
    for (const r of tectonic.landRifts ?? []) {
      if (r.points.length >= 2) drawPolyline(r.points, "rgba(200,90,220,0.9)", 2.6);
    }
  } else {
    for (const cell of layer.cells) {
      ctx.fillStyle = "rgba(60,70,90,0.5)";
      ctx.fill(polygonToPath(cell.polygon));
    }
  }

  ctx.restore();
}

/** 地壳层：陆壳/洋壳板块填色 + 板块边界（用于检查地壳分类） */
export function renderCrustMap(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  tectonic: TectonicState | null,
  canvasWidth: number,
  canvasHeight: number,
  zoom = 1,
  panX = 0,
  panY = 0
): void {
  const [x0, y0] = layer.bounds;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;

  ctx.save();
  paintMapBackdrop(ctx, layer, canvasWidth, canvasHeight, tf, "#081018");
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);

  for (const cell of layer.cells) {
    let land = false;
    if (tectonic) {
      const pid = tectonic.plateId[cell.id] ?? 0;
      land = tectonic.plates[pid]?.continental ?? false;
    } else {
      land = cell.crustKind === "continental";
    }
    ctx.fillStyle = land ? "rgba(196,165,116,0.94)" : "rgba(26,61,110,0.94)";
    ctx.fill(polygonToPath(cell.polygon));
  }

  if (tectonic) {
    for (const b of tectonic.boundaries) {
      const e = b.edge;
      ctx.strokeStyle =
        b.kind === "convergent"
          ? "rgba(255,120,90,0.7)"
          : b.kind === "divergent"
            ? "rgba(100,220,160,0.65)"
            : "rgba(220,220,240,0.45)";
      ctx.lineWidth = (b.kind === "convergent" ? 1.1 : 0.75) / scale;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(e.v0[0], e.v0[1]);
      ctx.lineTo(e.v1[0], e.v1[1]);
      ctx.stroke();
    }
  }

  ctx.restore();
}

const RULER_FONT = "9px Segoe UI, system-ui, sans-serif";
const RULER_TICK_FONT = "8px Segoe UI, system-ui, sans-serif";

function rulerNiceStep(span: number, targetTicks: number): number {
  if (span <= 0) return 1;
  const raw = span / Math.max(2, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1.5) return mag;
  if (norm <= 3) return 2 * mag;
  if (norm <= 7) return 5 * mag;
  return 10 * mag;
}

function rulerNiceTicks(min: number, max: number, targetTicks = 6): number[] {
  if (min === max) return [min];
  const step = rulerNiceStep(max - min, targetTicks);
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return ticks.length > 0 ? ticks : [min, max];
}

function formatKm(v: number): string {
  if (Math.abs(v) >= 1000) return `${Math.round(v)}`;
  if (Math.abs(v % 100) < 1) return `${Math.round(v)}`;
  return `${Math.round(v)}`;
}

function formatHeightTick(v: number): string {
  const r = Math.round(v);
  if (r === 0) return "0";
  if (Math.abs(r) >= 1000) return `${(r / 1000).toFixed(1)}k`;
  return `${r}`;
}

/** 画布内侧固定画框（不随缩放平移） */
function mapFrameRect(
  tf: WorldTransform,
  canvasWidth: number,
  canvasHeight: number
): { left: number; top: number; right: number; bottom: number } {
  const g = tf.gutter;
  const m = tf.margin;
  return {
    left: m + g.left,
    top: m + g.top,
    right: canvasWidth - m - g.right,
    bottom: canvasHeight - m - g.bottom,
  };
}

/** 选取比例尺长度（km），目标约 80–100px，且不超出画框宽度 */
function pickScaleBarKm(pxPerKm: number, maxBarPx: number): { km: number; barPx: number } {
  const candidates = [5, 10, 20, 25, 50, 100, 200, 250, 500];
  let bestKm = 100;
  let bestPx = 100 * pxPerKm;
  let bestScore = Infinity;

  for (const km of candidates) {
    const px = km * pxPerKm;
    if (px < 28 || px > maxBarPx) continue;
    const score = Math.abs(px - 92);
    if (score < bestScore) {
      bestScore = score;
      bestKm = km;
      bestPx = px;
    }
  }

  if (bestScore === Infinity) {
    for (const km of candidates) {
      const px = Math.min(km * pxPerKm, maxBarPx);
      if (px < 28) continue;
      const score = Math.abs(px - 80);
      if (score < bestScore) {
        bestScore = score;
        bestKm = km;
        bestPx = px;
      }
    }
  }

  if (bestScore === Infinity) {
    bestPx = Math.min(maxBarPx, Math.max(28, 80 * pxPerKm));
    bestKm = Math.round(bestPx / pxPerKm);
    if (bestKm < 1) bestKm = 1;
  }

  return { km: bestKm, barPx: bestPx };
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  barPx: number,
  km: number
): void {
  const h = 5;
  ctx.strokeStyle = "rgba(240,245,255,0.92)";
  ctx.fillStyle = "rgba(240,245,255,0.92)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barPx, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - h);
  ctx.lineTo(x, y + h);
  ctx.moveTo(x + barPx, y - h);
  ctx.lineTo(x + barPx, y + h);
  ctx.stroke();
  ctx.font = RULER_TICK_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${km} km`, x + barPx * 0.5, y - 7);
}

export interface MapRulerOptions {
  zoom?: number;
  panX?: number;
  panY?: number;
  /** 高度层显示右侧高度色标 */
  showHeightScale?: boolean;
  heightMin?: number;
  heightMax?: number;
  maxHeight?: number;
}

/** 主地图坐标标尺（km）+ 可选高度色标 */
export function renderMapRulers(
  ctx: CanvasRenderingContext2D,
  layer: MapLayer,
  canvasWidth: number,
  canvasHeight: number,
  options: MapRulerOptions = {}
): void {
  const { zoom = 1, panX = 0, panY = 0, showHeightScale = false, heightMin = 0, heightMax = 0, maxHeight = COLOR_REF_HEIGHT } = options;

  const [bx0, by0, bx1, by1] = layer.bounds;
  const worldW = bx1 - bx0;
  const worldH = by1 - by0;
  const tf = computeTransform(layer, canvasWidth, canvasHeight, zoom, panX, panY);
  const { scale, offsetX, offsetY } = tf;
  const frame = mapFrameRect(tf, canvasWidth, canvasHeight);

  const mapL = offsetX;
  const mapT = offsetY;
  const mapR = offsetX + worldW * scale;
  const mapB = offsetY + worldH * scale;

  const clipL = Math.max(tf.margin, mapL);
  const clipR = Math.min(canvasWidth - tf.margin, mapR);
  const clipT = Math.max(tf.margin, mapT);
  const clipB = Math.min(canvasHeight - tf.margin, mapB);
  if (clipR <= clipL || clipB <= clipT) return;

  const worldAtX = (sx: number) => bx0 + (sx - offsetX) / scale;
  const worldAtY = (sy: number) => by0 + (sy - offsetY) / scale;
  const screenX = (wx: number) => offsetX + (wx - bx0) * scale;
  const screenY = (wy: number) => offsetY + (wy - by0) * scale;

  const xVisMin = Math.max(bx0, worldAtX(clipL));
  const xVisMax = Math.min(bx1, worldAtX(clipR));
  const yVisMin = Math.max(by0, worldAtY(clipT));
  const yVisMax = Math.min(by1, worldAtY(clipB));

  const xTicks = rulerNiceTicks(xVisMin, xVisMax, 5);
  const yTicks = rulerNiceTicks(yVisMin, yVisMax, 5);
  const labelBottom = mapB + 14;

  ctx.save();
  ctx.font = RULER_TICK_FONT;
  ctx.strokeStyle = "rgba(200,220,240,0.55)";
  ctx.fillStyle = "rgba(210,225,240,0.9)";
  ctx.lineWidth = 1;

  for (const km of xTicks) {
    const x = screenX(km);
    if (x < clipL - 1 || x > clipR + 1) continue;
    ctx.beginPath();
    ctx.moveTo(x, mapB);
    ctx.lineTo(x, mapB + 4);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(`${formatKm(km)}`, x, labelBottom);
    ctx.beginPath();
    ctx.moveTo(x, clipT);
    ctx.lineTo(x, clipB);
    ctx.strokeStyle = "rgba(120,150,180,0.12)";
    ctx.stroke();
    ctx.strokeStyle = "rgba(200,220,240,0.55)";
  }

  for (const km of yTicks) {
    const y = screenY(km);
    if (y < clipT - 1 || y > clipB + 1) continue;
    const tickX = Math.max(tf.margin + 2, mapL - 4);
    ctx.beginPath();
    ctx.moveTo(tickX, y);
    ctx.lineTo(mapL, y);
    ctx.strokeStyle = "rgba(200,220,240,0.55)";
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`${formatKm(km)}`, mapL - 6, y);
    ctx.beginPath();
    ctx.moveTo(clipL, y);
    ctx.lineTo(clipR, y);
    ctx.strokeStyle = "rgba(120,150,180,0.12)";
    ctx.stroke();
    ctx.strokeStyle = "rgba(200,220,240,0.55)";
  }

  ctx.font = RULER_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(170,190,210,0.85)";
  ctx.fillText("X (km)", (clipL + clipR) * 0.5, labelBottom + 11);
  ctx.save();
  ctx.translate(tf.margin + 10, (clipT + clipB) * 0.5);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "top";
  ctx.fillText("Y (km)", 0, 0);
  ctx.restore();

  const barMargin = 12;
  const maxBarPx = frame.right - frame.left - barMargin * 2;
  const { km: scaleKm, barPx } = pickScaleBarKm(scale, maxBarPx);
  const barX = frame.right - barPx - barMargin;
  const barY = frame.bottom - barMargin - 6;
  drawScaleBar(ctx, barX, barY, barPx, scaleKm);

  if (showHeightScale) {
    const barW = 12;
    const barPad = 8;
    const barTop = frame.top + 8;
    const barBot = frame.bottom - 28;
    const barH = barBot - barTop;
    const barX = frame.right - barW - barPad;

    if (barH > 40) {
      const ref = COLOR_REF_HEIGHT;
      const hMin = Math.min(heightMin, 0);
      const hMax = Math.max(heightMax, maxHeight * 0.5, ref * 0.5);
      const span = Math.max(1, hMax - hMin);
      const contourScale = computeHeightContourScale(layer.cells);

      for (let py = 0; py < barH; py++) {
        const t = 1 - py / barH;
        const h = hMin + t * span;
        ctx.fillStyle = heightToContourBandedColor(h, contourScale);
        ctx.fillRect(barX, barTop + py, barW, 1);
      }

      ctx.strokeStyle = "rgba(200,220,240,0.7)";
      ctx.strokeRect(barX, barTop, barW, barH);

      const seaY = barTop + (1 - (0 - hMin) / span) * barH;
      if (seaY >= barTop && seaY <= barBot) {
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath();
        ctx.moveTo(barX - 2, seaY);
        ctx.lineTo(barX + barW + 2, seaY);
        ctx.stroke();
      }

      const { landStep } = contourScale;
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      for (let L = landStep; L <= hMax; L += landStep) {
        const hy = barTop + (1 - (L - hMin) / span) * barH;
        if (hy < barTop || hy > barBot) continue;
        ctx.beginPath();
        ctx.moveTo(barX, hy);
        ctx.lineTo(barX + barW, hy);
        ctx.stroke();
      }
      for (let L = -landStep; L >= hMin; L -= landStep) {
        const hy = barTop + (1 - (L - hMin) / span) * barH;
        if (hy < barTop || hy > barBot) continue;
        ctx.beginPath();
        ctx.moveTo(barX, hy);
        ctx.lineTo(barX + barW, hy);
        ctx.stroke();
      }

      const heightTicks = rulerNiceTicks(hMin, hMax, 5);
      ctx.font = RULER_TICK_FONT;
      ctx.fillStyle = "rgba(210,225,240,0.9)";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const hv of heightTicks) {
        const hy = barTop + (1 - (hv - hMin) / span) * barH;
        if (hy < barTop - 1 || hy > barBot + 1) continue;
        ctx.beginPath();
        ctx.moveTo(barX + barW, hy);
        ctx.lineTo(barX + barW + 4, hy);
        ctx.strokeStyle = "rgba(200,220,240,0.55)";
        ctx.stroke();
        ctx.fillText(`${formatHeightTick(hv)}m`, barX + barW + 6, hy);
      }

      ctx.font = RULER_FONT;
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(170,190,210,0.85)";
      ctx.fillText("高度", barX + barW * 0.5, barTop - 3);
    }
  }

  ctx.restore();
}

export interface MapInfoData {
  cellCount: number;
  maxHeight: number;
  decay: number;
  seed: number;
  heightMin: number;
  heightMax: number;
  landRatio: number;
  displayLabel: string;
  mountainCount?: number;
  basinCount?: number;
  continentCount?: number;
  oceanPlateCount?: number;
  geologyFrac?: Record<GeologyKind, number>;
  ecologyDay?: number;
  simTimeDays?: number;
  ecologySummary?: string;
  climateSummary?: string;
}

/** 页面左下角信息条（非画布叠加） */
export function updateMapInfoPanel(el: HTMLElement, info: MapInfoData): void {
  const items: string[] = [
    `显示层: ${info.displayLabel}`,
    `Cells: ${info.cellCount}`,
    `最高高度: ${info.maxHeight.toFixed(0)} m`,
    `高度: ${info.heightMin.toFixed(0)} ~ ${info.heightMax.toFixed(0)} m`,
    `陆地 ${(info.landRatio * 100).toFixed(0)}% · 海洋 ${((1 - info.landRatio) * 100).toFixed(0)}%`,
    `陆块聚集 ${(100 - info.decay * 100).toFixed(0)}% · 种子 ${info.seed}`,
  ];

  if (info.continentCount !== undefined) {
    items.push(`大陆 ${info.continentCount} · 洋壳 ${info.oceanPlateCount ?? "?"}`);
  }
  if (info.mountainCount !== undefined) {
    items.push(`汇聚 ${info.mountainCount} · 裂谷 ${info.basinCount ?? 0}`);
  }
  if (info.geologyFrac) {
    for (const kind of ["ocean", "shield", "mountain", "basin", "volcanic"] as GeologyKind[]) {
      items.push(`${GEOLOGY[kind].name} ${(info.geologyFrac[kind] * 100).toFixed(1)}%`);
    }
  }
  if (info.simTimeDays !== undefined) {
    const day = info.simTimeDays;
    const hour = hourOfDayFromDay(day);
    const hh = Math.floor(hour);
    const mm = Math.floor((hour - hh) * 60);
    items.push(
      `模拟 第 ${Math.floor(day)} 天 ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`
    );
  } else if (info.ecologyDay !== undefined) {
    items.push(`模拟 第 ${info.ecologyDay} 天`);
  }
  if (info.ecologySummary) {
    items.push(info.ecologySummary);
  }
  if (info.climateSummary) {
    items.push(info.climateSummary);
  }

  el.textContent = items.join("  ·  ");
}
