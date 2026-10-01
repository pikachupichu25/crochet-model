// Aggregate metrics for one output of a run, and the Markdown tables that
// `eval run`, `eval report` and `eval compare` print.

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
  /** Instruction rows the translator kept in its output, over all it found. */
  rowsKept?: number;
  translatorErrors: number;
  msPerItem: number;
  /** LLM runs. */
  costUsd?: number;
  requestsPerItem?: number;
  questions?: { asked: number; answered: number };
  /** Set on a clean summary: the suspect-gold items it leaves out (suspect.ts). */
  excludedSuspect?: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

export function summarise(dataset: string, output: string, records: ItemRecord[]): Summary {
  const scored = records.filter((r) => r.gold?.ok !== false);
  const scores = scored.map((r) => r.scores[output]!);
  const counts = scores.flatMap((s) => (s.counts && s.counts.checked > 0 ? [s.counts] : []));
  const structures = scores.flatMap((s) => (s.structure ? [s.structure] : []));
  const chrFs = scores.flatMap((s) => (s.chrF === undefined ? [] : [s.chrF]));
  const found = scored.reduce((n, r) => n + r.rows.found, 0);
  const kept = scored.reduce((n, r) => n + r.rows.kept, 0);
  // "rules-compiled" keeps rows it cannot read as comments, so it has no kept count.
  const hasRows = output !== "rules-compiled" && found > 0;
  const llm = scored.flatMap((r) => (r.llm ? [r.llm] : []));
  const costs = llm.map((l) => l.costUsd);
  const questions = llm.flatMap((l) => l.questions);
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
    rowsKept: hasRows ? kept / found : undefined,
    translatorErrors: scored.filter((r) => r.error).length,
    msPerItem: Math.round(mean(records.map((r) => r.ms)) ?? 0),
    ...(llm.length
      ? {
          costUsd: costs.every((c) => c !== undefined) ? costs.reduce((a, b) => a! + b!, 0) : undefined,
          requestsPerItem: mean(llm.map((l) => l.requests)),
          questions: { asked: questions.length, answered: questions.filter((q) => q.correct !== undefined).length },
        }
      : {}),
  };
}

const pct = (x: number | undefined) => (x === undefined ? "–" : `${(100 * x).toFixed(1)}%`);

export function markdownTable(summaries: Summary[]): string {
  const head = [
    "Dataset",
    "Output",
    "Items",
    "Gold fails",
    "Parses",
    "Count match (n)",
    "Structure exact",
    "Structure partial",
    "chrF",
    "Rows kept",
    "Questions (answered)",
    "Cost",
  ];
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const s of summaries) {
    lines.push(
      `| ${[
        s.dataset,
        s.output,
        s.items,
        s.goldFailures,
        pct(s.parses / s.scored),
        s.countItems ? `${pct(s.countMatch)} (${s.countItems})` : "–",
        pct(s.structureExact),
        pct(s.structureScore),
        s.chrF === undefined ? "–" : s.chrF.toFixed(1),
        pct(s.rowsKept),
        s.questions ? `${s.questions.asked} (${s.questions.answered})` : "–",
        s.costUsd === undefined ? "–" : `$${s.costUsd.toFixed(2)}`,
      ].join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Items whose result changed between two runs of the same dataset: parse,
 * exact structure match, or partial structure score by more than 0.1.
 */
export function itemChanges(
  a: { output: string; records: ItemRecord[] },
  b: { output: string; records: ItemRecord[] },
): string[] {
  const before = new Map(a.records.map((r) => [r.id, r.scores[a.output]]));
  const lines: string[] = [];
  for (const r of b.records) {
    const was = before.get(r.id);
    const now = r.scores[b.output];
    if (!was || !now) continue;
    const parts: string[] = [];
    if (was.parses !== now.parses) parts.push(`parses ${was.parses} → ${now.parses}`);
    if (was.structure && now.structure) {
      if (was.structure.exact !== now.structure.exact) parts.push(`exact ${was.structure.exact} → ${now.structure.exact}`);
      else if (Math.abs(was.structure.score - now.structure.score) > 0.1)
        parts.push(`partial ${was.structure.score.toFixed(2)} → ${now.structure.score.toFixed(2)}`);
    }
    if (parts.length) lines.push(`- ${r.id}: ${parts.join(", ")}`);
  }
  return lines;
}
