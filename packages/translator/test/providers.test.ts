import Anthropic from "@anthropic-ai/sdk";
import { ApiError, type GenerateContentResponse, type GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelError, type ModelRequest, type Turn } from "../src/model.ts";
import { anthropicError, requestParams } from "../src/providers/anthropic.ts";
import { geminiThinking, openaiEffort, openrouterEffort } from "../src/providers/capabilities.ts";
import { geminiError, geminiParams, geminiReply, listGeminiModels } from "../src/providers/gemini.ts";
import { createModel } from "../src/providers/index.ts";
import { CompatModel, compatError, compatParams, listCompatModels } from "../src/providers/openaiCompat.ts";
import { outputFormat, RowResponse } from "../src/schema.ts";

const schema = outputFormat(RowResponse).schema;

const request = (model: string, messages: Turn[] = [], effort: ModelRequest["effort"] = "medium"): ModelRequest => ({
  id: "r1",
  model,
  effort,
  system: [{ text: "SYSTEM", cache: true }],
  messages: [
    { role: "user", blocks: [{ text: "PATTERN", cache: true }, { text: "ROW", cache: false }] },
    ...messages,
  ],
  schema,
  maxTokens: 1000,
});

const kind = (error: unknown) => (error as ModelError).kind;

/** No `type: [..]` lists anywhere: Gemini and strict OpenAI take anyOf. */
function hasTypeList(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTypeList);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([k, v]) => (k === "type" && Array.isArray(v)) || hasTypeList(v));
}

describe("capabilities", () => {
  it("clamps effort to what each provider takes", () => {
    expect(openaiEffort("gpt-4o", "high")).toBeUndefined();
    expect(openaiEffort("gpt-5", "max")).toBe("high");
    expect(openaiEffort("o3", "low")).toBe("low");
    expect(openrouterEffort("xhigh")).toBe("high");
    expect(geminiThinking("gemini-3-pro-preview", "medium")).toEqual({ thinkingLevel: "LOW" });
    expect(geminiThinking("gemini-3-flash", "medium")).toEqual({ thinkingLevel: "MEDIUM" });
    expect(geminiThinking("models/gemini-2.5-pro", "high")).toEqual({ thinkingBudget: 16384 });
    expect(geminiThinking("gemini-1.5-pro", "high")).toBeUndefined();
  });
});

describe("anthropic", () => {
  it("marks cached blocks and replays the reply's own content", () => {
    const thinking = [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "text", text: "{}" }];
    const p = requestParams(request("claude-opus-5-5", [{ role: "assistant", text: "{}", raw: thinking }]));
    expect(p.system).toEqual([{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
    expect(p.messages[0]!.content).toEqual([
      { type: "text", text: "PATTERN", cache_control: { type: "ephemeral" } },
      { type: "text", text: "ROW" },
    ]);
    expect(p.messages[1]!.content).toBe(thinking);
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ format: { type: "json_schema", schema }, effort: "medium" });
    expect(requestParams(request("claude-haiku-4-5")).thinking).toBeUndefined();
  });

  it("sorts API errors into kinds", () => {
    const api = (status: number, type?: string) =>
      anthropicError(Anthropic.APIError.generate(status, { type: "error", error: { type, message: "x" } }, "x", new Headers()));
    expect(kind(api(401, "authentication_error"))).toBe("key_rejected");
    expect(kind(api(400, "billing_error"))).toBe("no_credit");
    expect(kind(api(400, "invalid_request_error"))).toBe("bad_request");
    expect(kind(api(404, "not_found_error"))).toBe("bad_model");
    expect(kind(api(529, "overloaded_error"))).toBe("retryable");
    expect(kind(anthropicError(new Anthropic.APIConnectionError({ message: "down" })))).toBe("retryable");
    const plain = new Error("other");
    expect(anthropicError(plain)).toBe(plain);
  });
});

