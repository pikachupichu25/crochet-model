import { beforeAll, describe, expect, it } from "vitest";
import { parseStitchGraph, type StitchGraph } from "../src/cp/graph.ts";
import { builtinStitches, bundledExamples, createNodeValidator } from "../src/cp/nodeParser.ts";
import { createNodeSolver } from "../src/cp/nodeSolver.ts";
import type { Solver } from "../src/cp/layout.ts";
import { glyphFor } from "../src/symbols/glyphs.ts";
import { legendEntries, legendIcon, stitchName } from "../src/symbols/legend.ts";
import { placeStitches, UNDRAWN_TYPES } from "../src/symbols/legs.ts";
import { buildSymbolScene } from "../src/symbols/scene.ts";
import { cross, distance, dot, mean, sub } from "../src/symbols/vec.ts";

const { validate } = createNodeValidator();
let solver: Solver;
beforeAll(async () => {
  solver = await createNodeSolver();
});

function graphOf(text: string, dimension: 2 | 3 = 2): { graph: StitchGraph; simpleDot: string } {
  const result = validate(text, { dimension });
  if (!result.ok) throw new Error(result.error!.message);
  return { graph: parseStitchGraph(result.graphJson!), simpleDot: result.simpleDot! };
}

function laidOut(text: string, dimension: 2 | 3 = 2) {
  const { graph, simpleDot } = graphOf(text, dimension);
  return { graph, positions: solver.layout(simpleDot, { iterations: 200 }).positions };
}

/** Positions that only need to exist: for tests of topology, not geometry. */
function anyPositions(graph: StitchGraph): Record<string, number[]> {
  return Object.fromEntries(graph.nodes.map((n, i) => [n.id, [i % 17, Math.floor(i / 17), 0]]));
}

const pos = (id: string) => id.split("|")[0]!;

describe("placeStitches", () => {
  it("stands an increase's stitches on one foot and a decrease on two", () => {
    const { graph, positions } = laidOut("6ch,turn\nsk,sc2inc,sc2tog,dc2tog");
    const p = Object.fromEntries(placeStitches(graph, positions, 1, 2).map((x) => [pos(x.stitch.id), x]));
    expect(p["1,0"]!.legs.map((l) => pos(l.footNode))).toEqual(["0,4"]);
    expect(p["1,1"]!.legs.map((l) => pos(l.footNode))).toEqual(["0,4"]);
    expect(p["1,2"]!.legs.map((l) => pos(l.footNode))).toEqual(["0,3", "0,2"]);
    expect(p["1,3"]!.legs).toHaveLength(2);
  });

  it("puts the foot of a stitch in a chain space on the space, not on the chains either side", () => {
    const { graph, positions } = laidOut("6ch,turn\nsk,sc,3ch.A!,3sk,sc,turn\nch,3dc@A");
    const dcs = placeStitches(graph, positions, 1, 2).filter((x) => x.stitch.row === 2 && x.stitch.type === "dc");
    expect(dcs).toHaveLength(3);
    for (const dc of dcs) expect(dc.legs).toHaveLength(1);
    const spaced = dcs.filter((dc) => dc.legs[0]!.intoSpace);
    expect(spaced.length).toBeGreaterThan(0);
    for (const dc of spaced) expect(dc.legs[0]!.footNode).toMatch(/B\|/);
  });

  it("sends round 1 to the magic ring, with or without a ring label", () => {
    for (const text of ["ring\n6sc\n6*sc2inc", "ring.R\n6sc@R\n6*sc2inc"]) {
      const { graph, positions } = laidOut(text, 3);
      const round1 = placeStitches(graph, positions, 1, 3).filter((x) => x.stitch.row === 1);
      expect(round1).toHaveLength(6);
      for (const s of round1) expect(s.legs).toMatchObject([{ footNode: "0,0|0", onRing: true }]);
      const round2 = placeStitches(graph, positions, 1, 3).filter((x) => x.stitch.row === 2);
      for (const s of round2) expect(s.legs[0]!.onRing).toBe(false);
    }
  });

  it("ends loop and post legs at the stitch worked into, not at the loop node", () => {
    const { graph, positions } = laidOut("4ch,turn\nsk,3sc,turn\nch,sk,scbl,fpdc");
    const row2 = placeStitches(graph, positions, 1, 2).filter((x) => x.stitch.row === 2 && x.legs.length);
    for (const s of row2) for (const l of s.legs) expect(l.footNode).not.toMatch(/jacobian/);
  });

  it("gives chains, the ring and slip stitches no legs", () => {
    const { graph, positions } = laidOut("ring\n6sc,ss@[%,0]\n3ch,6sc", 3);
    const placed = placeStitches(graph, positions, 1, 3);
    for (const s of placed) {
      if (["ch", "ring", "ss"].includes(s.stitch.type)) expect(s.legs).toEqual([]);
      expect(UNDRAWN_TYPES.has(s.stitch.type)).toBe(false);
    }
  });
});

