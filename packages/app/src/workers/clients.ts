// Promise-based clients for the parser and layout workers.

import type {
  Dimension,
  LayoutProgress,
  LayoutResult,
  SolverSettings,
  ValidationResult,
} from "@crochet-model/core";
import type { LayoutResponse, ParserResponse } from "./protocol.ts";

export class ParserClient {
  private worker = new Worker(new URL("./parser.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: { result: ValidationResult; ms: number }) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<ParserResponse>) => {
      const message = event.data;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.type === "result") waiter.resolve({ result: message.result, ms: message.ms });
      else waiter.reject(new Error(message.message));
    };
  }

  validate(
    text: string,
    options: { dimension?: Dimension; withGraph?: boolean } = {},
  ): Promise<{ result: ValidationResult; ms: number }> {
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
  promise: Promise<LayoutResult>;
  cancel(): void;
}

/**
 * Runs one layout at a time. Starting a new layout cancels the running one.
 * Cancelling terminates the worker; the next layout starts a fresh one, which
 * reloads the solver (a few milliseconds plus the wasm fetch).
 */
export class LayoutClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private current: { id: number; reject: (e: Error) => void } | undefined;

  layout(
    simpleDot: string,
    settings: SolverSettings = {},
    onProgress?: (progress: LayoutProgress) => void,
  ): LayoutJob {
    this.cancel();
    const worker = (this.worker ??= this.spawn());
    const id = this.nextId++;
    const promise = new Promise<LayoutResult>((resolve, reject) => {
      this.current = { id, reject };
      worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") {
          onProgress?.(message.progress);
          return;
        }
        this.current = undefined;
        if (message.type === "result") resolve(message.result);
        else reject(new Error(message.message));
      };
      worker.postMessage({ id, simpleDot, settings });
    });
    return { promise, cancel: () => this.current?.id === id && this.cancel() };
  }

  cancel(): void {
    if (!this.current) return;
    this.worker?.terminate();
    this.worker = undefined;
    const { reject } = this.current;
    this.current = undefined;
    reject(new LayoutCancelled());
  }

  private spawn(): Worker {
    return new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  }
}
