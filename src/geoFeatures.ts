import type { TerrainParams } from "./types";
import { seededRandom } from "./voronoi";

// ---------------------------------------------------------------------------
// 无板块构造时的后备地质特征源（高原/山脉/盆地）
// 有 tectonicState 时由 geologyFromTectonics 驱动，此处不生成
// ---------------------------------------------------------------------------

export type FeatureKind = "plateau" | "mountain" | "basin";

export interface GeoFeature {
  kind: FeatureKind;
  cx: number;
  cy: number;
  /** 强度：正=抬升，负=下陷 */
  strength: number;
  radius: number;
}

const W = 2000;
const H = 2000;

function scatterFeatures(
  count: number,
  minSpacing: number,
  rand: () => number,
  builder: (i: number) => { kind: FeatureKind; strength: number; radius: number }
): GeoFeature[] {
  const out: GeoFeature[] = [];
  let attempts = 0;
  const maxAttempts = Math.max(50, count * 200);
  while (out.length < count && attempts < maxAttempts) {
    attempts++;
    const cx = 60 + rand() * (W - 120);
    const cy = 60 + rand() * (H - 120);
    let ok = true;
    for (const f of out) {
      if (Math.hypot(f.cx - cx, f.cy - cy) < minSpacing) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const partial = builder(out.length);
    out.push({ kind: partial.kind, cx, cy, strength: partial.strength, radius: partial.radius });
  }
  return out;
}

/** 后备：无板块时的高斯特征源 */
export function generateGeoFeatures(params: TerrainParams): GeoFeature[] {
  const { decay, seed, continentCount, mountainCount, basinCount } = params;
  const rand = seededRandom(seed);
  const baseR = 260 * (1 - 0.6 * decay);

  const plateaus = scatterFeatures(continentCount, baseR * 0.5, rand, (i) => ({
    kind: "plateau" as const,
    strength: Math.pow(0.72, i),
    radius: baseR * (0.7 + 0.6 * rand()),
  }));

  const mountains = scatterFeatures(mountainCount, baseR * 0.4, rand, () => ({
    kind: "mountain" as const,
    strength: 0.55 + 0.35 * rand(),
    radius: baseR * (0.28 + 0.12 * rand()),
  }));

  const basins = scatterFeatures(basinCount, baseR * 0.45, rand, () => ({
    kind: "basin" as const,
    strength: -(0.28 + 0.2 * rand()),
    radius: baseR * (0.32 + 0.12 * rand()),
  }));

  return [...plateaus, ...mountains, ...basins];
}

export function featureContribution(f: GeoFeature, x: number, y: number): number {
  const dx = x - f.cx;
  const dy = y - f.cy;
  const d2 = dx * dx + dy * dy;
  return f.strength * Math.exp(-d2 / (2 * f.radius * f.radius));
}

export function contributionsAt(
  features: GeoFeature[],
  x: number,
  y: number
): Record<FeatureKind, number> {
  const c: Record<FeatureKind, number> = { plateau: 0, mountain: 0, basin: 0 };
  for (const f of features) {
    c[f.kind] += featureContribution(f, x, y);
  }
  return c;
}
