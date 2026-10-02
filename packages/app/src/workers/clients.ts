// Promise-based clients for the parser and layout workers.

import type {
  Dimension,
  FoldCheck,
  LayoutProgress,
  SolverSettings,
  StitchGraph,
  UnfoldedLayoutResult,
  ValidationResult,
} from "@crochet-model/core";
import type { LayoutResponse, ParserResponse } from "./protocol.ts";

export interface ParseOutcome {
  result: ValidationResult;
  graph?: StitchGraph;
  ms: number;
}

export class ParserClient {
  private worker = new Worker(new URL("./parser.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: ParseOutcome) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<ParserResponse>) => {
      const message = event.data;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.type === "result") {
        waiter.resolve({ result: message.result, graph: message.graph, ms: message.ms });
      } else waiter.reject(new Error(message.message));
    };
  }

  validate(
    text: string,
    options: { dimension?: Dimension; withGraph?: boolean } = {},
  ): Promise<ParseOutcome> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, text, ...options });
    });
  }
}

export class LayoutCancelled extends Error {
  constructor() {
    super("layout cancelled");
    this.name = "LayoutCancelled";
  }
}

export interface LayoutJob {
  promise: Promise<UnfoldedLayoutResult>;
  cancel(): void;
}

/**
 * Runs one layout at a time. Starting a new layout cancels the running one.
 * Cancelling terminates the worker; the next layout starts a fresh one, which
 * reloads the solver (a few milliseconds plus the wasm fetch).
 *
 * The solver never frees its result buffer, and wasm memory does not shrink,
 * so the worker is also replaced after `recycleAfter` finished layouts.
 */
export class LayoutClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private current: { id: number; reject: (e: Error) => void } | undefined;
  private finished = 0;
  private readonly recycleAfter: number;

  constructor(recycleAfter = 50) {
    this.recycleAfter = recycleAfter;
  }

  layout(
    simpleDot: string,
    settings: SolverSettings = {},
    onProgress?: (progress: LayoutProgress) => void,
    /** A 2D layout came out folded and is being redone with `seed`. */
    onRetry?: (seed: number, previous: FoldCheck) => void,
    maxSeeds?: number,
  ): LayoutJob {
    this.cancel();
    const worker = (this.worker ??= this.spawn());
    const id = this.nextId++;
    const promise = new Promise<UnfoldedLayoutResult>((resolve, reject) => {
      this.current = { id, reject };
      worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") {
          onProgress?.(message.progress);
          return;
        }
        if (message.type === "retry") {
          onRetry?.(message.seed, message.previous);
          return;
        }
        this.current = undefined;
        if (++this.finished >= this.recycleAfter) this.retire();
        if (message.type === "result") resolve(message.result);
        else reject(new Error(message.message));
      };
      worker.postMessage({ id, simpleDot, settings, maxSeeds });
    });
    return { promise, cancel: () => this.current?.id === id && this.cancel() };
  }

  /** Cancels any running layout and frees the worker. */
  dispose(): void {
    this.cancel();
    this.retire();
  }

  cancel(): void {
    if (!this.current) return;
    this.retire();
    const { reject } = this.current;
    this.current = undefined;
    reject(new LayoutCancelled());
  }

  private retire(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.finished = 0;
  }

  private spawn(): Worker {
    return new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  }
}
