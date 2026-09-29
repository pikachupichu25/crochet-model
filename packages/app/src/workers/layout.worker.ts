// Runs CrochetPARADE's layout solver (graph64.wasm) off the main thread.
//
// performLayout is synchronous, so progress messages are posted from inside
// the solve (the main thread receives them as they are sent) and cancelling
// means terminating this worker.

import { createSolver, layoutUnfolded, type EmscriptenSolver, type SolverLoader } from "@crochet-model/core";
import solverSource from "../../../../vendor/crochetparade/graph64.js?raw";
import wasmUrl from "../../../../vendor/crochetparade/graph64.wasm?url";
import type { LayoutRequest, LayoutResponse } from "./protocol.ts";

const post = (message: LayoutResponse) => self.postMessage(message);

// graph64.js reads settings from a pre-existing `Module`; passing it as a
// parameter keeps the script's own `var Module` from replacing it.
const workerLoader: SolverLoader = async ({ print }) => {
  const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
  return new Promise((resolve, reject) => {
    const Module: Record<string, unknown> = {
      wasmBinary,
      print,
      printErr: () => {},
      onRuntimeInitialized: () => resolve(Module as unknown as EmscriptenSolver),
      onAbort: (reason: unknown) => reject(new Error(`layout solver aborted: ${String(reason)}`)),
    };
    new Function("Module", solverSource)(Module);
  });
};

const solverReady = createSolver(workerLoader);

// Post at most one progress message per this many milliseconds.
const PROGRESS_INTERVAL_MS = 50;

self.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  const { id, simpleDot, settings, maxSeeds } = event.data;
  try {
    const solver = await solverReady;
    let lastPost = 0;
    const result = layoutUnfolded(
      solver,
      simpleDot,
      settings,
      (progress) => {
        const now = performance.now();
        if (now - lastPost >= PROGRESS_INTERVAL_MS || progress.iteration === progress.iterations) {
          lastPost = now;
          post({ id, type: "progress", progress });
        }
      },
      { maxSeeds, onRetry: (seed, previous) => post({ id, type: "retry", seed, previous }) },
    );
    post({ id, type: "result", result });
  } catch (error) {
    post({ id, type: "error", message: String((error as Error)?.message ?? error) });
  }
};
