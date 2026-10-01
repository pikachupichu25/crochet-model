// The assembled pattern, checked by the parser worker whenever the
// translations change. The review reads per-row counts and errors from it;
// the model panel lays it out.

import { countMatches, lastRowCount, type Dimension, type RowTranslation, type StitchGraph, type ValidationResult } from "@crochet-model/core";
import { create } from "zustand";
import { assemble, guessDimension, parserRowOwners } from "./pattern.ts";
import { useApp } from "./store.ts";
import { LayoutClient, ParserClient } from "./workers/clients.ts";

export const parser = new ParserClient();
export const layoutClient = new LayoutClient();

export interface Check {
  text: string;
  dimension: Dimension;
  result: ValidationResult;
  graph?: StitchGraph;
  /** The pattern row of each parser row, when it can be told. */
  owners?: string[];
  /** Stitches on each pattern row's last parser row. */
  counts: Record<string, number>;
  /** The pattern row the parser error is on, when it can be told. */
  errorRowId?: string;
}

interface CheckState {
  check?: Check;
  checking: boolean;
  /** The user's choice; undefined follows the pattern (FR-4.2). */
  dimensionOverride?: Dimension;
}

export const useCheck = create<CheckState>(() => ({ checking: false }));

export function setDimension(d: Dimension | undefined) {
  useCheck.setState({ dimensionOverride: d });
  void runCheck();
}

let seq = 0;

export async function runCheck(): Promise<void> {
  const { segmented, translations } = useApp.getState();
  const { text, parts } = assemble(segmented.rows, translations);
  const dimension = useCheck.getState().dimensionOverride ?? guessDimension(segmented.rows, translations);
  const mine = ++seq;
  if (!text.trim()) {
    useCheck.setState({ check: undefined, checking: false });
    return;
  }
  useCheck.setState({ checking: true });
  const { result, graph } = await parser.validate(text, { dimension, withGraph: true });
  if (mine !== seq) return;
  const owners = result.ok ? parserRowOwners(parts, result.rows.length) : undefined;
  const counts: Record<string, number> = {};
  if (owners) result.rows.forEach((r, i) => (counts[owners[i]!] = r.stitches));
  // The parser stops at an error, so its row is mapped through the parts' own
  // lines, and failing that through the source line.
  let errorRowId: string | undefined;
  const error = result.error;
  if (error?.row !== undefined) errorRowId = parserRowOwners(parts)?.[error.row];
  if (!errorRowId && error?.line !== undefined) {
    let lines = 0;
    errorRowId = parts.find((p) => (lines += p.cp.split("\n").length) >= error.line!)?.rowId;
  }
  useCheck.setState({ check: { text, dimension, result, graph, owners, counts, errorRowId }, checking: false });
}

let pending: ReturnType<typeof setTimeout> | undefined;
useApp.subscribe((s, prev) => {
  if (s.translations === prev.translations && s.segmented === prev.segmented) return;
  if (s.english !== prev.english) useCheck.setState({ dimensionOverride: undefined });
  clearTimeout(pending);
  pending = setTimeout(() => void runCheck(), s.translating ? 600 : 120);
});

/** Checks one row as the user wrote it, after the rows before it (FR-3.3). */
export async function checkRow(rowId: string, cp: string): Promise<{ status: RowTranslation["status"]; message?: string; count?: number }> {
  const { segmented, translations } = useApp.getState();
  const index = segmented.rows.findIndex((r) => r.id === rowId);
  const row = segmented.rows[index]!;
  const prefix = assemble(segmented.rows.slice(0, index), translations).text;
  if (!cp.trim()) return { status: "valid" };
  const dimension = useCheck.getState().check?.dimension ?? 3;
  const [before, after] = await Promise.all([
    prefix ? parser.validate(prefix, { dimension, withGraph: false }) : undefined,
    parser.validate(prefix ? `${prefix}\n${cp}` : cp, { dimension, withGraph: true }),
  ]);
  if (!after.result.ok) return { status: "invalid", message: after.result.error?.message };
  const rowsBefore = before?.result.ok ? before.result.rows.length : 0;
  const count = after.result.rows.length > rowsBefore ? lastRowCount(after.result, after.graph) : undefined;
  const ok = !count || countMatches(count, row.statedCount);
  return { status: ok ? "valid" : "count_mismatch", count: count?.parsed };
}
