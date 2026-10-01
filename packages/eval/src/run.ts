// `eval run`: translate every item of a dataset, score it, and write a run
// directory that `eval report` can summarise on its own (docs/SPEC.md §7.2):
//
//   runs/<time>-<translator>-<dataset>/
//     config.json     what ran: translator settings, prompt version, dataset
//                     and CrochetPARADE commits
//     prompt.txt      the system prompt (LLM runs)
//     requests.jsonl  every request and reply (LLM runs), without the system prompt
//     items.jsonl     one line per item: outputs, scores, row translations
//     summary.json    the aggregate metrics, one entry per output
//
// The rule-based translator yields two outputs per item (see rules.ts); the
// LLM translator yields one.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RowTranslation, Usage } from "@crochet-model/core";
import { createNodeValidator, VENDOR_DIR } from "@crochet-model/core/node";
import {
  API_KEY_ENV,
  BatchModel,
  claudeCodeStatus,
  createModel,
  isFatal,
  listModels,
  ModelError,
  promptVersion,
  settingsOf,
  systemPrompt,
  translatePattern,
  translateWhole,
  type ModelInfo,
  type TranslateOptions,
  type TranslatorModel,
} from "@crochet-model/translator";
import { loadDataset, type DatasetName, type EvalItem } from "./datasets.ts";
import { estimateCost, goldAnswerer, itemInput, LoggingModel, type LlmConfig, type QuestionLog } from "./llm.ts";
import { costOf, priceOf } from "./pricing.ts";
import { translateWithRules, type RulesOutput } from "./rules.ts";
import { checkGold, scoreItem, type GoldCheck, type ItemScore } from "./score.ts";
import { DATA_DIR, RUNS_DIR } from "./sources.ts";
import { summarise, type Summary } from "./summary.ts";

const { validate } = createNodeValidator();

export type Translator = "rules" | "llm";

export interface RunOptions {
  translator: Translator;
  dataset: DatasetName;
  limit?: number;
  /** Only these item ids. */
  ids?: string[];
  llm?: LlmConfig;
  /** Refuse an LLM run estimated above this many US$ unless `yes`. */
  maxCost?: number;
  yes?: boolean;
  log?: (line: string) => void;
}

export interface ItemRecord {
  id: string;
  name: string;
  ms: number;
  gold?: GoldCheck;
  /** By output name. */
  outputs: Record<string, string>;
  scores: Record<string, ItemScore>;
  /** Instruction rows the translator found, and those it kept in its output. */
  rows: { found: number; kept: number };
  /** The translator failed on this item, or it was skipped. */
  error?: string;
  rules?: Omit<RulesOutput, "cp" | "compiledCp">;
  llm?: {
    usage: Usage;
    costUsd?: number;
    requests: number;
    models: string[];
    questions: QuestionLog[];
    statuses: Record<string, number>;
    translations: RowTranslation[];
  };
}

export const RULES_OUTPUTS = ["rules", "rules-compiled"];

export function llmOutputName(c: LlmConfig): string {
  return [c.provider, c.model, c.effort, c.mode, ...(c.repair ? [] : ["no-repair"]), ...(c.batch ? ["batch"] : [])].join(" ");
}

