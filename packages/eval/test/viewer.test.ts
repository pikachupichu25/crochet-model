import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ItemRecord } from "../src/run.ts";
import { buildView, isIncomplete, listRuns } from "../src/viewer.ts";

const OUT = "openrouter m medium row";

const record = (id: string, opts: { exact?: boolean; failed?: boolean } = {}): ItemRecord => ({
  id,
  name: id,
  ms: 1,
  outputs: { [OUT]: "6ch" },
  scores: {
    [OUT]: {
      nonEmpty: true,
      parses: true,
      structure: { exact: opts.exact ?? true, matched: 1, goldStitches: 1, outputStitches: 1, score: opts.exact === false ? 0.5 : 1 },
    },
  },
  rows: { found: 1, kept: opts.failed ? 0 : 1 },
  llm: {
    input: { english: "", rows: [], notes: [] } as never,
    answers: {},
    promptVersion: "p",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    requests: 1,
    models: ["m"],
    questions: [],
    statuses: {},
    translations: [
      {
        rowId: "r1",
        cp: "",
        source: "llm",
        status: opts.failed ? "invalid" : "valid",
        confidence: "high",
        assumptions: [],
        attempts: opts.failed
          ? [{ cp: "", validation: { ok: false, rows: [], warnings: [] }, provider: "openrouter", model: "m", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, rejected: "request failed" }]
          : [],
      },
    ] as never,
  },
});

function writeRun(dir: string, name: string, records: ItemRecord[], dataset = "stitchswitch") {
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, "config.json"), JSON.stringify({ translator: "llm", dataset, items: records.length, promptVersion: "p" }));
  writeFileSync(join(dir, name, "summary.json"), JSON.stringify({ summaries: [{ dataset, output: OUT, items: records.length }] }));
  writeFileSync(join(dir, name, "items.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("eval viewer", () => {
  it("lists runs newest first with their outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    writeRun(dir, "20261001-a", [record("ss-001")]);
    writeRun(dir, "20261002-b", [record("ss-002")]);
    expect(listRuns(dir).map((r) => [r.name, r.outputs])).toEqual([
      ["20261002-b", [OUT]],
      ["20261001-a", [OUT]],
    ]);
  });

  it("combines runs: a later complete result replaces a failed one, never the reverse", () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    writeRun(dir, "20261001-a", [record("ss-001"), record("ss-002", { failed: true }), record("ss-003", { exact: false })]);
    writeRun(dir, "20261002-b", [record("ss-002"), record("ss-003", { failed: true })]);
    const view = buildView(["20261002-b", "20261001-a"], undefined, dir);
    expect(view.items.map((i) => [i.id, i.run, i.incomplete])).toEqual([
      ["ss-001", "20261001-a", false],
      ["ss-002", "20261002-b", false],
      ["ss-003", "20261001-a", false],
    ]);
    expect(view.incomplete).toEqual([]);
    expect(view.summaries[0]!.items).toBe(3);
  });

  it("keeps items with failed requests out of the summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    writeRun(dir, "20261001-a", [record("ss-001"), record("ss-002", { failed: true })]);
    const view = buildView(["20261001-a"], undefined, dir);
    expect(isIncomplete(view.items[1]!)).toBe(true);
    expect(view.incomplete).toEqual(["ss-002"]);
    expect(view.summaries[0]!.items).toBe(1);
  });

  it("refuses runs of different datasets", () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    writeRun(dir, "20261001-a", [record("ss-001")]);
    writeRun(dir, "20261001-b", [record("step-001")], "crochetbench-step");
    expect(() => buildView(["20261001-a", "20261001-b"], undefined, dir)).toThrow(/share a dataset/);
  });
});
