// Runtime-agnostic validation of CrochetPARADE text.
//
// The CrochetPARADE parser is a browser script with globals, so running it is
// the job of a ParserHost (Node: nodeParser.ts; a Web Worker host comes later).
// This module turns what the host returns into a typed ValidationResult: a
// classified error, per-row stitch counts and the raw graph output.

import { mapRowsToLines } from "./sourceLines.ts";

/** What a ParserHost reports for one call of CrochetPARADE's processText. */
export type HostOutcome =
  | { ok: true; graphJson: string; simpleDot: string; warnings: string[] }
  | { ok: false; error: unknown; warnings: string[] };

export interface ParserHost {
  run(text: string): HostOutcome;
}

export type ParseErrorKind =
  | "label_not_found" // "Label not found: A" — the most common LLM error (Dias & Karim)
  | "stitch_not_defined" // unknown stitch name, e.g. slst, tc
  | "position_not_found" // attachment to a stitch or ID that does not exist
  | "attach_into_future" // attachment to a label or stitch made later
  | "turn_not_at_end" // `turn` followed by more stitches on the same row
  | "syntax" // unbalanced brackets and other malformed text
  | "other";

export interface ParseError {
  kind: ParseErrorKind;
  /** One line, HTML and embedded JSON removed; safe to show or send to an LLM. */
  message: string;
  /** 0-based CrochetPARADE row, when the parser reports one. */
  row?: number;
  /** 1-based line of the input text holding that row, when it can be mapped. */
  line?: number;
  /** The parser's full message, for debugging. */
  raw: string;
}

export interface RowSummary {
  /** 0-based CrochetPARADE row. */
  row: number;
  /** 1-based input line, when the rows can be mapped to lines. */
  line?: number;
  /**
   * Stitches this row adds, crochet-style: top nodes, excluding slip stitches,
   * rings, tie-ups and hidden nodes. Compare with a pattern's stated count.
   */
  stitches: number;
  /** Top nodes by type, including the excluded ones. A sc2inc adds two `sc`. */
  byType: Record<string, number>;
}

export interface ValidationResult {
  ok: boolean;
  error?: ParseError;
  /** Present when ok. */
  rows: RowSummary[];
  warnings: string[];
  /** Parser output 1: {dimen, elements:[nodes and edges]}. Present when ok. */
  graphJson?: string;
  /** Parser output 2: the stitch-level graph as DOT-like text. Present when ok. */
  simpleDot?: string;
}

/** Top-node types that do not count toward a row's stated stitch count. */
export const NON_COUNTING_TYPES: ReadonlySet<string> = new Set([
  "ss",
  "ring",
  "tie",
  "hidden",
]);

export function createValidator(host: ParserHost) {
  return {
    validate(text: string): ValidationResult {
      const outcome = host.run(text);
      const lines = mapRowsToLines(text);
      if (!outcome.ok) {
        const error = toParseError(outcome.error);
        if (error.row !== undefined && lines) error.line = lines[error.row];
        // The parser often warns with the same text it then throws.
        const warnings = outcome.warnings.filter((w) => cleanMessage(w) !== error.message);
        return { ok: false, error, rows: [], warnings };
      }
      const rows = summariseRows(outcome.graphJson);
      // Only trust the line mapping when it agrees with the parser's row count.
      if (lines && lines.length === rows.length) {
        for (const r of rows) r.line = lines[r.row];
      }
      return {
        ok: true,
        rows,
        warnings: outcome.warnings,
        graphJson: outcome.graphJson,
        simpleDot: outcome.simpleDot,
      };
    },
  };
}

// Top-level stitch nodes are named "row,index|statement"; internal nodes carry
// a letter suffix ("1,0C|4") or other forms, and are skipped.
const TOP_NODE = /^(\d+),(\d+)\|(\d+)$/;

interface GraphElement {
  type: string;
  name?: string;
  label?: string;
}

export function summariseRows(graphJson: string): RowSummary[] {
  const graph = JSON.parse(graphJson) as { elements: GraphElement[] };
  const rows: RowSummary[] = [];
  for (const el of graph.elements) {
    if (el.type !== "node" || !el.name) continue;
    const m = TOP_NODE.exec(el.name);
    if (!m) continue;
    const row = Number(m[1]);
    // label is "type|context…|colour"
    const type = (el.label ?? "").split("|")[0] ?? "";
    while (rows.length <= row) {
      rows.push({ row: rows.length, stitches: 0, byType: {} });
    }
    const summary = rows[row]!;
    summary.byType[type] = (summary.byType[type] ?? 0) + 1;
    if (!NON_COUNTING_TYPES.has(type)) summary.stitches += 1;
  }
  return rows;
}

export function toParseError(error: unknown): ParseError {
  // The parser runs in another realm (vm context or worker), so its errors
  // are not `instanceof Error` here; read `message` directly.
  const message = (error as { message?: unknown } | null)?.message;
  const raw =
    typeof message === "string" ? message : String(error ?? "unknown error");
  return {
    kind: classify(raw),
    message: cleanMessage(raw),
    row: errorRow(raw),
    raw,
  };
}

function classify(raw: string): ParseErrorKind {
  const first = raw.split("\n", 1)[0] ?? "";
  if (/^Label not found/i.test(first)) return "label_not_found";
  if (/Stitch type not defined|Invalid stitch name/i.test(first))
    return "stitch_not_defined";
  if (/^ID not found|Stitch at that position not found|Cannot find node/i.test(first))
    return "position_not_found";
  if (/Cannot attach into the future/i.test(first)) return "attach_into_future";
  if (/Turning can happen only at the end of a row/i.test(first))
    return "turn_not_at_end";
  if (/Unbalanced|brackets|parenthes|cannot begin with a new line/i.test(first))
    return "syntax";
  return "other";
}

function cleanMessage(raw: string): string {
  let msg = raw.split("\n", 1)[0] ?? "";
  // Some messages append a JSON dump of the parsed row; drop it.
  msg = msg.replace(/\s*Error at row:\s*\[.*$/, "");
  msg = msg.replace(/<[^>]+>/g, "");
  msg = msg
    .replace(/&hellip;/g, "…")
    .replace(/&crarr;/g, "↵")
    .replace(/&nbsp;/g, " ");
  msg = msg.trim();
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}

function errorRow(raw: string): number | undefined {
  const ctx = /row\/round:\s*(\d+)/.exec(raw) ?? /"nrow":(\d+)/.exec(raw);
  return ctx ? Number(ctx[1]) : undefined;
}
