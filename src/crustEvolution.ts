import type { Cell, CrustKind, TerrainParams } from "./types";
import type { TectonicState } from "./cellGraph";
import { upliftAt } from "./geologyFromTectonics";
import { tnFbm, tnRidged, warpPoint } from "./tectonicLoop";
import { assignCellAttribution, setElevation } from "./attribution";

/**
 * 地壳演化（第三步：高度过程）
 *   输入：板块陆/洋壳面 + 构造场（造山/褶皱/断层/节理）
 *   过程：u（隆升）− e（侵蚀/风化）+ d（沉积）
 *   输出：elevation + 写入 cell.weathering / sedimentCover / bedrockHardness
 */

export interface CrustEvolutionState {
  continentalCrust: Float64Array;
  oceanicCrust: Float64Array;
  uplift: Float64Array;
  erosion: Float64Array;
  sediment: Float64Array;
  cooling: Float64Array;
  weathering: Float64Array;
  elevation: Float64Array;
  processIterations: number;
  convergeIterations: number;
}

function diffuseField(field: Float64Array, cells: Cell[], passes: number): void {
  const n = field.length;
  const buf = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let sum = field[i] * 2;
      let w = 2;
      for (const nb of cells[i].neighbors) {
        sum += field[nb];
        w++;
      }
      buf[i] = sum / w;
    }
    for (let i = 0; i < n; i++) field[i] = buf[i];
  }
}

/** 洋壳玄武岩 vs 陆壳花岗质基底硬度（0~1） */
export function bedrockHardnessFor(
  crustKind: CrustKind,
  cooling: number,
  jointDensity: number,
  faultBreak: number
): number {
  if (crustKind === "oceanic") {
    return 0.36 + cooling * 0.44;
  }
  // 陆壳：节理/断层破碎区易风化，克拉通核心硬
  const fracture = Math.max(jointDensity, faultBreak * 0.85);
  return 0.86 - fracture * 0.38 - (1 - cooling) * 0.08;
}

/** 板块陆核 mask → 图 BFS 符号距离（陆内正、海内负、海岸≈0） */
function computeSignedDistance(cells: Cell[], landMask: Uint8Array): Float64Array {
  const n = cells.length;
  const dist = new Float64Array(n);
  dist.fill(Number.POSITIVE_INFINITY);
  const queue: number[] = [];

  for (let i = 0; i < n; i++) {
    const isLand = landMask[i] === 1;
    let onCoast = false;
    for (const nb of cells[i].neighbors) {
      if ((landMask[nb] === 1) !== isLand) {
        onCoast = true;
        break;
      }
    }
    if (onCoast) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const d = dist[i];
    const [xi, yi] = cells[i].site;
    for (const nb of cells[i].neighbors) {
      const [xn, yn] = cells[nb].site;
      const step = Math.hypot(xn - xi, yn - yi);
      const nd = d + step;
      if (nd < dist[nb]) {
        dist[nb] = nd;
        queue.push(nb);
      }
    }
  }

  const sd = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sd[i] = landMask[i] ? dist[i] : -dist[i];
  }
  return sd;
}

/** 大陆度场：符号距离 + 海岸分形噪声 + 外海群岛 */
function buildContinentDegree(
  cells: Cell[],
  sd: Float64Array,
  tectonic: TectonicState,
  params: TerrainParams
): Float64Array {
  const n = cells.length;
  const degree = new Float64Array(n);
  const [x0, y0, x1, y1] = tectonic.mapBounds;
  const half = Math.max(1, Math.min(x1 - x0, y1 - y0) * 0.5);
  const decay = Math.max(0, Math.min(1, params.decay ?? 0.5));
  const marginAmp = half * (0.1 + (1 - decay) * 0.05);
  const islandAmp = half * (0.04 + decay * 0.09);
  const coastSigma = half * 0.032;

  for (let i = 0; i < n; i++) {
    let [x, y] = cells[i].site;
    [x, y] = warpPoint(x, y, params.seed + 2029, half);
    const d = sd[i];
    const coastW = Math.exp(-(d * d) / (coastSigma * coastSigma));

    const fLow = (tnFbm((x / half) * 2.8, (y / half) * 2.8, params.seed + 4242, 5) - 0.5) * 2;
    const fRidge = (tnRidged((x / half) * 4.6, (y / half) * 4.6, params.seed + 9001, 4) - 0.5) * 2;
    const fHigh = (tnFbm((x / half) * 9.5, (y / half) * 9.5, params.seed + 1777, 4) - 0.5) * 2;

    let C = d;
    C += fLow * marginAmp * (0.3 + coastW * 0.7);
    C += fRidge * marginAmp * 0.32 * coastW;
    C += fHigh * marginAmp * 0.12 * coastW;

    if (d < 0 && d > -half * 0.14) {
      const isl = tnRidged((x / half) * 11, (y / half) * 11, params.seed + 3333, 3);
      if (isl > 0.68) C += islandAmp * (isl - 0.68) * 5.5;
    }

    if (params.oceanRing) {
      const edgeDist = Math.min(x - x0, x1 - x, y - y0, y1 - y);
      const band = half * 0.12;
      if (edgeDist < band) C -= (1 - edgeDist / band) * half * 0.08;
    }

    degree[i] = C;
  }
  return degree;
}

