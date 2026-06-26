import { generateGeoFeatures } from "../src/geoFeatures";
import { coEvolveTectonics } from "../src/tectonicLoop";
import { generateVoronoi } from "../src/voronoi";
import { assignHeights } from "../src/terrain";
import { computeElements } from "../src/elements";
import {
  DEFAULT_TERRAIN,
  DEFAULT_VORONOI,
  type GeologyKind,
} from "../src/types";

const base = { ...DEFAULT_TERRAIN, seed: 42 };
const config = { ...DEFAULT_VORONOI, cellCount: 800, seed: 42 };

function run(params: typeof base) {
  const cells = generateVoronoi(config);
  const tectonic = coEvolveTectonics(cells, {
    seed: params.seed,
    iterations: params.tectonicIterations,
    continentCount: params.continentCount,
    convergentBias: Math.min(1, 0.15 + params.mountainCount * 0.11),
    riftBias: Math.min(1, 0.12 + params.basinCount * 0.11),
    bounds: config.bounds,
  });
  const features = generateGeoFeatures(params, tectonic, cells);
  assignHeights(cells, params, features, tectonic);
  computeElements(cells, params.seed, features, params.veinDensity, tectonic);
  return { cells, tectonic };
}

function avgHeight(cells: { geology: GeologyKind; height: number }[], kind: GeologyKind) {
  const s = cells.filter((c) => c.geology === kind);
  if (s.length === 0) return 0;
  return s.reduce((a, c) => a + c.height, 0) / s.length;
}

const def = run(base);
const moreMountains = run({ ...base, mountainCount: 8 });
const moreBasins = run({ ...base, basinCount: 8 });

console.log("default mountain avg h:", avgHeight(def.cells, "mountain").toFixed(0));
console.log("default shield avg h:", avgHeight(def.cells, "shield").toFixed(0));
console.log("default basin avg h:", avgHeight(def.cells, "basin").toFixed(0));
console.log(
  "continents:",
  def.tectonic.plates.filter((p) => p.continental).length,
  "ocean plates:",
  def.tectonic.plates.filter((p) => !p.continental).length
);
console.log("8 convergent -> mountain cells:", moreMountains.cells.filter((c) => c.geology === "mountain").length);
console.log("3 convergent -> mountain cells:", def.cells.filter((c) => c.geology === "mountain").length);
console.log("8 rift -> basin cells:", moreBasins.cells.filter((c) => c.geology === "basin").length);

const mH = avgHeight(def.cells, "mountain");
const sH = avgHeight(def.cells, "shield");
const bH = avgHeight(def.cells, "basin");

if (mH <= sH + 80) throw new Error("mountains should be higher than shield on average");
if (bH >= sH - 30) throw new Error("basins should be lower than shield on average");
if (def.tectonic.ridges.length < 1) throw new Error("should extract at least one ridge polyline");
if (moreMountains.cells.filter((c) => c.geology === "mountain").length <= def.cells.filter((c) => c.geology === "mountain").length) {
  throw new Error("more convergent bias should increase mountain geology cells");
}

console.log("ALL CHECKS PASSED");