describe("the ring rule on the bundled examples", () => {
  // Only patterns with a magic ring can trip it. The parser alone takes
  // seconds on these, which slows the conformance run alongside.
  const SLOW = new Set(["textDoily", "textChevron", "textHat", "textEarth"]);
  for (const [name, text] of Object.entries(bundledExamples())) {
    if (SLOW.has(name) || !/\bring\b/.test(text)) continue;
    it(name, () => {
      const result = validate(text);
      if (!result.ok) return; // conformance.test.ts covers parse failures
      const graph = parseStitchGraph(result.graphJson!);
      const rings = new Set(graph.stitches.filter((s) => s.type === "ring").map((s) => s.id));
      const ringRows = new Set(graph.stitches.filter((s) => s.workedInto.some((id) => rings.has(id))).map((s) => s.row));
      for (const p of placeStitches(graph, anyPositions(graph), 1, 2)) {
        for (const leg of p.legs) {
          if (leg.onRing) expect(ringRows.has(p.stitch.row)).toBe(true);
          if (p.stitch.workedInto.length === 1 && rings.has(p.stitch.workedInto[0]!)) expect(leg.onRing).toBe(true);
        }
      }
    });
  }
});

describe("glyphs", () => {
  // Second phase (S3): until then they use the fallback mark.
  const LATER = /puff|bobble|pc$/;

  it("gives every built-in stitch a symbol, except the S3 ones", () => {
    const missing = builtinStitches()
      .filter((t) => !UNDRAWN_TYPES.has(t) && t !== "picot3")
      .filter((t) => glyphFor(t).fallback && !LATER.test(t));
    expect(missing).toEqual([]);
  });

  it("draws back and front loop, and front and back post, alike for now (ISSUE-003)", () => {
    expect(glyphFor("scbl", "back")).toEqual(glyphFor("scfl", "front"));
    expect(glyphFor("fpdc", "front").leg).toEqual(glyphFor("bpdc", "back").leg);
  });
});

