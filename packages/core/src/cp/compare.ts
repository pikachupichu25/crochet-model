// Structure match between two stitch graphs (docs/SPEC.md §7.3).
//
// Two translations match when they make the same fabric: row by row, the same
// stitch types in the same order, each worked into the same stitches. Label
// names, bracket style and repeat grouping vanish in the graph, so
// `[2sc,>,dc]*3` and `2sc,dc,2sc,dc,2sc` match.
//
// Stitches are compared by position, not by node name, because statement
// uids differ between texts that make the same graph. A position is
// (row, index) after dropping `hidden` top nodes (`start_anew` markers) and
// the rows left empty by that.

import type { StitchGraph } from "./graph.ts";

export interface StructureMatch {
  /** Same rows, same stitches, each worked into the same positions. */
  exact: boolean;
  /** Stitches equal to the gold stitch at the same position. */
  matched: number;
  goldStitches: number;
  outputStitches: number;
  /** matched / max(goldStitches, outputStitches); 1 when both are empty. */
  score: number;
  /** The first position that differs, for reports. */
  firstDifference?: {
    row: number;
    index: number;
    gold?: string;
    output?: string;
  };
}

/**
 * Each stitch as `type<position,position…` (what it is worked into), grouped
 * by row. Positions are `row,index` in this canonical numbering.
 */
export function canonicalRows(graph: StitchGraph): string[][] {
  const kept = graph.stitches
    .filter((s) => s.type !== "hidden")
    .sort((a, b) => a.row - b.row || a.index - b.index);

  const position = new Map<string, string>();
  const rows: { id: string; type: string; into: string[] }[][] = [];
  let lastRow: number | undefined;
  for (const s of kept) {
    if (s.row !== lastRow) {
      rows.push([]);
      lastRow = s.row;
    }
    const row = rows[rows.length - 1]!;
    position.set(s.id, `${rows.length - 1},${row.length}`);
    row.push({ id: s.id, type: s.type, into: s.workedInto });
  }

  return rows.map((row) =>
    row.map((s) => {
      // A stitch worked into a dropped hidden node keeps a marker for it.
      const into = s.into.map((id) => position.get(id) ?? "?").sort();
      return into.length ? `${s.type}<${into.join(" ")}` : s.type;
    }),
  );
}

export function compareStructure(gold: StitchGraph, output: StitchGraph): StructureMatch {
  const g = canonicalRows(gold);
  const o = canonicalRows(output);
  const goldStitches = g.reduce((n, r) => n + r.length, 0);
  const outputStitches = o.reduce((n, r) => n + r.length, 0);

  let matched = 0;
  let firstDifference: StructureMatch["firstDifference"];
  for (let row = 0; row < Math.max(g.length, o.length); row++) {
    const gr = g[row] ?? [];
    const or = o[row] ?? [];
    for (let index = 0; index < Math.max(gr.length, or.length); index++) {
      if (gr[index] !== undefined && gr[index] === or[index]) matched += 1;
      else firstDifference ??= { row, index, gold: gr[index], output: or[index] };
    }
  }

  const total = Math.max(goldStitches, outputStitches);
  return {
    exact: firstDifference === undefined,
    matched,
    goldStitches,
    outputStitches,
    score: total === 0 ? 1 : matched / total,
    firstDifference,
  };
}
