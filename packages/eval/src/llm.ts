// The LLM translator in the evaluation (docs/SPEC.md §7.2): dataset items as
// translator input, questions answered from the gold, a cost estimate before
// the run, and every request and reply logged to the run directory.

import { appendFileSync } from "node:fs";
import {
  compareStructure,
  parseStitchGraph,
  segmentPattern,
  statedCount,
  type PatternRow,
  type Usage,
} from "@crochet-model/core";
import { createNodeValidator } from "@crochet-model/core/node";
import {
  assemble,
  systemPrompt,
  type Effort,
  type ModelReply,
  type ModelRequest,
  type QuestionContext,
  type TranslateInput,
  type TranslatorModel,
} from "@crochet-model/translator";
import type { EvalItem } from "./datasets.ts";
import { costOf } from "./pricing.ts";

const { validate } = createNodeValidator();

export interface LlmConfig {
  model: string;
  effort: Effort;
  repairEffort: Effort;
  mode: "row" | "whole";
  repair: boolean;
  batch: boolean;
  concurrency: number;
}

export interface ItemInput {
  input: TranslateInput;
  /** Gold CrochetPARADE per row, when the dataset has it row by row. */
  goldRows?: string[];
  /** The output scored: the whole pattern, or only the target of a step item. */
  output: (pattern: Parameters<typeof assemble>[0]) => string;
}

function lineRows(lines: string[]): PatternRow[] {
  return lines.map((text, i) => ({ id: `l${i + 1}`, label: "", text, span: 1, ...countOf(text) }));
}

function countOf(text: string) {
  const n = statedCount(text);
  return n === undefined ? {} : { statedCount: n };
}

export function itemInput(item: EvalItem): ItemInput {
  switch (item.dataset) {
    case "stitchswitch": {
      // English and gold have one line per row; keep that alignment.
      const english = item.english.split("\n").filter((l) => l.trim());
      const gold = item.gold!.split("\n").filter((l) => l.trim());
      const segmented = segmentPattern(item.english);
      const rows = segmented.rows.length === english.length ? segmented.rows : lineRows(english);
      return {
        input: { english: item.english, rows, notes: segmented.notes },
        goldRows: gold.length === rows.length ? gold : undefined,
        output: (p) => assemble(p),
      };
    }
    case "crochetbench-step": {
      const context = item.context ?? [];
      const asRow = (text: string, id: string): PatternRow => {
        const r = segmentPattern(text).rows[0];
        return { ...(r ?? { label: "", text, span: 1 }), id, section: undefined, ...countOf(text) };
      };
      const rows = [...context.map((c, i) => asRow(c.english, `s${i + 1}`)), asRow(item.english, "target")];
      if (item.statedCount !== undefined) rows[rows.length - 1]!.statedCount = item.statedCount;
      return {
        input: {
          english: [...context.map((c) => c.english), item.english].join("\n"),
          rows,
          notes: [],
          given: Object.fromEntries(context.map((c, i) => [`s${i + 1}`, c.cp])),
        },
        output: (p) => assemble(p, { skipGiven: true }),
      };
    }
    case "crochetbench-project": {
      const segmented = segmentPattern(item.english);
      return {
        input: { english: item.english, rows: segmented.rows, notes: segmented.notes },
        output: (p) => assemble(p),
      };
    }
  }
}

export interface QuestionLog {
  rowId: string;
  options: number;
  /** The option index whose CrochetPARADE gives the gold graph, if any. */
  correct?: number;
}

/**
 * Answers a question with the option whose CrochetPARADE, after the
 * accepted prefix, makes the same graph as the gold rows up to this one
 * (SPEC §7.3, metric 4). Without row-aligned gold, or with no such option,
 * the question goes unanswered and counts as a failure.
 */
export function goldAnswerer(goldRows: string[] | undefined, log: QuestionLog[]) {
  return (q: QuestionContext): number | undefined => {
    const entry: QuestionLog = { rowId: q.row.id, options: q.question.options.length };
    log.push(entry);
    if (!goldRows) return undefined;
    const gold = validate(goldRows.slice(0, q.rowIndex + 1).join("\n"));
    if (!gold.ok) return undefined;
    const goldGraph = parseStitchGraph(gold.graphJson!);
    for (const [i, option] of q.question.options.entries()) {
      if (option.cp === null) continue;
      const r = validate([q.prefix, option.cp].filter((t) => t.trim()).join("\n"));
      if (r.ok && compareStructure(goldGraph, parseStitchGraph(r.graphJson!)).exact) {
        entry.correct = i;
        return i;
      }
    }
    return undefined;
  };
}

/** Logs every request (without the shared system prompt) and reply to a file. */
export class LoggingModel implements TranslatorModel {
  private inner: TranslatorModel;
  private file: string;

  constructor(inner: TranslatorModel, file: string) {
    this.inner = inner;
    this.file = file;
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    const { system, format, ...rest } = request;
    void system;
    void format;
    try {
      const reply = await this.inner.send(request);
      appendFileSync(
        this.file,
        `${JSON.stringify({ request: rest, reply: { text: reply.text, stopReason: reply.stopReason, usage: reply.usage, model: reply.model } })}\n`,
      );
      return reply;
    } catch (error) {
      appendFileSync(this.file, `${JSON.stringify({ request: rest, error: String(error) })}\n`);
      throw error;
    }
  }
}

const OUTPUT_TOKENS: Record<Effort, number> = { low: 800, medium: 1500, high: 3000, xhigh: 5000, max: 8000 };

/**
 * A rough upper estimate, from characters (about 3.5 per token) and an
 * assumed output per request by effort. Real usage is in the run summary.
 */
export function estimateCost(items: EvalItem[], config: LlmConfig): { dollars?: number; requests: number; detail: string } {
  const systemTokens = systemPrompt().length / 3.5;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let requests = 0;
  const attempts = config.repair ? 1.5 : 1;
  for (const item of items) {
    const { input } = itemInput(item);
    const todo = input.rows.filter((r) => input.given?.[r.id] === undefined).length;
    const patternTokens = input.english.length / 3.5 + 15 * input.rows.length;
    const perPattern = config.mode === "row" ? Math.max(1, todo) * attempts : attempts;
    requests += perPattern;
    usage.cacheWriteTokens += patternTokens + systemTokens / Math.max(1, items.length);
    usage.cacheReadTokens += perPattern * (systemTokens + patternTokens);
    usage.inputTokens += perPattern * (300 + (input.english.length / 3.5) * 0.5);
    usage.outputTokens += perPattern * OUTPUT_TOKENS[config.effort] * (config.mode === "whole" ? Math.max(1, todo / 2) : 1);
  }
  const dollars = costOf(config.model, usage, config.batch);
  return {
    dollars,
    requests: Math.round(requests),
    detail: `~${Math.round(requests)} requests, ~${Math.round(usage.outputTokens / 1000)}k output tokens`,
  };
}