describe("buildSymbolScene", () => {
  it("keeps a dc's bar and slash the same size when the stitch is stretched", () => {
    const { graph, positions } = laidOut("4ch,turn\nsk,3dc");
    const dc = graph.stitches.find((s) => s.row === 1 && s.index === 1)!;
    // Lengths in units: moving a node can change the median yarn edge.
    const scene = (p: Record<string, number[]>) => {
      const s = buildSymbolScene(graph, p, 2, { colorMode: "ink" });
      const glyph = s.glyphs.find((g) => g.stitchId === dc.id)!;
      return glyph.lines.filter((l) => l.length === 2).map(([a, b]) => distance(a!, b!) / s.unit);
    };
    const before = scene(positions);
    // Pull the stitch's top a long way up.
    const [x, y] = positions[dc.id]!;
    const after = scene({ ...positions, [dc.id]: [x!, y! + 5] });
    const [postBefore, ...restBefore] = before;
    const [postAfter, ...restAfter] = after;
    expect(postAfter!).toBeGreaterThan(postBefore! + 2);
    restAfter.forEach((l, i) => expect(l).toBeCloseTo(restBefore[i]!, 6));
  });

  it("is flat in 2D and bounds every point", () => {
    const { graph, positions } = laidOut("ring\n6sc\n6*sc2inc", 2);
    const scene = buildSymbolScene(graph, positions, 2, { colorMode: "ink" });
    for (const g of scene.glyphs)
      for (const p of g.lines.flat()) {
        expect(p[2]).toBe(0);
        for (let i = 0; i < 3; i++) {
          expect(p[i]).toBeGreaterThanOrEqual(scene.bounds.min[i]! - 1e-9);
          expect(p[i]).toBeLessThanOrEqual(scene.bounds.max[i]! + 1e-9);
        }
      }
  });

  it("resolves colour keys by mode", () => {
    const { graph, positions } = laidOut("COLOR: navy\n4ch,turn\nsk,3sc");
    const keys = (colorMode: "ink" | "yarn" | "type") =>
      new Set(buildSymbolScene(graph, positions, 2, { colorMode }).glyphs.map((g) => g.colorKey));
    expect(keys("ink")).toEqual(new Set(["ink"]));
    expect(keys("type")).toEqual(new Set(["ch", "sc"]));
    expect([...keys("yarn")].every((k) => k.toLowerCase() === "navy")).toBe(true);
  });
});

describe("legend", () => {
  it("names composite stitches and counts them as the pattern does", () => {
    const { graph, positions } = laidOut("ring\n6sc\n6*sc2inc\n6*[sc,sc2tog]", 3);
    const entries = legendEntries(buildSymbolScene(graph, positions, 3, { colorMode: "ink" }));
    expect(entries.map((e) => [e.key, e.count])).toEqual([
      ["ring", 1],
      ["sc", 12],
      ["sc2inc", 6],
      ["sc2tog", 6],
    ]);
  });

  it("finds picots, and lists unknown stitches last", () => {
    const { graph, positions } = laidOut("8ch,turn\nsk,sc,picot3,sc,dc3bobble,sc");
    const entries = legendEntries(buildSymbolScene(graph, positions, 2, { colorMode: "ink" }));
    expect(entries.map((e) => e.key)).toEqual(["ch", "sc", "picot3", "dc3bobble"]);
    expect(entries.at(-1)!.fallback).toBe(true);
  });

  it("gives US names", () => {
    expect(stitchName("sc2tog")).toBe("single crochet 2 together");
    expect(stitchName("dc3inc")).toBe("3 double crochet in one stitch");
    expect(stitchName("fpdc")).toBe("front post double crochet");
    expect(stitchName("scbl")).toBe("single crochet, back loop only");
    expect(stitchName("dc3bobble")).toBe("dc3bobble");
  });

  it("draws an icon for every entry", () => {
    for (const key of ["ch", "ss", "ring", "sc", "dc", "trtr", "sc2inc", "dc2tog", "picot3", "scbl", "fpdc", "dc3bobble"]) {
      const icon = legendIcon(key);
      expect(icon.lines.length + icon.dots.length).toBeGreaterThan(0);
      expect(icon.box[2]).toBeGreaterThan(icon.box[0]);
      expect(icon.box[3]).toBeGreaterThan(icon.box[1]);
    }
  });
});

