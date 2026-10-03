// Which symbols overlap (docs/known_issues/ISSUE-004): pairs whose strokes
// come closer than a line width, leaving out the contact charts draw on
// purpose: the legs of an increase meeting at their shared foot, and a
// stitch standing on the top of the stitch below.

import type { StitchPlacement } from "./legs.ts";
import { add, distance, dot, scale, sub, vec, type Vec3 } from "./vec.ts";

/** The parts of a drawn symbol that can collide. */
export interface Strokes {
  lines: Vec3[][];
  dots: { at: Vec3; radius: number }[];
}

/** Strokes closer than this many units touch: two half line widths. */
export const CLEARANCE = 0.06;
/** Contact within this many units of a shared node is the chart convention, not an overlap. */
const NEAR_NODE = 0.15;

/**
 * Pairs [i, j], i < j, of symbols that overlap. `placements[i]` drew
 * `drawn[i]`; `positions` are the layout's, for the shared nodes.
 */
export function findOverlaps(
  drawn: Strokes[],
  placements: StitchPlacement[],
  positions: Record<string, number[]>,
  unit: number,
): [number, number][] {
  return new OverlapIndex(drawn, placements, positions, unit).pairs();
}

/**
 * Drawn symbols bucketed by bounding box into a grid, so a symbol is only
 * compared with its neighbours, and one symbol can be redrawn or tried out
 * somewhere else without rebuilding the rest.
 */
export class OverlapIndex {
  private readonly segments: Segment[][] = [];
  private readonly boxes: (Box | undefined)[] = [];
  private readonly grid = new Map<string, Set<number>>();
  private readonly cell: number;
  private readonly width: number;
  private readonly test: ReturnType<typeof pairTest>;

  constructor(drawn: Strokes[], placements: StitchPlacement[], positions: Record<string, number[]>, unit: number) {
    this.cell = 2 * unit;
    this.width = CLEARANCE * unit;
    this.test = pairTest(placements, positions, unit);
    drawn.forEach((d, i) => this.set(i, d));
  }

  /** Replaces symbol `i`'s strokes. */
  set(i: number, strokes: Strokes): void {
    const old = this.boxes[i];
    if (old) for (const key of this.keys(old)) this.grid.get(key)?.delete(i);
    const segs = segmentsOf(strokes);
    const box = boxOf(segs, this.width);
    this.segments[i] = segs;
    this.boxes[i] = box;
    if (box)
      for (const key of this.keys(box)) {
        const set = this.grid.get(key);
        if (set) set.add(i);
        else this.grid.set(key, new Set([i]));
      }
  }

  /** The symbols that `i` overlaps, as drawn, or as `candidate` would be. */
  overlapsOf(i: number, candidate?: Strokes): number[] {
    const segs = candidate ? segmentsOf(candidate) : this.segments[i]!;
    const box = candidate ? boxOf(segs, this.width) : this.boxes[i];
    if (!box) return [];
    const near = new Set<number>();
    for (const key of this.keys(box)) for (const j of this.grid.get(key) ?? []) if (j !== i) near.add(j);
    return [...near].filter((j) => boxesMeet(box, this.boxes[j]!) && this.test(i, segs, j, this.segments[j]!));
  }

  /** Every overlapping pair [i, j], i < j. */
  pairs(): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < this.segments.length; i++) for (const j of this.overlapsOf(i)) if (j > i) out.push([i, j]);
    return out;
  }

  private *keys(b: Box): Generator<string> {
    const c = this.cell;
    for (let x = Math.floor(b.min[0] / c); x <= Math.floor(b.max[0] / c); x++)
      for (let y = Math.floor(b.min[1] / c); y <= Math.floor(b.max[1] / c); y++)
        for (let z = Math.floor(b.min[2] / c); z <= Math.floor(b.max[2] / c); z++) yield `${x},${y},${z}`;
  }
}

