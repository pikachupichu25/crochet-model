// A surface under 3D symbols (docs/symbol/SPEC.md §5.4): triangles between
// each stitch's top and feet and its neighbour's, so the shape reads and the
// far side is hidden. It shows the fabric's shape only roughly: it is a
// backdrop for symbols, not a render of the yarn.

import type { StitchPlacement } from "./legs.ts";
import { cross, distance, dot, length, sub, vec, type Vec3 } from "./vec.ts";

export interface Surface {
  vertices: Vec3[];
  /** Vertex indices, three per triangle, wound so the normal faces `out`. */
  triangles: number[];
}

/** Triangles with an edge longer than this many units span a gap (a row end, a turn), not fabric. */
const MAX_EDGE = 3;

export function buildSurface(placements: StitchPlacement[], positions: Record<string, number[]>, unit: number): Surface {
  const vertices: Vec3[] = [];
  const index = new Map<string, number>();
  const vertex = (id: string, fallback: Vec3): number => {
    let i = index.get(id);
    if (i === undefined) {
      const p = positions[id];
      vertices.push(p ? vec(p) : fallback);
      index.set(id, (i = vertices.length - 1));
    }
    return i;
  };

  const triangles: number[] = [];
  const add = (a: number, b: number, c: number, out: Vec3) => {
    if (a === b || b === c || a === c) return;
    const [pa, pb, pc] = [vertices[a]!, vertices[b]!, vertices[c]!];
    if (Math.max(distance(pa, pb), distance(pb, pc), distance(pc, pa)) > MAX_EDGE * unit) return;
    const n = cross(sub(pb, pa), sub(pc, pa));
    if (length(n) < 1e-12) return;
    if (dot(n, out) < 0) triangles.push(a, c, b);
    else triangles.push(a, b, c);
  };

  let prev: { row: number; top: number; lastFoot: number } | undefined;
  for (const p of placements) {
    if (!p.legs.length) {
      prev = undefined;
      continue;
    }
    const top = vertex(p.stitch.id, p.top);
    // Foot nodes as laid out; a ring's legs meet at its centre (legs.ts), not at its node.
    const feet = p.legs.map((l) => (l.onRing ? vertex(`ring:${l.footNode}`, l.foot) : vertex(l.footNode, l.foot)));
    const out = p.frame.out;
    // A decrease: a fan from its top over its feet.
    for (let k = 1; k < feet.length; k++) add(feet[k - 1]!, feet[k]!, top, out);
    // The quad between this stitch and the one before it in the same row.
    if (prev && prev.row === p.stitch.row) {
      add(prev.lastFoot, feet[0]!, top, out);
      add(prev.lastFoot, top, prev.top, out);
    }
    prev = { row: p.stitch.row, top, lastFoot: feet.at(-1)! };
  }
  return { vertices, triangles };
}
