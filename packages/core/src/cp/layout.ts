// Runtime-agnostic wrapper around CrochetPARADE's layout solver (graph64.wasm,
// an Emscripten build of graph.cpp; see the ply-split-braiding
// docs/elastic/README.md §2 for what it computes).
//
// Loading the Emscripten module is the job of a loader (Node: nodeSolver.ts;
// browser: a Web Worker). This module builds the solver's input, runs it,
// parses its output and turns its per-iteration log lines into progress.
//
// performLayout is synchronous and cannot be interrupted. To cancel a layout,
// terminate the worker running it.

import type { Dimension } from "./validator.ts";

/** The subset of the Emscripten module that the solver needs. */
export interface EmscriptenSolver {
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  ccall(name: string, returnType: string, argTypes: string[], args: unknown[]): number;
  stringToUTF8(text: string, pointer: number, maxBytes: number): void;
  UTF8ToString(pointer: number): string;
}

/**
 * Loads a fresh Emscripten module. `print` receives the solver's stdout, one
 * line at a time; it must be installed before the module starts.
 */
export type SolverLoader = (hooks: { print(line: string): void }) => Promise<EmscriptenSolver>;

/**
 * Overrides for the solver settings. Anything not given keeps the value from
 * the pattern's own `DOT:` lines, or the solver default.
 */
export interface SolverSettings {
  /** Random seed. A different seed can flip an inside-out 3D model. Default 0. */
  seed?: number;
  /** Gradient steps per attempt. Default 500. */
  iterations?: number;
}

export interface LayoutProgress {
  /** Starts at 1; goes up when the solver blows up and restarts with a smaller step. */
  attempt: number;
  iteration: number;
  iterations: number;
  /** RMS of the adjacent-spring forces; shows convergence, not accuracy. */
  error: number;
}

export interface LayoutResult {
  dimension: Dimension;
  /** Node name ("row,index|statement", or an internal node name) → [x, y] or [x, y, z]. */
  positions: Record<string, number[]>;
  iterations: number;
  attempts: number;
  /** Last reported error, if the solver reported any. */
  finalError?: number;
  ms: number;
}

const DEFAULT_ITERATIONS = 500;

export function readDimension(simpleDot: string): Dimension {
  const first = simpleDot.slice(0, simpleDot.indexOf("\n")).trim();
  if (first === "2" || first === "3") return Number(first) as Dimension;
  throw new Error(`simpleDot does not start with a dimension line: ${JSON.stringify(first)}`);
}

/**
 * Appends settings as extra lines. The solver reads settings from any line
 * that is not a node or edge, and a later line overrides an earlier one, so
 * these win over the pattern's own DOT: lines.
 */
export function buildSolverInput(simpleDot: string, settings: SolverSettings = {}): string {
  const extra: string[] = [];
  if (settings.seed !== undefined) extra.push(`start=${Math.trunc(settings.seed)}`);
  if (settings.iterations !== undefined) extra.push(`iterations=${Math.trunc(settings.iterations)}`);
  if (extra.length === 0) return simpleDot;
  const base = simpleDot.endsWith("\n") ? simpleDot : `${simpleDot}\n`;
  return `${base}${extra.join("\n")}\n`;
}

/** The iteration count the solver will use for this input. */
export function readIterations(input: string): number {
  let iterations = DEFAULT_ITERATIONS;
  for (const line of input.split("\n")) {
    if (line.startsWith('"')) continue; // node and edge lines
    const m = /(?:^|[^_a-z])iterations\s*=\s*(\d+)/.exec(line);
    if (m) iterations = Number(m[1]);
  }
  return iterations;
}

/** Solver output is `{"name": "…","pos": "x,y[,z]"},` per line. */
export function parseLayoutOutput(raw: string): Record<string, number[]> {
  const body = raw.trim().replace(/,$/, "");
  const entries = JSON.parse(`[${body}]`) as { name: string; pos: string }[];
  const positions: Record<string, number[]> = {};
  for (const { name, pos } of entries) {
    positions[name] = pos.split(",").map(Number);
  }
  return positions;
}

type ProgressLine =
  | { kind: "iteration"; iteration: number; error: number }
  | { kind: "restart" };

export function parseProgressLine(line: string): ProgressLine | undefined {
  const it = /^Iteration = (\d+) Error = (\S+)/.exec(line);
  if (it) return { kind: "iteration", iteration: Number(it[1]), error: Number(it[2]) };
  if (line.startsWith("Failed to converge")) return { kind: "restart" };
  return undefined;
}

export interface Solver {
  /** Runs one layout synchronously. */
  layout(
    simpleDot: string,
    settings?: SolverSettings,
    onProgress?: (progress: LayoutProgress) => void,
  ): LayoutResult;
}

export async function createSolver(load: SolverLoader): Promise<Solver> {
  let listener: ((line: string) => void) | undefined;
  const module = await load({ print: (line) => listener?.(line) });

  return {
    layout(simpleDot, settings = {}, onProgress) {
      const started = Date.now();
      const input = buildSolverInput(simpleDot, settings);
      const iterations = readIterations(input);
      let attempt = 1;
      let finalError: number | undefined;
      listener = (line) => {
        const p = parseProgressLine(line);
        if (!p) return;
        if (p.kind === "restart") {
          attempt += 1;
          return;
        }
        finalError = p.error;
        onProgress?.({ attempt, iteration: p.iteration + 1, iterations, error: p.error });
      };

      const bytes = new TextEncoder().encode(input).length + 1;
      const inputPointer = module._malloc(bytes);
      let raw: string;
      try {
        module.stringToUTF8(input, inputPointer, bytes);
        // The result buffer is owned by the solver; upstream never frees it either.
        const resultPointer = module.ccall("performLayout", "number", ["number"], [inputPointer]);
        raw = module.UTF8ToString(resultPointer);
      } finally {
        module._free(inputPointer);
        listener = undefined;
      }

      return {
        dimension: readDimension(simpleDot),
        positions: parseLayoutOutput(raw),
        iterations,
        attempts: attempt,
        finalError,
        ms: Date.now() - started,
      };
    },
  };
}
