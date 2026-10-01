// Aggregate metrics for one output of a run, and the Markdown table that
// `eval run` and `eval report` print.

import type { ItemRecord } from "./run.ts";

export interface Summary {
  dataset: string;
  output: string;
  items: number;
  /** Items whose gold (or gold prefix) does not parse. They are left out of the rates below. */
  goldFailures: number;
  /** Items scored: those with a parsing gold, or no gold at all. */
  scored: number;
  nonEmpty: number;
  parses: number;
  /** Mean over scored items that have counts to check. */
  countMatch?: number;
  countItems: number;
  structureExact?: number;
  /** Mean partial structure score. */
  structureScore?: number;
  chrF?: number;
  /** Instruction rows the translator kept, over all it found (rule-based only). */
  rowsKept?: number;
  translatorErrors: number;
  msPerItem: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

export function summarise(dataset: string, output: string, records: ItemRecord[]): Summary {
  const scored = records.filter((r) => r.gold?.ok !== false);
  const scores = scored.map((r) => r.scores[output]!);
  const counts = scores.flatMap((s) => (s.counts && s.counts.checked > 0 ? [s.counts] : []));
  const structures = scores.flatMap((s) => (s.structure ? [s.structure] : []));
  const chrFs = scores.flatMap((s) => (s.chrF === undefined ? [] : [s.chrF]));
  const found = scored.reduce((n, r) => n + r.rules.instructions, 0);
  const kept = scored.reduce((n, r) => n + r.rules.instructionsIncluded, 0);
  return {
    dataset,
    output,
    items: records.length,
    goldFailures: records.length - scored.length,
    scored: scored.length,
    nonEmpty: scores.filter((s) => s.nonEmpty).length,
    parses: scores.filter((s) => s.parses).length,
    countMatch: mean(counts.map((c) => c.matched / c.checked)),
    countItems: counts.length,
    structureExact: structures.length
      ? structures.filter((s) => s.exact).length / structures.length
      : undefined,
    structureScore: mean(structures.map((s) => s.score)),
    chrF: mean(chrFs),
    rowsKept: output === "rules" && found ? kept / found : undefined,
    translatorErrors: records.filter((r) => r.rules.error).length,
    msPerItem: Math.round(mean(records.map((r) => r.ms)) ?? 0),
  };
}

const pct = (x: number | undefined) => (x === undefined ? "–" : `${(100 * x).toFixed(1)}%`);

export function markdownTable(summaries: Summary[]): string {
  const head = [
    "Dataset",
    "Output",
    "Items",
    "Gold fails",
    "Non-empty",
    "Parses",
    "Count match (n)",
    "Structure exact",
    "Structure partial",
    "chrF",
    "Rows kept",
  ];
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const s of summaries) {
    lines.push(
      `| ${[
        s.dataset,
        s.output,
        s.items,
        s.goldFailures,
        pct(s.nonEmpty / s.scored),
        pct(s.parses / s.scored),
        s.countItems ? `${pct(s.countMatch)} (${s.countItems})` : "–",
        pct(s.structureExact),
        pct(s.structureScore),
        s.chrF === undefined ? "–" : s.chrF.toFixed(1),
        pct(s.rowsKept),
      ].join(" | ")} |`,
    );
  }
  return lines.join("\n");
}
