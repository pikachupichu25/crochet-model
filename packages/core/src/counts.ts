// Does a translated row make the count the English states? (FR-2.4)
//
// The parser counts every stitch on a line, chains included; patterns
// usually do not count a beginning or turning chain, or count a chain of 2 or
// more as one stitch ("ch 3 counts as dc"). So a line that starts with L
// chains and makes T stitches in all matches a stated count of T − L, or
// T − L + 1 when L ≥ 2. A single chain is never taken as a stitch: allowing
// that would hide an off-by-one in every "ch 1, …" row.

import { parseStitchGraph, type StitchGraph } from "./cp/graph.ts";
import type { ValidationResult } from "./cp/validator.ts";

export interface CountCheck {
  /** The parser's count for the last line. */
  parsed: number;
  /** Chains at the start of the line. */
  leading: number;
  /** The counts that would match a stated count. */
  accepted: number[];
}

/**
 * The count check for the last parser row of a valid result. The graph is
 * parsed from `graphJson` unless given (the browser's parser worker sends the
 * graph instead).
 */
export function lastRowCount(result: ValidationResult, graph?: StitchGraph): CountCheck | undefined {
  if (!result.ok || result.rows.length === 0) return undefined;
  const last = result.rows[result.rows.length - 1]!;
  const stitches = (graph ?? parseStitchGraph(result.graphJson!))
    .stitches.filter((s) => s.row === last.row)
    .sort((a, b) => a.index - b.index);
  let leading = 0;
  while (stitches[leading]?.type === "ch") leading += 1;
  if (leading === stitches.length) leading = 0; // a line of chains only
  const total = last.stitches;
  const accepted =
    leading === 0 ? [total] : leading === 1 ? [total - 1] : [total - leading, total - leading + 1];
  return { parsed: total, leading, accepted };
}

export function countMatches(check: CountCheck | undefined, stated: number | undefined): boolean {
  if (stated === undefined) return true;
  return !!check && check.accepted.includes(stated);
}
