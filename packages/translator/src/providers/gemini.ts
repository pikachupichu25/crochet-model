// Gemini through the Gemini API's generateContent (docs/SPEC.md §5.6).
// Caching is implicit on a stable prefix; the request keeps the same order as
// the other providers, so it needs no markers.

import { ApiError, GoogleGenAI, type Content, type GenerateContentResponse, type ThinkingConfig } from "@google/genai";
import type { Usage } from "@crochet-model/core";
import {
  kindOfStatus,
  ModelError,
  type ModelInfo,
  type ModelReply,
  type ModelRequest,
  type StopReason,
  type TranslatorModel,
  type Turn,
} from "../model.ts";
import { portableSchema } from "../schema.ts";
import { geminiStructuredOutput, geminiThinking } from "./capabilities.ts";

function content(turn: Turn): Content {
  if (turn.role === "user") return { role: "user", parts: turn.blocks.map((b) => ({ text: b.text })) };
  // The reply's own parts, thought signatures included: Gemini needs them back unchanged.
  return (turn.raw as Content | undefined) ?? { role: "model", parts: [{ text: turn.text }] };
}

export function geminiParams(r: ModelRequest) {
  const thinking = geminiThinking(r.model, r.effort);
  return {
    model: r.model,
    contents: r.messages.map(content),
    config: {
      systemInstruction: r.system.map((b) => b.text).join("\n\n"),
      responseMimeType: "application/json",
      responseJsonSchema: portableSchema(r.schema),
      maxOutputTokens: r.maxTokens,
      // The SDK's ThinkingLevel enum has the same string values.
      ...(thinking ? { thinkingConfig: thinking as ThinkingConfig } : {}),
    },
  };
}

const REFUSALS = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

function stopReason(response: GenerateContentResponse): StopReason {
  if (response.promptFeedback?.blockReason) return "refusal";
  const finish = response.candidates?.[0]?.finishReason as string | undefined;
  if (finish === "STOP") return "end";
  if (finish === "MAX_TOKENS") return "max_tokens";
  if (finish && REFUSALS.has(finish)) return "refusal";
  return "other";
}

/** promptTokenCount includes cached tokens; thinking tokens are billed as output. */
export function geminiUsage(u: GenerateContentResponse["usageMetadata"]): Usage {
  const cached = u?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (u?.promptTokenCount ?? 0) - cached),
    outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

export function geminiReply(response: GenerateContentResponse, model: string): ModelReply {
  const raw = response.candidates?.[0]?.content;
  const text = (raw?.parts ?? []).flatMap((p) => (p.text !== undefined && !p.thought ? [p.text] : [])).join("");
  return {
    text,
    raw,
    stopReason: stopReason(response),
    usage: geminiUsage(response.usageMetadata),
    model: response.modelVersion ?? model,
    response,
  };
}

/** SDK errors as ModelErrors; anything else unchanged. */
export function geminiError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  // A bad key comes back as 400 INVALID_ARGUMENT, not 401.
  const kind = error.status === 400 && /API key/i.test(error.message) ? "key_rejected" : kindOfStatus(error.status);
  return new ModelError("gemini", kind, error.message, { cause: error });
}

export interface GeminiModelOptions {
  client?: GoogleGenAI;
  /** Defaults to GEMINI_API_KEY. */
  apiKey?: string;
}

function client(options: GeminiModelOptions): GoogleGenAI {
  if (options.client) return options.client;
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ModelError("gemini", "key_rejected", "no API key");
  // Retries 408, 429 and 5xx, like the other SDKs.
  return new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 5 } } });
}

export class GeminiModel implements TranslatorModel {
  readonly provider = "gemini" as const;
  private client: GoogleGenAI;

  constructor(options: GeminiModelOptions = {}) {
    this.client = client(options);
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    try {
      return geminiReply(await this.client.models.generateContent(geminiParams(request)), request.model);
    } catch (error) {
      throw geminiError(error);
    }
  }
}

/** Models for this key that generate content, without the `models/` prefix. */
export async function listGeminiModels(options: GeminiModelOptions = {}): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  try {
    for await (const m of await client(options).models.list()) {
      const id = (m.name ?? "").replace(/^models\//, "");
      if (!id || !(m.supportedActions ?? []).includes("generateContent")) continue;
      models.push({ id, structuredOutput: geminiStructuredOutput(id) });
    }
  } catch (error) {
    throw geminiError(error);
  }
  return models;
}
