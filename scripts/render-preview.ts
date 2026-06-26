import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { generateVoronoi } from "../src/voronoi.ts";
import {
  coEvolveTectonics,
  orogenAmplifier,
  riftAmplifier,
  effectiveContinentCount,
} from "../src/tectonicLoop.ts";
import { buildContinentalCrustField, evolveCrustTerrain } from "../src/crustEvolution.ts";
import { generateGeologicalStructures } from "../src/geologyFromTectonics.ts";
import { assignHeights } from "../src/terrain.ts";
import { computeElements } from "../src/elements.ts";
import { isOceanCell } from "../src/attribution.ts";
import { DEFAULT_TERRAIN, DEFAULT_VORONOI } from "../src/types.ts";
import type { Cell } from "../src/types.ts";

const seed = Number(process.argv[2] ?? 42);
const cellCount = Number(process.argv[3] ?? 9000);
const multi = process.argv[4] === "multi";
const W = 820;
const H = 820;
const bounds: [number, number, number, number] = [0, 0, 1000, 1000];

const p = {
  ...DEFAULT_TERRAIN,
  seed,
  singleContinent: multi ? false : DEFAULT_TERRAIN.singleContinent,
  continentCount: multi ? 4 : DEFAULT_TERRAIN.continentCount,
};
const cells = generateVoronoi({ ...DEFAULT_VORONOI, cellCount, seed });
let t = coEvolveTectonics(cells, {
  seed: p.seed,
  iterations: p.tectonicIterations,
  continentCount: effectiveContinentCount(p),
  convergentBias: 0.55,
  riftBias: 0.3,
  meshUniformity: p.meshUniformity,
  orogenAmp: orogenAmplifier(p.mountainCount),
  riftAmp: riftAmplifier(p.basinCount),
  bounds,
  landCentric: p.landCentric,
  singleContinent: p.singleContinent,
  oceanRing: p.oceanRing,
  oceanRatio: p.oceanRatio,
  decay: p.decay,
});
const cc = buildContinentalCrustField(cells, t, p);
t = generateGeologicalStructures(
  cells,
  t,
  { seed: p.seed, orogenAmp: t.orogenAmp, riftAmp: t.riftAmp },
  cc
);
const cs = evolveCrustTerrain(cells, t, cc, p);
assignHeights(cells, p, [], t, bounds, cs);
computeElements(cells, p.seed, [], p.veinDensity, t);

// ---- 调色板 ----
function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
function lerp(a: number, b: number, u: number) {
  return a + (b - a) * u;
}
function mix(c1: number[], c2: number[], u: number): number[] {
  return [lerp(c1[0], c2[0], u), lerp(c1[1], c2[1], u), lerp(c1[2], c2[2], u)];
}

function terrainColor(c: Cell): number[] {
  if (c.height < 0 && c.crustKind === "continental") {
    const d = clamp(-c.height / 2500, 0, 1);
    if (c.fillKind === "ice") return mix([190, 210, 230], [140, 170, 200], d);
    if (c.fillKind === "freshWater") return mix([50, 90, 110], [30, 60, 80], d);
    return mix([100, 75, 60], [70, 55, 45], d);
  }
  const h = c.height;
  if (h < 0) {
    const d = clamp(-h / 5000, 0, 1);
    return mix([170, 215, 240], [12, 40, 95], Math.pow(d, 0.7));
  }
  const e = clamp(h / 5000, 0, 1);
  if (e < 0.12) return mix([70, 140, 70], [120, 170, 85], e / 0.12);
  if (e < 0.4) return mix([120, 170, 85], [150, 140, 95], (e - 0.12) / 0.28);
  if (e < 0.75) return mix([150, 140, 95], [120, 95, 70], (e - 0.4) / 0.35);
  return mix([120, 95, 70], [250, 250, 252], (e - 0.75) / 0.25);
}

const GEO_COLORS: Record<string, number[]> = {
  ocean: [40, 90, 160],
  basin: [205, 180, 120],
  shield: [70, 120, 80],
  mountain: [130, 95, 70],
  volcanic: [200, 70, 50],
};
function geoColor(c: Cell): number[] {
  return GEO_COLORS[c.geology] ?? [128, 128, 128];
}

