// Symbols for a laid-out stitch graph (docs/symbol/SPEC.md §4.5): every drawn
// stitch's glyph turned into polylines and dots in world space, with a quad to
// pick it by. A pure function of the graph, the positions and the options.

import type { StitchGraph } from "../cp/graph.ts";
import { drawPlacement } from "./draw.ts";
import { legendKeys } from "./legend.ts";
import { placeStitches, yarnUnit } from "./legs.ts";
import { baseType } from "./stitchTypes.ts";
import type { Vec3 } from "./vec.ts";

export type SymbolColorMode = "ink" | "yarn" | "type";

export interface SymbolOptions {
  colorMode: SymbolColorMode;
}

export interface PlacedGlyph {
  stitchId: string;
  /** Statement uid: the legend counts statements, so a sc2inc counts once. */
  statement: number;
  /** The legend entry: "sc", "sc2inc", "dc2tog", "picot3", … */
  key: string;
  /** What the colour mode resolves against: "ink", a COLOR: name ("" for none), or a base type. */
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
  const glyphs = placements.map((p, i) => {
    const drawn = drawPlacement(p, unit);
    const colorKey =
      options.colorMode === "ink" ? "ink" : options.colorMode === "yarn" ? (p.stitch.color ?? "") : baseType(p.stitch.type);
    return { stitchId: p.stitch.id, statement: p.stitch.statement, key: keys[i]!, colorKey, ...drawn };
  });
  return { dimension, unit, glyphs, bounds: boundsOf(glyphs) };
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