/** The overlap test for one pair, allowing contact at the nodes charts share on purpose. */
function pairTest(placements: StitchPlacement[], positions: Record<string, number[]>, unit: number) {
  const width = CLEARANCE * unit;
  const near = NEAR_NODE * unit;
  const feet = placements.map((p) => new Set(p.legs.map((l) => l.footNode)));
  const nodeAt = (id: string): Vec3 | undefined => (positions[id] ? vec(positions[id]!) : undefined);
  return (i: number, si: Segment[], j: number, sj: Segment[]): boolean => {
    // Nodes where contact is the chart's own: a shared foot, or the top one stands on.
    const allowed: (Vec3 | undefined)[] = [];
    for (const f of feet[i]!) if (feet[j]!.has(f)) allowed.push(nodeAt(f));
    if (feet[j]!.has(placements[i]!.stitch.id)) allowed.push(placements[i]!.top);
    if (feet[i]!.has(placements[j]!.stitch.id)) allowed.push(placements[j]!.top);
    return touch(si, sj, width, allowed.filter((p) => p !== undefined), near);
  };
}

interface Segment {
  a: Vec3;
  b: Vec3;
  /** Extra reach: a dot's radius. */
  r: number;
  /** Bounding box, grown by `r`: [minX, minY, minZ, maxX, maxY, maxZ]. */
  box: number[];
}

function segment(a: Vec3, b: Vec3, r: number): Segment {
  return {
    a,
    b,
    r,
    box: [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r],
  };
}

function segmentsOf(d: Strokes): Segment[] {
  const out: Segment[] = [];
  for (const line of d.lines) for (let k = 1; k < line.length; k++) out.push(segment(line[k - 1]!, line[k]!, 0));
  for (const dot of d.dots) out.push(segment(dot.at, dot.at, dot.radius));
  return out;
}

/** Whether two segments' boxes come within `gap`: a cheap test before the exact one. */
const near3 = (p: number[], q: number[], gap: number) =>
  p[0]! - gap <= q[3]! && q[0]! - gap <= p[3]! && p[1]! - gap <= q[4]! && q[1]! - gap <= p[4]! && p[2]! - gap <= q[5]! && q[2]! - gap <= p[5]!;

function touch(s: Segment[], t: Segment[], width: number, allowed: Vec3[], near: number): boolean {
  for (const p of s)
    for (const q of t) {
      if (!near3(p.box, q.box, width)) continue;
      const [d, x, y] = closest(p.a, p.b, q.a, q.b);
      if (d > width + p.r + q.r) continue;
      // Contact at an allowed node is fine.
      const mid = scale(add(x, y), 0.5);
      if (allowed.some((n) => distance(mid, n) < near)) continue;
      return true;
    }
  return false;
}

/** Distance between segments pq and rs, and the closest point on each. */
export function closest(p: Vec3, q: Vec3, r: Vec3, s: Vec3): [number, Vec3, Vec3] {
  const d1 = sub(q, p);
  const d2 = sub(s, r);
  const w = sub(p, r);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, w);
  let u = 0;
  let t = 0;
  if (a < 1e-18 && e < 1e-18) return [distance(p, r), p, r];
  if (a < 1e-18) t = clamp(f / e);
  else {
    const c = dot(d1, w);
    if (e < 1e-18) u = clamp(-c / a);
    else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      u = den > 1e-18 ? clamp((b * f - c * e) / den) : 0;
      t = (b * u + f) / e;
      if (t < 0) {
        t = 0;
        u = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        u = clamp((b - c) / a);
      }
    }
  }
  const x = add(p, scale(d1, u));
  const y = add(r, scale(d2, t));
  return [distance(x, y), x, y];
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));

interface Box {
  min: Vec3;
  max: Vec3;
}

function boxOf(segs: Segment[], pad: number): Box | undefined {
  if (!segs.length) return undefined;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of segs)
    for (const p of [s.a, s.b])
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[k]! - s.r - pad);
        max[k] = Math.max(max[k]!, p[k]! + s.r + pad);
      }
  return { min, max };
}

const boxesMeet = (a: Box, b: Box) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! && b.min[k]! <= a.max[k]!);
