import { segmentPattern } from "@crochet-model/core";
import { createNodeValidator } from "@crochet-model/core/node";
import { describe, expect, it } from "vitest";
import { commentBlocks, countMismatches, documentRows, splitDocument, translateDocument } from "../src/document.ts";
import { assemble, type TranslateOptions } from "../src/loop.ts";
import type { RowTranslation } from "@crochet-model/core";
import type { ModelReply, ModelRequest, TranslatorModel, Turn } from "../src/model.ts";

const { validate } = createNodeValidator();

const reply = (cp: string, extra: Partial<ModelReply> = {}): ModelReply => {
  const text = JSON.stringify({ cp, assumptions: [] });
  return {
    raw: [{ type: "text", text }],
    text,
    stopReason: "end",
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 },
    model: "fake",
    ...extra,
  };
};

class Scripted implements TranslatorModel {
  readonly provider = "anthropic" as const;
  requests: ModelRequest[] = [];
  private replies: ModelReply[];
  constructor(replies: ModelReply[]) {
    this.replies = replies;
  }
  async send(request: ModelRequest): Promise<ModelReply> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.replies.shift();
    if (!next) throw new Error("no more replies");
    return next;
  }
}

const options = (model: TranslatorModel): TranslateOptions => ({
  model,
  modelName: "fake",
  effort: "medium",
  repairEffort: "high",
  validate,
  idPrefix: "t",
});

const input = (english: string) => ({ english, ...segmentPattern(english) });
const userText = (turn: Turn | undefined) => (turn?.role === "user" ? turn.blocks.map((b) => b.text).join("\n") : "");

const english = "Head\nRnd 1: 6 sc in magic ring. (6)\nRnd 2: Inc in each st around. (12)\nFasten off.";

describe("translateDocument", () => {
  it("sends the English as written and accepts a text that parses with the stated counts", async () => {
    const model = new Scripted([reply("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*sc2inc\n# Fasten off")]);
    const { pattern, requests } = await translateDocument(input(english), options(model));
    expect(requests).toBe(1);
    expect(userText(model.requests[0]!.messages[0])).toContain(english);
    expect(model.requests[0]!.system[0]!.text).toContain("whole translation in one piece");
    expect(pattern.translations.document!.status).toBe("valid");
    expect(assemble(pattern)).toBe("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*sc2inc\n# Fasten off");
  });

  it("sends the parser error with its line back", async () => {
    const model = new Scripted([
      reply("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*inc"),
      reply("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*sc2inc"),
    ]);
    const { pattern } = await translateDocument(input(english), options(model));
    const repair = userText(model.requests[1]!.messages.at(-1));
    expect(repair).toContain("6*inc");
    expect(repair).toContain("whole text");
    expect(model.requests[1]!.effort).toBe("high");
    expect(pattern.translations.document!.status).toBe("valid");
  });

  it("names the instructions that miss their stated count", async () => {
    const model = new Scripted([
      reply("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*sc2inc,sc"),
      reply("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*sc2inc"),
    ]);
    await translateDocument(input(english), options(model));
    const repair = userText(model.requests[1]!.messages.at(-1));
    expect(repair).toContain("Rnd 2: the English states 12, the parser counts 13");
    expect(repair).not.toContain("Rnd 1:");
  });

  it("keeps the best attempt when repairs do not help", async () => {
    const model = new Scripted([
      reply("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*sc2inc,sc"),
      reply("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*inc"),
      { ...reply(""), text: '{"cp": "# Rnd', stopReason: "max_tokens" },
    ]);
    const { pattern } = await translateDocument(input(english), options(model));
    expect(model.requests).toHaveLength(3);
    expect(pattern.translations.document!.status).toBe("count_mismatch");
    expect(pattern.translations.document!.attempts).toHaveLength(3);
    expect(assemble(pattern)).toContain("6*sc2inc,sc");
  });

  it("continues from given rows and returns only the rest", async () => {
    const step = input("Rnd 1: 6 sc in magic ring. (6)\nRnd 2: Inc in each st around. (12)");
    const [r1, r2] = step.rows;
    const model = new Scripted([reply("# Rnd 2\n6*sc2inc,sc")]);
    const { pattern } = await translateDocument(
      { ...step, given: { [r1!.id]: "ring.R\n6sc@R" } },
      { ...options(model), maxAttempts: 1 },
    );
    const sent = userText(model.requests[0]!.messages[0]);
    expect(sent).toContain("<accepted_cp>\nring.R\n6sc@R\n</accepted_cp>");
    expect(sent).toContain(`<pattern>\nRnd 2: ${r2!.text}\n</pattern>`);
    expect(assemble(pattern, { skipGiven: true })).toBe("# Rnd 2\n6*sc2inc,sc");
    expect(pattern.translations.document!.status).toBe("count_mismatch");
  });
});

