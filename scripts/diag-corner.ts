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
import { DEFAULT_TERRAIN, DEFAULT_VORONOI } from "../src/types.ts";

const p = { ...DEFAULT_TERRAIN, seed: 42 };
const bounds: [number, number, number, number] = [0, 0, 1000, 1000];
const cells = generateVoronoi({ ...DEFAULT_VORONOI, seed: 42 });
let t = coEvolveTectonics(cells, {
  seed: 42,
  iterations: p.tectonicIterations,
  continentCount: effectiveContinentCount(p),
  convergentBias: 0.48,
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
  { seed: 42, orogenAmp: t.orogenAmp, riftAmp: t.riftAmp },
  cc
);
const cs = evolveCrustTerrain(cells, t, cc, p);
assignHeights(cells, p, [], t, bounds, cs);

function stats(label: string, subset: typeof cells) {
  const land = subset.filter((c) => c.height >= 0);
  const hs = land.map((c) => c.height).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)] ?? 0;
  const low = land.filter((c) => c.height < 500).length;
  console.log(
    label,
    "n=",
    subset.length,
    "land=",
    land.length,
    "medH=",
    med.toFixed(0),
    "low<500=",
    low,
    "shield=",
    land.filter((c) => c.geology === "shield").length
  );
}

stats("bottom-right x,y>780", cells.filter((c) => c.site[0] > 780 && c.site[1] > 780));
stats("bottom-right x,y>850", cells.filter((c) => c.site[0] > 850 && c.site[1] > 850));
stats("center", cells.filter((c) => c.site[0] > 400 && c.site[0] < 600 && c.site[1] > 400 && c.site[1] < 600));
stats("edge band <100km", cells.filter((c) => {
  const ed = Math.min(c.site[0], 1000 - c.site[0], c.site[1], 1000 - c.site[1]);
  return ed < 100;
}));

// continental degree before threshold - check BR low elevation in zKm pre-rank
const br = cells.filter((c) => c.site[0] > 800 && c.site[1] > 800);
for (const c of br.slice(0, 5)) {
  console.log(
    "cell",
    c.id,
    c.site.map((v) => v.toFixed(0)),
    "h=",
    c.height.toFixed(0),
    c.crustKind,
    c.geology,
    "orogen=",
    t.orogenField[c.id].toFixed(2),
    "rift=",
    t.riftField[c.id].toFixed(2)
  );
}

// oceanRing off comparison
{
  const cells2 = generateVoronoi({ ...DEFAULT_VORONOI, seed: 42 });
  const p2 = { ...p, oceanRing: false, landCentric: 0 };
  let t2 = coEvolveTectonics(cells2, {
    seed: 42,
    iterations: p2.tectonicIterations,
    continentCount: effectiveContinentCount(p2),
    convergentBias: 0.48,
    riftBias: 0.3,
    meshUniformity: p2.meshUniformity,
    orogenAmp: orogenAmplifier(p2.mountainCount),
    riftAmp: riftAmplifier(p2.basinCount),
    bounds,
    landCentric: p2.landCentric,
    singleContinent: p2.singleContinent,
    oceanRing: false,
    oceanRatio: p2.oceanRatio,
    decay: p2.decay,
  });
  const cc2 = buildContinentalCrustField(cells2, t2, p2);
  t2 = generateGeologicalStructures(cells2, t2, { seed: 42, orogenAmp: t2.orogenAmp, riftAmp: t2.riftAmp }, cc2);
  const cs2 = evolveCrustTerrain(cells2, t2, cc2, p2);
  assignHeights(cells2, p2, [], t2, bounds, cs2);
  stats("BR no ring lc=0", cells2.filter((c) => c.site[0] > 780 && c.site[1] > 780));
}
