import { createNodeValidator } from "@crochet-model/core/node";
import {
  anthropicError,
  isFatal,
  ModelError,
  translatePattern,
  type ModelReply,
  type ModelRequest,
  type TranslatorModel,
} from "@crochet-model/translator";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { EvalItem } from "../src/datasets.ts";
import { estimateCost, goldAnswerer, itemInput, type LlmConfig, type QuestionLog } from "../src/llm.ts";
import { costOf, priceOf } from "../src/pricing.ts";
import { scoreItem } from "../src/score.ts";

const { validate } = createNodeValidator();

const item = (over: Partial<EvalItem>): EvalItem => ({ dataset: "stitchswitch", id: "t", name: "t", english: "", ...over });

/** Replies with the cp for each target row, looked up by the row's text. */
class ByRow implements TranslatorModel {
  readonly provider = "anthropic" as const;
  requests: ModelRequest[] = [];
  private answers: [string, object][];
  constructor(answers: [string, object][]) {
    this.answers = answers;
  }
  async send(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const first = request.messages[0]!;
    const block = first.role === "user" ? first.blocks[1]!.text : "";
    const target = block.slice(block.indexOf("Translate row"));
    const found = this.answers.find(([key]) => target.includes(key));
    const body = { cp: "", expectedCount: null, confidence: "high", assumptions: [], question: null, amendPrevious: [], ...found?.[1] };
    const text = JSON.stringify(body);
    return {
      raw: [{ type: "text", text }],
      text,
      stopReason: "end",
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 4000, cacheWriteTokens: 0 },
      model: "claude-opus-5-5",
    };
  }
}

const config: LlmConfig = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: "medium",
  repairEffort: "high",
  mode: "row",
  repair: true,
  batch: false,
  concurrency: 1,
};

describe("itemInput", () => {
  it("keeps StitchSwitch rows aligned with the gold lines", () => {
    const { input, goldRows } = itemInput(
      item({ english: "Row 1: Ch 7\nRow 2: 6 sc, turn (6)", gold: "7ch, turn\n6sc" }),
    );
    expect(input.rows.map((r) => [r.label, r.statedCount])).toEqual([["Row 1", undefined], ["Row 2", 6]]);
    expect(goldRows).toEqual(["7ch, turn", "6sc"]);
  });

  it("gives a step item its gold prefix and scores only the target", async () => {
    const step = item({
      dataset: "crochetbench-step",
      english: "2nd row: Ch 1. Sc in each st across. Turn. 6 sts.",
      context: [
        { english: "Ch 7.", cp: "7ch,turn" },
        { english: "1st row: Sc in 2nd ch from hook and each ch across. Turn.", cp: "sk,6sc,turn" },
      ],
      statedCount: 6,
    });
    const { input, output } = itemInput(step);
    expect(input.rows.map((r) => r.id)).toEqual(["s1", "s2", "target"]);
    expect(input.given).toEqual({ s1: "7ch,turn", s2: "sk,6sc,turn" });
    const model = new ByRow([["Ch 1. Sc in each st", { cp: "ch,6sc,turn" }]]);
    const result = await translatePattern(input, { model, modelName: "claude-opus-5-5", effort: "medium", repairEffort: "high", validate, idPrefix: "x" });
    expect(model.requests).toHaveLength(1);
    const text = output(result.pattern);
    expect(text).toBe("ch,6sc,turn");
    expect(scoreItem(step, text)).toMatchObject({ parses: true, counts: { matched: 1 } });
  });
});

describe("goldAnswerer", () => {
  it("picks the option that makes the gold graph, and logs the question", () => {
    const log: QuestionLog[] = [];
    const answer = goldAnswerer(["8ch,turn", "sk,sc,sc2tog,2sc,sc2tog"], log);
    const question = {
      text: "Where do the decreases go?",
      options: [
        { label: "first", cp: "sk,sc2tog,sc2tog,3sc" },
        { label: "spread", cp: "sk,sc,sc2tog,2sc,sc2tog" },
        { label: "ask the designer", cp: null },
      ],
    };
    const row = { id: "r2", label: "Row 2", text: "", span: 1 };
    expect(answer({ row, rowIndex: 1, question, prefix: "8ch,turn" })).toBe(1);
    expect(log).toEqual([{ rowId: "r2", options: 3, correct: 1 }]);
  });

  it("leaves a question unanswered without row-aligned gold", () => {
    const log: QuestionLog[] = [];
    const row = { id: "r2", label: "", text: "", span: 1 };
    const q = { text: "?", options: [{ label: "a", cp: "6sc" }, { label: "b", cp: "5sc" }] };
    expect(goldAnswerer(undefined, log)({ row, rowIndex: 0, question: q, prefix: "" })).toBeUndefined();
    expect(log).toEqual([{ rowId: "r2", options: 2 }]);
  });
});

describe("cost", () => {
  it("prices usage per model, and halves it for batches", () => {
    const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0 };
    const opus = priceOf("anthropic", "claude-opus-5-5");
    expect(costOf(opus, usage, false)).toBeCloseTo(24.2);
    expect(costOf(opus, usage, true)).toBeCloseTo(12.1);
    expect(priceOf("anthropic", "unknown-model")).toBeUndefined();
    expect(costOf(undefined, usage, false)).toBeUndefined();
  });

  it("uses a listed price when none is on file, with cache reads at the input price by default", () => {
    const listed = { input: 2, output: 10 };
    expect(priceOf("openrouter", "a/b", listed)).toBe(listed);
    const usage = { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 0 };
    expect(costOf(listed, usage, false)).toBeCloseTo(4);
  });

  it("estimates a run before it starts", () => {
    const items = [item({ english: "Row 1: Ch 7\nRow 2: 6 sc", gold: "7ch\n6sc" })];
    const e = estimateCost(items, config, priceOf("anthropic", "claude-opus-5-5"));
    expect(e.requests).toBe(3);
    expect(e.dollars).toBeGreaterThan(0);
    expect(estimateCost(items, { ...config, batch: true }, priceOf("anthropic", "claude-opus-5-5")).dollars).toBeCloseTo(e.dollars! / 2);
    expect(estimateCost(items, { ...config, provider: "gemini", model: "gemini-3-pro-preview" }, undefined).dollars).toBeUndefined();
  });
});

describe("isFatal", () => {
  it("stops on bad requests and authentication, not on transient failures", () => {
    const api = (status: number) => anthropicError(Anthropic.APIError.generate(status, { error: { message: "x" } }, "x", new Headers()));
    expect(isFatal(api(400))).toBe(true);
    expect(isFatal(api(401))).toBe(true);
    expect(isFatal(api(429))).toBe(false);
    expect(isFatal(api(529))).toBe(false);
    expect(isFatal(anthropicError(new Anthropic.APIConnectionError({ message: "down" })))).toBe(false);
    expect(isFatal(new Error("batch request expired"))).toBe(false);
    expect(isFatal(new ModelError("gemini", "no_credit", "quota"))).toBe(true);
  });
});
