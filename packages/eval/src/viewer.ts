// Run data for the eval results page (packages/app/eval.html). The app's dev
// server mounts `evalViewerMiddleware` under /__eval/; it reads the
// git-ignored run directories on each request, so nothing from the datasets is
// bundled into the app build.
//
//   GET /__eval/runs                       every run: config and summaries
//   GET /__eval/view?runs=a,b&output=name  those runs combined (below)
//   GET /__eval/datasets                   every dataset: source and counts
//   GET /__eval/dataset?name=stitchswitch  its items, each with its run results
//
// Combining: a baseline on a rate-limited free model is spread over several
// runs of the same dataset. Each item comes from the latest selected run in
// which it is complete. An item is incomplete when a request failed (a 429,
// say) for any of its rows; it is shown, but left out of the summaries,
// because its score measures the provider, not the translator.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DATASET_INFO, DATASETS, loadDataset, type DatasetName, type EvalItem } from "./datasets.ts";
import type { ItemRecord } from "./run.ts";
import type { ItemScore } from "./score.ts";
import { RUNS_DIR, SOURCES } from "./sources.ts";
import { loadSuspects, summariesWithClean, type SuspectGold } from "./suspect.ts";
import type { Summary } from "./summary.ts";

export interface RunInfo {
  name: string;
  translator: string;
  dataset: string;
  /** The run's own outputs (an LLM run has one, a rules run two). */
  outputs: string[];
  items: number;
  promptVersion?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Model and effort settings, for LLM runs. */
  llm?: Record<string, unknown>;
  /** As written by `eval run`, over every item, failed requests included. */
  summaries: Summary[];
  stopped?: string;
}

export interface ViewItem extends ItemRecord {
  /** The run this item's result comes from. */
  run: string;
  /** A request failed for at least one row. */
  incomplete: boolean;
  /** The dataset's photo of the finished project, when it has one. */
  imageUrl?: string;
}

export interface View {
  runs: RunInfo[];
  dataset: string;
  output: string;
  items: ViewItem[];
  /** Over the complete items only. */
  summaries: Summary[];
  incomplete: string[];
  suspects: SuspectGold[];
}

const REQUEST_FAILED = "request failed";

/** The parts of config.json and summary.json read here. */
interface RunFiles {
  config: { translator: string; dataset: string; items?: number; promptVersion?: string; startedAt?: string; llm?: Record<string, unknown> };
  summary?: { summaries?: Summary[]; finishedAt?: string; stopped?: string };
}

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

