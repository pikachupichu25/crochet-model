// Node loader for the vendored layout solver.
//
// graph64.js starts with `var Module = typeof Module != "undefined" ? Module : {}`,
// so settings must already exist as a global `Module` when it runs. Under
// require() the script's own `var Module` hoists over any global, so it is run
// in a vm context instead, with Module (print hook and the wasm bytes) preset.
// With no `process` in the context, the loader takes no Node-specific paths.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createSolver, type EmscriptenSolver, type Solver, type SolverLoader } from "./layout.ts";
import { VENDOR_DIR } from "./nodeParser.ts";

export function nodeSolverLoader(dir: string = VENDOR_DIR): SolverLoader {
  const script = new vm.Script(readFileSync(`${dir}graph64.js`, "utf8"), {
    filename: "graph64.js",
  });
  const wasmBinary = readFileSync(`${dir}graph64.wasm`);

  return ({ print }) =>
    new Promise((resolve, reject) => {
      const Module: Record<string, unknown> = {
        wasmBinary,
        print,
        printErr: () => {},
        onRuntimeInitialized: () => resolve(Module as unknown as EmscriptenSolver),
        onAbort: (reason: unknown) => reject(new Error(`layout solver aborted: ${String(reason)}`)),
      };
      const context = vm.createContext({
        Module,
        console,
        WebAssembly,
        TextDecoder,
        TextEncoder,
        URL,
        performance,
        setTimeout,
        clearTimeout,
      });
      try {
        script.runInContext(context);
      } catch (error) {
        reject(error);
      }
    });
}

export function createNodeSolver(dir?: string): Promise<Solver> {
  return createSolver(nodeSolverLoader(dir));
}
