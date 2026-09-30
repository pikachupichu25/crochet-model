// `TRANSFORM_OBJECT:` lines: moving the separate pieces of a project apart.
//
// A pattern of several pieces (`start_anew`, `new`) is laid out as one graph,
// and unconnected pieces end up on top of each other. crochetparade.org's
// "Object Transform" tool lets the user move and rotate each piece after the
// layout, and writes the result into the pattern as
//
//   TRANSFORM_OBJECT: object,tx,ty,tz,rx,ry,rz
//
// The parser skips these lines; only the site's renderer (mesh64.js) reads
// them. Objects are the connected components of the graph, numbered in the
// order their first node appears in the parser's output. A piece is rotated
// about its centre of mass by the Euler angles rx, ry, rz (radians, XYZ order,
// as three.js), then moved by (tx, ty, tz). The renderer first centres the
// model and divides by its bounding radius, so the move is in bounding radii.

import type { StitchGraph } from "./graph.ts";

export interface ObjectTransform {
  /** Connected component number. */
  object: number;
  /** In bounding radii of the whole model. */
  translate: [number, number, number];
  /** Euler angles in radians, applied in XYZ order. */
  rotate: [number, number, number];
}

const TRANSFORM =
  /^\s*TRANSFORM_OBJECT:\s*(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/gm;

/** Reads the `TRANSFORM_OBJECT:` lines of a pattern; a later line for the same object wins. */
export function readObjectTransforms(text: string): ObjectTransform[] {
  // Like the site, ignore `\…\` comments.
  const uncommented = text.split("\\").filter((_, i) => i % 2 === 0).join("");
  const byObject = new Map<number, ObjectTransform>();
  for (const m of uncommented.matchAll(TRANSFORM)) {
    const [tx, ty, tz, rx, ry, rz] = m.slice(2, 8).map(Number) as [number, number, number, number, number, number];
    byObject.set(Number(m[1]), { object: Number(m[1]), translate: [tx, ty, tz], rotate: [rx, ry, rz] });
  }
  return [...byObject.values()];
}

/** Numbers the connected components of the graph, as the site does: by first node. */
export function objectNumbers(graph: StitchGraph): Map<string, number> {
  const neighbours = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    neighbours.get(e.tail)?.push(e.head);
    neighbours.get(e.head)?.push(e.tail);
  }
  const object = new Map<string, number>();
  let next = 0;
  for (const { id } of graph.nodes) {
    if (object.has(id)) continue;
    const stack = [id];
    object.set(id, next);
    while (stack.length) {
      for (const nb of neighbours.get(stack.pop()!) ?? []) {
        if (!object.has(nb)) {
          object.set(nb, next);
          stack.push(nb);
        }
      }
    }
    next++;
  }
  return object;
}

/**
 * Applies the transforms to a 3D layout and returns new positions. 2D layouts,
 * and layouts without transforms, are returned as they are.
 *
 * The site takes each piece's centre of mass over the meshes it draws (stitch
 * balls, edge midpoints, arrowheads); this takes it over the piece's drawn
 * nodes, which is close enough to put the pieces in the same places.
 */
export function applyObjectTransforms(
  graph: StitchGraph,
  positions: Record<string, number[]>,
  transforms: ObjectTransform[],
): Record<string, number[]> {
  const points = Object.values(positions);
  const active = transforms.filter((t) => [...t.translate, ...t.rotate].some((v) => v !== 0));
  if (!active.length || points.some((p) => p.length !== 3)) return positions;

  // The site's unit of translation: the largest distance from the model's centre.
  const centre = mean(points);
  const radius = Math.sqrt(Math.max(...points.map((p) => distance2(p, centre))));

  const objects = objectNumbers(graph);
  const hidden = new Set(graph.nodes.filter((n) => n.hidden).map((n) => n.id));
  const result = { ...positions };
  for (const t of active) {
    const ids = Object.keys(positions).filter((id) => objects.get(id) === t.object);
    const drawn = ids.filter((id) => !hidden.has(id));
    if (!ids.length) continue;
    const com = mean((drawn.length ? drawn : ids).map((id) => positions[id]!));
    const r = eulerXYZ(...t.rotate);
    for (const id of ids) {
      const p = positions[id]!;
      const d = [p[0]! - com[0]!, p[1]! - com[1]!, p[2]! - com[2]!];
      result[id] = [0, 1, 2].map(
        (i) => r[i]![0]! * d[0]! + r[i]![1]! * d[1]! + r[i]![2]! * d[2]! + com[i]! + t.translate[i]! * radius,
      );
    }
  }
  return result;
}

/** The rotation matrix of a three.js `Euler(x, y, z, "XYZ")`: Rx · Ry · Rz. */
function eulerXYZ(x: number, y: number, z: number): number[][] {
  const [a, b] = [Math.cos(x), Math.sin(x)];
  const [c, d] = [Math.cos(y), Math.sin(y)];
  const [e, f] = [Math.cos(z), Math.sin(z)];
  return [
    [c * e, -c * f, d],
    [a * f + b * e * d, a * e - b * f * d, -b * c],
    [b * f - a * e * d, b * e + a * f * d, a * c],
  ];
}

function mean(points: number[][]): number[] {
  const sum = [0, 0, 0];
  for (const p of points) for (let i = 0; i < 3; i++) sum[i]! += p[i] ?? 0;
  return sum.map((s) => s / points.length);
}

function distance2(p: number[], q: number[]): number {
  return (p[0]! - q[0]!) ** 2 + (p[1]! - q[1]!) ** 2 + ((p[2] ?? 0) - (q[2] ?? 0)) ** 2;
}
