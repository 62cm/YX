import { generateVoronoi } from "../src/voronoi.ts";
import {
  coEvolveTectonics,
  orogenAmplifier,
  riftAmplifier,
  effectiveContinentCount,
} from "../src/tectonicLoop.ts";
import { buildContinentalCrustField } from "../src/crustEvolution.ts";
import { generateGeologicalStructures } from "../src/geologyFromTectonics.ts";
import { DEFAULT_TERRAIN, DEFAULT_VORONOI } from "../src/types.ts";

const seed = Number(process.argv[2] ?? 42);
const bounds: [number, number, number, number] = [0, 0, 1000, 1000];
const p = { ...DEFAULT_TERRAIN, seed };
const cells = generateVoronoi({ ...DEFAULT_VORONOI, cellCount: 9000, seed });
let t = coEvolveTectonics(cells, {
  seed,
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
  { seed, orogenAmp: t.orogenAmp, riftAmp: t.riftAmp },
  cc
);

const onLand = (line: { cells: number[] }) =>
  line.cells.some((i) => t.continental[i] === 1);
const edgeAligned = (line: { points: [number, number][] }) => {
  const m = 35;
  const pts = line.points;
  const edgeN = pts.filter(([x, y]) => x < m || x > 1000 - m || y < m || y > 1000 - m).length;
  return edgeN >= pts.length * 0.65;
};

const stats = {
  seed,
  orogenBelts: t.orogenBelts?.length ?? 0,
  mountainRidges: t.mountainRidges?.length ?? 0,
  oceanRidges: t.ridges.length,
  trenches: t.trenches.length,
  landRifts: t.landRifts?.length ?? 0,
  ridgesTouchingLand: t.ridges.filter(onLand).length,
  trenchesTouchingLand: t.trenches.filter(onLand).length,
  edgeAligned: {
    orogen: (t.orogenBelts ?? []).filter(edgeAligned).length,
    mountain: (t.mountainRidges ?? []).filter(edgeAligned).length,
    ridge: t.ridges.filter(edgeAligned).length,
    trench: t.trenches.filter(edgeAligned).length,
    landRift: (t.landRifts ?? []).filter(edgeAligned).length,
  },
};

process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
