import { beforeAll, describe, expect, it } from "vitest";
import { parseStitchGraph, type StitchGraph } from "../src/cp/graph.ts";
import { bundledExamples, createNodeValidator } from "../src/cp/nodeParser.ts";
import { createNodeSolver } from "../src/cp/nodeSolver.ts";
import { applyObjectTransforms, objectNumbers, readObjectTransforms } from "../src/cp/objectTransform.ts";

const { validate } = createNodeValidator();

function graphOf(text: string): { graph: StitchGraph; simpleDot: string } {
  const result = validate(text, { dimension: 3 });
  if (!result.ok) throw new Error(result.error!.message);
  return { graph: parseStitchGraph(result.graphJson!), simpleDot: result.simpleDot! };
}

describe("readObjectTransforms", () => {
  it("reads object, translation and rotation; a later line wins", () => {
    const text = "ring\n6sc\nTRANSFORM_OBJECT: 0,1,2,3,0,0,0\nTRANSFORM_OBJECT: 2,0,0.97,0,2.22,0,-0.5\nTRANSFORM_OBJECT: 0,0,-1.5,0,0,0,0";
    expect(readObjectTransforms(text)).toEqual([
      { object: 0, translate: [0, -1.5, 0], rotate: [0, 0, 0] },
      { object: 2, translate: [0, 0.97, 0], rotate: [2.22, 0, -0.5] },
    ]);
  });

  it("ignores lines inside \\…\\ comments", () => {
    expect(readObjectTransforms("ring\n\\\nTRANSFORM_OBJECT: 0,1,0,0,0,0,0\n\\\n6sc")).toEqual([]);
  });
});

describe("applyObjectTransforms", () => {
  // Two separate balls: they are laid out on top of each other.
  const BALLS = "ring\n6sc\n6*[sc2inc]\n6*[sc,sc2inc]\n6*sc\nstart_anew\nring\n6sc\n6*[sc2inc]\n6*sc";
  const { graph } = graphOf(BALLS);
  const objects = objectNumbers(graph);
  // A made-up layout: node i at (i, 2i, -i).
  const positions = Object.fromEntries(graph.nodes.map((n, i) => [n.id, [i, 2 * i, -i]]));

  it("numbers the unconnected pieces by first node", () => {
    expect(objects.get(graph.stitches[0]!.id)).toBe(0);
    expect(objects.get(graph.stitches.at(-1)!.id)).toBe(new Set(objects.values()).size - 1);
  });

  it("returns the layout as it is without transforms", () => {
    expect(applyObjectTransforms(graph, positions, [])).toBe(positions);
    expect(applyObjectTransforms(graph, positions, [{ object: 0, translate: [0, 0, 0], rotate: [0, 0, 0] }])).toBe(positions);
  });

  it("moves one piece by bounding radii and leaves the others", () => {
    const moved = applyObjectTransforms(graph, positions, [{ object: 0, translate: [0, 1, 0], rotate: [0, 0, 0] }]);
    const points = Object.values(positions);
    const c = [0, 1, 2].map((i) => points.reduce((s, p) => s + p[i]!, 0) / points.length);
    const radius = Math.sqrt(Math.max(...points.map((p) => (p[0]! - c[0]!) ** 2 + (p[1]! - c[1]!) ** 2 + (p[2]! - c[2]!) ** 2)));
    for (const [id, p] of Object.entries(positions)) {
      const dy = objects.get(id) === 0 ? radius : 0;
      [p[0]!, p[1]! + dy, p[2]!].forEach((v, i) => expect(moved[id]![i]).toBeCloseTo(v, 9));
    }
  });

  it("rotates a piece about its centre, as three.js Euler XYZ", () => {
    const quarter = applyObjectTransforms(graph, positions, [{ object: 1, translate: [0, 0, 0], rotate: [0, 0, Math.PI / 2] }]);
    const ids = graph.nodes.filter((n) => objects.get(n.id) === 1 && !n.hidden).map((n) => n.id);
    const centre = (ps: number[][]) => [0, 1, 2].map((i) => ps.reduce((s, p) => s + p[i]!, 0) / ps.length);
    const before = centre(ids.map((id) => positions[id]!));
    const after = centre(ids.map((id) => quarter[id]!));
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 9));
    // About z by 90°: (x, y) relative to the centre becomes (-y, x).
    const [p, q] = [positions[ids[0]!]!, quarter[ids[0]!]!];
    expect(q[0]! - before[0]!).toBeCloseTo(-(p[1]! - before[1]!), 9);
    expect(q[1]! - before[1]!).toBeCloseTo(p[0]! - before[0]!, 9);
    expect(q[2]).toBeCloseTo(p[2]!, 9);
  });
});

describe("the snowman, against crochetparade.org", () => {
  // Read from the site's scene after it drew "Amigurumi: simplistic snowman" (textSnowman2):
  // positions are centred on the model and divided by its bounding radius, then transformed.
  const SITE_OBJECT_CENTRES = [
    [-0.0042, -1.5277, -0.0011],
    [0.0123, 0.0049, -0.0003],
    [-0.0054, 0.9718, 0.0059],
  ];
  const SITE_STITCHES: Record<string, number[]> = {
    "1,0|1": [-0.0465, -0.5996, 0.1146],
    "12,5|287": [-0.282, -1.1729, -0.8184],
    "30,3|757": [-0.6012, 0.1287, 0.0721],
    "50,2|1080": [0.3442, 1.1335, -0.2286],
  };
  let normalised: (id: string) => number[];
  let graph: StitchGraph;

  beforeAll(async () => {
    const text = bundledExamples().textSnowman2!;
    const parsed = graphOf(text);
    graph = parsed.graph;
    const { positions } = (await createNodeSolver()).layout(parsed.simpleDot);
    const moved = applyObjectTransforms(graph, positions, readObjectTransforms(text));
    // The site normalises the untransformed layout, then transforms it.
    const points = Object.values(positions);
    const c = [0, 1, 2].map((i) => points.reduce((s, p) => s + p[i]!, 0) / points.length);
    const r = Math.sqrt(Math.max(...points.map((p) => (p[0]! - c[0]!) ** 2 + (p[1]! - c[1]!) ** 2 + (p[2]! - c[2]!) ** 2)));
    normalised = (id) => moved[id]!.map((v, i) => (v - c[i]!) / r);
  }, 60_000);

  it("puts each piece where the site does", () => {
    const objects = objectNumbers(graph);
    SITE_OBJECT_CENTRES.forEach((site, object) => {
      const ids = graph.nodes.filter((n) => !n.hidden && objects.get(n.id) === object).map((n) => n.id);
      const ours = [0, 1, 2].map((i) => ids.reduce((s, id) => s + normalised(id)[i]!, 0) / ids.length);
      ours.forEach((v, i) => expect(Math.abs(v - site[i]!)).toBeLessThan(0.02));
    });
  });

  it("puts sample stitches where the site does", () => {
    for (const [id, site] of Object.entries(SITE_STITCHES)) {
      normalised(id).forEach((v, i) => expect(Math.abs(v - site[i]!)).toBeLessThan(0.02));
    }
  });
});
