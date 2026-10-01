// Claude through the Messages and Message Batches APIs (docs/SPEC.md §5.6).

import Anthropic from "@anthropic-ai/sdk";
import {
  kindOfStatus,
  ModelError,
  type ErrorKind,
  type ModelInfo,
  type ModelReply,
  type ModelRequest,
  type StopReason,
  type TextBlock,
  type TranslatorModel,
  type Turn,
} from "../model.ts";
import { anthropicSettings } from "./capabilities.ts";

function textBlocks(blocks: TextBlock[]): Anthropic.TextBlockParam[] {
  return blocks.map((b) => ({ type: "text", text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}) }));
}

function messageParam(turn: Turn): Anthropic.MessageParam {
  if (turn.role === "user") return { role: "user", content: textBlocks(turn.blocks) };
  // The reply's own blocks, thinking included: Claude binds its thinking to them.
  const content = (turn.raw as Anthropic.ContentBlockParam[] | undefined) ?? [{ type: "text", text: turn.text }];
  return { role: "assistant", content };
}

export function requestParams(r: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  const { thinking, effort } = anthropicSettings(r.model, r.effort);
  return {
    model: r.model,
    max_tokens: r.maxTokens,
    system: textBlocks(r.system),
    messages: r.messages.map(messageParam),
    ...(thinking ? { thinking } : {}),
    output_config: { format: { type: "json_schema", schema: r.schema }, ...(effort ? { effort } : {}) },
  };
}

function stopReason(reason: string | null): StopReason {
  if (reason === "end_turn") return "end";
  if (reason === "max_tokens" || reason === "refusal") return reason;
  return "other";
}

function toReply(message: {
  content: unknown[];
  stop_reason: string | null;
  usage: Anthropic.Usage;
  model: string;
}): ModelReply {
  const content = message.content as Anthropic.ContentBlock[];
  return {
    raw: content as unknown as Anthropic.ContentBlockParam[],
    text: content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    stopReason: stopReason(message.stop_reason),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    model: message.model,
  };
}

/** The kind for an Anthropic `error.type`, in a live response or a batch result. */
function kindOfType(type: string | null | undefined): ErrorKind | undefined {
  switch (type) {
    case "authentication_error":
    case "permission_error":
      return "key_rejected";
    case "billing_error":
      return "no_credit";
    case "not_found_error":
      return "bad_model";
    case "invalid_request_error":
      return "bad_request";
    case "rate_limit_error":
    case "overloaded_error":
    case "api_error":
    case "timeout_error":
      return "retryable";
    default:
      return undefined;
  }
}

/** SDK errors as ModelErrors; anything else unchanged. */
export function anthropicError(error: unknown): unknown {
  if (!(error instanceof Anthropic.AnthropicError)) return error;
  if (!(error instanceof Anthropic.APIError)) return new ModelError("anthropic", "bad_request", error.message, { cause: error });
  const kind = kindOfType(error.type) ?? kindOfStatus(error.status);
  return new ModelError("anthropic", kind, error.message, { cause: error });
}

export interface ClaudeModelOptions {
  client?: Anthropic;
  /** Defaults to ANTHROPIC_API_KEY (or an `ant auth login` profile). */
  apiKey?: string;
  /**
   * Re-run a refused request on Anthropic's recommended fallback model
   * (`fallbacks: "default"`). The app turns this on; evaluation runs leave it
   * off so live and batch runs are scored alike (Batches reject it).
   */
  fallbacks?: boolean;
}

