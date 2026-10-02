// A frame for each stitch (docs/symbol/SPEC.md §3.4): up from its feet to its
// top, along the row, out of the fabric, and across (in the fabric, at right
// angles to up). In 3D, orientFrames() then makes `out` agree across the
// fabric.

import { cross, dot, mean, normalize, perpendicular, reject, scale, sub, type Vec3 } from "./vec.ts";

export interface Frame {
  up: Vec3;
  along: Vec3;
  out: Vec3;
  across: Vec3;
}

const Z: Vec3 = [0, 0, 1];

/**
 * `feet` may be empty (a chain); `prev` and `next` are the tops of the
 * stitches before and after it in working order.
 */
export function frameFor(top: Vec3, feet: Vec3[], prev: Vec3 | undefined, next: Vec3 | undefined, dimension: 2 | 3): Frame {
  const rowDir =
    normalize(sub(next ?? top, prev ?? top)) ?? normalize(sub(top, prev ?? top)) ?? normalize(sub(next ?? top, top)) ?? ([1, 0, 0] as Vec3);
  const legUp = feet.length ? normalize(sub(top, mean(feet))) : undefined;

  if (dimension === 2) {
    const along2: Vec3 = normalize([rowDir[0], rowDir[1], 0]) ?? [1, 0, 0];
    // A chain stands at right angles to the chain.
    const up = legUp ? (normalize([legUp[0], legUp[1], 0]) ?? cross(Z, along2)) : cross(Z, along2);
    const across = cross(Z, up);
    const along = normalize(reject(along2, up)) ?? across;
    return { up, along, out: Z, across };
  }

  const up = legUp ?? (normalize(reject(perpendicular(rowDir), rowDir)) as Vec3);
  const along = normalize(reject(rowDir, up)) ?? perpendicular(up);
  const out = normalize(cross(up, along)) ?? perpendicular(up);
  const across = normalize(cross(out, up)) ?? along;
  return { up, along, out, across };
}

/** A unit vector in the fabric at right angles to `dir`, for the width of a symbol along a leg. */
export function acrossOf(dir: Vec3, frame: Frame): Vec3 {
  return normalize(cross(frame.out, dir)) ?? frame.across;
}

/**
 * Makes 3D frames face one way across the fabric (SPEC §3.4). `out` comes
 * from the row direction, so it flips on every turned row; this walks the
 * fabric from the first stitch over `neighbours` (the stitches each is worked
 * into, and the ones before and after it) and flips any frame that disagrees
 * with the frames already set around it. Then the whole fabric is turned so
 * `out` points away from its centre, which is the outside of a closed shape.
 * `across` flips with `out`, so symbols are not mirrored.
 */
export function orientFrames(frames: Frame[], tops: Vec3[], neighbours: number[][]): void {
  const n = frames.length;
  const done = new Array<boolean>(n).fill(false);
  const flipFrame = (i: number) => {
    const f = frames[i]!;
    frames[i] = { ...f, out: scale(f.out, -1), across: scale(f.across, -1) };
  };
  for (let start = 0; start < n; start++) {
    if (done[start]) continue;
    done[start] = true;
    const queue = [start];
    while (queue.length) {
      const i = queue.shift()!;
      for (const j of neighbours[i]!) {
        if (done[j]) continue;
        // Agree with every already-set neighbour, weighted by how sure each is.
        let vote = 0;
        for (const k of neighbours[j]!) if (done[k]) vote += dot(frames[j]!.out, frames[k]!.out);
        if (vote < 0) flipFrame(j);
        done[j] = true;
        queue.push(j);
      }
    }
  }
  const centre = mean(tops);
  const outward = frames.reduce((sum, f, i) => sum + dot(f.out, sub(tops[i]!, centre)), 0);
  if (outward < 0) for (let i = 0; i < n; i++) flipFrame(i);
}