export async function runEvaluation(options: RunOptions): Promise<{ dir: string; summaries: Summary[] }> {
  const log = options.log ?? ((line: string) => console.error(line));
  let items = loadDataset(options.dataset);
  if (options.ids) items = items.filter((i) => options.ids!.includes(i.id));
  items = items.slice(0, options.limit);
  const llm = options.translator === "llm" ? options.llm : undefined;
  if (options.translator === "llm" && !llm) throw new Error("an LLM run needs its settings");

  // Check credentials and the model id first (a free call), so a setup
  // problem fails before a run directory exists.
  const info = llm ? await preflight(llm, log) : undefined;
  const price = llm && llm.provider !== "claude-code" ? priceOf(llm.provider, llm.model, info?.price) : undefined;
  if (llm?.provider === "claude-code") {
    // Counts against the Claude Code plan's usage limits, not billed per token.
    log(`estimate: Claude Code plan usage, ${estimateCost(items, llm, undefined).detail}`);
  } else if (llm) {
    const estimate = estimateCost(items, llm, price);
    const dollars = estimate.dollars === undefined ? "unknown (no price for this model)" : `about US$${estimate.dollars.toFixed(2)}`;
    log(`estimate: ${dollars}, ${estimate.detail}`);
    const limit = options.maxCost ?? 5;
    if (!options.yes && (estimate.dollars === undefined || estimate.dollars > limit)) {
      throw new Error(`estimated cost is over the US$${limit} limit; rerun with --yes to accept it, or --max-cost`);
    }
  }

  if (llm?.batch && llm.provider !== "anthropic") throw new Error("--batch is only built for Anthropic");
  const batch = llm?.batch ? new BatchModel({ log }) : undefined;
  const direct = llm && !llm.batch ? createModel(llm.provider) : undefined;

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
    ids: options.ids ?? null,
    items: items.length,
    ...(llm ? { llm, promptVersion: promptVersion(settingsOf({ ...settingsFor(llm), provider: llm.provider }, llm.mode)) } : {}),
    startedAt: started.toISOString(),
    datasetSource: sources[options.dataset.split("-")[0]!] ?? null,
    crochetparadeCommit: readFileSync(`${VENDOR_DIR}COMMIT`, "utf8").trim(),
    node: process.version,
    python: spawnSync("python3", ["--version"], { encoding: "utf8" }).stdout.trim(),
  };
  writeFileSync(`${dir}config.json`, `${JSON.stringify(config, null, 2)}\n`);

  const records: ItemRecord[] = [];
  const done = (record: ItemRecord) => {
    records.push(record);
    appendFileSync(`${dir}items.jsonl`, `${JSON.stringify(record)}\n`);
    const mark = (s: ItemScore) => (s.parses ? "ok" : s.nonEmpty ? "invalid" : "empty");
    const marks = Object.values(record.scores).map(mark).join(" / ");
    const cost = record.llm?.costUsd === undefined ? "" : `, $${record.llm.costUsd.toFixed(3)}`;
    log(`[${records.length}/${items.length}] ${record.id} ${marks || "skipped"} (${record.ms} ms${cost})${record.error ? ` ${record.error}` : ""}`);
  };

  let outputs: string[];
  let batches: BatchModel["batches"] | undefined;
  if (!llm) {
    outputs = RULES_OUTPUTS;
    for (const item of items) done(runRules(item));
  } else {
    outputs = [llmOutputName(llm)];
    writeFileSync(`${dir}prompt.txt`, systemPrompt());
    batches = batch?.batches;
    const model = new LoggingModel(batch ?? direct!, `${dir}requests.jsonl`);
    const tasks = items.map((item) => () => runLlm(item, llm, model, outputs[0]!, price).then(done));
    if (batch) await batch.all(tasks);
    else await pool(tasks, llm.concurrency);
  }

  const order = new Map(items.map((item, i) => [item.id, i]));
  records.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const summaries = outputs.map((output) => summarise(options.dataset, output, records));
  writeFileSync(
    `${dir}summary.json`,
    `${JSON.stringify({ ...config, finishedAt: new Date().toISOString(), ...(batches ? { batches } : {}), summaries }, null, 2)}\n`,
  );
  return { dir, summaries };
}

function runRules(item: EvalItem): ItemRecord {
  const t0 = performance.now();
  const gold = checkGold(item);
  const prevCount = item.context && gold?.ok ? prefixCount(item) : undefined;
  const { cp, compiledCp, ...rules } = translateWithRules(item.english, prevCount);
  return {
    id: item.id,
    name: item.name,
    ms: Math.round(performance.now() - t0),
    gold,
    outputs: { rules: cp, "rules-compiled": compiledCp },
    scores: { rules: scoreItem(item, cp), "rules-compiled": scoreItem(item, compiledCp) },
    rows: { found: rules.instructions, kept: rules.instructionsIncluded },
    ...(rules.error ? { error: rules.error } : {}),
    rules,
  };
}