export function listRuns(dir = RUNS_DIR): RunInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "config.json")))
    .map((d) => {
      const config = readJson<RunFiles["config"]>(join(dir, d.name, "config.json"))!;
      const summary = readJson<NonNullable<RunFiles["summary"]>>(join(dir, d.name, "summary.json"));
      const summaries: Summary[] = summary?.summaries ?? [];
      return {
        name: d.name,
        translator: config.translator,
        dataset: config.dataset,
        outputs: [...new Set(summaries.filter((s) => !s.excludedSuspect).map((s) => s.output))],
        items: config.items ?? summaries[0]?.items ?? 0,
        promptVersion: config.promptVersion,
        startedAt: config.startedAt,
        finishedAt: summary?.finishedAt,
        llm: config.llm,
        summaries,
        stopped: summary?.stopped,
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function readItems(dir: string, run: string): ItemRecord[] {
  const path = join(dir, run, "items.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ItemRecord);
}

export function isIncomplete(record: ItemRecord): boolean {
  return (record.llm?.translations ?? []).some((t) => t.attempts.some((a) => a.rejected === REQUEST_FAILED));
}

/**
 * Dataset items by id, as the dataset is now: runs made before `eval run` kept
 * the item (or its `imageUrl`) do not record it. Empty when the data is not
 * fetched.
 */
function datasetItems(dataset: string): Map<string, EvalItem> {
  try {
    return new Map(loadDataset(dataset as DatasetName).map((i) => [i.id, i]));
  } catch {
    return new Map();
  }
}

export function buildView(runNames: string[], output: string | undefined, dir = RUNS_DIR): View {
  const all = listRuns(dir);
  const runs = runNames.map((n) => {
    const run = all.find((r) => r.name === n);
    if (!run) throw new Error(`no run named ${n}`);
    return run;
  });
  if (runs.length === 0) throw new Error("choose at least one run");
  const dataset = runs[0]!.dataset;
  if (runs.some((r) => r.dataset !== dataset)) throw new Error("runs to combine must share a dataset");
  const out = output ?? runs[0]!.outputs[0];
  if (!out || runs.some((r) => !r.outputs.includes(out))) throw new Error("runs to combine must share an output");

  // Oldest first, so a later complete result replaces an earlier one.
  const known = datasetItems(dataset);
  const byId = new Map<string, ViewItem>();
  for (const run of [...runs].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const record of readItems(dir, run.name)) {
      const source = record.item ?? known.get(record.id);
      const imageUrl = record.item?.imageUrl ?? known.get(record.id)?.imageUrl;
      const item: ViewItem = {
        ...record,
        ...(source ? { item: source } : {}),
        run: run.name,
        incomplete: isIncomplete(record),
        ...(imageUrl ? { imageUrl } : {}),
      };
      const had = byId.get(record.id);
      if (!had || had.incomplete || !item.incomplete) byId.set(record.id, item);
    }
  }
  const items = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const complete = items.filter((i) => !i.incomplete);
  return {
    runs,
    dataset,
    output: out,
    items,
    summaries: complete.length ? summariesWithClean(dataset, [out], complete) : [],
    incomplete: items.filter((i) => i.incomplete).map((i) => i.id),
    suspects: loadSuspects().filter((s) => s.dataset === dataset),
  };
}

// --- Datasets -------------------------------------------------------------

export interface DatasetInfo {
  name: DatasetName;
  title: string;
  paper: string;
  about: string;
  repo: string;
  commit: string;
  licence: string;
  /** Undefined when the data is not fetched; `error` says why. */
  items?: number;
  withGold: number;
  withContext: number;
  withPhoto: number;
  suspects: number;
  runs: number;
  error?: string;
}

/** One run's result for one item, on the run's first output. */
export interface ItemRun {
  run: string;
  /** Model and effort for LLM runs, else the translator. */
  translator: string;
  output: string;
  incomplete: boolean;
  goldOk?: boolean;
  score?: ItemScore;
}

export interface DatasetItem extends EvalItem {
  suspect?: SuspectGold;
  /** Newest first. */
  runs: ItemRun[];
}

export interface DatasetView {
  info: DatasetInfo;
  items: DatasetItem[];
}

const NOT_FETCHED = "Not downloaded yet: run npm run eval -- fetch";

function datasetInfo(name: DatasetName, items: EvalItem[] | undefined, runs: RunInfo[], error?: string): DatasetInfo {
  const meta = DATASET_INFO[name];
  const source = SOURCES[meta.source];
  const suspects = loadSuspects().filter((s) => s.dataset === name && s.status !== "rejected");
  return {
    name,
    ...meta,
    repo: source.repo,
    commit: source.commit,
    licence: source.licence,
    items: items?.length,
    withGold: items?.filter((i) => i.gold !== undefined).length ?? 0,
    withContext: items?.filter((i) => i.context?.length).length ?? 0,
    withPhoto: items?.filter((i) => i.imageUrl).length ?? 0,
    suspects: suspects.length,
    runs: runs.filter((r) => r.dataset === name).length,
    ...(error ? { error } : {}),
  };
}

function tryLoad(name: DatasetName): { items?: EvalItem[]; error?: string } {
  try {
    return { items: loadDataset(name) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { error: code === "ENOENT" ? NOT_FETCHED : error instanceof Error ? error.message : String(error) };
  }
}

export function listDatasets(dir = RUNS_DIR): DatasetInfo[] {
  const runs = listRuns(dir);
  return DATASETS.map((name) => {
    const { items, error } = tryLoad(name);
    return datasetInfo(name, items, runs, error);
  });
}

export function buildDatasetView(name: string, dir = RUNS_DIR): DatasetView {
  if (!DATASETS.includes(name as DatasetName)) throw new Error(`no dataset named ${name}`);
  const dataset = name as DatasetName;
  const { items, error } = tryLoad(dataset);
  if (!items) throw new Error(error);
  const runs = listRuns(dir).filter((r) => r.dataset === dataset);

  const byId = new Map<string, ItemRun[]>();
  for (const run of runs) {
    const output = run.outputs[0];
    if (!output) continue;
    const translator = run.llm ? `${run.llm.model} · ${run.llm.effort}` : run.translator;
    for (const record of readItems(dir, run.name)) {
      const list = byId.get(record.id) ?? [];
      list.push({ run: run.name, translator, output, incomplete: isIncomplete(record), goldOk: record.gold?.ok, score: record.scores[output] });
      byId.set(record.id, list);
    }
  }
  const suspects = new Map(loadSuspects().filter((s) => s.dataset === dataset && s.status !== "rejected").map((s) => [s.id, s]));
  return {
    info: datasetInfo(dataset, items, runs),
    items: items.map((i) => ({ ...i, ...(suspects.has(i.id) ? { suspect: suspects.get(i.id) } : {}), runs: byId.get(i.id) ?? [] })),
  };
}

/** Connect-style middleware; mount it under /__eval. */
export function evalViewerMiddleware(dir = RUNS_DIR) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/runs") return send(200, listRuns(dir));
      if (url.pathname === "/view") {
        const names = (url.searchParams.get("runs") ?? "").split(",").filter(Boolean);
        return send(200, buildView(names, url.searchParams.get("output") ?? undefined, dir));
      }
      if (url.pathname === "/datasets") return send(200, listDatasets(dir));
      if (url.pathname === "/dataset") return send(200, buildDatasetView(url.searchParams.get("name") ?? "", dir));
    } catch (error) {
      return send(400, { error: error instanceof Error ? error.message : String(error) });
    }
    next();
  };
}