describe("openai and openrouter", () => {
  it("builds a strict JSON Schema request for OpenAI, with reasoning effort", () => {
    const p = compatParams("openai", request("gpt-5", [], "max"));
    expect(p.max_completion_tokens).toBe(1000);
    expect(p.reasoning_effort).toBe("high");
    expect(p).not.toHaveProperty("reasoning");
    const format = p.response_format as { json_schema: { strict: boolean; schema: unknown } };
    expect(format.json_schema.strict).toBe(true);
    expect(hasTypeList(schema)).toBe(true);
    expect(hasTypeList(format.json_schema.schema)).toBe(false);
    // OpenAI caches automatically: no markers.
    expect(JSON.stringify(p.messages)).not.toContain("cache_control");
  });

  it("marks the cached prefix only for OpenRouter models that need it, and requires the schema", () => {
    const claude = compatParams("openrouter", request("anthropic/claude-opus-5-5"));
    expect(claude.reasoning).toEqual({ effort: "medium" });
    expect(claude.provider).toEqual({ require_parameters: true });
    const [system, user] = claude.messages as { content: { cache_control?: unknown }[] }[];
    expect(system!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(user!.content.map((c) => c.cache_control)).toEqual([{ type: "ephemeral" }, undefined]);
    const other = compatParams("openrouter", request("deepseek/deepseek-v4"));
    expect(JSON.stringify(other.messages)).not.toContain("cache_control");
  });

  it("replays OpenRouter reasoning details in the assistant turn", () => {
    const raw = { content: "{}", reasoning_details: [{ type: "reasoning.encrypted", data: "x" }] };
    const p = compatParams("openrouter", request("google/gemini-3-pro", [{ role: "assistant", text: "{}", raw }]));
    expect((p.messages as unknown[])[2]).toEqual({ role: "assistant", content: "{}", reasoning_details: raw.reasoning_details });
  });

  it("normalises the reply: cached tokens, reported cost, refusals", async () => {
    const completion = (message: object, finish: string, usage: object) => ({
      model: "anthropic/claude-opus-5-5",
      choices: [{ index: 0, message: { role: "assistant", content: "{}", refusal: null, ...message }, finish_reason: finish }],
      usage,
    });
    const replies = [
      completion({}, "stop", { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 }, cost: 0.0123 }),
      completion({}, "content_filter", { prompt_tokens: 10, completion_tokens: 0 }),
      completion({ refusal: "no" }, "stop", { prompt_tokens: 10, completion_tokens: 0 }),
      completion({}, "length", { prompt_tokens: 10, completion_tokens: 1000 }),
    ];
    const sent: unknown[] = [];
    const fake = { chat: { completions: { create: async (body: unknown) => (sent.push(body), replies.shift()) } } };
    const model = new CompatModel("openrouter", { client: fake as unknown as OpenAI });
    const first = await model.send(request("anthropic/claude-opus-5-5"));
    expect(first).toMatchObject({
      text: "{}",
      stopReason: "end",
      usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 },
      costUsd: 0.0123,
      model: "anthropic/claude-opus-5-5",
    });
    expect((await model.send(request("x"))).stopReason).toBe("refusal");
    expect((await model.send(request("x"))).stopReason).toBe("refusal");
    expect((await model.send(request("x"))).stopReason).toBe("max_tokens");
    expect(sent).toHaveLength(4);
  });

  it("sorts API errors into kinds", () => {
    const api = (status: number, error: object = {}) => OpenAI.APIError.generate(status, { error: { message: "x", ...error } }, "x", new Headers());
    expect(kind(compatError("openai", api(401)))).toBe("key_rejected");
    expect(kind(compatError("openai", api(403)))).toBe("key_rejected");
    expect(kind(compatError("openai", api(429, { code: "insufficient_quota" })))).toBe("no_credit");
    expect(kind(compatError("openai", api(429)))).toBe("retryable");
    expect(kind(compatError("openai", api(404)))).toBe("bad_model");
    expect(kind(compatError("openai", api(400)))).toBe("bad_request");
    expect(kind(compatError("openrouter", api(402)))).toBe("no_credit");
    // OpenRouter's moderation: a failed attempt, not a bad key.
    expect(kind(compatError("openrouter", api(403)))).toBe("retryable");
  });

  it("lists OpenRouter models with structured output and prices per million tokens", async () => {
    const fake = {
      models: {
        list: async function* () {
          yield { id: "a/json", supported_parameters: ["structured_outputs", "reasoning"], pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" } };
          yield { id: "b/plain", supported_parameters: ["tools"] };
        },
      },
    };
    const models = await listCompatModels("openrouter", { client: fake as unknown as OpenAI });
    expect(models[0]).toEqual({ id: "a/json", structuredOutput: true, price: { input: 2, output: 10, cacheRead: 0.2 } });
    expect(models[1]).toEqual({ id: "b/plain", structuredOutput: false });
  });
});

