// Items whose gold looks wrong (gold-suspect.json, docs/SPEC.md §7.1). Runs
// report each output twice: over every item, and without these items, so a
// translator is not marked down for matching the English instead of a faulty
// gold.

import { readFileSync } from "node:fs";
import type { ItemRecord } from "./run.ts";
import { summarise, type Summary } from "./summary.ts";

export interface SuspectGold {
  dataset: string;
  id: string;
  /** Rows the problem touches, counted from 1 as the English labels them. */
  rows: number[];
  status: "suspected" | "confirmed" | "rejected";
  issue: string;
  evidence: string;
  found: string;
}

const FILE = new URL("../gold-suspect.json", import.meta.url);

export function loadSuspects(): SuspectGold[] {
  return (JSON.parse(readFileSync(FILE, "utf8")) as { items: SuspectGold[] }).items;
}

/** Ids left out of the clean summary: suspected or confirmed, not rejected. */
export function suspectIds(dataset: string, suspects = loadSuspects()): Set<string> {
  return new Set(suspects.filter((s) => s.dataset === dataset && s.status !== "rejected").map((s) => s.id));
}

/**
 * The summary of one output without the suspect items in `records`, or
 * undefined when none of them is there.
 */
export function cleanSummary(dataset: string, output: string, records: ItemRecord[], ids = suspectIds(dataset)): Summary | undefined {
  const excluded = records.filter((r) => ids.has(r.id)).map((r) => r.id);
  if (excluded.length === 0) return undefined;
  const summary = summarise(dataset, output, records.filter((r) => !ids.has(r.id)));
  return { ...summary, output: `${output} (excl. ${excluded.length} suspect gold)`, excludedSuspect: excluded };
}

/** Each output's summary, followed by its clean summary when suspect items ran. */
export function summariesWithClean(dataset: string, outputs: string[], records: ItemRecord[]): Summary[] {
  const ids = suspectIds(dataset);
  return outputs.flatMap((output) => {
    const clean = cleanSummary(dataset, output, records, ids);
    return [summarise(dataset, output, records), ...(clean ? [clean] : [])];
  });
}
