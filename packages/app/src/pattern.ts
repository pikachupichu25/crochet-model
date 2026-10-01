// Pure helpers over a translated pattern: the code to lay out, the export
// text, the summary before rendering, and which English row each parser row
// came from (FR-3.2, FR-3.5, FR-6.1).

import { mapRowsToLines, type PatternNote, type PatternRow, type RowTranslation } from "@crochet-model/core";

export type Translations = Record<string, RowTranslation>;

/** Rows that join the model: everything but failed rows (FR-3.5). */
export function usable(t: RowTranslation | undefined): t is RowTranslation {
  return !!t && t.status !== "invalid" && t.cp.trim() !== "";
}

/** The code to validate and lay out, and the pattern row of each part, in order. */
export function assemble(rows: PatternRow[], translations: Translations): { text: string; parts: { rowId: string; cp: string }[] } {
  const parts = rows.flatMap((row) => {
    const t = translations[row.id];
    return usable(t) ? [{ rowId: row.id, cp: t.cp.trim() }] : [];
  });
  return { text: parts.map((p) => p.cp).join("\n"), parts };
}

/** CrochetPARADE with the English as `#` comments above each row (FR-6.1). */
export function exportText(rows: PatternRow[], notes: PatternNote[], translations: Translations, colors: Record<string, string> = {}): string {
  const out: string[] = ["# Translated by Crochet Model; English as comments."];
  for (const [k, v] of Object.entries(colors)) out.push(`# Colour ${k} = ${v}`);
  for (const n of notes.filter((n) => !n.section)) out.push(`# ${n.text}`);
  let section: string | undefined;
  for (const row of rows) {
    if (row.section && row.section !== section) {
      section = row.section;
      out.push("", `# == ${section} ==`);
    }
    const t = translations[row.id];
    const english = `${row.label ? `${row.label}: ` : ""}${row.text}`.replace(/\n/g, " ");
    out.push(`# ${english}`);
    if (!t) out.push("# (not translated)");
    else if (t.status === "invalid") out.push(...t.cp.split("\n").map((l) => `# FAILED: ${l}`));
    else if (t.cp.trim()) out.push(t.cp.trim());
  }
  return `${out.join("\n")}\n`;
}

/**
 * The pattern row of each parser row (0-based), from how many parser rows each
 * part makes. Undefined when a part's rows cannot be counted from its text
 * (brackets spanning lines), or the total disagrees with the parser's.
 */
export function parserRowOwners(parts: { rowId: string; cp: string }[], parserRows?: number): string[] | undefined {
  const owners: string[] = [];
  for (const part of parts) {
    const lines = mapRowsToLines(part.cp);
    if (!lines) return undefined;
    for (let i = 0; i < lines.length; i++) owners.push(part.rowId);
  }
  return parserRows === undefined || owners.length === parserRows ? owners : undefined;
}

export interface Summary {
  rows: number;
  translated: number;
  questions: number;
  failed: number;
  mismatched: number;
  edited: number;
}

export function summarise(rows: PatternRow[], translations: Translations): Summary {
  const s: Summary = { rows: rows.length, translated: 0, questions: 0, failed: 0, mismatched: 0, edited: 0 };
  for (const row of rows) {
    const t = translations[row.id];
    if (!t) continue;
    s.translated += 1;
    if (t.status === "needs_answer") s.questions += 1;
    if (t.status === "invalid") s.failed += 1;
    if (t.status === "count_mismatch") s.mismatched += 1;
    if (t.source === "user") s.edited += 1;
  }
  return s;
}

/**
 * 2D or 3D from the pattern (FR-4.2): rows that turn are flat; rounds are 3D
 * when they stop growing or shrink (a ball, a hat), flat when they keep
 * growing (a circle, a granny square). The user can change it.
 */
export function guessDimension(rows: PatternRow[], translations: Translations): 2 | 3 {
  const cps = rows.map((r) => translations[r.id]?.cp ?? "");
  const rounds = rows.filter((r) => /^(rnd|round|r)\b/i.test(r.label) && !/^row/i.test(r.label)).length;
  const turned = cps.filter((cp) => /\bturn\b/.test(cp)).length;
  if (turned > rounds) return 2;
  if (cps.some((cp) => /\d*tog\b/.test(cp))) return 3;
  const counts = rows.map((r) => r.statedCount).filter((n): n is number => n !== undefined);
  for (let i = 2; i < counts.length; i++) if (counts[i] === counts[i - 1]) return 3;
  return rounds > 0 && cps.some((cp) => /\bring\b/.test(cp)) && rows.some((r) => r.span > 2) ? 3 : 2;
}

/** A short label for a row: "Rnd 3", or the start of an unlabelled instruction. */
export function rowLabel(row: PatternRow): string {
  if (row.label) return row.label;
  return row.text.length > 18 ? `${row.text.slice(0, 16)}…` : row.text;
}