// ---- 多边形栅格化 ----
function rasterize(colorOf: (c: Cell) => number[]): Uint8Array {
  const buf = new Uint8Array(W * H * 3);
  buf.fill(245);
  const sx = W / (bounds[2] - bounds[0]);
  const sy = H / (bounds[3] - bounds[1]);
  for (const cell of cells) {
    const poly = cell.polygon;
    if (!poly || poly.length < 3) continue;
    const col = colorOf(cell);
    const r = col[0] | 0;
    const g = col[1] | 0;
    const b = col[2] | 0;
    let minY = Infinity;
    let maxY = -Infinity;
    const px: number[] = [];
    const py: number[] = [];
    for (const [wx, wy] of poly) {
      const X = (wx - bounds[0]) * sx;
      const Y = (wy - bounds[1]) * sy;
      px.push(X);
      py.push(Y);
      if (Y < minY) minY = Y;
      if (Y > maxY) maxY = Y;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(H - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const yi = py[i];
        const yj = py[j];
        if (yi <= yc && yj > yc) {
          xs.push(px[i] + ((yc - yi) / (yj - yi)) * (px[j] - px[i]));
        } else if (yj <= yc && yi > yc) {
          xs.push(px[j] + ((yc - yj) / (yi - yj)) * (px[i] - px[j]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k]));
        const xb = Math.min(W - 1, Math.round(xs[k + 1]));
        for (let x = xa; x <= xb; x++) {
          const o = (y * W + x) * 3;
          buf[o] = r;
          buf[o + 1] = g;
          buf[o + 2] = b;
        }
      }
    }
  }
  return buf;
}

// ---- 最小 PNG 编码（RGB, filter 0）----
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c >>> 0;
  }
  return tbl;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBuf = Buffer.from(type, "ascii");
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBuf, 4);
  out.set(data, 8);
  const crc = crc32(Uint8Array.from([...typeBuf, ...data]));
  dv.setUint32(8 + data.length, crc);
  return out;
}
function encodePng(rgb: Uint8Array): Buffer {
  const raw = new Uint8Array(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
  }
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from(raw));
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

function landConnectedComponents(): number {
  const land = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    land[i] = cells[i].crustKind === "continental" && cells[i].height >= 0 ? 1 : 0;
  }
  const seen = new Uint8Array(cells.length);
  let comps = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!land[i] || seen[i]) continue;
    comps++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const cur = stack.pop() as number;
      for (const nb of cells[cur].neighbors) {
        if (land[nb] && !seen[nb]) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
  }
  return comps;
}

const tag = multi ? `${seed}_multi` : `${seed}`;
const terrainPng = `d:/TEST/NEW/preview_terrain_${tag}.png`;
const geoPng = `d:/TEST/NEW/preview_geology_${tag}.png`;
writeFileSync(terrainPng, encodePng(rasterize(terrainColor)));
writeFileSync(geoPng, encodePng(rasterize(geoColor)));

const counts: Record<string, number> = {};
for (const c of cells) counts[c.geology] = (counts[c.geology] || 0) + 1;
const bkm: Record<string, number> = {};
for (const b of t.boundaries) bkm[b.kind] = (bkm[b.kind] || 0) + 1;
const marginKm: Record<string, number> = {};
for (const b of t.boundaries) {
  if (b.kind === "convergent") marginKm[b.marginType] = (marginKm[b.marginType] || 0) + 1;
}

let orogenCells = 0;
let landRiftCells = 0;
let landDepCells = 0;
let iceRiftCells = 0;
let landN = 0;
let shieldLand = 0;
let volcLand = 0;
let seaIslands = 0;
let coastCells = 0;
for (const c of cells) {
  if (t.orogenField[c.id] > 0.22) orogenCells++;
  if (t.riftField[c.id] > 0.18 && c.crustKind === "continental") landRiftCells++;
  if (c.crustKind === "continental" && c.height < 0) {
    landDepCells++;
    if (c.fillKind === "ice") iceRiftCells++;
  }
  if (c.height >= 0) {
    landN++;
    if (c.geology === "shield") shieldLand++;
    if (c.geology === "volcanic") volcLand++;
    if (c.crustKind === "oceanic") seaIslands++;
    let coast = false;
    for (const nb of c.neighbors) {
      if (isOceanCell(cells[nb]) || cells[nb].height < 0) {
        coast = true;
        break;
      }
    }
    if (coast) coastCells++;
  }
}
const coastFractal = coastCells / Math.sqrt(landN || 1);
const landComps = landConnectedComponents();

console.log("wrote", terrainPng, geoPng);
console.log("mode", multi ? "multi-continent" : "single");
console.log("geology", JSON.stringify(counts));
console.log("boundaries", JSON.stringify(bkm));
console.log("convergent_margin", JSON.stringify(marginKm));
console.log(
  "tectonic",
  JSON.stringify({
    orogenCells,
    orogenFrac: (orogenCells / cells.length).toFixed(4),
    landRiftCells,
    landRiftPolylines: t.landRifts?.length ?? 0,
    landDepCells,
    iceRiftCells,
    landComponents: landComps,
  })
);
console.log(
  "land",
  landN,
  "shield%",
  ((shieldLand / Math.max(1, landN)) * 100).toFixed(1),
  "volc%",
  ((volcLand / Math.max(1, landN)) * 100).toFixed(1),
  "seaIslands",
  seaIslands,
  "coastFractal",
  coastFractal.toFixed(2)
);