describe("3D", () => {
  const rep = (line: string, n: number) => Array.from({ length: n }, () => line).join("\n");
  const BALL = `ring.R\n6sc@R\n6*sc2inc\n6*[sc,sc2inc]\n6*[2sc,sc2inc]\n${rep("24sc", 4)}\n6*[2sc,sc2tog]\n6*[sc,sc2tog]\n6*sc2tog`;

  it("turns every frame of a ball outwards", () => {
    const { graph, positions } = laidOut(BALL, 3);
    const placed = placeStitches(graph, positions, 1, 3);
    const centre = mean(placed.map((p) => p.top));
    const outward = placed.filter((p) => dot(p.frame.out, sub(p.top, centre)) > 0);
    expect(outward.length / placed.length).toBeGreaterThan(0.97);
  });

  it("makes frames agree across turned rows", () => {
    const { graph, positions } = laidOut(`16ch,turn\nsk,15sc,turn\n${rep("ch,15sc,turn", 8)}`, 3);
    const placed = placeStitches(graph, positions, 1, 3);
    const byId = new Map(placed.map((p) => [p.stitch.id, p]));
    const pairs = placed.flatMap((p) => p.legs.map((l) => byId.get(l.footNode)).filter((q) => q !== undefined).map((q) => [p, q] as const));
    expect(pairs.length).toBeGreaterThan(100);
    for (const [p, q] of pairs) expect(dot(p.frame.out, q.frame.out)).toBeGreaterThan(0);
  });

  it("lifts symbols off the fabric along out", () => {
    const { graph, positions } = laidOut(BALL, 3);
    const scene = buildSymbolScene(graph, positions, 3, { colorMode: "ink" });
    const ss = graph.stitches.find((s) => s.row === 3)!;
    const glyph = scene.glyphs.find((g) => g.stitchId === ss.id)!;
    // The hit quad's centre is the top moved along out by the lift.
    const centre = mean(glyph.hit);
    const top = positions[ss.id]! as [number, number, number];
    expect(dot(sub(centre, top), glyph.out)).toBeCloseTo(0.15 * scene.unit, 6);
  });

  it("builds a surface whose triangles face out", () => {
    const { graph, positions } = laidOut(BALL, 3);
    const scene = buildSymbolScene(graph, positions, 3, { colorMode: "ink" });
    const { vertices, triangles } = scene.surface!;
    expect(triangles.length / 3).toBeGreaterThan(graph.stitches.length);
    const centre = mean(vertices);
    let outward = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [vertices[triangles[t]!]!, vertices[triangles[t + 1]!]!, vertices[triangles[t + 2]!]!];
      if (dot(cross(sub(b, a), sub(c, a)), sub(mean([a, b, c]), centre)) > 0) outward++;
    }
    expect(outward / (triangles.length / 3)).toBeGreaterThan(0.97);
  });

  it("has no surface in 2D", () => {
    const { graph, positions } = laidOut("4ch,turn\nsk,3sc");
    expect(buildSymbolScene(graph, positions, 2, { colorMode: "ink" }).surface).toBeUndefined();
  });
});

describe("overlays", () => {
  it("labels each row once, and alternates row colours", () => {
    const { graph, positions } = laidOut("ring\n6sc\n6*sc2inc\n6*[sc,sc2inc]", 2);
    const scene = buildSymbolScene(graph, positions, 2, { colorMode: "rows" });
    expect(scene.rowLabels.map((l) => l.row)).toEqual([1, 2, 3]);
    const keyOf = (row: number) => scene.glyphs.find((g) => graph.stitches.find((s) => s.id === g.stitchId)!.row === row)!.colorKey;
    expect([keyOf(1), keyOf(2), keyOf(3)]).toEqual(["row1", "row0", "row1"]);
  });

  it("follows the yarn through every stitch of one piece, and breaks between pieces", () => {
    const one = laidOut("4ch,turn\nsk,3sc");
    expect(buildSymbolScene(one.graph, one.positions, 2, { colorMode: "ink" }).yarnPath.map((r) => r.length)).toEqual([7]);
    const two = laidOut("4ch\nstart_anew\n3ch", 3);
    expect(buildSymbolScene(two.graph, two.positions, 3, { colorMode: "ink" }).yarnPath.map((r) => r.length)).toEqual([4, 3]);
  });
});
