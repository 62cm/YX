import { generateVoronoi } from "../src/voronoi";
import { DEFAULT_VORONOI, DEFAULT_TERRAIN, DEFAULT_CLOUD } from "../src/types";
import { coEvolveTectonics, orogenAmplifier, riftAmplifier, effectiveContinentCount } from "../src/tectonicLoop";
import { buildContinentalCrustField, evolveCrustTerrain } from "../src/crustEvolution";
import { generateGeologicalStructures } from "../src/geologyFromTectonics";
import { assignHeights } from "../src/terrain";
import { computeElements } from "../src/elements";
import { computeSurfaceClimate } from "../src/surface";
import { initClimateFields, warmupClimate, buildMeteoFields, tickClimateStep } from "../src/climate";
import { insolationTopAt, latitudeRad, solarDeclinationRad } from "../src/surface";

const seed = Number(process.argv[2] ?? 42);
const bounds: [number, number, number, number] = [0, 0, 1000, 1000];
const p = { ...DEFAULT_TERRAIN, seed };
const cells = generateVoronoi({ ...DEFAULT_VORONOI, seed });
let tectonic = coEvolveTectonics(cells, {
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

const continentalCrust = buildContinentalCrustField(cells, tectonic, p);
tectonic = generateGeologicalStructures(cells, tectonic, { seed, orogenAmp: tectonic.orogenAmp, riftAmp: tectonic.riftAmp }, continentalCrust);
const crustState = evolveCrustTerrain(cells, tectonic, continentalCrust, p);
assignHeights(cells, p, [], tectonic, bounds, crustState);
computeElements(cells, seed, [], p.veinDensity, tectonic);
computeSurfaceClimate(cells, bounds, p.maxHeight);
initClimateFields(cells, bounds, DEFAULT_CLOUD, 0, seed);

function stats(label: string) {
  let tLo = Infinity, tHi = -Infinity, pLo = Infinity, pHi = -Infinity;
  let cwLo = Infinity, cwHi = -Infinity, iLo = Infinity, iHi = -Infinity;
  let land = 0;
  for (const c of cells) {
    if (c.height < 0) continue;
    land++;
    tLo = Math.min(tLo, c.temperature);
    tHi = Math.max(tHi, c.temperature);
    pLo = Math.min(pLo, c.pressure);
    pHi = Math.max(pHi, c.pressure);
    cwLo = Math.min(cwLo, c.cloudWater);
    cwHi = Math.max(cwHi, c.cloudWater);
    iLo = Math.min(iLo, c.insolationTop);
    iHi = Math.max(iHi, c.insolationTop);
  }
  process.stdout.write(
    `${label}: land=${land} T=${tLo.toFixed(1)}~${tHi.toFixed(1)} P=${pLo.toFixed(1)}~${pHi.toFixed(1)} cw=${cwLo.toFixed(3)}~${cwHi.toFixed(3)} insolTop=${iLo.toFixed(3)}~${iHi.toFixed(3)}\n`
  );
}

stats("init");

const day0 = 0;
const day180 = 180;
warmupClimate(cells, bounds, DEFAULT_CLOUD, day180, seed);
buildMeteoFields(cells, bounds, DEFAULT_CLOUD, day180);
stats("warmup180d");

warmupClimate(cells, bounds, DEFAULT_CLOUD, 185, seed);
buildMeteoFields(cells, bounds, DEFAULT_CLOUD, 365);
stats("warmup365d");

const mid = cells.find((c) => c.height >= 0)!;
const latR = latitudeRad(mid.site[1], bounds);
const insolSummer = insolationTopAt(latR, solarDeclinationRad(80));
const insolWinter = insolationTopAt(latR, solarDeclinationRad(260));
process.stdout.write(`insol seasonal spread at sample lat: ${insolWinter.toFixed(3)} -> ${insolSummer.toFixed(3)}\n`);

tickClimateStep(cells, 30, { bounds, day: 365, cloud: DEFAULT_CLOUD, worldSeed: seed });
stats("after +30d tick");
