import type { AtmColumn } from "./verticalGrid";

/** 行星 10×20 瓦片之一（2000 km 边长） */
export interface PlanetTileContext {
  tilesLat: number;
  tilesLon: number;
  tileKm: number;
  tileCol: number;
  tileRow: number;
}

export interface SimClock {
  simDay: number;
  epochLabel: string;
}

export interface GeoFrame {
  planet: PlanetTileContext;
  clock: SimClock;
}
export type ElementKey = "C" | "H" | "O" | "N" | "Si" | "Fe" | "Ca" | "Na";

export const ELEMENT_KEYS: ElementKey[] = [
  "C",
  "H",
  "O",
  "N",
  "Si",
  "Fe",
  "Ca",
  "Na",
];

export interface ElementInfo {
  key: ElementKey;
  /** 中文名 */
  name: string;
  /** 周期表类别 */
  category: string;
  /** 配色（标准/周期表风格） */
  color: string;
}

/** 元素元数据（配色采用标准元素/周期表类别色，可随时调整） */
export const ELEMENTS: Record<ElementKey, ElementInfo> = {
  C: { key: "C", name: "碳", category: "非金属", color: "#909090" },
  H: { key: "H", name: "氢", category: "非金属", color: "#dfe6ff" },
  O: { key: "O", name: "氧", category: "非金属", color: "#ff3b3b" },
  N: { key: "N", name: "氮", category: "非金属", color: "#3a5bff" },
  Si: { key: "Si", name: "硅", category: "类金属", color: "#c8a25a" },
  Fe: { key: "Fe", name: "铁", category: "过渡金属", color: "#e0662e" },
  Ca: { key: "Ca", name: "钙", category: "碱土金属", color: "#7bd64b" },
  Na: { key: "Na", name: "钠", category: "碱金属", color: "#ab5cf2" },
};

/** 地质结构类别 */
export type GeologyKind = "ocean" | "shield" | "mountain" | "basin" | "volcanic";

/** 地壳岩性：洋壳玄武岩 vs 陆壳花岗质基底 */
export type CrustKind = "oceanic" | "continental";

/** 充填介质（地表与海拔之间；与壳归属独立） */
export type FillKind = "none" | "freshWater" | "saltWater" | "ice" | "air";

/** 固体基底岩性 */
export type BasementKind = "rock" | "volcanic" | "sediment";

export const GEOLOGY_KINDS: GeologyKind[] = [
  "ocean",
  "shield",
  "mountain",
  "basin",
  "volcanic",
];

export interface GeologyInfo {
  kind: GeologyKind;
  name: string;
  color: string;
  /** 成因（侧栏折叠详情） */
  origin: string;
  /** 与高度的关系 */
  heightNote: string;
  /** 典型矿脉与元素 */
  veins: string;
  /** 对文明/工业的意义 */
  development: string;
}

/** 地质类别元数据（地质图风格配色，彼此高对比便于区分） */
export const GEOLOGY: Record<GeologyKind, GeologyInfo> = {
  ocean: {
    kind: "ocean",
    name: "海盆",
    color: "#1e4a78",
    origin: "洋壳单元：高度低于海平面；威尔逊循环中的海盆/俯冲消亡端。",
    heightNote: "负高度；洋中脊略隆、海沟略陷。",
    veins: "Na 钠 — 海水/卤水（大范围盐类，非深海挖「钠金属」）。",
    development: "航运、渔业、海盐与化工原料；陆地文明需跨海联通。",
  },
  shield: {
    kind: "shield",
    name: "克拉通/地盾",
    color: "#9aaa70",
    origin: "陆壳古老稳定核心：低造山/裂谷活动，克拉通陆核标记 + shieldField 高。",
    heightNote: "低缓幂律高度；剥蚀后结晶基底裸露。",
    veins: "Fe 铁（古铁矿床）、Ca 钙（石灰岩/大理岩建材矿）。",
    development: "稳定农业基底、铁矿与水泥原料；侵蚀慢、适合长期定居。",
  },
  mountain: {
    kind: "mountain",
    name: "造山带",
    color: "#5c3820",
    origin: "汇聚边界褶皱/逆断层带：orogenField 高（环太平洋、特提斯型造山）。",
    heightNote: "窄条带高 u，幂律映射后呈山脊/山峰；非宽高原。",
    veins: "Fe 铁（最多、沿走向拉长）、Ca 钙（碳酸盐/变质岩）。",
    development: "钢铁、石材；通行难，但矿脉集中。",
  },
  basin: {
    kind: "basin",
    name: "沉积盆地",
    color: "#f2dc50",
    origin: "裂谷沉降或地盾内拗陷：riftField 高且局部洼地，威尔逊链盆地阶段。",
    heightNote: "相对邻域低洼；可发育于古老克拉通之上。",
    veins: "C 碳（煤/油气等沉积有机资源）、Ca 钙（石膏等蒸发岩）、Na 钠（岩盐/湖盐）。",
    development: "能源与化工原料、盐业；平坦易开发，低洼处有机质背景偏高。",
  },
  volcanic: {
    kind: "volcanic",
    name: "火山/岛弧",
    color: "#d03858",
    origin: "俯冲带岛弧热点：arcField 高（陆侧距海沟约 70–120 km，点状弧列）。",
    heightNote: "弧上局部峰点；环太平洋岛链、安第斯弧类似。",
    veins: "Fe 铁（岩浆相关铁矿，强度全场最高）。",
    development: "铁矿热点；火山灰熟化后可育土。",
  },
};

