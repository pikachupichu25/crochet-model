// `eval run`: translate every item of a dataset, score it, and write a run
// directory that `eval report` can summarise on its own (docs/SPEC.md §7.2):
//
//   runs/<time>-<translator>-<dataset>/
//     config.json    what ran: translator, dataset commit, CrochetPARADE commit
//     items.jsonl    one line per item: outputs and scores
//     summary.json   the aggregate metrics, one entry per output
//
// Only the rule-based translator exists so far. It yields two outputs per
// item (see rules.ts); an LLM translator will yield one.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createNodeValidator, VENDOR_DIR } from "@crochet-model/core/node";
import { loadDataset, type DatasetName, type EvalItem } from "./datasets.ts";
import { translateWithRules, type RulesOutput } from "./rules.ts";
import { checkGold, scoreItem, type GoldCheck, type ItemScore } from "./score.ts";
import { DATA_DIR, RUNS_DIR } from "./sources.ts";
import { summarise, type Summary } from "./summary.ts";

const { validate } = createNodeValidator();

export type Translator = "rules";

export interface RunOptions {
  translator: Translator;
  dataset: DatasetName;
  limit?: number;
  log?: (line: string) => void;
}

export interface ItemRecord {
  id: string;
  name: string;
  ms: number;
  gold?: GoldCheck;
  rules: RulesOutput;
  /** By output name: "rules" (the site's checked block), "rules-compiled". */
  scores: Record<string, ItemScore>;
}

export function runEvaluation(options: RunOptions): { dir: string; summaries: Summary[] } {
  const log = options.log ?? ((line: string) => console.error(line));
  const items = loadDataset(options.dataset).slice(0, options.limit);
  const started = new Date();
  const stamp = started.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const dir = `${RUNS_DIR}${stamp}-${options.translator}-${options.dataset}/`;
  mkdirSync(dir, { recursive: true });

  const sources = existsSync(`${DATA_DIR}SOURCES.json`)
    ? (JSON.parse(readFileSync(`${DATA_DIR}SOURCES.json`, "utf8")) as Record<string, unknown>)
    : {};
  const config = {
    translator: options.translator,
    dataset: options.dataset,
    limit: options.limit ?? null,
    items: items.length,
    startedAt: started.toISOString(),
    datasetSource: sources[options.dataset.split("-")[0]!] ?? null,
    crochetparadeCommit: readFileSync(`${VENDOR_DIR}COMMIT`, "utf8").trim(),
    node: process.version,
    python: spawnSync("python3", ["--version"], { encoding: "utf8" }).stdout.trim(),
  };
  writeFileSync(`${dir}config.json`, `${JSON.stringify(config, null, 2)}\n`);

  const records: ItemRecord[] = [];
  for (const [i, item] of items.entries()) {
    const t0 = performance.now();
    const gold = checkGold(item);
    const prevCount = item.context && gold?.ok ? prefixCount(item) : undefined;
    const rules = translateWithRules(item.english, prevCount);
    const scores = {
      rules: scoreItem(item, rules.cp),
      "rules-compiled": scoreItem(item, rules.compiledCp),
    };
    const record: ItemRecord = {
      id: item.id,
      name: item.name,
      ms: Math.round(performance.now() - t0),
      gold,
      rules,
      scores,
    };
    records.push(record);
    appendFileSync(`${dir}items.jsonl`, `${JSON.stringify(record)}\n`);
    const mark = (s: ItemScore) => (s.parses ? "ok" : s.nonEmpty ? "invalid" : "empty");
    log(
      `[${i + 1}/${items.length}] ${item.id} ${mark(scores.rules)} / ${mark(scores["rules-compiled"])}` +
        ` (${record.ms} ms)${rules.error ? ` translator error: ${rules.error}` : ""}`,
    );
  }

  const summaries = ["rules", "rules-compiled"].map((output) =>
    summarise(options.dataset, output, records),
  );
  writeFileSync(
    `${dir}summary.json`,
    `${JSON.stringify({ ...config, finishedAt: new Date().toISOString(), summaries }, null, 2)}\n`,
  );
  return { dir, summaries };
}

/** The stitch count of the gold prefix's last row, given to the translator as context. */
function prefixCount(item: EvalItem): number | undefined {
  const r = validate(item.context!.map((c) => c.cp).join("\n"));
  return r.ok ? r.rows[r.rows.length - 1]?.stitches : undefined;
}
