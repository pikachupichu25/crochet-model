import type Anthropic from "@anthropic-ai/sdk";
import { segmentPattern } from "@crochet-model/core";
import { createNodeValidator } from "@crochet-model/core/node";
import { describe, expect, it } from "vitest";
import { assemble, translatePattern, translateWhole, type TranslateOptions } from "../src/loop.ts";
import { ModelError, type ModelReply, type ModelRequest, type TranslatorModel, type Turn } from "../src/model.ts";
import { BatchModel } from "../src/providers/anthropic.ts";
import type { RowResponse } from "../src/schema.ts";

const { validate } = createNodeValidator();

const reply = (r: Partial<RowResponse> | object, extra: Partial<ModelReply> = {}): ModelReply => {
  const body = "rows" in r ? r : { cp: "", expectedCount: null, confidence: "high", assumptions: [], question: null, amendPrevious: [], ...r };
  const text = JSON.stringify(body);
  return {
    raw: [{ type: "text", text }],
    text,
    stopReason: "end",
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 },
    model: "fake",
    ...extra,
  };
};

/** Replies in order; records every request. */
class Scripted implements TranslatorModel {
  readonly provider = "anthropic" as const;
  requests: ModelRequest[] = [];
  private replies: ModelReply[];
  constructor(replies: ModelReply[]) {
    this.replies = replies;
  }
  async send(request: ModelRequest): Promise<ModelReply> {
    // A copy: the loop appends to the same messages array afterwards.
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.replies.shift();
    if (!next) throw new Error("no more replies");
    return next;
  }
}

const options = (model: TranslatorModel, extra: Partial<TranslateOptions> = {}): TranslateOptions => ({
  model,
  modelName: "fake",
  effort: "medium",
  repairEffort: "high",
  validate,
  idPrefix: "t",
  ...extra,
});

const input = (english: string) => ({ english, ...segmentPattern(english) });

/** The text of a user turn's blocks. */
const userText = (turn: Turn | undefined) => (turn?.role === "user" ? turn.blocks.map((b) => b.text).join("\n") : "");

