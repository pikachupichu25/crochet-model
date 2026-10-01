// Per-item metrics (docs/SPEC.md §7.3): parses, count match, structure match
// and chrF. Datasets with no gold get only the first two.

import {
  canonicalRows,
  compareStructure,
  parseStitchGraph,
  type ParseErrorKind,
  type StructureMatch,
  type ValidationResult,
} from "@crochet-model/core";
import { createNodeValidator } from "@crochet-model/core/node";
import { countMatches, lastRowCount } from "@crochet-model/translator";
import { chrF } from "./chrf.ts";
import type { EvalItem } from "./datasets.ts";
import { codeOnly } from "./rules.ts";

const { validate } = createNodeValidator();

export interface ItemScore {
  /** The output has at least one line the parser reads. */
  nonEmpty: boolean;
  /** Non-empty, and the parser accepts it (after the gold prefix, for step items). */
  parses: boolean;
  error?: { kind: ParseErrorKind; message: string };
  /** Rows checked for count match, and how many matched. */
  counts?: { checked: number; matched: number };
  structure?: Omit<StructureMatch, "firstDifference"> & {
    firstDifference?: StructureMatch["firstDifference"];
  };
  chrF?: number;
}

export interface GoldCheck {
  /** The gold CP (StitchSwitch) or gold prefix (CrochetBench step) parses. */
  ok: boolean;
  error?: string;
}

/**
 * Parses the gold once per item. A gold that does not parse is reported, not
 * dropped (SPEC §7.1); its item is scored without structure or counts.
 */
export function checkGold(item: EvalItem): GoldCheck | undefined {
  const gold = goldText(item);
  if (gold === undefined) return undefined;
  const r = validate(gold);
  return r.ok ? { ok: true } : { ok: false, error: r.error!.message };
}

function goldText(item: EvalItem): string | undefined {
  if (item.gold !== undefined) return item.gold;
  // Some step prompts leave every earlier DSL blank: nothing to check.
  const prefix = item.context?.map((c) => c.cp).filter((cp) => cp !== "") ?? [];
  return prefix.length ? prefix.join("\n") : undefined;
}

export function scoreItem(item: EvalItem, output: string): ItemScore {
  const code = codeOnly(output);
  const nonEmpty = code !== "";
  const prefix = item.context?.map((c) => c.cp).filter((cp) => cp !== "") ?? [];
  const text = [...prefix, code].join("\n");
  const result: ValidationResult | undefined = nonEmpty ? validate(text) : undefined;
  const score: ItemScore = { nonEmpty, parses: !!result?.ok };
  if (result && !result.ok) {
    score.error = { kind: result.error!.kind, message: result.error!.message };
  }

  if (item.gold !== undefined) {
    const gold = validate(item.gold);
    score.chrF = chrF(code, codeOnly(item.gold));
    if (gold.ok) {
      const matched = gold.rows.filter(
        (g) => result?.ok && result.rows[g.row]?.stitches === g.stitches,
      ).length;
      score.counts = { checked: gold.rows.length, matched };
      const goldGraph = parseStitchGraph(gold.graphJson!);
      score.structure = result?.ok
        ? compareStructure(goldGraph, parseStitchGraph(result.graphJson!))
        : {
            exact: false,
            matched: 0,
            goldStitches: canonicalRows(goldGraph).flat().length,
            outputStitches: 0,
            score: 0,
          };
    }
  } else if (item.statedCount !== undefined) {
    // The translator's rule: allow for a beginning chain the English does not count.
    const matched = !!result?.ok && countMatches(lastRowCount(result), item.statedCount);
    score.counts = { checked: 1, matched: matched ? 1 : 0 };
  }
  return score;
}
