// Symbols for a laid-out stitch graph (docs/symbol/SPEC.md §4.5): every drawn
// stitch's glyph turned into polylines and dots in world space, with a quad to
// pick it by, plus what the overlays need: row labels, the yarn path and, in
// 3D, a surface. A pure function of the graph, the positions and the options.

import type { StitchGraph } from "../cp/graph.ts";
import { drawPlacement, type Fit, type Oval } from "./draw.ts";
import { CROSS_HALF_HEIGHT, CROSS_HALF_WIDTH, glyphFor } from "./glyphs.ts";
import { CLEARANCE, OverlapIndex } from "./overlap.ts";
import { legendKeys } from "./legend.ts";
import { placeStitches, yarnUnit, type StitchPlacement } from "./legs.ts";
import { baseType, typeParts } from "./stitchTypes.ts";
import { buildSurface, type Surface } from "./surface.ts";
import { add, distance, dot, normalize, scale, sub, type Vec3 } from "./vec.ts";

/** "rows" alternates two inks by row parity (SYM-FR-4.4). */
export type SymbolColorMode = "ink" | "yarn" | "type" | "rows";

/** How far 3D symbols, labels and the yarn path sit off the fabric, in units (SPEC §5.4). */
const LIFT = 0.15;

export interface SymbolOptions {
  colorMode: SymbolColorMode;
}

export interface PlacedGlyph {
  stitchId: string;
  /** Statement uid: the legend counts statements, so a sc2inc counts once. */
  statement: number;
  /** The legend entry: "sc", "sc2inc", "dc2tog", "picot3", … */
  key: string;
  /** What the colour mode resolves against: "ink", a COLOR: name ("" for none), a base type, or "row0" / "row1". */
  colorKey: string;
  /** Polylines in world space. */
  lines: Vec3[][];
  dots: { at: Vec3; radius: number }[];
  /** A quad covering the glyph in its frame plane, for picking. */
  hit: [Vec3, Vec3, Vec3, Vec3];
  /** The glyph's normal. */
  out: Vec3;
  fallback: boolean;
}

export interface SymbolScene {
  dimension: 2 | 3;
  unit: number;
  /** One per drawn stitch, in working order. */
  glyphs: PlacedGlyph[];
  /** Where each row's number goes: just before its first stitch (SYM-FR-4.6). */
  rowLabels: { row: number; at: Vec3; out: Vec3 }[];
  /** The yarn from stitch to stitch, one polyline per unbroken run (SYM-FR-4.6). */
  yarnPath: Vec3[][];
  /** 3D only: a surface under the symbols (SYM-FR-3.8). */
  surface?: Surface;
  bounds: { min: Vec3; max: Vec3 };
}

export function buildSymbolScene(
  graph: StitchGraph,
  positions: Record<string, number[]>,
  dimension: 2 | 3,
  options: SymbolOptions,
): SymbolScene {
  const unit = yarnUnit(graph, positions);
  const placements = placeStitches(graph, positions, unit, dimension);
  const keys = legendKeys(placements);
  const lift = dimension === 3 ? LIFT * unit : 0;
  const fits = fitSymbols(placements, positions, unit);
  const glyphs = placements.map((p, i) => {
    const drawn = drawPlacement(p, unit, lift, fits[i]);
    return { stitchId: p.stitch.id, statement: p.stitch.statement, key: keys[i]!, colorKey: colorKey(p, options.colorMode), ...drawn };
  });
  return {
    dimension,
    unit,
    glyphs,
    rowLabels: rowLabels(placements, unit, lift),
    yarnPath: yarnPath(placements, graph, lift),
    surface: dimension === 3 ? buildSurface(placements, positions, unit) : undefined,
    bounds: boundsOf(glyphs),
  };
}

/** Shrink steps for crowded symbols, and how far they may shrink (ISSUE-004). */
const SHRINK = 0.85;
const MIN_SCALE = 0.6;
/** Extra room between the crosses of an increase, in units. */
const CROSS_MARGIN = 0.05;

