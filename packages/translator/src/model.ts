// The provider-neutral model interface (docs/SPEC.md §5.6). The loop talks to
// a TranslatorModel; one adapter per provider (providers/) maps it to that
// provider's API, so tests can script replies and the evaluation can swap in
// batching.

import type { Usage } from "@crochet-model/core";

export type ProviderId = "anthropic" | "openrouter" | "gemini" | "openai";

export const PROVIDERS: ProviderId[] = ["anthropic", "openrouter", "gemini", "openai"];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** `cache`: this block ends a cached prefix (SPEC §5.2). */
export interface TextBlock {
  text: string;
  cache: boolean;
}

export type Turn =
  | { role: "user"; blocks: TextBlock[] }
  /** `raw`: the provider's own reply content, replayed unchanged (thinking blocks, thought signatures). */
  | { role: "assistant"; text: string; raw?: unknown };

export interface ModelRequest {
  /** Unique within a run; becomes the batch custom_id. */
  id: string;
  model: string;
  effort: Effort;
  system: TextBlock[];
  messages: Turn[];
  /** JSON Schema the reply must match (SPEC §5.4). */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export type StopReason = "end" | "max_tokens" | "refusal" | "other";

export interface ModelReply {
  /** The JSON answer. */
  text: string;
  /** The provider's reply content, for the next assistant turn. */
  raw: unknown;
  stopReason: StopReason;
  usage: Usage;
  /** US$, when the provider reports it (OpenRouter). */
  costUsd?: number;
  /** The model that answered (a fallback may differ from the one asked). */
  model: string;
}

export interface TranslatorModel {
  readonly provider: ProviderId;
  send(request: ModelRequest): Promise<ModelReply>;
}

/**
 * What went wrong, as the loop and the server act on it (SPEC §5.6). Only
 * `retryable` errors become failed attempts; the rest stop the pattern.
 */
export type ErrorKind = "retryable" | "key_rejected" | "no_credit" | "bad_model" | "bad_request";

export class ModelError extends Error {
  readonly kind: ErrorKind;
  readonly provider: ProviderId;
  constructor(provider: ProviderId, kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(`${provider}: ${kind}: ${message}`, options);
    this.kind = kind;
    this.provider = provider;
  }
}

/** The error kind for an HTTP status, after the SDK has retried what it retries. */
export function kindOfStatus(status: number | undefined): ErrorKind {
  if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500) return "retryable";
  if (status === 401 || status === 403) return "key_rejected";
  if (status === 402) return "no_credit";
  if (status === 404) return "bad_model";
  return "bad_request";
}

/** Bugs or setup problems, not translation failures: they stop the pattern. */
export function isFatal(error: unknown): boolean {
  return error instanceof ModelError && error.kind !== "retryable";
}

/** A model the provider lists for this key. */
export interface ModelInfo {
  id: string;
  /** Constrains output to a JSON Schema; false means it cannot translate (SPEC §5.4). */
  structuredOutput: boolean;
  /** US$ per million tokens, when the provider publishes it (OpenRouter). */
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