/** 矿脉规则：成因绑定地质，总量随该地质面积；富集度滑块只改密集/贫富。 */
export interface VeinRule {
  geology: GeologyKind;
  element: ElementKey;
  /** 矿种中文名 */
  oreName: string;
  /** 侧栏折叠说明 */
  note: string;
  /** 数量 = 该地质格数×countPerFrac + countBase（或 volcanic 专用公式） */
  countPerFrac: number;
  countBase: number;
  /** 仅 volcanic：用 volcanic 格数×此系数 */
  countPerVolcanicCell?: number;
  rMin: number;
  rMax: number;
  intensity: number;
  aspect: number;
}

export const VEIN_RULES: VeinRule[] = [
  { geology: "mountain", element: "Fe", oreName: "铁矿", note: "造山带褶皱矿化；切到「铁 Fe」层可见橙红富集热点。", countPerFrac: 70, countBase: 3, rMin: 6, rMax: 12, intensity: 2.2, aspect: 3.0 },
  { geology: "mountain", element: "Ca", oreName: "石灰岩", note: "碳酸盐/变质岩；切到「钙 Ca」层，沿山脉走向略拉长。", countPerFrac: 20, countBase: 1, rMin: 6, rMax: 10, intensity: 1.2, aspect: 2.0 },
  { geology: "shield", element: "Fe", oreName: "古铁矿", note: "克拉通古矿床；切到「铁 Fe」层，分布较散、范围较大。", countPerFrac: 28, countBase: 2, rMin: 8, rMax: 14, intensity: 1.8, aspect: 1.0 },
  { geology: "shield", element: "Ca", oreName: "石灰岩", note: "稳定陆核建材矿；切到「钙 Ca」层可见。", countPerFrac: 12, countBase: 1, rMin: 8, rMax: 12, intensity: 1.0, aspect: 1.0 },
  { geology: "basin", element: "C", oreName: "煤/油气", note: "沉积有机资源（煤与油气未分轨）；切到「碳 C」层，盆地中最亮。", countPerFrac: 70, countBase: 2, rMin: 8, rMax: 16, intensity: 2.0, aspect: 1.3 },
  { geology: "basin", element: "Ca", oreName: "石膏", note: "蒸发岩；切到「钙 Ca」层。", countPerFrac: 45, countBase: 2, rMin: 8, rMax: 16, intensity: 1.6, aspect: 1.2 },
  { geology: "basin", element: "Na", oreName: "岩盐", note: "盐矿/湖盐；切到「钠 Na」层，紫色富集。", countPerFrac: 22, countBase: 1, rMin: 8, rMax: 16, intensity: 1.4, aspect: 1.3 },
  { geology: "volcanic", element: "Fe", oreName: "岩浆铁矿", note: "覆盖火山标签后的专属铁矿；切到「铁 Fe」层，单点强度最高。", countPerFrac: 0, countBase: 1, countPerVolcanicCell: 0.2, rMin: 5, rMax: 10, intensity: 2.6, aspect: 1.0 },
  { geology: "ocean", element: "Na", oreName: "海盐/卤水", note: "海水盐类；切到「钠 Na」层，大范围浅紫热点。", countPerFrac: 30, countBase: 2, rMin: 30, rMax: 70, intensity: 1.0, aspect: 1.0 },
];

