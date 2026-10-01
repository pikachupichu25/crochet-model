// Request content (docs/SPEC.md §5.2–5.3, §5.5, §5.7).
//
// Ordered so the stable parts are cached:
//   system      role and rules, grammar reference, idiom table, stitch list,
//               worked examples                       cached (breakpoint 1)
//   user 1      the whole pattern with row ids, notes, colours, answers
//                                                      cached (breakpoint 2)
//   user 2      accepted CrochetPARADE so far, the target row
// Repairs append the model's reply and a new user message; nothing earlier is
// edited (current models bind their thinking to the exact conversation).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ParseError, PatternNote, PatternRow, Question } from "@crochet-model/core";
import { builtinStitches } from "@crochet-model/core/node";
import type { CountCheck } from "./counts.ts";
import type { TextBlock } from "./model.ts";
import { outputFormat, RowResponse, WholeResponse } from "./schema.ts";

const read = (name: string) =>
  readFileSync(new URL(`./prompt/${name}`, import.meta.url), "utf8").trim();

let systemText: string | undefined;

/** The system prompt, built once. The stitch list comes from the vendored parser. */
export function systemPrompt(): string {
  systemText ??= [
    read("system.md"),
    read("grammar.md"),
    `## Built-in stitch names\n\n${builtinStitches().join(" ")}\n\nAny of these with \`Ninc\` or \`Ntog\` appended (\`sc2inc\`, \`dc3tog\`) is also built in.`,
    read("idioms.md"),
    read("examples.md"),
  ].join("\n\n");
  return systemText;
}

export function systemBlocks(): TextBlock[] {
  return [{ text: systemPrompt(), cache: true }];
}

/**
 * Identifies everything that shapes a translation: the prompt text, the
 * schemas and the model settings. Part of the cache key and of every
 * evaluation result.
 */
export function promptVersion(settings: object): string {
  const h = createHash("sha256");
  h.update(systemPrompt());
  h.update(JSON.stringify(outputFormat(RowResponse)));
  h.update(JSON.stringify(outputFormat(WholeResponse)));
  h.update(JSON.stringify(settings));
  return h.digest("hex").slice(0, 12);
}

export interface PatternContext {
  rows: PatternRow[];
  notes: PatternNote[];
  colors: Record<string, string>;
  /** Answered questions, in the order they were answered. */
  answers: { rowId: string; question: Question; answer: number }[];
}

function rowLine(row: PatternRow): string {
  const label = row.label ? `${row.label}: ` : "";
  const section = row.section ? ` (section: ${row.section})` : "";
  return `[${row.id}] ${label}${row.text}${section}`;
}

/** User block 1: the whole pattern. Answers go last, so earlier rows keep the cache. */
export function patternBlock(p: PatternContext): TextBlock {
  const parts = [`<pattern>\n${p.rows.map(rowLine).join("\n")}\n</pattern>`];
  if (p.notes.length) {
    parts.push(`<notes>\n${p.notes.map((n) => n.text).join("\n")}\n</notes>`);
  }
  const colors = Object.entries(p.colors);
  if (colors.length) {
    parts.push(`<colours>\n${colors.map(([k, v]) => `${k} = ${v}`).join("\n")}\n</colours>`);
  }
  if (p.answers.length) {
    const lines = p.answers.map(
      (a) => `[${a.rowId}] ${a.question.text} → ${a.question.options[a.answer]?.label ?? "?"}`,
    );
    parts.push(`<answers>\n${lines.join("\n")}\n</answers>`);
  }
  return { text: parts.join("\n\n"), cache: true };
}

export interface AcceptedRow {
  row: PatternRow;
  cp: string;
  /** Parser rows this row's lines became, and their counts. */
  parserRows: { row: number; count: number }[];
  /** Given already translated; cannot be amended. */
  given?: boolean;
}