describe("gemini", () => {
  it("sends the system prompt, a portable schema, thinking and the reply's own content", () => {
    const raw = { role: "model", parts: [{ text: "{}", thoughtSignature: "sig" }] };
    const p = geminiParams(request("gemini-3-pro-preview", [{ role: "assistant", text: "{}", raw }], "high"));
    expect(p.config.systemInstruction).toBe("SYSTEM");
    expect(p.config.responseMimeType).toBe("application/json");
    expect(hasTypeList(p.config.responseJsonSchema)).toBe(false);
    expect(p.config.thinkingConfig).toEqual({ thinkingLevel: "HIGH" });
    expect(p.contents).toEqual([{ role: "user", parts: [{ text: "PATTERN" }, { text: "ROW" }] }, raw]);
  });

  it("reads the answer without thought parts, and normalises usage and refusals", () => {
    const response = {
      candidates: [{ content: { role: "model", parts: [{ text: "thinking…", thought: true }, { text: "{\"cp\":", thoughtSignature: "s" }, { text: "\"\"}" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 40, thoughtsTokenCount: 200 },
      modelVersion: "gemini-3-pro-preview-001",
    } as unknown as GenerateContentResponse;
    const reply = geminiReply(response, "gemini-3-pro-preview");
    expect(reply).toMatchObject({
      text: "{\"cp\":\"\"}",
      stopReason: "end",
      usage: { inputTokens: 400, outputTokens: 240, cacheReadTokens: 600, cacheWriteTokens: 0 },
      model: "gemini-3-pro-preview-001",
    });
    expect(reply.raw).toBe(response.candidates![0]!.content);
    const blocked = { promptFeedback: { blockReason: "SAFETY" } } as unknown as GenerateContentResponse;
    expect(geminiReply(blocked, "m").stopReason).toBe("refusal");
    const safety = { candidates: [{ finishReason: "SAFETY" }] } as unknown as GenerateContentResponse;
    expect(geminiReply(safety, "m").stopReason).toBe("refusal");
  });

  it("sorts API errors into kinds, including a bad key sent back as 400", () => {
    const api = (status: number, message = "x") => geminiError(new ApiError({ status, message }));
    expect(kind(api(400, "API key not valid. Please pass a valid API key."))).toBe("key_rejected");
    expect(kind(api(400))).toBe("bad_request");
    expect(kind(api(403))).toBe("key_rejected");
    expect(kind(api(404))).toBe("bad_model");
    expect(kind(api(503))).toBe("retryable");
  });

  it("lists models that generate content, without the models/ prefix", async () => {
    const fake = {
      models: {
        list: async () =>
          (async function* () {
            yield { name: "models/gemini-3-pro-preview", supportedActions: ["generateContent", "countTokens"] };
            yield { name: "models/text-embedding-004", supportedActions: ["embedContent"] };
          })(),
      },
    };
    expect(await listGeminiModels({ client: fake as unknown as GoogleGenAI })).toEqual([
      { id: "gemini-3-pro-preview", structuredOutput: true },
    ]);
  });
});

describe("createModel", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reads the key from the provider's environment variable, and fails clearly without one", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => createModel("openrouter")).toThrow(ModelError);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    expect(createModel("openrouter").provider).toBe("openrouter");
    delete process.env.GEMINI_API_KEY;
    expect(() => createModel("gemini")).toThrow("gemini: key_rejected: no API key");
    expect(createModel("gemini", { apiKey: "test" }).provider).toBe("gemini");
  });
});