function settingsFor(c: LlmConfig) {
  return { modelName: c.model, effort: c.effort, repairEffort: c.repairEffort, maxAttempts: c.repair ? 3 : 1 };
}

/**
 * Lists the provider's models with the key from the environment (free) and
 * finds the chosen one. Anthropic also reads ANTHROPIC_AUTH_TOKEN or an
 * `ant auth login` profile. Claude Code has no model list; it only needs a
 * login, and an unknown model fails on the first request.
 */
async function preflight(c: LlmConfig, log: (line: string) => void): Promise<ModelInfo | undefined> {
  if (c.provider === "claude-code") {
    const status = await claudeCodeStatus();
    if (!status.loggedIn) throw new Error("Claude Code is not logged in: run `claude auth login`");
    log(`Claude Code login: ${status.authMethod ?? "unknown"}`);
    return undefined;
  }
  let models: ModelInfo[];
  try {
    models = await listModels(c.provider);
  } catch (error) {
    if (error instanceof ModelError && error.kind === "key_rejected") {
      const login = c.provider === "anthropic" ? ", or run `ant auth login`" : "";
      throw new Error(`no usable ${c.provider} credentials (${error.message.split("\n")[0]}): set ${API_KEY_ENV[c.provider]}${login}`);
    }
    throw error;
  }
  const info = models.find((m) => m.id === c.model);
  if (!info) throw new Error(`unknown model for ${c.provider}: ${c.model}`);
  if (!info.structuredOutput) throw new Error(`${c.provider} ${c.model} cannot constrain output to a JSON Schema`);
  return info;
}

async function runLlm(
  item: EvalItem,
  c: LlmConfig,
  model: TranslatorModel,
  output: string,
  price: ModelInfo["price"],
): Promise<ItemRecord> {
  const t0 = performance.now();
  const gold = checkGold(item);
  const base = { id: item.id, name: item.name, gold };
  if (gold && !gold.ok) {
    return { ...base, ms: 0, outputs: {}, scores: {}, rows: { found: 0, kept: 0 }, error: "skipped: gold does not parse" };
  }
  const { input, goldRows, output: outputOf } = itemInput(item);
  const questions: QuestionLog[] = [];
  const options: TranslateOptions = {
    ...settingsFor(c),
    model,
    validate: (text) => validate(text),
    idPrefix: `${item.dataset}-${item.id}`,
    answer: goldAnswerer(goldRows, questions),
  };
  const todo = input.rows.filter((r) => input.given?.[r.id] === undefined);
  try {
    const result = await (c.mode === "row" ? translatePattern(input, options) : translateWhole(input, options));
    const text = outputOf(result.pattern);
    const translations = todo.map((r) => result.pattern.translations[r.id]!).filter(Boolean);
    const statuses: Record<string, number> = {};
    for (const t of translations) statuses[t.status] = (statuses[t.status] ?? 0) + 1;
    return {
      ...base,
      ms: Math.round(performance.now() - t0),
      outputs: { [output]: text },
      scores: { [output]: scoreItem(item, text) },
      rows: { found: todo.length, kept: translations.filter((t) => t.status !== "invalid").length },
      llm: {
        usage: result.usage,
        costUsd: result.costUsd ?? costOf(price, result.usage, c.batch),
        requests: result.requests,
        models: result.models,
        questions,
        statuses,
        translations,
      },
    };
  } catch (error) {
    if (isFatal(error)) throw error;
    return {
      ...base,
      ms: Math.round(performance.now() - t0),
      outputs: { [output]: "" },
      scores: { [output]: scoreItem(item, "") },
      rows: { found: todo.length, kept: 0 },
      error: `translator failed: ${String(error)}`,
    };
  }
}

/** Runs tasks with at most `n` at a time. */
async function pool<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tasks.length)) }, worker));
  return results;
}

/** The stitch count of the gold prefix's last row, given to the rule-based translator as context. */
function prefixCount(item: EvalItem): number | undefined {
  const r = validate(item.context!.map((c) => c.cp).join("\n"));
  return r.ok ? r.rows[r.rows.length - 1]?.stitches : undefined;
}
