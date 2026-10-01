// Where the evaluation datasets come from (docs/SPEC.md §7.1).
//
// Both are downloaded into packages/eval/data/, which is git-ignored: the
// StitchSwitch repository states no licence, and CrochetBench data is
// CC BY-NC 4.0. Each is pinned to a commit so results can be reproduced.

import { fileURLToPath } from "node:url";

export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
export const RUNS_DIR = fileURLToPath(new URL("../runs/", import.meta.url));

export interface Source {
  repo: string;
  commit: string;
  files: string[];
  licence: string;
}

export const SOURCES = {
  stitchswitch: {
    repo: "rachaelteresa/StitchSwitch",
    commit: "262ff432438256a3df89a9e7459509f248b2e4e7",
    files: ["StitchSwitchDataset.csv"],
    licence: "none stated: local evaluation only",
  },
  crochetbench: {
    repo: "Peiyu-Georgia-Li/crochetBench",
    commit: "4f834d5addf3241f09a7e11b59fc3b0142dba269",
    files: [
      "data/step_level_test_1_2.json",
      "data/step_level_test_3_4.json",
      "data/step_level_test_5_6.json",
      "data/project_level_test.json",
    ],
    licence: "data CC BY-NC 4.0",
  },
} satisfies Record<string, Source>;

export type SourceName = keyof typeof SOURCES;

/** Local path of a downloaded dataset file. */
export function dataPath(source: SourceName, file: string): string {
  return `${DATA_DIR}${source}/${file}`;
}
