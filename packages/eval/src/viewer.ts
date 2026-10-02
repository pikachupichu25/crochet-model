// Run data for the eval results page (packages/app/eval.html). The app's dev
// server mounts `evalViewerMiddleware` under /__eval/; it reads the
// git-ignored run directories on each request, so nothing from the datasets is
// bundled into the app build.
//
//   GET /__eval/runs                       every run: config and summaries
//   GET /__eval/view?runs=a,b&output=name  those runs combined (below)
//
// Combining: a baseline on a rate-limited free model is spread over several
// runs of the same dataset. Each item comes from the latest selected run in
// which it is complete. An item is incomplete when a request failed (a 429,
// say) for any of its rows; it is shown, but left out of the summaries,
// because its score measures the provider, not the translator.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { loadDataset, type DatasetName } from "./datasets.ts";
import type { ItemRecord } from "./run.ts";
import { RUNS_DIR } from "./sources.ts";
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
 * Image links by item id, from the dataset as it is now: runs made before the
 * loader kept `imageUrl` do not record it. Empty when the data is not fetched.
 */
function imageUrls(dataset: string): Map<string, string> {
  try {
    return new Map(loadDataset(dataset as DatasetName).flatMap((i) => (i.imageUrl ? [[i.id, i.imageUrl] as const] : [])));
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
  const images = imageUrls(dataset);
  const byId = new Map<string, ViewItem>();
  for (const run of [...runs].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const record of readItems(dir, run.name)) {
      const imageUrl = record.item?.imageUrl ?? images.get(record.id);
      const item: ViewItem = { ...record, run: run.name, incomplete: isIncomplete(record), ...(imageUrl ? { imageUrl } : {}) };
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
    } catch (error) {
      return send(400, { error: error instanceof Error ? error.message : String(error) });
    }
    next();
  };
}
