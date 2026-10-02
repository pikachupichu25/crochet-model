// Dataset loaders (docs/SPEC.md §7.1). Each turns a downloaded file into
// EvalItems, so every translator and metric sees the same shape.

import { readFileSync } from "node:fs";
import { statedCount } from "@crochet-model/core";
import { dataPath, type SourceName } from "./sources.ts";

export type DatasetName = "stitchswitch" | "crochetbench-step" | "crochetbench-project";

export const DATASETS: DatasetName[] = ["stitchswitch", "crochetbench-step", "crochetbench-project"];

/** Where each dataset comes from, for people reading it (README, SPEC §7.1). */
export const DATASET_INFO: Record<DatasetName, { source: SourceName; title: string; paper: string; about: string }> = {
  stitchswitch: {
    source: "stitchswitch",
    title: "StitchSwitch",
    paper: "https://ojs.aaai.org/index.php/AAAI-SS/article/view/36054",
    about: "Short patterns with CrochetPARADE translated by hand: the only set with a gold answer for every item.",
  },
  "crochetbench-step": {
    source: "crochetbench",
    title: "CrochetBench Task D-step",
    paper: "https://arxiv.org/abs/2511.09483",
    about: "One step of a pattern to translate, with the earlier steps and their CrochetPARADE as context. No gold for the target.",
  },
  "crochetbench-project": {
    source: "crochetbench",
    title: "CrochetBench Task D-proj",
    paper: "https://arxiv.org/abs/2511.09483",
    about: "Whole patterns, no gold. Scored on parse rate and stated stitch counts.",
  },
};

export interface EvalItem {
  dataset: DatasetName;
  /** Stable within the dataset: `ss-007`, `step_3_4-012`, `project-031`. */
  id: string;
  name: string;
  /** The English the translator is given. */
  english: string;
  /** Gold CrochetPARADE for the whole of `english` (StitchSwitch only). */
  gold?: string;
  /**
   * Step-level items: the earlier steps, English with their gold
   * CrochetPARADE. The translation of `english` is appended to their CP.
   */
  context?: { english: string; cp: string }[];
  /** The stitch count `english` states, when it states one plainly. */
  statedCount?: number;
  /** StitchSwitch `Variation` column, as written (meaning unconfirmed; SPEC §12). */
  variation?: string;
  /**
   * CrochetBench `image_link`: a photo of the finished project on the
   * publisher's site. Linked for people to look at, never downloaded or sent
   * to a translator; the publisher holds its copyright.
   */
  imageUrl?: string;
}

export function loadDataset(name: DatasetName): EvalItem[] {
  switch (name) {
    case "stitchswitch":
      return loadStitchSwitch(readFileSync(dataPath("stitchswitch", "StitchSwitchDataset.csv"), "utf8"));
    case "crochetbench-step":
      return ["1_2", "3_4", "5_6"].flatMap((split) =>
        loadCrochetBenchStep(
          readJson(dataPath("crochetbench", `data/step_level_test_${split}.json`)),
          `step_${split}`,
        ),
      );
    case "crochetbench-project":
      return loadCrochetBenchProject(readJson(dataPath("crochetbench", "data/project_level_test.json")));
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const pad = (i: number) => String(i + 1).padStart(3, "0");
const unixLines = (s: string) => s.replace(/\r\n?/g, "\n").trim();

// --- StitchSwitch ---------------------------------------------------------

/** Columns: Original Pattern, crochetPARADE Pattern, Name, Variation. */
export function loadStitchSwitch(csv: string): EvalItem[] {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ""));
  const col = (name: string) => {
    const i = header!.findIndex((h) => h.trim() === name);
    if (i < 0) throw new Error(`StitchSwitch: no column "${name}"`);
    return i;
  };
  const english = col("Original Pattern");
  const gold = col("crochetPARADE Pattern");
  const name = col("Name");
  const variation = col("Variation");
  return rows
    .filter((r) => r.some((cell) => cell.trim()))
    .map((r, i) => ({
      dataset: "stitchswitch",
      id: `ss-${pad(i)}`,
      name: r[name]!.trim(),
      english: unixLines(r[english]!),
      gold: unixLines(r[gold]!),
      variation: r[variation]!.trim() || undefined,
    }));
}

/** RFC 4180: quoted fields may hold commas, newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- CrochetBench ---------------------------------------------------------

interface CrochetBenchRecord {
  id: string;
  pattern_name: string;
  instructions: string;
  prompt?: string;
  image_link?: string;
}

/** Only https links are kept. */
const imageUrl = (r: CrochetBenchRecord) => (r.image_link?.startsWith("https://") ? r.image_link : undefined);

/**
 * Task D-step. Each prompt is
 *
 *   Previous NL and DSL:
 *   NL: <english>
 *   DSL:<cp>
 *   …
 *   Now translate the NL into DSL:
 *   NL:<english>
 *   DSL:
 *
 * One prompt writes `DL:` for `DSL:`; both are accepted.
 */
export function loadCrochetBenchStep(records: unknown, split: string): EvalItem[] {
  return (records as CrochetBenchRecord[]).map((r, i) => {
    const { context, target } = parseStepPrompt(r.prompt ?? "");
    return {
      dataset: "crochetbench-step",
      id: `${split}-${pad(i)}`,
      name: r.pattern_name.trim(),
      english: target,
      context,
      statedCount: statedCount(target),
      imageUrl: imageUrl(r),
    };
  });
}

export function parseStepPrompt(prompt: string): {
  context: { english: string; cp: string }[];
  target: string;
} {
  const marker = "Now translate the NL into DSL:";
  const at = prompt.indexOf(marker);
  if (at < 0) throw new Error("CrochetBench prompt without a target");
  const blocks = splitBlocks(prompt.slice(0, at));
  const target = splitBlocks(prompt.slice(at + marker.length))[0];
  if (!target) throw new Error("CrochetBench prompt without target NL");
  return {
    context: blocks.map((b) => ({ english: b.nl, cp: b.dsl })),
    target: target.nl,
  };
}

function splitBlocks(text: string): { nl: string; dsl: string }[] {
  const blocks: { nl: string; dsl: string }[] = [];
  let part: "nl" | "dsl" | undefined;
  for (const line of text.split("\n")) {
    const nl = /^NL:\s?(.*)$/.exec(line);
    const dsl = /^DS?L:(.*)$/.exec(line);
    if (nl) {
      blocks.push({ nl: nl[1]!, dsl: "" });
      part = "nl";
    } else if (dsl && part === "nl") {
      blocks[blocks.length - 1]!.dsl = dsl[1]!;
      part = "dsl";
    } else if (part) {
      const b = blocks[blocks.length - 1]!;
      b[part] += `\n${line}`;
    }
  }
  return blocks.map((b) => ({ nl: b.nl.trim(), dsl: b.dsl.trim() }));
}

/**
 * Task D-proj: whole patterns, no gold. One record at the pinned commit
 * ("Home Spa Bath Mat") has no instructions and is skipped; ids keep the
 * record's position, so they do not shift.
 */
export function loadCrochetBenchProject(records: unknown): EvalItem[] {
  return (records as CrochetBenchRecord[]).flatMap((r, i) =>
    typeof r.instructions === "string"
      ? [
          {
            dataset: "crochetbench-project" as const,
            id: `project-${pad(i)}`,
            name: r.pattern_name.trim(),
            english: unixLines(r.instructions),
            imageUrl: imageUrl(r),
          },
        ]
      : [],
  );
}
