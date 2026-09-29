import { beforeAll, describe, expect, it } from "vitest";
import { countEdgeCrossings, isFolded, layoutUnfolded } from "../src/cp/fold.ts";
import { readSeed, type Solver } from "../src/cp/layout.ts";
import { createNodeValidator } from "../src/cp/nodeParser.ts";
import { createNodeSolver } from "../src/cp/nodeSolver.ts";

const { validate } = createNodeValidator();
let solver: Solver;
beforeAll(async () => {
  solver = await createNodeSolver();
});

// A small cut of CrochetPARADE's baby blanket example. In 2D, seeds 0, 2, 4
// and 9 fold it (13–17% of edges crossing); 1 and 3 lay it out flat.
const BLANKET = `DEF: dc=Copy(dc,3)
[7ch]*4,5ch,turn
$K=0,m=0$,4ch,dc2inc,3sk,sc,[3ch.C[m,K++]!+,3dc,3sk,sc]*4,turn
{$m++,k=0$,4ch,dc2inc,[sc,3ch.C[m,k++]!+,3dc]@C[m-1,K-k]*4,sc@[-1,3],turn
}*4
`;

function simpleDotOf(text: string, dimension: 2 | 3) {
  const result = validate(text, { dimension });
  if (!result.ok) throw new Error(result.error!.message);
  return result.simpleDot!;
}

describe("countEdgeCrossings", () => {
  const dot = '2\n"a"\n"b"\n"c"\n"d"\n"a" -- "b" 1\n"c" -- "d" 1\n"a" -- "c" 1\n';

  it("counts edges that cross", () => {
    const positions = { a: [0, 0], b: [1, 1], c: [0, 1], d: [1, 0] };
    expect(countEdgeCrossings(dot, positions)).toEqual({ edges: 3, crossings: 1 });
  });

  it("does not count edges that only share a node, or miss each other", () => {
    const positions = { a: [0, 0], b: [1, 0], c: [0, 1], d: [1, 1] };
    expect(countEdgeCrossings(dot, positions)).toEqual({ edges: 3, crossings: 0 });
  });

  it("treats a share above 5% as folded", () => {
    expect(isFolded({ edges: 100, crossings: 5 })).toBe(false);
    expect(isFolded({ edges: 100, crossings: 15 })).toBe(true);
  });
});

describe("readSeed", () => {
  it("reads the last start= and ignores node lines", () => {
    expect(readSeed('2\n"start"\n')).toBe(0);
    expect(readSeed("2\nstart=1\nstart=12\n")).toBe(12);
  });
});

describe("layoutUnfolded", () => {
  it("retries a folded 2D layout with the next seed", () => {
    const dot = simpleDotOf(BLANKET, 2);
    const retries: number[] = [];
    const result = layoutUnfolded(solver, dot, { seed: 0 }, undefined, {
      onRetry: (seed, previous) => {
        expect(previous.folded).toBe(true);
        retries.push(seed);
      },
    });
    expect(retries).toEqual([1]);
    expect(result.seed).toBe(1);
    expect(result.fold).toMatchObject({ folded: false, seedsTried: [0, 1] });
  });

  it("starts from the pattern's DOT: start=", () => {
    const result = layoutUnfolded(solver, simpleDotOf(`${BLANKET}DOT: start=2\n`, 2));
    expect(result.fold!.seedsTried).toEqual([2, 3]);
    expect(result.seed).toBe(3);
  });

  it("keeps a flat first layout", () => {
    const result = layoutUnfolded(solver, simpleDotOf(BLANKET, 2), { seed: 1 });
    expect(result.fold).toMatchObject({ folded: false, seedsTried: [1] });
  });

  it("keeps the least folded layout when every seed folds", () => {
    const result = layoutUnfolded(solver, simpleDotOf(BLANKET, 2), { seed: 0 }, undefined, { maxSeeds: 1 });
    expect(result.fold).toMatchObject({ folded: true, seedsTried: [0] });
  });

  it("leaves 3D layouts alone", () => {
    const result = layoutUnfolded(solver, simpleDotOf("ring\n6sc\n6*[sc2inc]", 3));
    expect(result.fold).toBeUndefined();
  });
});