/** 单个维诺单元 */
export interface Cell {
  id: number;
  /** 种子点坐标 [x, y]，单位 km（瓦片内局部） */
  site: [number, number];
  /** 行星绝对纬度 °（南负北正） */
  latDeg: number;
  /** 行星绝对经度 °（西负东正） */
  lonDeg: number;
  /** 多边形顶点序列 [[x,y], ...] */
  polygon: [number, number][];
  /** 邻接 cell 的 id 列表 */
  neighbors: number[];
  /** 高度，单位米（与 elevation 同步） */
  height: number;
  /** 世界海拔（米） */
  elevation: number;
  /** 充填介质：海水/淡水/冰/干谷 */
  fillKind: FillKind;
  /** 固体基底岩性 */
  basement: BasementKind;
  /** 云浓度 0~1（云层维度，随时间变化） */
  cloud: number;
  /** 地质结构类别 */
  geology: GeologyKind;
  /** 地壳类型（板块 Voronoi 面：陆壳/洋壳） */
  crustKind: CrustKind;
  /** 基底岩层硬度 0~1（洋壳玄武岩 vs 陆壳花岗质） */
  bedrockHardness: number;
  /** 风化程度 0~1（第三步过程迭代写入） */
  weathering: number;
  /** 沉积盖层厚度 0~1（第三步过程迭代写入） */
  sedimentCover: number;
  /** 元素组成（各元素的浓度占比，合计约为 1） */
  elements: Record<ElementKey, number>;
  /** 地表基质（岩石/土壤/冰等，不含植被） */
  surface: SurfaceKind;
  /** 植被覆盖（与基质分离；火山岩等基质上为 none） */
  vegetation: VegetationKind;
  /** 淡水储量 0~1（湖水、地下水、土壤水） */
  waterFresh: number;
  /** 盐水储量 0~1（海水、盐湖、卤水） */
  waterSalt: number;
  /** 氢氧结合度 0~1（可成液态水的 H-O 配对程度） */
  hoBind: number;
  /** 氧化程度 0~1（矿物结合氧为主） */
  oxidation: number;
  /** 还原程度 0~1（有机质/油气/还原环境） */
  reduction: number;
  /** 日照 0~1（纬度：赤道最强；运行中同步为 insolationGround） */
  insolation: number;
  /** 气温（°C，简化：纬度+高度递减） */
  temperature: number;
  /** 湿度 0~1 */
  humidity: number;
  /** 地表反照率 0~1 */
  albedo: number;
  /** 大气顶日照 0~1（纬度+季节） */
  insolationTop: number;
  /** 地面有效日照 0~1（顶日照×云遮×反照后） */
  insolationGround: number;
  /** 物理云水 0~1 */
  cloudWater: number;
  /** 日降水强度 0~1 */
  precip: number;
  /** 海平面气压 anomaly 基准 ~1013 hPa */
  pressure: number;
  /** 局地风分量 km/日（由气压梯度+科氏+弱环流 steering 导出） */
  windU: number;
  windV: number;
  /** 抬升/辐合指数 0~1（地形+低压辐合+锋面） */
  windExposure: number;
  /** 垂直分层大气剖面（37 层，0–10 km） */
  atm?: AtmColumn;
  /** 硬度 0~1（抗侵蚀/耕作） */
  hardness: number;
  /** 可侵蚀性 K 0~1（越大越易风化剥蚀，与硬度反相关） */
  erodibility: number;
  /** 渗透性 0~1（透水/保水） */
  permeability: number;
  /** 元素/生态储量池（慢池+快池，日/年循环） */
  pools: CellPools;
}

/** 土壤可交换营养（快池，日循环可增减） */
export interface BioavailablePool {
  N: number;
  Fe: number;
  Ca: number;
}

/** 单格生态储量池 */
export interface CellPools {
  /** 岩石总储量（慢池，来自 elements，日循环基本不变） */
  lithoStock: Record<ElementKey, number>;
  /** 可交换营养离子 */
  bioavailable: BioavailablePool;
  /** 活生物量 0~1 */
  biomass: number;
  /** 凋落物 0~1 */
  litter: number;
  /** 土壤有机质 0~1 */
  soilOrganic: number;
  /** 锁在生物量中的金属 */
  biomassMetal: { Fe: number; Ca: number };
  /** 基质慢变累计年数（火山熟化/荒漠化） */
  surfaceAgeYears: number;
}