describe("translatePattern", () => {
  it("translates row by row and accepts rows that parse with the stated count", async () => {
    const model = new Scripted([reply({ cp: "7ch,turn" }), reply({ cp: "sk,6sc,turn", expectedCount: 6 })]);
    const { pattern, usage, requests } = await translatePattern(
      input("Row 1: Ch 7.\nRow 2: Sc in 2nd ch from hook and across, turn. (6)"),
      options(model),
    );
    expect(Object.values(pattern.translations).map((t) => t.status)).toEqual(["valid", "valid"]);
    expect(assemble(pattern)).toBe("7ch,turn\nsk,6sc,turn");
    expect(requests).toBe(2);
    expect(usage.inputTokens).toBe(200);
    expect(pattern.promptVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it("caches the system prompt and the pattern, and shows accepted rows with parser counts", async () => {
    const model = new Scripted([reply({ cp: "7ch,turn" }), reply({ cp: "sk,6sc,turn" })]);
    await translatePattern(input("Row 1: Ch 7.\nRow 2: Sc across. (6)"), options(model));
    const second = model.requests[1]!;
    expect(second.system[0]!.cache).toBe(true);
    const [patternBlock, rowBlock] = (second.messages[0] as Extract<Turn, { role: "user" }>).blocks;
    expect(patternBlock!.cache).toBe(true);
    expect(patternBlock!.text).toContain("Row 2: Sc across. (6)");
    expect(rowBlock!.cache).toBe(false);
    expect(rowBlock!.text).toContain("(parser row 0: 7 stitches)\n7ch,turn");
    expect(rowBlock!.text).toContain("states a count of 6");
    // The first two blocks are byte-identical across rows, so they hit the cache.
    expect((model.requests[0]!.messages[0] as Extract<Turn, { role: "user" }>).blocks).toContainEqual(patternBlock);
  });

  it("repairs a parse error by appending to the conversation, at the repair effort", async () => {
    const model = new Scripted([reply({ cp: "5ch,turn" }), reply({ cp: "sk,4slst" }), reply({ cp: "sk,4ss" })]);
    const { pattern } = await translatePattern(input("Row 1: Ch 5.\nRow 2: Sl st across."), options(model));
    const row2 = pattern.translations[pattern.rows[1]!.id]!;
    expect(row2).toMatchObject({ status: "valid", cp: "sk,4ss" });
    expect(row2.attempts.map((a) => a.rejected)).toEqual(["parse error", undefined]);
    const repair = model.requests[2]!;
    expect(repair.effort).toBe("high");
    expect(repair.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(userText(repair.messages[2])).toContain("Stitch type not defined");
  });

  it("repairs a count mismatch, allowing for an uncounted beginning chain", async () => {
    const model = new Scripted([
      reply({ cp: "5ch,turn" }),
      reply({ cp: "sk,4sc,turn" }),
      reply({ cp: "ch,3sc" }), // 3 sc for a stated 4
      reply({ cp: "ch,4sc" }),
    ]);
    const { pattern } = await translatePattern(
      input("Row 1: Ch 5.\nRow 2: Sc across, ch 1, turn. (4)\nRow 3: Sc across. (4)"),
      options(model),
    );
    const row3 = pattern.translations[pattern.rows[2]!.id]!;
    expect(row3).toMatchObject({ status: "valid", cp: "ch,4sc" });
    expect(row3.attempts[0]!.rejected).toBe("count 3, stated 4");
    expect(userText(model.requests[3]!.messages.at(-1))).toContain(
      "states 4 stitches and the parser counts 4 on its last line (3 allowing for the 1 beginning chain)",
    );
  });

  it("accepts a count the model says differs on purpose, as count_mismatch", async () => {
    const model = new Scripted([reply({ cp: "12ch,turn" }), reply({ cp: "3sk,9dc", expectedCount: 9, assumptions: ["skipped chains count as a dc"] })]);
    const { pattern } = await translatePattern(input("Row 1: Ch 12.\nRow 2: Dc in 4th ch from hook and across. (10)"), options(model));
    expect(pattern.translations[pattern.rows[1]!.id]).toMatchObject({ status: "count_mismatch", cp: "3sk,9dc" });
    expect(model.requests).toHaveLength(2);
  });

  it("keeps the best attempt: a parsing one joins the prefix, a failing one does not", async () => {
    const model = new Scripted([
      reply({ cp: "5ch,turn" }),
      reply({ cp: "sk,2sc" }),
      reply({ cp: "sk,3sc" }),
      reply({ cp: "sk,xx" }),
      reply({ cp: "bad1" }),
      reply({ cp: "bad2" }),
      reply({ cp: "bad3" }),
    ]);
    const { pattern } = await translatePattern(
      input("Row 1: Ch 5.\nRow 2: Sc across. (4)\nRow 3: Sc across."),
      options(model),
    );
    const [, row2, row3] = pattern.rows.map((r) => pattern.translations[r.id]!);
    expect(row2).toMatchObject({ status: "count_mismatch", cp: "sk,3sc" });
    expect(row3!.status).toBe("invalid");
    expect(assemble(pattern)).toBe("5ch,turn\nsk,3sc");
  });

  it("makes one attempt per row when repair is off", async () => {
    const model = new Scripted([reply({ cp: "5ch,turn" }), reply({ cp: "sk,4slst" })]);
    const { pattern } = await translatePattern(input("Row 1: Ch 5.\nRow 2: Sl st across."), options(model, { maxAttempts: 1 }));
    expect(pattern.translations[pattern.rows[1]!.id]!.status).toBe("invalid");
    expect(model.requests).toHaveLength(2);
  });

  it("applies an amendment that only adds a label", async () => {
    const model = new Scripted([
      reply({ cp: "7ch,turn" }),
      reply({ cp: "sk,sc,3ch,2sk,2sc,turn" }),
      reply({ cp: "ch,sc,3sc@A,2sc", amendPrevious: [{ rowId: "", cp: "" }] }),
    ]);
    const { rows } = input("Row 1: Ch 7.\nRow 2: Sc, ch 3, sk 2, 2 sc, turn.\nRow 3: Ch 1, sc, 3 sc in ch-3 sp, 2 sc.");
    // Fill in the real row id of Row 2.
    const amend = reply({ cp: "ch,sc,3sc@A,2sc", amendPrevious: [{ rowId: rows[1]!.id, cp: "sk,sc,3ch.A,2sk,2sc,turn" }] });
    (model as unknown as { replies: ModelReply[] }).replies[2] = amend;
    const { pattern } = await translatePattern({ english: "", rows, notes: [] }, options(model));
    expect(assemble(pattern)).toBe("7ch,turn\nsk,sc,3ch.A,2sk,2sc,turn\nch,sc,3sc@A,2sc");
    expect(pattern.translations[rows[1]!.id]!.assumptions).toContain(`labels added for row [${rows[2]!.id}]`);
  });

  it("rejects an amendment that changes stitches", async () => {
    const english = "Row 1: Ch 7.\nRow 2: Sc across, turn.\nRow 3: Sc across.";
    const { rows } = input(english);
    const model = new Scripted([
      reply({ cp: "7ch,turn" }),
      reply({ cp: "sk,6sc,turn" }),
      reply({ cp: "6sc", amendPrevious: [{ rowId: rows[1]!.id, cp: "sk,5sc,turn" }] }),
      reply({ cp: "6sc" }),
    ]);
    const { pattern } = await translatePattern({ english, rows, notes: [] }, options(model));
    expect(pattern.translations[rows[2]!.id]!.attempts[0]!.rejected).toBe("amendment rejected");
    expect(assemble(pattern)).toBe("7ch,turn\nsk,6sc,turn\n6sc");
  });

  it("uses the answer to a question when one is given, and records it", async () => {
    const question = {
      text: "Where do the decreases go?",
      options: [
        { label: "start of each repeat", cp: "6*[sc2tog,sc]" },
        { label: "end of each repeat", cp: "6*[sc,sc2tog]" },
      ],
    };
    const model = new Scripted([reply({ cp: "ring.R\n6sc@R\n6*sc2inc\n6*[sc,sc2inc]" }), reply({ cp: "6*[sc2tog,sc]", question })]);
    const english = "Rnd 1-4: work to 18 sts (18)\nRnd 5: Dec 6 times evenly. (12)";
    const answered = await translatePattern(input(english), options(model, { answer: () => 1 }));
    const row = answered.pattern.translations[answered.pattern.rows[1]!.id]!;
    expect(row).toMatchObject({ status: "valid", cp: "6*[sc,sc2tog]" });
    expect(row.question!.answer).toBe(1);

    const again = new Scripted([reply({ cp: "ring.R\n6sc@R\n6*sc2inc\n6*[sc,sc2inc]" }), reply({ cp: "6*[sc2tog,sc]", question })]);
    const open = await translatePattern(input(english), options(again));
    expect(open.pattern.translations[open.pattern.rows[1]!.id]).toMatchObject({ status: "needs_answer", cp: "6*[sc2tog,sc]" });
  });

  it("uses given rows as they are and translates only the rest", async () => {
    const { rows } = input("Row 1: Ch 7.\nRow 2: Sc across, turn. (6)");
    const model = new Scripted([reply({ cp: "sk,6sc,turn" })]);
    const { pattern } = await translatePattern({ english: "", rows, notes: [], given: { [rows[0]!.id]: "7ch,turn" } }, options(model));
    expect(model.requests).toHaveLength(1);
    expect(pattern.translations[rows[0]!.id]!.source).toBe("gold");
    expect(assemble(pattern, { skipGiven: true })).toBe("sk,6sc,turn");
  });

  it("rejects an amendment to a given row", async () => {
    const english = "Row 1: Ch 7.\nRow 2: Sc, ch 3, sk 2, 2 sc, turn.\nRow 3: Ch 1, sc, 3 sc in ch-3 sp, 2 sc.";
    const { rows } = input(english);
    const given = { [rows[0]!.id]: "7ch,turn", [rows[1]!.id]: "sk,sc,3ch,2sk,2sc,turn" };
    const model = new Scripted([
      reply({ cp: "ch,sc,3sc@A,2sc", amendPrevious: [{ rowId: rows[1]!.id, cp: "sk,sc,3ch.A,2sk,2sc,turn" }] }),
      reply({ cp: "ch,sc,3sc@[1,2],2sc" }),
    ]);
    const { pattern } = await translatePattern({ english, rows, notes: [], given }, options(model));
    expect(pattern.translations[rows[2]!.id]!.attempts[0]!.rejected).toBe("amendment rejected");
    expect(pattern.translations[rows[1]!.id]!.cp).toBe("sk,sc,3ch,2sk,2sc,turn");
    const rowBlock = (model.requests[0]!.messages[0] as Extract<Turn, { role: "user" }>).blocks[1]!.text;
    expect(rowBlock).toContain("given, cannot be amended");
  });

  it("flags but does not repair a count mismatch after an invalid row", async () => {
    const model = new Scripted([
      reply({ cp: "5ch,turn" }),
      reply({ cp: "bad1" }),
      reply({ cp: "bad2" }),
      reply({ cp: "bad3" }),
      reply({ cp: "sk,3sc" }), // stated 4
    ]);
    const { pattern } = await translatePattern(
      input("Row 1: Ch 5.\nRow 2: Sc across, turn.\nRow 3: Sc across. (4)"),
      options(model),
    );
    const [, row2, row3] = pattern.rows.map((r) => pattern.translations[r.id]!);
    expect(row2!.status).toBe("invalid");
    expect(row3).toMatchObject({ status: "count_mismatch", cp: "sk,3sc" });
    expect(row3!.attempts).toHaveLength(1);
    expect(model.requests).toHaveLength(5);
  });

  it("stops on a rejected key, and records a retryable error as a failed attempt", async () => {
    const failing = (error: Error): TranslatorModel => ({
      provider: "openrouter",
      send: async () => {
        throw error;
      },
    });
    await expect(
      translatePattern(input("Row 1: Ch 7."), options(failing(new ModelError("openrouter", "key_rejected", "bad key")))),
    ).rejects.toThrow("openrouter: key_rejected: bad key");
    const { pattern } = await translatePattern(
      input("Row 1: Ch 7."),
      options(failing(new ModelError("openrouter", "retryable", "overloaded"))),
    );
    const row = pattern.translations[pattern.rows[0]!.id]!;
    expect(row.status).toBe("invalid");
    expect(row.attempts[0]).toMatchObject({ provider: "openrouter", rejected: "request failed" });
    expect(pattern.provider).toBe("openrouter");
  });

  it("marks a refused row invalid without retrying", async () => {
    const model = new Scripted([reply({ cp: "" }, { stopReason: "refusal", text: "" })]);
    const { pattern } = await translatePattern(input("Row 1: Ch 7."), options(model));
    expect(pattern.translations[pattern.rows[0]!.id]!.status).toBe("invalid");
    expect(model.requests).toHaveLength(1);
  });
});

describe("translateWhole", () => {
  it("translates every row in one request and repairs the whole", async () => {
    const { rows } = input("Row 1: Ch 5.\nRow 2: Sc across. (4)");
    const model = new Scripted([
      reply({ rows: [{ rowId: rows[0]!.id, cp: "5ch,turn" }, { rowId: rows[1]!.id, cp: "sk,4slst" }], assumptions: [] }),
      reply({ rows: [{ rowId: rows[0]!.id, cp: "5ch,turn" }, { rowId: rows[1]!.id, cp: "sk,4sc" }], assumptions: [] }),
    ]);
    const { pattern } = await translateWhole({ english: "", rows, notes: [] }, options(model));
    expect(model.requests).toHaveLength(2);
    expect(assemble(pattern)).toBe("5ch,turn\nsk,4sc");
    expect(Object.values(pattern.translations).map((t) => t.status)).toEqual(["valid", "valid"]);
  });

  it("asks for every row again after an unusable response", async () => {
    const { rows } = input("Row 1: Ch 5.\nRow 2: Sc across. (4)");
    const model = new Scripted([
      { ...reply({ rows: [], assumptions: [] }), text: "{\"rows\": [", stopReason: "max_tokens" },
      reply({ rows: [{ rowId: rows[0]!.id, cp: "5ch,turn" }, { rowId: rows[1]!.id, cp: "sk,4sc" }], assumptions: [] }),
    ]);
    const { pattern } = await translateWhole({ english: "", rows, notes: [] }, options(model));
    const repair = userText(model.requests[1]!.messages.at(-1));
    expect(repair).toContain("cut off at the token limit");
    expect(repair).toContain("for every row");
    expect(assemble(pattern)).toBe("5ch,turn\nsk,4sc");
  });

  it("does not blame a stated count on an earlier row's stitches", async () => {
    const { rows } = input("Row 1: Ch 5.\nRow 2: Sc across, turn.\nRow 3: Fasten off. (7)");
    const model = new Scripted([
      reply({ rows: [{ rowId: rows[0]!.id, cp: "5ch,turn" }, { rowId: rows[1]!.id, cp: "sk,4sc,turn" }, { rowId: rows[2]!.id, cp: "" }], assumptions: [] }),
    ]);
    await translateWhole({ english: "", rows, notes: [] }, options(model));
    expect(model.requests).toHaveLength(1);
  });

  it("keeps the best attempt when later repairs get worse", async () => {
    const { rows } = input("Row 1: Ch 5.\nRow 2: Sc across. (4)");
    const whole = (cp2: string) =>
      reply({ rows: [{ rowId: rows[0]!.id, cp: "5ch,turn" }, { rowId: rows[1]!.id, cp: cp2 }], assumptions: [] });
    const model = new Scripted([whole("sk,3sc"), whole("sk,4slst"), whole("sk,4xx")]);
    const { pattern } = await translateWhole({ english: "", rows, notes: [] }, options(model));
    expect(model.requests).toHaveLength(3);
    expect(assemble(pattern)).toBe("5ch,turn\nsk,3sc");
    expect(Object.values(pattern.translations).map((t) => t.status)).toEqual(["valid", "count_mismatch"]);
  });
});

describe("BatchModel", () => {
  it("sends one batch per round of rows across patterns", async () => {
    const created: string[][] = [];
    const replies = new Map<string, ModelReply>();
    const fakeClient = {
      messages: {
        batches: {
          async create({ requests }: { requests: { custom_id: string; params: { messages: Anthropic.MessageParam[] } }[] }) {
            created.push(requests.map((r) => r.custom_id));
            for (const r of requests) {
              const block = (r.params.messages[0]!.content as Anthropic.TextBlockParam[])[1]!.text;
              const cp = block.includes("Ch 5") ? "5ch,turn" : block.includes("Ch 3") ? "3ch,turn" : "sk,sc";
              replies.set(r.custom_id, reply({ cp }));
            }
            return { id: `b${created.length}`, processing_status: "ended" };
          },
          async retrieve() {
            return { processing_status: "ended" };
          },
          async results() {
            const ids = created.at(-1)!;
            return (async function* () {
              for (const id of ids) {
                const r = replies.get(id)!;
                yield {
                  custom_id: id,
                  result: {
                    type: "succeeded",
                    message: { content: r.raw, stop_reason: "end_turn", model: "fake", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
                  },
                };
              }
            })();
          },
        },
      },
    };
    const model = new BatchModel({ client: fakeClient as unknown as Anthropic, pollMs: 1 });
    const patterns = ["Row 1: Ch 5.\nRow 2: Sc.", "Row 1: Ch 3.\nRow 2: Sc."];
    const results = await model.all(
      patterns.map((english, i) => () => translatePattern(input(english), options(model, { idPrefix: `p${i}` }))),
    );
    expect(created).toHaveLength(2);
    expect(created[0]).toHaveLength(2);
    expect(results.map((r) => assemble(r.pattern))).toEqual(["5ch,turn\nsk,sc", "3ch,turn\nsk,sc"]);
  });

  it("throws on an invalid request in a batch, and records an expired one as a failed attempt", async () => {
    const run = async (result: object) => {
      const ids: string[] = [];
      const fakeClient = {
        messages: {
          batches: {
            async create({ requests }: { requests: { custom_id: string }[] }) {
              ids.push(...requests.map((r) => r.custom_id));
              return { id: "b1", processing_status: "ended" };
            },
            async results() {
              return (async function* () {
                for (const custom_id of ids.splice(0)) yield { custom_id, result };
              })();
            },
          },
        },
      };
      const model = new BatchModel({ client: fakeClient as unknown as Anthropic, pollMs: 1 });
      return model.all([() => translatePattern(input("Row 1: Ch 5."), options(model))]);
    };
    const errored = { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "bad effort" } } };
    await expect(run(errored)).rejects.toThrow("invalid_request_error: bad effort");
    const [expired] = await run({ type: "expired" });
    expect(expired!.pattern.translations[expired!.pattern.rows[0]!.id]!.status).toBe("invalid");
  });
});