function client(options: { client?: Anthropic; apiKey?: string }): Anthropic {
  return options.client ?? new Anthropic({ maxRetries: 4, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
}

/** One Messages API request per call. The SDK retries 429, 5xx and connection errors. */
export class ClaudeModel implements TranslatorModel {
  readonly provider = "anthropic" as const;
  private client: Anthropic;
  private fallbacks: boolean;

  constructor(options: ClaudeModelOptions = {}) {
    this.client = client(options);
    this.fallbacks = options.fallbacks ?? false;
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    const params = requestParams(request);
    try {
      if (!this.fallbacks) return toReply(await this.client.messages.create(params));
      const message = await this.client.beta.messages.create({
        ...(params as Anthropic.Beta.MessageCreateParamsNonStreaming),
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      return toReply(message);
    } catch (error) {
      throw anthropicError(error);
    }
  }
}

/**
 * Sends requests through the Message Batches API at half price.
 *
 * Each pattern's loop waits on one request at a time, and later rows depend
 * on earlier ones. So requests are collected until every active loop is
 * waiting, then sent as one batch: the first rows of all patterns, then the
 * next round (second rows and first repairs), and so on. Callers bracket each
 * loop with `enter()` and `leave()`.
 */
export class BatchModel implements TranslatorModel {
  readonly provider = "anthropic" as const;
  private client: Anthropic;
  private active = 0;
  private flushing = false;
  private pending: {
    request: ModelRequest;
    resolve: (reply: ModelReply) => void;
    reject: (error: unknown) => void;
  }[] = [];
  /** Batches sent, for the run record. */
  readonly batches: { id: string; requests: number }[] = [];

  private options: { client?: Anthropic; apiKey?: string; pollMs?: number; log?: (line: string) => void };

  constructor(options: BatchModel["options"] = {}) {
    this.options = options;
    this.client = client(options);
  }

  /**
   * Runs pattern loops together, each bracketed by enter() and leave(). All
   * enter before any starts, so the first request cannot go out alone.
   */
  async all<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
    for (const _ of tasks) this.enter();
    return Promise.all(
      tasks.map(async (task) => {
        try {
          return await task();
        } finally {
          this.leave();
        }
      }),
    );
  }

  enter() {
    this.active += 1;
  }

  leave() {
    this.active -= 1;
    this.maybeFlush();
  }

  send(request: ModelRequest): Promise<ModelReply> {
    return new Promise((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
      this.maybeFlush();
    });
  }

  private maybeFlush() {
    if (this.flushing || this.pending.length === 0 || this.pending.length < this.active) return;
    const batch = this.pending.splice(0);
    this.flushing = true;
    this.run(batch)
      .catch((error) => {
        const e = anthropicError(error);
        for (const p of batch) p.reject(e);
      })
      .finally(() => {
        this.flushing = false;
        this.maybeFlush();
      });
  }

  private async run(batch: BatchModel["pending"]) {
    const byId = new Map(batch.map((p) => [customId(p.request.id), p]));
    if (byId.size !== batch.length) throw new Error("duplicate batch custom_id");
    const created = await this.client.messages.batches.create({
      requests: [...byId].map(([custom_id, p]) => ({ custom_id, params: requestParams(p.request) })),
    });
    this.batches.push({ id: created.id, requests: batch.length });
    this.options.log?.(`batch ${created.id}: ${batch.length} requests`);
    const pollMs = this.options.pollMs ?? 30_000;
    let status = created;
    while (status.processing_status !== "ended") {
      await new Promise((r) => setTimeout(r, pollMs));
      status = await this.client.messages.batches.retrieve(created.id);
    }
    for await (const result of await this.client.messages.batches.results(created.id)) {
      const p = byId.get(result.custom_id);
      if (!p) continue;
      byId.delete(result.custom_id);
      if (result.result.type === "succeeded") p.resolve(toReply(result.result.message));
      else if (result.result.type === "errored") {
        const { type, message } = result.result.error.error;
        p.reject(new ModelError("anthropic", kindOfType(type) ?? "retryable", `batch request errored: ${type}: ${message}`));
      } else p.reject(new Error(`batch request ${result.result.type}`));
    }
    for (const p of byId.values()) p.reject(new Error("batch result missing"));
  }
}

/** Batch custom_ids allow letters, digits, `_` and `-`, up to 64 characters. */
export function customId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return clean.length <= 64 ? clean : clean.slice(clean.length - 64);
}

/** Claude models for this key. Claude 3 models predate structured outputs. */
export async function listAnthropicModels(options: { client?: Anthropic; apiKey?: string } = {}): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  try {
    for await (const m of client(options).models.list()) models.push({ id: m.id, structuredOutput: !m.id.startsWith("claude-3") });
  } catch (error) {
    throw anthropicError(error);
  }
  return models;
}
