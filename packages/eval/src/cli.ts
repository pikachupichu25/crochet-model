// Evaluation CLI (docs/SPEC.md §7.2).
//
//   npm run eval -- fetch
//   npm run eval -- run --translator rules --dataset stitchswitch [--limit N]
//   npm run eval -- run --translator rules --dataset all
//   npm run eval -- report packages/eval/runs/<run> [more runs…]

import { readFileSync } from "node:fs";
import { DATASETS, type DatasetName } from "./datasets.ts";
import { fetchDatasets } from "./fetch.ts";
import { runEvaluation, type Translator } from "./run.ts";
import { markdownTable, type Summary } from "./summary.ts";

const USAGE = `usage:
  eval fetch
  eval run --translator rules --dataset <${DATASETS.join("|")}|all> [--limit N]
  eval report <run-dir>...`;

const [command, ...args] = process.argv.slice(2);

function option(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

switch (command) {
  case "fetch":
    await fetchDatasets();
    break;

  case "run": {
    const translator = (option("translator") ?? "rules") as Translator;
    if (translator !== "rules") fail(`unknown translator: ${translator}`);
    const dataset = option("dataset") ?? fail("--dataset is required");
    const names =
      dataset === "all"
        ? DATASETS
        : DATASETS.includes(dataset as DatasetName)
          ? [dataset as DatasetName]
          : fail(`unknown dataset: ${dataset}`);
    const limit = option("limit") === undefined ? undefined : Number(option("limit"));
    const summaries: Summary[] = [];
    for (const name of names) {
      const run = runEvaluation({ translator, dataset: name, limit });
      console.error(`wrote ${run.dir}`);
      summaries.push(...run.summaries);
    }
    console.log(markdownTable(summaries));
    break;
  }

  case "report": {
    if (args.length === 0) fail("no run directories given");
    const summaries = args.flatMap((dir) => {
      const file = `${dir.replace(/\/?$/, "/")}summary.json`;
      return (JSON.parse(readFileSync(file, "utf8")) as { summaries: Summary[] }).summaries;
    });
    console.log(markdownTable(summaries));
    break;
  }

  default:
    fail(command ? `unknown command: ${command}` : "no command");
}
