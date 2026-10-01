// OpenAI and OpenRouter through Chat Completions (docs/SPEC.md §5.6).
// OpenRouter's API is OpenAI-compatible, so one adapter serves both; the
// differences are effort, cache markers, routing and reported cost.

import OpenAI from "openai";
import type { Usage } from "@crochet-model/core";
import {
  kindOfStatus,
  ModelError,
  type ModelInfo,
  type ModelReply,
  type ModelRequest,
  type StopReason,
  type TextBlock,
  type TranslatorModel,
  type Turn,
} from "../model.ts";
import { portableSchema } from "../schema.ts";
import {
  openaiEffort,
  openaiStructuredOutput,
  openrouterEffort,
  openrouterExplicitCache,
} from "./capabilities.ts";

export type CompatProvider = "openai" | "openrouter";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** The assistant message as replayed: OpenRouter's reasoning details keep thinking intact. */
interface RawMessage {
  content: string;
  reasoning_details?: unknown[];
}

type Part = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

function parts(blocks: TextBlock[], explicitCache: boolean): Part[] {
  return blocks.map((b) => ({
    type: "text",
    text: b.text,
    ...(explicitCache && b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

function message(turn: Turn, explicitCache: boolean): Record<string, unknown> {
  if (turn.role === "user") return { role: "user", content: parts(turn.blocks, explicitCache) };
  const raw = turn.raw as RawMessage | undefined;
  return {
    role: "assistant",
    content: raw?.content ?? turn.text,
    ...(raw?.reasoning_details ? { reasoning_details: raw.reasoning_details } : {}),
  };
}

/** The Chat Completions body. OpenRouter's extra fields go in the same object. */
export function compatParams(provider: CompatProvider, r: ModelRequest): Record<string, unknown> {
  const explicitCache = provider === "openrouter" && openrouterExplicitCache(r.model);
  const body: Record<string, unknown> = {
    model: r.model,
    messages: [
      { role: "system", content: parts(r.system, explicitCache) },
      ...r.messages.map((t) => message(t, explicitCache)),
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "response", schema: portableSchema(r.schema), strict: true },
    },
  };
  if (provider === "openai") {
    body.max_completion_tokens = r.maxTokens;
    const effort = openaiEffort(r.model, r.effort);
    if (effort) body.reasoning_effort = effort;
  } else {
    body.max_tokens = r.maxTokens;
    body.reasoning = { effort: openrouterEffort(r.effort) };
    // Only route to hosts that honour every parameter, the schema above included.
    body.provider = { require_parameters: true };
    body.usage = { include: true };
  }
  return body;
}

interface CompatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  cost?: number;
}

/** prompt_tokens includes cached tokens; they move to cacheReadTokens. */
export function compatUsage(u: CompatUsage | undefined): Usage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u?.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached - written),
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
  };
}

function stopReason(finish: string | null | undefined, refusal: string | null | undefined): StopReason {
  if (refusal) return "refusal";
  if (finish === "stop") return "end";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  return "other";
}

/** SDK errors as ModelErrors; anything else unchanged. */
export function compatError(provider: CompatProvider, error: unknown): unknown {
  if (!(error instanceof OpenAI.OpenAIError)) return error;
  if (!(error instanceof OpenAI.APIError)) return new ModelError(provider, "bad_request", error.message, { cause: error });
  let kind = kindOfStatus(error.status);
  if (error.status === 429 && error.code === "insufficient_quota") kind = "no_credit";
  // OpenRouter answers 403 when its moderation flags the input: a refusal, not a bad key.
  if (provider === "openrouter" && error.status === 403) kind = "retryable";
  return new ModelError(provider, kind, error.message, { cause: error });
}

export interface CompatModelOptions {
  client?: OpenAI;
  /** Defaults to OPENAI_API_KEY or OPENROUTER_API_KEY. */
  apiKey?: string;
}

function client(provider: CompatProvider, options: CompatModelOptions): OpenAI {
  if (options.client) return options.client;
  const apiKey = options.apiKey ?? process.env[provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"];
  if (!apiKey) throw new ModelError(provider, "key_rejected", "no API key");
  return new OpenAI({
    apiKey,
    maxRetries: 4,
    ...(provider === "openrouter" ? { baseURL: OPENROUTER_BASE_URL } : {}),
  });
}

export class CompatModel implements TranslatorModel {
  readonly provider: CompatProvider;
  private client: OpenAI;

  constructor(provider: CompatProvider, options: CompatModelOptions = {}) {
    this.provider = provider;
    this.client = client(provider, options);
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    const body = compatParams(this.provider, request);
    let completion: OpenAI.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      );
    } catch (error) {
      throw compatError(this.provider, error);
    }
    const choice = completion.choices[0];
    const msg = choice?.message as (OpenAI.ChatCompletionMessage & { reasoning_details?: unknown[] }) | undefined;
    const usage = completion.usage as CompatUsage | undefined;
    const text = msg?.content ?? "";
    const raw: RawMessage = { content: text, ...(msg?.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}) };
    return {
      text,
      raw,
      stopReason: stopReason(choice?.finish_reason, msg?.refusal),
      usage: compatUsage(usage),
      ...(typeof usage?.cost === "number" ? { costUsd: usage.cost } : {}),
      model: completion.model,
    };
  }
}

/** One entry of OpenRouter's model list (only the fields used). */
interface OpenRouterModel {
  id: string;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}

/** OpenRouter prices are US$ per token, as strings; rounded to drop float noise. */
const perMillion = (perToken: string | undefined) =>
  perToken === undefined ? undefined : Math.round(Number(perToken) * 1e12) / 1e6;

export function openrouterInfo(m: OpenRouterModel): ModelInfo {
  const input = perMillion(m.pricing?.prompt);
  const output = perMillion(m.pricing?.completion);
  const cacheRead = perMillion(m.pricing?.input_cache_read);
  const cacheWrite = perMillion(m.pricing?.input_cache_write);
  return {
    id: m.id,
    structuredOutput: m.supported_parameters?.includes("structured_outputs") ?? false,
    ...(input !== undefined && output !== undefined
      ? {
          price: {
            input,
            output,
            ...(cacheRead !== undefined ? { cacheRead } : {}),
            ...(cacheWrite !== undefined ? { cacheWrite } : {}),
          },
        }
      : {}),
  };
}

/** Models for this key: OpenRouter's list carries capabilities and prices; OpenAI's only ids. */
export async function listCompatModels(provider: CompatProvider, options: CompatModelOptions = {}): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  try {
    for await (const m of client(provider, options).models.list()) {
      models.push(
        provider === "openrouter"
          ? openrouterInfo(m as unknown as OpenRouterModel)
          : { id: m.id, structuredOutput: openaiStructuredOutput(m.id) },
      );
    }
  } catch (error) {
    throw compatError(provider, error);
  }
  return models;
}
