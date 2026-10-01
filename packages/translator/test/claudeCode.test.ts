import { readFileSync } from "node:fs";
import { segmentPattern } from "@crochet-model/core";
import { createNodeValidator } from "@crochet-model/core/node";
import { describe, expect, it } from "vitest";
import { translatePattern } from "../src/loop.ts";
import { ModelError, type ModelRequest } from "../src/model.ts";
import { ClaudeCodeModel, claudeCodeStatus, type RunResult, type Runner } from "../src/providers/claudeCode.ts";
import { outputFormat, RowResponse } from "../src/schema.ts";

const { validate } = createNodeValidator();
const schema = outputFormat(RowResponse).schema;

/** A CLI result as `claude -p --output-format json` prints it. */
const success = (answer: object, sessionId = "s1", extra: object = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(answer),
    structured_output: answer,
    stop_reason: "end_turn",
    session_id: sessionId,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 },
    modelUsage: { "claude-opus-5-5": {} },
    ...extra,
  });

/** The error result the CLI printed on 2026-10-01 with an expired login. */
const expiredLogin = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  terminal_reason: "api_error",
  api_error_status: null,
  session_id: "x",
});

/** Answers each run with the next output; records arguments and stdin. */
function fake(outputs: string[]): { run: Runner; calls: { args: string[]; input: string; cwd: string }[] } {
  const calls: { args: string[]; input: string; cwd: string }[] = [];
  const run: Runner = async (args, input, cwd): Promise<RunResult> => {
    calls.push({ args, input, cwd });
    return { stdout: outputs.shift() ?? "", stderr: "", code: 0 };
  };
  return { run, calls };
}

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  id: "r1",
  model: "claude-opus-5-5",
  effort: "medium",
  system: [{ text: "SYSTEM", cache: true }],
  messages: [{ role: "user", blocks: [{ text: "PATTERN", cache: true }, { text: "ROW", cache: false }] }],
  schema,
  maxTokens: 1000,
  ...over,
});

describe("ClaudeCodeModel", () => {
  it("runs claude -p with our system prompt, no tools, safe mode and the schema", async () => {
    const { run, calls } = fake([success({ cp: "7ch" })]);
    const model = new ClaudeCodeModel({ run });
    const reply = await model.send(request());
    const { args, input, cwd } = calls[0]!;
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(flag(args, "--tools")).toBe("");
    expect(flag(args, "--model")).toBe("claude-opus-5-5");
    expect(flag(args, "--effort")).toBe("medium");
    expect(JSON.parse(flag(args, "--json-schema")!)).toEqual(schema);
    expect(readFileSync(flag(args, "--system-prompt-file")!, "utf8")).toBe("SYSTEM");
    expect(args).not.toContain("--resume");
    expect(input).toBe("PATTERN\n\nROW");
    expect(cwd).toMatch(/crochet-claude-code-/);
    expect(reply).toMatchObject({
      text: JSON.stringify({ cp: "7ch" }),
      raw: { sessionId: "s1" },
      stopReason: "end",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3000, cacheWriteTokens: 500 },
      model: "claude-opus-5-5",
    });
    expect(reply.costUsd).toBeUndefined();
  });

  it("resumes the session for a follow-up, sending only the new message", async () => {
    const { run, calls } = fake([success({ cp: "x" }, "s2")]);
    const model = new ClaudeCodeModel({ run });
    await model.send(
      request({
        messages: [
          { role: "user", blocks: [{ text: "PATTERN", cache: true }] },
          { role: "assistant", text: "{}", raw: { sessionId: "s1" } },
          { role: "user", blocks: [{ text: "REPAIR", cache: false }] },
        ],
      }),
    );
    expect(flag(calls[0]!.args, "--resume")).toBe("s1");
    expect(calls[0]!.input).toBe("REPAIR");
  });

  it("refuses a follow-up without the session before it, and gives Haiku no effort", async () => {
    const model = new ClaudeCodeModel({ run: fake([]).run });
    await expect(
      model.send(request({ messages: [{ role: "assistant", text: "{}" }, { role: "user", blocks: [{ text: "R", cache: false }] }] })),
    ).rejects.toMatchObject({ kind: "bad_request" });
    expect(model.args(request({ model: "haiku" })).args).not.toContain("--effort");
  });

  it("falls back to the result text without structured output", async () => {
    const { run } = fake([JSON.stringify({ subtype: "success", is_error: false, result: "{\"cp\":\"\"}", session_id: "s" })]);
    expect((await new ClaudeCodeModel({ run }).send(request())).text).toBe("{\"cp\":\"\"}");
  });

  it("sorts error results: login, plan limit, API status, unreadable output", async () => {
    const send = (stdout: string) => new ClaudeCodeModel({ run: fake([stdout]).run }).send(request());
    await expect(send(expiredLogin)).rejects.toMatchObject({ kind: "key_rejected", provider: "claude-code" });
    const limit = JSON.stringify({ is_error: true, result: "Claude usage limit reached. Your limit will reset at 5pm" });
    await expect(send(limit)).rejects.toMatchObject({ kind: "no_credit" });
    await expect(send(JSON.stringify({ is_error: true, result: "Overloaded", api_error_status: 529 }))).rejects.toMatchObject({ kind: "retryable" });
    await expect(send("Error: something broke")).rejects.toMatchObject({ kind: "retryable" });
  });

  it("repairs through the translator loop by resuming the session", async () => {
    const { run, calls } = fake([
      success({ cp: "5ch,turn", expectedCount: null, confidence: "high", assumptions: [], question: null, amendPrevious: [] }, "a"),
      success({ cp: "sk,4slst", expectedCount: null, confidence: "high", assumptions: [], question: null, amendPrevious: [] }, "b"),
      success({ cp: "sk,4ss", expectedCount: null, confidence: "high", assumptions: [], question: null, amendPrevious: [] }, "b2"),
    ]);
    const english = "Row 1: Ch 5.\nRow 2: Sl st across.";
    const { pattern } = await translatePattern(
      { english, ...segmentPattern(english) },
      { model: new ClaudeCodeModel({ run }), modelName: "claude-opus-5-5", effort: "medium", repairEffort: "high", validate, idPrefix: "t" },
    );
    expect(Object.values(pattern.translations).map((t) => t.status)).toEqual(["valid", "valid"]);
    expect(calls.map((c) => flag(c.args, "--resume"))).toEqual([undefined, undefined, "b"]);
    expect(flag(calls[2]!.args, "--effort")).toBe("high");
    expect(calls[2]!.input).toContain("Stitch type not defined");
    expect(pattern.provider).toBe("claude-code");
  });
});

describe("claudeCodeStatus", () => {
  it("reads `claude auth status --json`", async () => {
    const { run, calls } = fake([JSON.stringify({ loggedIn: false, authMethod: "none" })]);
    expect(await claudeCodeStatus({ run })).toEqual({ loggedIn: false, authMethod: "none" });
    expect(calls[0]!.args).toEqual(["auth", "status", "--json"]);
  });

  it("reports a missing CLI clearly", async () => {
    const run: Runner = async () => {
      throw new Error("spawn claude ENOENT");
    };
    await expect(claudeCodeStatus({ run })).rejects.toThrow(ModelError);
  });
});
