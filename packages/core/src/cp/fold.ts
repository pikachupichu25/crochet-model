// Fold detection and seed retry for 2D layouts.
//
// CrochetPARADE's solver starts from random positions and relaxes springs.
// In 2D an unlucky seed can leave part of the fabric mirrored: the two parts
// overlap and pinch together, and no spring force can flip one back. The
// solver does not notice; upstream's advice is to try another `DOT: start=`.
//
// A folded layout shows up as edges crossing each other. Flat fabric crosses
// a few edges where several stitches fan out of one base (about 1% for the
// baby blanket); the blanket folded by seed 0 crosses 20%.

import type { LayoutProgress, LayoutResult, Solver, SolverSettings } from "./layout.ts";
import { buildSolverInput, readSeed } from "./layout.ts";

export interface CrossingCount {
  /** Edges with both ends laid out. */
  edges: number;
  /** Pairs of edges, sharing no node, that cross. */
  crossings: number;
}

/** Above this share of crossings per edge, a 2D layout counts as folded. */
export const FOLD_CROSSING_RATIO = 0.05;

/** Seeds tried in all, the first included, before keeping the best layout. */
export const DEFAULT_MAX_SEEDS = 5;

const EDGE = /^"([^"]+)" -- "([^"]+)"/gm;

/** Counts crossing edge pairs of a 2D layout. Uses a grid, so it is near-linear. */
export function countEdgeCrossings(
  simpleDot: string,
  positions: Record<string, number[]>,
): CrossingCount {
  const segments: [number, number, number, number, string, string][] = [];
  for (const m of simpleDot.matchAll(EDGE)) {
    const a = positions[m[1]!];
    const b = positions[m[2]!];
    if (a && b) segments.push([a[0]!, a[1]!, b[0]!, b[1]!, m[1]!, m[2]!]);
  }
  if (segments.length < 2) return { edges: segments.length, crossings: 0 };

  // Cells about one median edge long; long edges span several.
  const lengths = segments.map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0)).sort((p, q) => p - q);
  const cell = lengths[lengths.length >> 1]! || 1;
  const grid = new Map<string, number[]>();
  const cellsOf = segments.map(([x0, y0, x1, y1], i) => {
    const keys: string[] = [];
    for (let cx = Math.floor(Math.min(x0, x1) / cell); cx <= Math.floor(Math.max(x0, x1) / cell); cx++) {
      for (let cy = Math.floor(Math.min(y0, y1) / cell); cy <= Math.floor(Math.max(y0, y1) / cell); cy++) {
        const key = `${cx},${cy}`;
        keys.push(key);
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(i);
      }
    }
    return keys;
  });

  const seen = new Int32Array(segments.length).fill(-1);
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    const [ax, ay, bx, by, an, bn] = segments[i]!;
    for (const key of cellsOf[i]!) {
      for (const j of grid.get(key)!) {
        if (j <= i || seen[j] === i) continue;
        seen[j] = i;
        const [cx, cy, dx, dy, cn, dn] = segments[j]!;
        if (an === cn || an === dn || bn === cn || bn === dn) continue;
        const o1 = orient(ax, ay, bx, by, cx, cy);
        const o2 = orient(ax, ay, bx, by, dx, dy);
        const o3 = orient(cx, cy, dx, dy, ax, ay);
        const o4 = orient(cx, cy, dx, dy, bx, by);
        if (o1 * o2 < 0 && o3 * o4 < 0) crossings++;
      }
    }
  }
  return { edges: segments.length, crossings };
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export function isFolded({ edges, crossings }: CrossingCount): boolean {
  return edges > 0 && crossings / edges > FOLD_CROSSING_RATIO;
}

export interface FoldCheck extends CrossingCount {
  folded: boolean;
  /** Seeds laid out, in order. The result used the one with fewest crossings. */
  seedsTried: number[];
}

export interface UnfoldedLayoutResult extends LayoutResult {
  /** Present for 2D layouts. */
  fold?: FoldCheck;
}

export interface UnfoldOptions {
  /** Default DEFAULT_MAX_SEEDS. 1 turns retrying off. */
  maxSeeds?: number;
  /** Called before each retry, with the seed about to be tried. */
  onRetry?(seed: number, previous: FoldCheck): void;
}

/**
 * Lays out, and in 2D, while the layout is folded, retries with the next
 * seeds (the pattern's or the given seed, plus 1, 2, …). Keeps the layout
 * with the fewest crossings. 3D layouts are returned as they are: an
 * inside-out 3D model does not show up as crossings.
 */
export function layoutUnfolded(
  solver: Solver,
  simpleDot: string,
  settings: SolverSettings = {},
  onProgress?: (progress: LayoutProgress) => void,
  { maxSeeds = DEFAULT_MAX_SEEDS, onRetry }: UnfoldOptions = {},
): UnfoldedLayoutResult {
  const first = solver.layout(simpleDot, settings, onProgress);
  if (first.dimension !== 2) return first;

  const firstSeed = readSeed(buildSolverInput(simpleDot, settings));
  let best = first;
  let bestCount = countEdgeCrossings(simpleDot, first.positions);
  const seedsTried = [first.seed];
  let ms = first.ms;
  for (let n = 1; n < maxSeeds && isFolded(bestCount); n++) {
    const seed = firstSeed + n;
    onRetry?.(seed, { ...bestCount, folded: true, seedsTried: [...seedsTried] });
    const next = solver.layout(simpleDot, { ...settings, seed }, onProgress);
    seedsTried.push(seed);
    ms += next.ms;
    const count = countEdgeCrossings(simpleDot, next.positions);
    if (count.crossings < bestCount.crossings) {
      best = next;
      bestCount = count;
    }
  }
  return { ...best, ms, fold: { ...bestCount, folded: isFolded(bestCount), seedsTried } };
}