/**
 * How each symbol is drawn so it stays clear of the others (ISSUE-004):
 * legs clear the chain ovals they start from, an increase's × moves up its
 * arm, and symbols that still overlap shrink step by step down to
 * MIN_SCALE. Where the layout packs stitches tighter than that, they still
 * overlap: the layout is never changed (SYM-FR-3.9).
 */
function fitSymbols(placements: StitchPlacement[], positions: Record<string, number[]>, unit: number): Fit[] {
  const scales = placements.map(() => 1);
  const chainOval = glyphFor("ch").top[0];
  const [rx, ry] = chainOval?.kind === "ellipse" ? [chainOval.rx, chainOval.ry] : [0.42, 0.18];
  const index = new Map(placements.map((p, i) => [p.stitch.id, i]));
  const ovals = (id: string): Oval | undefined => {
    const i = index.get(id);
    if (i === undefined) return undefined;
    const p = placements[i]!;
    const k = scales[i]!;
    return { centre: p.top, along: p.frame.along, up: p.frame.up, rx: rx * unit * k, ry: ry * unit * k };
  };
  const fitOf = (i: number): Fit => ({ scale: scales[i], mid: crossMid(placements, i, unit, scales[i]!), ovals });

  // Legs that clear each chain: redrawn when that chain's oval shrinks.
  const clearing = new Map<number, number[]>();
  placements.forEach((p, i) => {
    for (const id of p.legs.flatMap((l) => l.clear)) {
      const c = index.get(id);
      if (c !== undefined) clearing.set(c, [...(clearing.get(c) ?? []), i]);
    }
  });

  const fits = placements.map((_, i) => fitOf(i));
  // Unlifted, so shared nodes are where the layout put them.
  const drawn = placements.map((p, i) => drawPlacement(p, unit, 0, fits[i]));
  const overlaps = new OverlapIndex(drawn, placements, positions, unit);
  let pairs = overlaps.pairs();
  for (;;) {
    const crowded = new Set(pairs.flat().filter((i) => scales[i]! > MIN_SCALE));
    if (!crowded.size) break;
    const changed = new Set<number>();
    for (const i of crowded) {
      scales[i] = Math.max(MIN_SCALE, scales[i]! * SHRINK);
      changed.add(i);
      for (const j of clearing.get(i) ?? []) changed.add(j);
    }
    for (const i of changed) {
      fits[i] = fitOf(i);
      drawn[i] = drawPlacement(placements[i]!, unit, 0, fits[i]);
      overlaps.set(i, drawn[i]);
    }
    // Pairs between unchanged symbols stand; the changed ones are checked again.
    const again = pairs.filter(([i, j]) => !changed.has(i) && !changed.has(j));
    for (const i of changed) for (const j of overlaps.overlapsOf(i)) if (!changed.has(j) || j > i) again.push([Math.min(i, j), Math.max(i, j)]);
    pairs = again;
  }

  // Still overlapping at the smallest size: try a few other places for the
  // parts that may move (an sc's × along its leg, a slip-stitch dot around
  // its node) and keep the first that touches nothing.
  for (const i of new Set(pairs.flat())) {
    for (const candidate of alternatives(placements[i]!, fits[i]!, unit)) {
      const tried = drawPlacement(placements[i]!, unit, 0, candidate);
      if (overlaps.overlapsOf(i, tried).length) continue;
      fits[i] = candidate;
      overlaps.set(i, tried);
      break;
    }
  }
  return fits;
}

/** Other fits to try for a symbol that still overlaps. */
function alternatives(p: StitchPlacement, fit: Fit, unit: number): Fit[] {
  if (typeParts(p.stitch.type).base === "sc" && p.legs.length === 1) {
    return [0.65, 0.35, 0.75, 0.3, 0.8].map((mid) => ({ ...fit, mid }));
  }
  if (!p.legs.length && glyphFor(p.stitch.type).dots.length) {
    const { along, up } = p.frame;
    const out: Fit[] = [];
    for (const d of [0.15, 0.25, 0.35])
      for (const dir of [up, scale(up, -1), along, scale(along, -1)]) out.push({ ...fit, offset: scale(dir, d * unit) });
    return out;
  }
  return [];
}

