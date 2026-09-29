import { describe, expect, it } from "vitest";
import { parseStitchGraph, type StitchGraph } from "../src/cp/graph.ts";
import { createNodeValidator } from "../src/cp/nodeParser.ts";

const { validate } = createNodeValidator();

function graphOf(text: string): StitchGraph {
  const result = validate(text);
  if (!result.ok) throw new Error(result.error!.message);
  return parseStitchGraph(result.graphJson!);
}

/** "row,index" → stitch, dropping the statement uid for readable assertions. */
function byPos(graph: StitchGraph) {
  const pos = (id: string) => id.split("|")[0]!;
  return Object.fromEntries(
    graph.stitches.map((s) => [pos(s.id), { ...s, into: s.workedInto.map(pos) }]),
  );
}

describe("parseStitchGraph", () => {
  it("reads stitches in working order, with what each is worked into", () => {
    const s = byPos(graphOf("4ch,turn\nsc,sc,dc2tog"));
    expect(Object.keys(s)).toEqual(["0,0", "0,1", "0,2", "0,3", "1,0", "1,1", "1,2"]);
    expect(s["0,1"]!.into).toEqual([]);
    expect(s["1,0"]!).toMatchObject({ row: 1, index: 0, type: "sc", into: ["0,3"] });
    // a decrease has one top worked into two stitches
    expect(s["1,2"]!).toMatchObject({ type: "dc", into: ["0,1", "0,0"] });
  });

  it("gives an increase two stitches in one statement", () => {
    const s = byPos(graphOf("3ch,turn\nsk,sc2inc,sc"));
    expect(s["1,0"]!.statement).toBe(s["1,1"]!.statement);
    expect(s["1,0"]!.into).toEqual(["0,1"]);
    expect(s["1,1"]!.into).toEqual(["0,1"]);
  });

  it("marks back- and front-loop and post stitches", () => {
    const s = byPos(graphOf("4ch,turn\nsk,3sc,turn\nch,sk,scbl,fpdc"));
    expect(s["2,1"]!).toMatchObject({ type: "scbl", side: "back" });
    expect(s["2,2"]!).toMatchObject({ type: "fpdc", side: "front" });
    expect(s["2,1"]!.into).toEqual(["1,1"]);
    expect(s["2,2"]!.into).toEqual(["1,0"]);
    expect(s["1,0"]!.side).toBeUndefined();
  });

  it("follows internal nodes of puffs and popcorns to what they are worked into", () => {
    const s = byPos(graphOf("4ch,turn\nsk,sc,hdc3puff,dc3pc"));
    expect(s["1,1"]!.into).toEqual(["0,1"]);
    expect(s["1,1"]!.nodeIds).toHaveLength(7);
    // a popcorn also ties the previous stitch to an internal node; that is not an attachment
    expect(s["1,2"]!.into).toEqual(["0,0"]);
  });

  it("gives the slip stitch of a picot the stitch it closes on", () => {
    const s = byPos(graphOf("3ch,turn\nsk,sc,picot3"));
    expect(["1,1", "1,2", "1,3"].map((p) => s[p]!.type)).toEqual(["ch", "ch", "ch"]);
    expect(s["1,4"]!).toMatchObject({ type: "ss", into: ["1,0"] });
  });

  it("marks stitches worked into a chain space", () => {
    const s = byPos(graphOf("9ch,turn\n9sc,turn\nch,@[-1,-1],2sc,4ch.A,3sc,turn\n2ch,sc,3sc@A,ch,sc"));
    const spaced = Object.values(s).filter((x) => x.intoSpace);
    expect(spaced.length).toBeGreaterThan(0);
    for (const x of spaced) expect(x.row).toBe(3);
  });

  it("keeps separate pieces apart after start_anew", () => {
    const g = graphOf("ring\n3sc\nstart_anew\nring\n2sc");
    const yarn = g.edges.filter((e) => e.kind === "yarn");
    const hidden = g.stitches.find((s) => s.type === "hidden")!;
    // no yarn runs into the hidden start node
    expect(yarn.some((e) => e.head === hidden.id)).toBe(false);
  });

  it("reads colours and labels", () => {
    const g = graphOf("COLOR: Red\n3ch.A\nCOLOR: Blue\nsc@A");
    expect(g.stitches[0]!.color).toBe("Red");
    expect(g.stitches.at(-1)!.color).toBe("Blue");
    expect(g.stitches.some((s) => s.labels.includes("A"))).toBe(true);
  });

  it("has an edge for every simpleDot edge, and a node for every end", () => {
    const text = "ring\n6sc\n6*[sc2inc]\n6*[sc,dcbl,picot3]";
    const result = validate(text);
    const g = parseStitchGraph(result.graphJson!);
    const dotEdges = result.simpleDot!.split("\n").filter((l) => / -- /.test(l));
    expect(g.edges).toHaveLength(dotEdges.length);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.tail)).toBe(true);
      expect(ids.has(e.head)).toBe(true);
    }
  });
});