/** User block 2: what is accepted so far and the row to translate. */
export function rowBlock(accepted: AcceptedRow[], target: PatternRow): TextBlock {
  const done = accepted.length
    ? accepted
        .map((a) => {
          const where = a.parserRows.length
            ? a.parserRows.map((r) => `parser row ${r.row}: ${r.count} stitches`).join("; ")
            : "no stitches";
          const fixed = a.given ? "; given, cannot be amended" : "";
          return `[${a.row.id}] (${where}${fixed})\n${a.cp || "(empty)"}`;
        })
        .join("\n")
    : "(none yet)";
  const span = target.span > 1 ? ` It stands for ${target.span} rows: write ${target.span} lines.` : "";
  const stated =
    target.statedCount === undefined
      ? "The English states no count for it."
      : `The English states a count of ${target.statedCount}.`;
  const last = accepted.flatMap((a) => a.parserRows).at(-1);
  const prev = last ? ` The previous parser row (${last.row}) has ${last.count} stitches.` : "";
  return {
    cache: false,
    text:
      `<accepted>\n${done}\n</accepted>\n\n` +
      `Translate row [${target.id}]: ${target.label ? `${target.label}: ` : ""}${target.text}\n` +
      `${stated}${span}${prev}`,
  };
}

/** Whole-pattern mode: one request for every row. */
export function wholeBlock(rows: PatternRow[], given: AcceptedRow[]): TextBlock {
  const prefix = given.length
    ? `These rows are already translated; do not return them:\n${given.map((a) => `[${a.row.id}] ${a.cp}`).join("\n")}\n\n`
    : "";
  const ids = rows.map((r) => r.id).join(", ");
  return {
    cache: false,
    text:
      `${prefix}Translate every remaining row of the pattern in one response: ${ids}. ` +
      "Return one entry per row id, in order. Leave `cp` empty for a row that makes no stitches.",
  };
}

const ADVICE: Record<ParseError["kind"], string> = {
  label_not_found:
    "A label is used but not defined on an earlier stitch, or its index is wrong. Check the spelling and the index; remember that after a turn chain spaces come back in reverse order. If the label belongs on a stitch in an earlier row, define it there with `amendPrevious`.",
  stitch_not_defined:
    "A stitch name is not built in. Use a name from the built-in list (`ss` for slip stitch, `tr` for treble, `sc2tog` for a decrease).",
  position_not_found:
    "An `@[row,i]` points at a row or stitch that does not exist. Rows and stitches count from 0; check the parser row numbers shown with the accepted rows.",
  attach_into_future: "A stitch attaches to a stitch made after it. Attach only to earlier stitches.",
  turn_not_at_end: "`turn` must be the last item on its line. Move what follows it to the next line.",
  syntax: "The text is malformed, for example unbalanced brackets. Check the brackets and commas.",
  other: "Read the message and fix the cause it names.",
};

export function parseErrorRepair(error: ParseError, target: PatternRow): string {
  const where = error.row === undefined ? "" : ` (parser row ${error.row})`;
  return (
    `The parser rejected the translation of row [${target.id}]${where}:\n${error.message}\n\n` +
    `${ADVICE[error.kind]}\n\nReturn the corrected response for the same row.`
  );
}

export function countRepair(stated: number, check: CountCheck, target: PatternRow): string {
  const chains =
    check.leading === 0
      ? ""
      : ` (${check.accepted.join(" or ")} allowing for the ${check.leading} beginning chain${check.leading > 1 ? "s" : ""})`;
  return (
    `Row [${target.id}] parses, but the English states ${stated} stitches and the parser counts ${check.parsed} on its last line${chains}.\n\n` +
    "Check each instruction of the row against your stitches: repeats, increases (`sc2inc` counts 2), stitches worked into the same place, and skipped stitches. " +
    "If you are sure the English counts differently from the parser (for example skipped chains it counts as a stitch), keep the translation, set `expectedCount` to the parser's count and say why in `assumptions`. " +
    "Return the corrected response for the same row."
  );
}

export function amendmentRepair(rowId: string, why: string, target: PatternRow): string {
  return (
    `The amendment of row [${rowId}] was rejected: ${why}. An amendment may only add labels; everything else in that row must stay the same.\n\n` +
    `Return the corrected response for row [${target.id}].`
  );
}

export function formatRepair(why: string, whole = false): string {
  const what = whole ? "the response for every row, in one response" : "the response for the same row";
  return `Your response could not be used: ${why}. Return ${what} again.`;
}