function thresholdForLandFraction(degree: Float64Array, targetLand: number): number {
  const sorted = Float64Array.from(degree).sort();
  const n = sorted.length;
  const k = Math.min(n - 1, Math.max(0, Math.floor((1 - targetLand) * n)));
  return sorted[k];
}

/**
 * 陆/洋壳面：板块陆核 → 符号距离 → 分形海岸等值线（非凸 Voronoi 团块）
 */
export function buildContinentalCrustField(
  cells: Cell[],
  tectonic: TectonicState,
  params: TerrainParams
): Float64Array {
  const n = cells.length;
  const field = new Float64Array(n);
  const { plateId, plates } = tectonic;
  const targetLand = 1 - Math.max(0.05, Math.min(0.92, params.oceanRatio));

  const plateLand = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    plateLand[i] = plates[plateId[i]].continental ? 1 : 0;
  }

  const sd = computeSignedDistance(cells, plateLand);
  const degree = buildContinentDegree(cells, sd, tectonic, params);
  const threshold = thresholdForLandFraction(degree, targetLand);

  for (let i = 0; i < n; i++) {
    const continental = degree[i] > threshold;
    field[i] = continental ? 1 : 0;
    cells[i].crustKind = continental ? "continental" : "oceanic";
    cells[i].bedrockHardness = bedrockHardnessFor(
      cells[i].crustKind,
      continental ? 0.55 : 0.2,
      0,
      0
    );
    tectonic.continental[i] = continental ? 1 : 0;
  }

  return field;
}

/** 多边形面积（km²，作汇水面积 A 的基元） */
function cellArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [px, py] = poly[i];
    const [qx, qy] = poly[(i + 1) % poly.length];
    a += px * qy - qx * py;
  }
  return Math.abs(a) * 0.5;
}

