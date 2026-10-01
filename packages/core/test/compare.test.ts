import { describe, expect, it } from "vitest";
import { compareStructure } from "../src/cp/compare.ts";
import { parseStitchGraph, type StitchGraph } from "../src/cp/graph.ts";
import { createNodeValidator } from "../src/cp/nodeParser.ts";

const { validate } = createNodeValidator();

function graphOf(text: string): StitchGraph {
  const result = validate(text);
  if (!result.ok) throw new Error(result.error!.message);
  return parseStitchGraph(result.graphJson!);
}

const compare = (gold: string, output: string) =>
  compareStructure(graphOf(gold), graphOf(output));

describe("compareStructure", () => {
  it("matches a pattern with itself", () => {
    const m = compare("ring\n6sc\n6*[sc2inc]", "ring\n6sc\n6*[sc2inc]");
    expect(m).toMatchObject({ exact: true, score: 1, goldStitches: 19 });
  });

  it("ignores repeat grouping and early repeat endings", () => {
    const gold = "9ch,turn\nsk,2sc,dc,2sc,dc,2sc";
    expect(compare(gold, "9ch,turn\nsk,[2sc,>,dc]*3").exact).toBe(true);
    expect(compare(gold, "9ch,turn\nsk,2*[2sc,dc],2sc").exact).toBe(true);
  });

  it("ignores label names", () => {
    const m = compare("ring.R\n5sc@R\nsc2inc*5", "ring.X\n5sc@X\nsc2inc*5");
    expect(m.exact).toBe(true);
  });

  it("tells stitches worked into a ring from stitches worked into each other", () => {
    // Without @R, CrochetPARADE works each sc into the one before it.
    expect(compare("ring.R\n6sc@R", "ring\n6sc").exact).toBe(false);
  });

  it("does not match a different stitch type", () => {
    // The paper's cone example: sc swapped for tr.
    const m = compare("ring\n6sc\n6*[sc2inc]", "ring\n6sc\n6*[tr2inc]");
    expect(m.exact).toBe(false);
    expect(m.matched).toBe(7);
    expect(m.score).toBeCloseTo(7 / 19);
    expect(m.firstDifference).toMatchObject({ row: 2, index: 0 });
  });

  it("does not match stitches worked into different places", () => {
    const m = compare("5ch,turn\nsk,4sc", "5ch,turn\nsk,sk,sc2inc,2sc");
    expect(m.exact).toBe(false);
    expect(m.goldStitches).toBe(m.outputStitches);
  });

  it("scores missing stitches against the larger count", () => {
    const m = compare("ring\n6sc\n6*[sc2inc]", "ring\n6sc");
    expect(m).toMatchObject({ exact: false, matched: 7, goldStitches: 19, outputStitches: 7 });
    expect(m.score).toBeCloseTo(7 / 19);
  });
});