/** 模拟时间步进/播放档位 */
export type SimAdvanceUnit = "1h" | "6h" | "12h" | "1d" | "1mo" | "1y" | "100y";

export const SIM_ADVANCE_SPECS: { id: SimAdvanceUnit; label: string; hours: number }[] = [
  { id: "1h", label: "1 小时", hours: 1 },
  { id: "6h", label: "6 小时", hours: 6 },
  { id: "12h", label: "12 小时", hours: 12 },
  { id: "1d", label: "1 天", hours: 24 },
  { id: "1mo", label: "1 月", hours: 30 * 24 },
  { id: "1y", label: "1 年", hours: 365 * 24 },
  { id: "100y", label: "100 年", hours: 100 * 365 * 24 },
];

/** 自动播放可选档位（最高 1 年/秒） */
export const SIM_PLAY_UNITS: SimAdvanceUnit[] = ["1h", "6h", "12h", "1d", "1mo", "1y"];

export function simUnitHours(unit: SimAdvanceUnit): number {
  return SIM_ADVANCE_SPECS.find((s) => s.id === unit)?.hours ?? 1;
}

export function simUnitToDays(unit: SimAdvanceUnit): number {
  return simUnitHours(unit) / 24;
}

export function simUnitShortLabel(unit: SimAdvanceUnit): string {
  switch (unit) {
    case "1h":
      return "1h";
    case "6h":
      return "6h";
    case "12h":
      return "12h";
    case "1d":
      return "1天";
    case "1mo":
      return "1月";
    case "1y":
      return "1年";
    case "100y":
      return "100年";
  }
}

export function simPlaySpeedIndex(unit: SimAdvanceUnit): number {
  const i = SIM_PLAY_UNITS.indexOf(unit);
  return i >= 0 ? i : 0;
}

export function simPlaySpeedFromIndex(index: number): SimAdvanceUnit {
  return SIM_PLAY_UNITS[Math.max(0, Math.min(SIM_PLAY_UNITS.length - 1, Math.round(index)))] ?? "1h";
}

export function simPlayRateLabel(unit: SimAdvanceUnit): string {
  return `${simUnitShortLabel(unit)}/秒`;
}

/** 生态模拟参数 */
export interface EcologyParams {
  /** 自动播放（默认关） */
  playing: boolean;
  /** 播放速度档位 */
  playSpeed: SimAdvanceUnit;
}

export const DEFAULT_ECOLOGY: EcologyParams = {
  playing: false,
  playSpeed: "1h",
};

/** 地表基质（无植物语义） */
export type SurfaceKind =
  | "saltSea"
  | "freshLake"
  | "wetland"
  | "saltFlat"
  | "sand"
  | "alluvial"
  | "soil"
  | "bareRock"
  | "rockySlope"
  | "ice"
  | "permafrost"
  | "volcanicRock"
  | "beach";

export const SURFACE_KINDS: SurfaceKind[] = [
  "saltSea",
  "freshLake",
  "wetland",
  "saltFlat",
  "sand",
  "alluvial",
  "soil",
  "bareRock",
  "rockySlope",
  "ice",
  "permafrost",
  "volcanicRock",
  "beach",
];

/** 植被覆盖（叠在基质之上） */
export type VegetationKind = "none" | "moss" | "shrub" | "grass" | "forest";

export const VEGETATION_KINDS: VegetationKind[] = ["none", "moss", "shrub", "grass", "forest"];

export interface VegetationInfo {
  kind: VegetationKind;
  name: string;
  color: string;
  effects: string;
}

export const VEGETATION: Record<VegetationKind, VegetationInfo> = {
  none: {
    kind: "none",
    name: "无植被",
    color: "transparent",
    effects: "裸地、火山岩、冰盖等；无植物生长。",
  },
  moss: {
    kind: "moss",
    name: "苔藓/地衣",
    color: "#8a9a7a",
    effects: "冻土缘、阴湿岩面；极薄覆盖。",
  },
  shrub: {
    kind: "shrub",
    name: "灌木/旱生灌丛",
    color: "#9a8a48",
    effects: "干旱半干旱区；低耗水植被。",
  },
  grass: {
    kind: "grass",
    name: "草本/草甸",
    color: "#7daa52",
    effects: "草原、草甸、湿地缘；中等耗水。",
  },
  forest: {
    kind: "forest",
    name: "森林",
    color: "#2d5a32",
    effects: "湿润暖温区；高蒸腾、遮阴。",
  },
};