/**
 * Where an sc's × sits on its leg. Alone, half way up. In an increase, its
 * legs share a foot, so the × moves up to where it is a × width (plus
 * clearance) from its nearest sibling, but not past the top.
 */
function crossMid(placements: StitchPlacement[], i: number, unit: number, scale: number): number {
  const p = placements[i]!;
  if (typeParts(p.stitch.type).base !== "sc" || p.legs.length !== 1) return 0.5;
  const leg = p.legs[0]!;
  const length = distance(leg.foot, leg.top);
  const dir = normalize(sub(leg.top, leg.foot));
  if (!dir || length < 1e-9) return 0.5;
  let angle = Math.PI;
  for (const q of [placements[i - 1], placements[i + 1]]) {
    const other = q?.legs.length === 1 ? q.legs[0]! : undefined;
    if (!other || other.footNode !== leg.footNode) continue;
    const d = normalize(sub(other.top, other.foot));
    if (d) angle = Math.min(angle, Math.acos(Math.max(-1, Math.min(1, dot(dir, d)))));
  }
  if (angle >= Math.PI) return 0.5;
  // Each × turns with its arm, so its inner corner reaches w cos + h sin of half the angle sideways.
  const half = Math.max(angle, 1e-3) / 2;
  const reach = CROSS_HALF_WIDTH * Math.cos(half) + CROSS_HALF_HEIGHT * Math.sin(half);
  // A little more than touching distance: the formula treats each × as a box.
  const needed = (2 * reach * scale + CLEARANCE + CROSS_MARGIN) * unit;
  const along = needed / (2 * Math.sin(half));
  const highest = 1 - ((CROSS_HALF_HEIGHT * scale + 0.05) * unit) / length;
  return Math.max(0.5, Math.min(along / length, highest));
}

function colorKey(p: StitchPlacement, mode: SymbolColorMode): string {
  switch (mode) {
    case "ink":
      return "ink";
    case "yarn":
      return p.stitch.color ?? "";
    case "type":
      return baseType(p.stitch.type);
    case "rows":
      return `row${p.stitch.row % 2}`;
  }
}

/** Each row's label sits a unit before its first stitch, against the working direction. */
function rowLabels(placements: StitchPlacement[], unit: number, lift: number): SymbolScene["rowLabels"] {
  const seen = new Set<number>();
  const labels: SymbolScene["rowLabels"] = [];
  for (const p of placements) {
    if (seen.has(p.stitch.row) || p.stitch.type === "ring") continue;
    seen.add(p.stitch.row);
    const at = add(add(p.top, scale(p.frame.along, -unit)), scale(p.frame.out, lift));
    labels.push({ row: p.stitch.row, at, out: p.frame.out });
  }
  return labels;
}

/** Tops in working order, broken wherever no yarn joins one stitch to the next. */
function yarnPath(placements: StitchPlacement[], graph: StitchGraph, lift: number): Vec3[][] {
  const yarn = new Set(graph.edges.filter((e) => e.kind === "yarn").map((e) => `${e.tail}\n${e.head}`));
  const runs: Vec3[][] = [];
  let run: Vec3[] = [];
  placements.forEach((p, i) => {
    const prev = placements[i - 1];
    if (!prev || !yarn.has(`${prev.stitch.id}\n${p.stitch.id}`)) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    run.push(add(p.top, scale(p.frame.out, lift)));
  });
  if (run.length > 1) runs.push(run);
  return runs;
}

function boundsOf(glyphs: PlacedGlyph[]): SymbolScene["bounds"] {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const take = (p: Vec3) => {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  };
  for (const g of glyphs) {
    for (const line of g.lines) line.forEach(take);
    for (const d of g.dots) take(d.at);
  }
  if (!glyphs.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
