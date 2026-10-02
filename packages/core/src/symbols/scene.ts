// Symbols for a laid-out stitch graph (docs/symbol/SPEC.md §4.5): every drawn
// stitch's glyph turned into polylines and dots in world space, with a quad to
// pick it by, plus what the overlays need: row labels, the yarn path and, in
// 3D, a surface. A pure function of the graph, the positions and the options.

import type { StitchGraph } from "../cp/graph.ts";
import { drawPlacement } from "./draw.ts";
import { legendKeys } from "./legend.ts";
import { placeStitches, yarnUnit, type StitchPlacement } from "./legs.ts";
import { baseType } from "./stitchTypes.ts";
import { buildSurface, type Surface } from "./surface.ts";
import { add, scale, type Vec3 } from "./vec.ts";

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
  const glyphs = placements.map((p, i) => {
    const drawn = drawPlacement(p, unit, lift);
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
