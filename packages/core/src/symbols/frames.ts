// A frame for each stitch (docs/symbol/SPEC.md §3.4): up from its feet to its
// top, along the row, out of the fabric, and across (in the fabric, at right
// angles to up). 3D frames are not yet made consistent across the fabric;
// that is S2.

import { cross, mean, normalize, perpendicular, reject, sub, type Vec3 } from "./vec.ts";

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
