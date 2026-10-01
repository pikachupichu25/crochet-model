// Evaluation CLI (docs/SPEC.md §7.2).
//
//   npm run eval -- fetch
//   npm run eval -- run --translator rules --dataset all
//   npm run eval -- run --translator llm --dataset stitchswitch \
//       [--provider anthropic|openrouter|gemini|openai] [--model claude-opus-5-5] [--effort medium] [--repair-effort high] \
//       [--mode row|whole] [--no-repair] [--batch] [--limit N] [--ids a,b] \
//       [--concurrency 4] [--max-cost 5] [--yes]
//   npm run eval -- report packages/eval/runs/<run> [more runs…]
//   npm run eval -- compare packages/eval/runs/<a> packages/eval/runs/<b>

import { readFileSync } from "node:fs";
import { PROVIDERS, type Effort, type ProviderId } from "@crochet-model/translator";
import { DATASETS, type DatasetName } from "./datasets.ts";
import { fetchDatasets } from "./fetch.ts";
import type { LlmConfig } from "./llm.ts";
import { runEvaluation, type ItemRecord, type Translator } from "./run.ts";
import { itemChanges, markdownTable, type Summary } from "./summary.ts";

const USAGE = `usage:
  eval fetch
  eval run --translator rules|llm --dataset <${DATASETS.join("|")}|all> [--limit N] [--ids a,b]
           LLM: [--provider ${PROVIDERS.join("|")}] [--model ID] [--effort low|medium|high|xhigh|max] [--repair-effort …]
                [--mode row|whole] [--no-repair] [--batch] [--concurrency N] [--max-cost USD] [--yes]
  eval report <run-dir>...
  eval compare <run-dir-a> <run-dir-b>`;

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const [command, ...args] = process.argv.slice(2);

function option(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function effort(name: string, fallback: Effort): Effort {
  const value = option(name) ?? fallback;
  if (!EFFORTS.includes(value as Effort)) fail(`--${name} must be one of ${EFFORTS.join(", ")}`);
  return value as Effort;
}

function readRun(dir: string): { summaries: Summary[]; records: ItemRecord[] } {
  const base = dir.replace(/\/?$/, "/");
  const { summaries } = JSON.parse(readFileSync(`${base}summary.json`, "utf8")) as { summaries: Summary[] };
  const records = readFileSync(`${base}items.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ItemRecord);
  return { summaries, records };
}

switch (command) {
  case "fetch":
    await fetchDatasets();
    break;

  case "run": {
    const translator = (option("translator") ?? "rules") as Translator;
    if (translator !== "rules" && translator !== "llm") fail(`unknown translator: ${translator}`);
    const dataset = option("dataset") ?? fail("--dataset is required");
    const names =
      dataset === "all"
        ? DATASETS
        : DATASETS.includes(dataset as DatasetName)
          ? [dataset as DatasetName]
          : fail(`unknown dataset: ${dataset}`);
    const limit = option("limit") === undefined ? undefined : Number(option("limit"));
    const mode = option("mode") ?? "row";
    if (mode !== "row" && mode !== "whole") fail("--mode must be row or whole");
    const provider = (option("provider") ?? "anthropic") as ProviderId;
    if (!PROVIDERS.includes(provider)) fail(`--provider must be one of ${PROVIDERS.join(", ")}`);
    // Only Claude has a default until the sweep picks one per provider (SPEC §5.6).
    const model = option("model") ?? (provider === "anthropic" ? "claude-opus-5-5" : undefined);
    if (translator === "llm" && !model) fail(`--model is required for ${provider}`);
    if (flag("batch") && provider !== "anthropic") fail("--batch is only built for anthropic");
    const llm: LlmConfig | undefined =
      translator === "llm"
        ? {
            provider,
            model: model!,
            effort: effort("effort", "medium"),
            repairEffort: effort("repair-effort", "high"),
            mode,
            repair: !flag("no-repair"),
            batch: flag("batch"),
            concurrency: Number(option("concurrency") ?? 4),
          }
        : undefined;
    const summaries: Summary[] = [];
    for (const name of names) {
      try {
        const run = await runEvaluation({
          translator,
          dataset: name,
          limit,
          ids: option("ids")?.split(","),
          llm,
          maxCost: option("max-cost") === undefined ? undefined : Number(option("max-cost")),
          yes: flag("yes"),
        });
        console.error(`wrote ${run.dir}`);
        summaries.push(...run.summaries);
      } catch (error) {
        console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    }
    console.log(markdownTable(summaries));
    break;
  }

  case "report": {
    if (args.length === 0) fail("no run directories given");
    console.log(markdownTable(args.flatMap((dir) => readRun(dir).summaries)));
    break;
  }

  case "compare": {
    if (args.length !== 2) fail("compare takes two run directories");
    const [a, b] = args.map(readRun) as [ReturnType<typeof readRun>, ReturnType<typeof readRun>];
    console.log(markdownTable([...a.summaries, ...b.summaries]));
    // Item changes between the first output of each run.
    const changes = itemChanges(
      { output: a.summaries[0]!.output, records: a.records },
      { output: b.summaries[0]!.output, records: b.records },
    );
    console.log(changes.length ? `\nChanged items:\n${changes.join("\n")}` : "\nNo item changed.");
    break;
  }

  default:
    fail(command ? `unknown command: ${command}` : "no command");
}