export interface SurfaceInfo {
  kind: SurfaceKind;
  name: string;
  color: string;
  /** 对温度、湿度、硬度、渗透等的说明 */
  effects: string;
}

export const SURFACE: Record<SurfaceKind, SurfaceInfo> = {
  saltSea: {
    kind: "saltSea",
    name: "盐水域",
    color: "#1a5a8a",
    effects: "温度缓冲、高湿；硬度低；渗透极高（海水）。",
  },
  freshLake: {
    kind: "freshLake",
    name: "淡水湖",
    color: "#3d8ec8",
    effects: "增湿、降温；硬度低；高渗透与蒸发。",
  },
  wetland: {
    kind: "wetland",
    name: "湿地",
    color: "#4a7a62",
    effects: "高湿、温和；软土；渗透高、排水难。",
  },
  saltFlat: {
    kind: "saltFlat",
    name: "盐湖/盐田",
    color: "#e8dcc8",
    effects: "干燥、昼夜温差大；硬壳；渗透极低；无植被。",
  },
  sand: {
    kind: "sand",
    name: "砂砾/沙漠基质",
    color: "#d4b878",
    effects: "高温、低湿、强日照；砂砾硬；渗透高但保水差。",
  },
  alluvial: {
    kind: "alluvial",
    name: "冲积平原土",
    color: "#c4a86a",
    effects: "肥沃、湿度较高；软；渗透高。可长草本/森林。",
  },
  soil: {
    kind: "soil",
    name: "土壤",
    color: "#8b7355",
    effects: "通用农业基底；硬度低；渗透中等。",
  },
  bareRock: {
    kind: "bareRock",
    name: "裸岩/高山",
    color: "#6a6a6a",
    effects: "低温、干燥；极硬；渗透极低；无植被。",
  },
  rockySlope: {
    kind: "rockySlope",
    name: "岩坡/山地",
    color: "#5c5048",
    effects: "凉爽、排水快；硬；渗透低。极少植被。",
  },
  ice: {
    kind: "ice",
    name: "冰盖/冰川",
    color: "#e8f4ff",
    effects: "雪线以上且低温；极硬；无植被。",
  },
  permafrost: {
    kind: "permafrost",
    name: "永冻土/冻土",
    color: "#7a8478",
    effects: "高纬冻土基质；仅边缘可苔藓。",
  },
  volcanicRock: {
    kind: "volcanicRock",
    name: "火山岩/熔渣",
    color: "#4a3838",
    effects: "炽热、新生岩面；不可长植物（肥力未熟化）。",
  },
  beach: {
    kind: "beach",
    name: "海岸/沙滩",
    color: "#e8d9a8",
    effects: "温和、潮湿；砂质软；渗透高；无稳定植被。",
  },
};

/** 基质元素：地壳背景，不参与「资源主导」 */
export const MATRIX_ELEMENT_KEYS: ElementKey[] = ["O", "Si"];

/** 资源/循环元素：主导元素层只在这些里选最高 */
export const RESOURCE_ELEMENT_KEYS: ElementKey[] = ["C", "H", "N", "Fe", "Ca", "Na"];

/** 底图显示层 */
export type BaseLayer =
  | "height"
  | "geology"
  | "structure"
  | "crust"
  | "dominant"
  | "surface"
  | "water"
  | "climate";

/** 气候分层显示变量 */
export type ClimateScalarLayer =
  | "satelliteCloud"
  | "insolationGround"
  | "albedo"
  | "temperature"
  | "humidity"
  | "cloudWater"
  | "precip"
  | "pressure"
  | "windExposure"
  | "vegetation";

export type ClimateDisplayMode = "merged" | "layered";

export interface ClimateUiState {
  displayMode: ClimateDisplayMode;
  scalarLayer: ClimateScalarLayer;
}

export const DEFAULT_CLIMATE_UI: ClimateUiState = {
  displayMode: "layered",
  scalarLayer: "pressure",
};