describe("countMismatches", () => {
  it("matches comments to labels in order, across sections", () => {
    const { rows } = segmentPattern("Head\nRnd 1: 6 sc in magic ring. (6)\nArm\nRnd 1: 5 sc in magic ring. (5)");
    const cp = "# Rnd 1\nring.R\n6sc@R\n# Rnd 1\nstart_anew\nring.S\n6sc@S";
    expect(countMismatches("", cp, rows, validate)).toEqual(["Rnd 1: the English states 5, the parser counts 6 on its last line"]);
  });

  it("does not take Rnd 30 for Rnd 3", () => {
    const { rows } = segmentPattern("Rnd 3: Sc around. (18)");
    expect(countMismatches("", "# Rnd 30\nring.R\n6sc@R", rows, validate)).toEqual([]);
  });

  it("splits text at whole-line comments", () => {
    expect(commentBlocks("ring.R\n# Rnd 1\n6sc@R # six\n#Rnd 2\n")).toEqual([
      { body: "ring.R\n" },
      { header: "Rnd 1", body: "6sc@R # six\n" },
      { header: "Rnd 2", body: "\n" },
    ]);
  });
});

describe("splitDocument", () => {
  const { rows } = segmentPattern("Ch 4, join to form a ring.\nRnd 1: 12 dc in ring. (12)\nRnd 2: 2 dc in each st. (24)\nFasten off.");

  it("gives each row the lines under its comment, without the comment", () => {
    const split = splitDocument("# Ch 4\n4ch.R,ss@[%,0]\n# Rnd 1\n12dc@R\n# Rnd 2\n12*dc2inc\n# Fasten off", rows);
    expect([...split.values()]).toEqual(["4ch.R,ss@[%,0]", "12dc@R", "12*dc2inc"]);
  });

  it("puts lines under an unknown comment with the row before", () => {
    const split = splitDocument("# Rnd 1\n12dc@R\n# extra\n12sc", rows);
    expect(split.get(rows[1]!.id)).toBe("12dc@R\n12sc");
    expect(split.has(rows[2]!.id)).toBe(false);
  });
});

describe("documentRows", () => {
  const { rows } = segmentPattern("Rnd 1: 6 sc in magic ring. (6)\nRnd 2: Inc in each st around. (12)\nRnd 3: (Sc, inc) 6 times. (18)");
  const doc = (cp: string, extra: Partial<RowTranslation> = {}): RowTranslation => ({
    rowId: "document", cp, source: "llm", status: "valid", confidence: "medium", assumptions: [], attempts: [], ...extra,
  });

  it("checks each row against the rows before it", () => {
    const out = documentRows(doc("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*sc2inc,sc\n# Rnd 3\n6*[sc,sc2inc]"), rows, validate);
    expect(out.map((t) => [t.cp, t.status])).toEqual([
      ["ring.R\n6sc@R", "valid"],
      ["6*sc2inc,sc", "count_mismatch"],
      ["6*[sc,sc2inc]", "valid"],
    ]);
  });

  it("leaves a row that does not parse out of the prefix", () => {
    const out = documentRows(doc("# Rnd 1\nring.R\n6sc@R\n# Rnd 2\n6*inc\n# Rnd 3\n6*sc2inc"), rows, validate);
    expect(out.map((t) => t.status)).toEqual(["valid", "invalid", "count_mismatch"]);
  });

  it("flags a row with no lines, files assumptions by label, and keeps the user's rows", () => {
    const user: RowTranslation = { rowId: rows[0]!.id, cp: "ring.R\n6sc@R", source: "user", status: "valid", confidence: "high", assumptions: [], attempts: [] };
    const out = documentRows(
      doc("# Rnd 1\nring.R\n5sc@R\n# Rnd 2\n6*sc2inc\n6*[sc,sc2inc]", { assumptions: ["Rnd 2: inc read as sc2inc", "yarn colour not given"] }),
      rows,
      validate,
      { [rows[0]!.id]: user },
    );
    expect(out[0]).toMatchObject({ source: "user", cp: "ring.R\n6sc@R", status: "valid" });
    expect(out[0]!.assumptions).toEqual([]);
    expect(out[1]!.assumptions).toEqual(["Rnd 2: inc read as sc2inc"]);
    expect(out[2]).toMatchObject({ cp: "", status: "count_mismatch", confidence: "low" });
  });

  it("marks every row invalid when there is no text", () => {
    const out = documentRows(doc("", { status: "invalid" }), rows, validate);
    expect(out.map((t) => t.status)).toEqual(["invalid", "invalid", "invalid"]);
  });
});