// 紧凑 value-noise fBm（分形自相似细节）
function cnHash(ix: number, iy: number, s: number): number {
  let h = Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(s | 0, 83492791);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

function cnValue(x: number, y: number, s: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = cnHash(x0, y0, s);
  const b = cnHash(x0 + 1, y0, s);
  const c = cnHash(x0, y0 + 1, s);
  const d = cnHash(x0 + 1, y0 + 1, s);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

function cnFbm(x: number, y: number, s: number, oct: number): number {
  let amp = 0.5;
  let f = 1;
  let sum = 0;
  let nrm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * cnValue(x * f, y * f, s + o * 1013);
    nrm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / nrm;
}

/** 风化侵蚀系数 K：岩性硬度 + 节理 + 已风化程度 */
function erosionK(
  cell: Cell,
  tectonic: TectonicState,
  weathering: number,
  cooling: number
): number {
  const joints = tectonic.jointDensityField[cell.id] ?? 0;
  const faults = tectonic.faultBreakField[cell.id] ?? 0;
  const bedrock = bedrockHardnessFor(cell.crustKind, cooling, joints, faults);
  const lithoK = 0.55 - bedrock * 0.42;
  return (
    lithoK +
    0.28 * weathering +
    0.18 * joints +
    0.14 * faults +
    0.1 * (1 - cooling) +
    0.08 * tectonic.riftField[cell.id]
  );
}

/**
 * 高度演化（艾里均衡 + 地形演化模型 LEM）
 *   ① 构造决定地壳厚度 H（造山加厚/裂谷减薄）
 *   ② 艾里均衡 h = (ρm−ρc)/ρm·H  → 宏观骨架（薄洋壳深、厚陆壳高、山根深）
 *   ③ LEM：∂z/∂t = U − K·Aᵐ·∇z（河流汇水下切）+ D·∇²z（山坡扩散）
 *   ④ 分形 fBm 叠加跨尺度细节；按目标海洋比定海平面
 */
export function evolveCrustTerrain(
  cells: Cell[],
  tectonic: TectonicState,
  continentalCrust: Float64Array,
  params: TerrainParams
): CrustEvolutionState {
  const n = cells.length;
  const oceanicCrust = new Float64Array(n);
  const uplift = new Float64Array(n);
  const erosion = new Float64Array(n);
  const sediment = new Float64Array(n);
  const cooling = new Float64Array(n);
  const weathering = new Float64Array(n);
  const elevation = new Float64Array(n);

  const targetOcean = Math.max(0.05, Math.min(0.92, params.oceanRatio));

  // 密度 g/cm³ 与基准厚度 km
  const RHO_M = 3.3;
  const RHO_CONT = 2.72;
  const RHO_OCEAN = 2.9;
  const H_CONT = 33;
  const H_OCEAN = 7;

  const [bx0, by0, bx1, by1] = tectonic.mapBounds;
  const span = Math.max(1, Math.min(bx1 - bx0, by1 - by0));
  const regFreq = 2.2 / span; // 低频区域起伏：几个跨大陆的「省」

  // ① 地壳厚度场（构造加厚/减薄 + 低频区域起伏 → 异质大陆，非平板）
  const thickness = new Float64Array(n);
  const rho = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const cont = cells[i].crustKind === "continental";
    rho[i] = cont ? RHO_CONT : RHO_OCEAN;
    if (cont) {
      const [x, y] = cells[i].site;
      // 区域隆升：多倍频 fBm → 高原/丘陵/低地多级基面（消除单一基面尖峰，给河流坡降）
      const reg =
        cnFbm(x * regFreq, y * regFreq, params.seed + 777, 3) * 0.5 +
        cnFbm(x * regFreq * 2.4, y * regFreq * 2.4, params.seed + 9001, 3) * 0.32 +
        cnFbm(x * regFreq * 5.1, y * regFreq * 5.1, params.seed + 1337, 3) * 0.18;
      thickness[i] =
        H_CONT +
        reg * 14 + // 0~14km 区域加厚 → 省级基面差 ~2.4km
        tectonic.orogenField[i] * 40 + // 碰撞造山加厚 → 深山根、高山
        tectonic.arcField[i] * 14 -
        tectonic.riftField[i] * 18; // 大陆裂谷拉张减薄
    } else {
      thickness[i] =
        H_OCEAN +
        tectonic.arcField[i] * 12 +
        tectonic.ridgeField[i] * 1.5 -
        tectonic.trenchField[i] * 2;
    }
    thickness[i] = Math.max(4, thickness[i]);
    oceanicCrust[i] = cont ? 0 : 1;
    uplift[i] = upliftAt(tectonic, i);
    cooling[i] = tectonic.shieldField[i] * 0.75 + (cont ? 0.15 : tectonic.ridgeField[i] * 0.1);
    weathering[i] = cont ? 0.04 + tectonic.jointDensityField[i] * 0.12 : 0;
  }
  // 山根连续：厚度场平滑
  diffuseField(thickness, cells, 2);

  // ② 艾里均衡（km）；基准抵消后再由分位海平面统一参考
  const baseTerm = H_CONT * (1 - RHO_CONT / RHO_M) - 0.85;
  const zKm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    zKm[i] = thickness[i] * (1 - rho[i] / RHO_M) - baseTerm;
    // 火山建造（非均衡）：岛弧/热点直接堆高 → 洋内火山岛
    if (cells[i].crustKind === "oceanic") zKm[i] += tectonic.arcField[i] * 3.6;
    else zKm[i] += tectonic.arcField[i] * 0.8;
  }

  // 分形细节（自相似纹理）：高地/陡处粗糙，低平地小，避免戳出破洞
  const localDecay = params.localDecay ?? 0.5;
  const fFreq = 6 / span;
  const fOct = Math.round(3 + localDecay * 3);
  const detScale = 0.05 + 0.34 * localDecay;
  for (let i = 0; i < n; i++) {
    const [x, y] = cells[i].site;
    const det = (cnFbm(x * fFreq, y * fFreq, params.seed + 4242, fOct) - 0.5) * 2;
    const relief = zKm[i] > 0 ? 0.1 + 0.32 * Math.min(1, zKm[i] / 3) : 0.05;
    zKm[i] += det * relief * detScale;
  }

  // ③ LEM：山坡扩散 + 河流幂律下切（汇水面积 A）
  const area = new Float64Array(n);
  for (let i = 0; i < n; i++) area[i] = cellArea(cells[i].polygon) || 1;

  const lemSteps = 12;
  const Kf = 0.0014; // 河流侵蚀系数（加强切谷 → 内陆水系纹理）
  const mExp = 0.5;
  const Dd = 0.16; // 山坡扩散
  const idx = Array.from({ length: n }, (_, i) => i);

  for (let s = 0; s < lemSteps; s++) {
    const sortedZ = Float64Array.from(zKm).sort();
    const seaIdx = Math.min(n - 1, Math.max(0, Math.floor(targetOcean * n)));
    const seaLevel = sortedZ[seaIdx];

    // 流向：最陡下降邻居；按高→低累积汇水
    idx.sort((a, b) => zKm[b] - zKm[a]);
    const receiver = new Int32Array(n).fill(-1);
    const acc = Float64Array.from(area);
    for (const i of idx) {
      let best = -1;
      let bestDrop = 0;
      for (const nb of cells[i].neighbors) {
        const d = zKm[i] - zKm[nb];
        if (d > bestDrop) {
          bestDrop = d;
          best = nb;
        }
      }
      receiver[i] = best;
    }
    for (const i of idx) {
      const r = receiver[i];
      if (r >= 0) acc[r] += acc[i];
    }

    const dz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let w = 0;
      for (const nb of cells[i].neighbors) {
        sum += zKm[nb];
        w++;
      }
      const lap = w > 0 ? sum / w - zKm[i] : 0;
      if (zKm[i] <= seaLevel) {
        dz[i] = Dd * lap * 0.4; // 海下仅缓慢扩散
        continue;
      }
      const r = receiver[i];
      const slope = r >= 0 ? Math.max(0, zKm[i] - zKm[r]) : 0;
      const K = Kf * (0.5 + erosionK(cells[i], tectonic, weathering[i], cooling[i]));
      const incision = K * Math.pow(acc[i], mExp) * slope;
      dz[i] = -incision + Dd * lap;
      erosion[i] = Math.min(1, erosion[i] + incision * 5);
    }
    for (let i = 0; i < n; i++) zKm[i] += dz[i];
    // 沉积：下切的物质堆到下游接收端（洼地/海岸 → 沉积盆地）
    for (let i = 0; i < n; i++) {
      if (dz[i] < 0) {
        const r = receiver[i];
        if (r >= 0) {
          const dep = -dz[i] * 0.4;
          zKm[r] += dep;
          sediment[r] = Math.min(1, sediment[r] + dep * 2.5);
        }
      }
    }
  }

  // ④ 定海平面（目标海洋比）
  const seaAt = (): number => {
    const s = Float64Array.from(zKm).sort();
    const k = Math.min(n - 1, Math.max(0, Math.floor(targetOcean * n)));
    return s[k];
  };
  let seaLevel = seaAt();

  // 填内陆封闭海：从地图边缘真海洪泛，未连通的水域=封闭洼地→抬出水面成盆地
  {
    const reached = new Uint8Array(n);
    const stack: number[] = [];
    const margin = span * 0.02;
    for (let i = 0; i < n; i++) {
      if (zKm[i] > seaLevel) continue;
      const [x, y] = cells[i].site;
      if (x - bx0 < margin || bx1 - x < margin || y - by0 < margin || by1 - y < margin) {
        reached[i] = 1;
        stack.push(i);
      }
    }
    while (stack.length) {
      const i = stack.pop() as number;
      for (const nb of cells[i].neighbors) {
        if (!reached[nb] && zKm[nb] <= seaLevel) {
          reached[nb] = 1;
          stack.push(nb);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (zKm[i] <= seaLevel && !reached[i]) {
        if (cells[i].crustKind === "continental") {
          sediment[i] = Math.min(1, sediment[i] + 0.35);
        } else {
          zKm[i] = seaLevel + 0.02;
        }
      }
    }
    seaLevel = seaAt();
  }

  // 测高曲线校准：保留物理模型的「空间次序」（山脉/高原/平原位置、水系、抖动），
  // 仅按秩重映射 面积-高度 曲线为地球式（低地多、高峰少），消除单一基面尖峰。
  const landIdx: number[] = [];
  const oceanIdx: number[] = [];
  for (let i = 0; i < n; i++) (zKm[i] > seaLevel ? landIdx : oceanIdx).push(i);
  landIdx.sort((a, b) => zKm[a] - zKm[b]); // 低→高
  oceanIdx.sort((a, b) => zKm[a] - zKm[b]); // 深→浅
  const gammaLand = params.hypsometryGamma ?? 2.3;
  const gammaOcean = 0.72; // <1：洋底以深海平原为主，陆架窄
  const maxDepth = params.maxHeight * 0.85;
  const nl = landIdx.length;
  const no = oceanIdx.length;
  // 两段式：绝大多数陆地是 0~平台高度 的低地/丘陵，仅顶端少数成高山（如珠峰般离群）
  const platformR = 0.9; // 更多陆地可进入峰带
  const platformH = 2200;
  for (let k = 0; k < nl; k++) {
    const r = (k + 0.5) / nl;
    let h: number;
    if (r < platformR) {
      h = platformH * Math.pow(r / platformR, gammaLand * 0.75);
    } else {
      const tt = (r - platformR) / (1 - platformR);
      h = platformH + (params.maxHeight - platformH) * Math.pow(tt, 1.3);
    }
    elevation[landIdx[k]] = h;
  }
  for (let k = 0; k < no; k++) {
    const r = (k + 0.5) / no; // r→0 最深
    elevation[oceanIdx[k]] = -maxDepth * Math.pow(1 - r, gammaOcean);
  }

  // 秩映射后叠加构造分形起伏：造山脊/裂谷槽在宏观格网上仍可见
  const reliefFreq = 7.5 / span;
  const oAmp = tectonic.orogenAmp ?? tectonic.compressionAmp ?? 1;
  const rAmp = tectonic.riftAmp ?? tectonic.compressionAmp ?? 1;
  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    if (cell.crustKind !== "continental") continue;
    const o = tectonic.orogenField[i];
    const r = tectonic.riftField[i];
    const arc = tectonic.arcField[i];
    if (o < 0.06 && r < 0.06 && arc < 0.2) continue;

    const [x, y] = cell.site;
    const ridged =
      (tnRidged(x * reliefFreq, y * reliefFreq, params.seed + 5511, 4) - 0.5) * 2;
    const detail =
      (tnFbm(x * reliefFreq * 2.2, y * reliefFreq * 2.2, params.seed + 6612, 3) - 0.5) * 2;

    if (o > 0.06) {
      const ridge = Math.max(0, ridged);
      elevation[i] += o * params.maxHeight * (0.18 + ridge * 0.14) * oAmp;
      elevation[i] += detail * o * params.maxHeight * 0.04;
    }
    if (arc > 0.22) {
      elevation[i] += arc * params.maxHeight * 0.12 * oAmp;
    }
    if (r > 0.06) {
      const trough = Math.max(0, -ridged);
      const drop = r * (params.maxHeight * 0.1 + trough * params.maxHeight * 0.08) * rAmp;
      elevation[i] -= drop;
    }
  }

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(elevation[i])) elevation[i] = 0;

    const cell = cells[i];
    setElevation(cell, elevation[i]);
    cell.weathering = weathering[i];
    cell.sedimentCover = sediment[i];
    cell.bedrockHardness = bedrockHardnessFor(
      cell.crustKind,
      cooling[i],
      tectonic.jointDensityField[i],
      tectonic.faultBreakField[i]
    );
    assignCellAttribution(cell, tectonic.mapBounds, tectonic, 0);
  }

  return {
    continentalCrust,
    oceanicCrust,
    uplift,
    erosion,
    sediment,
    cooling,
    weathering,
    elevation,
    processIterations: lemSteps,
    convergeIterations: 1,
  };
}
