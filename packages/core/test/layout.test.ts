import { beforeAll, describe, expect, it } from "vitest";
import {
  buildSolverInput,
  parseLayoutOutput,
  parseProgressLine,
  readIterations,
  type LayoutProgress,
  type Solver,
} from "../src/cp/layout.ts";
import { createNodeValidator } from "../src/cp/nodeParser.ts";
import { createNodeSolver } from "../src/cp/nodeSolver.ts";

const { validate } = createNodeValidator();
let solver: Solver;
beforeAll(async () => {
  solver = await createNodeSolver();
});

const BALL = "ring\n6sc\n6*[sc2inc]\n6*[sc,sc2inc]\n6*[2sc,sc2inc]";

function simpleDotOf(text: string, dimension: 2 | 3) {
  const result = validate(text, { dimension });
  if (!result.ok) throw new Error(result.error!.message);
  return result.simpleDot!;
}

/** Edges of simpleDot: `"a" -- "b" restLength`. */
function edgesOf(simpleDot: string) {
  return [...simpleDot.matchAll(/^"([^"]+)" -- "([^"]+)" (\S+)/gm)].map((m) => ({
    a: m[1]!,
    b: m[2]!,
    rest: Number(m[3]),
  }));
}

describe("solver input", () => {
  it("appends seed and iteration overrides after the pattern's own DOT: lines", () => {
    const input = buildSolverInput('3\n"0,0|0"\niterations=300\n', { seed: 7, iterations: 900 });
    expect(input.endsWith("iterations=300\nstart=7\niterations=900\n")).toBe(true);
    expect(readIterations(input)).toBe(900);
  });

  it("does not mistake viscous_iterations for iterations", () => {
    expect(readIterations('3\nviscous_iterations=50\n')).toBe(500);
  });

  it("parses progress and restart lines", () => {
    expect(parseProgressLine("Iteration = 12 Error = 0.39")).toEqual({
      kind: "iteration",
      iteration: 12,
      error: 0.39,
    });
    expect(parseProgressLine("Failed to converge. Learning rate reduced to: 0.03")).toEqual({
      kind: "restart",
    });
  });

  it("parses the solver's trailing-comma output", () => {
    const raw = '{"name": "0,0|0","pos": "1,2"},\n{"name": "1,0|1","pos": "3,4.5,-1"},\n';
    expect(parseLayoutOutput(raw)).toEqual({ "0,0|0": [1, 2], "1,0|1": [3, 4.5, -1] });
  });
});

describe("layout", () => {
  it("lays out every node in 3D", () => {
    const dot = simpleDotOf(BALL, 3);
    const result = solver.layout(dot);
    expect(result.dimension).toBe(3);
    const names = [...dot.matchAll(/^"([^"]+)"$/gm)].map((m) => m[1]);
    expect(Object.keys(result.positions).sort()).toEqual(names.sort());
    for (const p of Object.values(result.positions)) {
      expect(p).toHaveLength(3);
      expect(p.every(Number.isFinite)).toBe(true);
    }
  });

  it("gives 2D positions for a 2D parse", () => {
    const result = solver.layout(simpleDotOf("10ch,turn\nsk,9sc,turn\n9sc", 2));
    expect(result.dimension).toBe(2);
    expect(Object.values(result.positions).every((p) => p.length === 2)).toBe(true);
  });

  it("is deterministic for a given seed, and a new seed changes the layout", () => {
    const dot = simpleDotOf(BALL, 3);
    const a = solver.layout(dot, { seed: 3 }).positions;
    const b = solver.layout(dot, { seed: 3 }).positions;
    const c = solver.layout(dot, { seed: 4 }).positions;
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it("brings stitch edges close to their rest lengths", () => {
    const dot = simpleDotOf(BALL, 3);
    const { positions } = solver.layout(dot);
    const strains = edgesOf(dot).map(({ a, b, rest }) => {
      const pa = positions[a]!;
      const pb = positions[b]!;
      const length = Math.hypot(...pa.map((v, i) => v - pb[i]!));
      return Math.abs(length - rest) / rest;
    });
    const mean = strains.reduce((s, x) => s + x, 0) / strains.length;
    // CrochetPARADE's manual quotes "within 10%" for typical patterns.
    expect(mean).toBeLessThan(0.1);
  });

  it("reports progress for every iteration", () => {
    const seen: LayoutProgress[] = [];
    const result = solver.layout(simpleDotOf(BALL, 3), { iterations: 120 }, (p) => seen.push(p));
    expect(result.iterations).toBe(120);
    expect(seen).toHaveLength(120);
    expect(seen.at(-1)).toMatchObject({ attempt: 1, iteration: 120, iterations: 120 });
    expect(result.finalError).toBe(seen.at(-1)!.error);
  });
});