export const CLIMATE_SCALAR_LAYERS: { id: ClimateScalarLayer; label: string }[] = [
  { id: "satelliteCloud", label: "气象图(气压+降水+气旋)" },
  { id: "pressure", label: "气压 hPa" },
  { id: "temperature", label: "气温 °C" },
  { id: "precip", label: "降水" },
  { id: "humidity", label: "湿度" },
  { id: "cloudWater", label: "云水" },
  { id: "windExposure", label: "辐合抬升" },
  { id: "vegetation", label: "植被/生物量" },
  { id: "insolationGround", label: "日照(影响因子)" },
  { id: "albedo", label: "反照率(影响因子)" },
];

/** @deprecated 使用 BaseLayer；元素浓度改由勾选叠加 */
export type DisplayMode = BaseLayer;

/** 地图层级（为下钻预留） */
export interface MapLayer {
  id: string;
  level: "macro" | "block" | "community";
  parentId: string | null;
  children: string[];
  /** 域边界 [x0, y0, x1, y1]，单位 km（当前瓦片内） */
  bounds: [number, number, number, number];
  /** 行星瓦片 + 模拟时钟 */
  geoFrame?: GeoFrame;
  cells: Cell[];
}

/** 地形生成参数 */
export interface TerrainParams {
  /** 最高高度（米） */
  maxHeight: number;
  /** 宏观衰减 0~1：高原/山脉/盆地特征半径与间距（大陆聚合 vs 碎裂泼溅） */
  decay: number;
  /** 局部衰减 0~1：fBm 噪声权重与频率（海岸锯齿、局部起伏，与宏观独立） */
  localDecay: number;
  /** 维诺边缘平滑 0~1：邻格高度混合，削弱格网蜂窝海岸线（不改格子形状） */
  edgeSmooth: number;
  /** 随机种子 */
  seed: number;
  /** 大陆块数（陆核/克拉通种子，必为陆壳板块） */
  continentCount: number;
  /** 山脉数量 */
  mountainCount: number;
  /** 盆地数量 */
  basinCount: number;
  /** 海洋/盆地基准下沉比例 0~1 */
  oceanRatio: number;
  /** 矿脉富集度 0=分散贫矿 · 1=密集富矿（总量仍由地质面积决定） */
  veinDensity: number;
  /** 维诺↔板块共演化迭代次数 */
  tectonicIterations: number;
  /** 格网均匀化 0=构造线挤压格网 · 1=接近等面积 Lloyd */
  meshUniformity: number;
  /** 陆地居中 0=均匀撒点 · 1=陆核/高点偏画布中心、边缘趋海 */
  landCentric: number;
  /** 单一大陆：仅 1 个陆壳板块/陆核（忽略大陆块数滑块） */
  singleContinent: boolean;
  /** 强制环海：域边缘带压低为海，避免大陆贴边裁切 */
  oceanRing: boolean;
  /** 陆地高度幂律指数 γ（>1 则低地多、高峰少，参考地球 hypsometry） */
  hypsometryGamma: number;
}

/** 云层参数 */
export interface CloudParams {
  /** 是否显示气旋云系叠加（非气候层） */
  enabled: boolean;
  /** 螺旋云带显示强度 0~1 */
  coverage: number;
}

export const DEFAULT_CLOUD: CloudParams = {
  enabled: false,
  coverage: 0.72,
};

/** 生成配置 */
export interface VoronoiConfig {
  cellCount: number;
  bounds: [number, number, number, number];
  lloydIterations: number;
  seed: number;
}

export const DEFAULT_TERRAIN: TerrainParams = {
  maxHeight: 8848,
  decay: 0.35,
  localDecay: 0.35,
  edgeSmooth: 0,
  seed: 42,
  continentCount: 4,
  mountainCount: 3,
  basinCount: 2,
  oceanRatio: 0.45,
  veinDensity: 0.5,
  tectonicIterations: 6,
  meshUniformity: 0.35,
  landCentric: 0.55,
  singleContinent: false,
  oceanRing: false,
  hypsometryGamma: 2.35,
};

export const DEFAULT_VORONOI: VoronoiConfig = {
  cellCount: 10000,
  bounds: [0, 0, 40000, 20000],
  lloydIterations: 1,
  seed: 42,
};

/** 肉色及其反色 */
export const FLESH = { r: 224, g: 172, b: 157 };
export const FLESH_INV = { r: 31, g: 83, b: 98 };

/**
 * 颜色绝对参考高度（米）。
 * 颜色直接绑定到米数：|height| 达到该值时为最深（黑）。
 * 这样矮大陆显浅、满 10000m 才最深，而非相对最大值缩放。
 */
export const COLOR_REF_HEIGHT = 10000;
