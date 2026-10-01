// Calls to Claude (docs/SPEC.md §5.6). The loop talks to a TranslatorModel,
// so tests can script replies and the evaluation can swap in batching.

import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "@crochet-model/core";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRequest {
  /** Unique within a run; becomes the batch custom_id. */
  id: string;
  model: string;
  effort: Effort;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  format: { type: "json_schema"; schema: Record<string, unknown> };
  maxTokens: number;
}

export interface ModelReply {
  /** The assistant content, to append unchanged to the conversation. */
  content: Anthropic.ContentBlockParam[];
  text: string;
  stopReason: string | null;
  usage: Usage;
  /** The model that answered (a fallback may differ from the one asked). */
  model: string;
}

export interface TranslatorModel {
  send(request: ModelRequest): Promise<ModelReply>;
}

/** Thinking and effort settings that differ by model. */
function modelSettings(model: string, effort: Effort) {
  // Haiku 4.5 rejects `effort` and takes no adaptive thinking.
  if (model.startsWith("claude-haiku-4")) return {};
  return { thinking: { type: "adaptive" as const }, effort };
}

export function requestParams(r: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  const { thinking, effort } = modelSettings(r.model, r.effort);
  return {
    model: r.model,
    max_tokens: r.maxTokens,
    system: r.system,
    messages: r.messages,
    ...(thinking ? { thinking } : {}),
    output_config: { format: r.format, ...(effort ? { effort } : {}) },
  };
}

function toReply(message: {
  content: unknown[];
  stop_reason: string | null;
  usage: Anthropic.Usage;
  model: string;
}): ModelReply {
  const content = message.content as Anthropic.ContentBlock[];
  return {
    content: content as unknown as Anthropic.ContentBlockParam[],
    text: content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    stopReason: message.stop_reason,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    model: message.model,
  };
}

export interface ClaudeModelOptions {
  client?: Anthropic;
  /**
   * Re-run a refused request on Anthropic's recommended fallback model
   * (`fallbacks: "default"`). The app turns this on; evaluation runs leave it
   * off so live and batch runs are scored alike (Batches reject it).
   */
  fallbacks?: boolean;
}

/** One Messages API request per call. The SDK retries 429, 5xx and connection errors. */
export class ClaudeModel implements TranslatorModel {
  private client: Anthropic;
  private fallbacks: boolean;

  constructor(options: ClaudeModelOptions = {}) {
    this.client = options.client ?? new Anthropic({ maxRetries: 4 });
    this.fallbacks = options.fallbacks ?? false;
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    const params = requestParams(request);
    if (!this.fallbacks) return toReply(await this.client.messages.create(params));
    const message = await this.client.beta.messages.create({
      ...(params as Anthropic.Beta.MessageCreateParamsNonStreaming),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    return toReply(message);
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

  private options: { client?: Anthropic; pollMs?: number; log?: (line: string) => void };

  constructor(options: BatchModel["options"] = {}) {
    this.options = options;
    this.client = options.client ?? new Anthropic({ maxRetries: 4 });
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
        for (const p of batch) p.reject(error);
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
        p.reject(new BatchRequestError(type, `batch request errored: ${type}: ${message}`));
      } else p.reject(new Error(`batch request ${result.result.type}`));
    }
    for (const p of byId.values()) p.reject(new Error("batch result missing"));
  }
}

/** One request in a batch that errored, with the API's error type. */
export class BatchRequestError extends Error {
  readonly errorType: string;
  constructor(errorType: string, message: string) {
    super(message);
    this.errorType = errorType;
  }
}

/** Batch custom_ids allow letters, digits, `_` and `-`, up to 64 characters. */
export function customId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return clean.length <= 64 ? clean : clean.slice(clean.length - 64);
}
