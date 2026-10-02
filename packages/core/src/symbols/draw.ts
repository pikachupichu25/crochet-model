// One stitch's glyph in world space (docs/symbol/SPEC.md §4): its strokes
// mapped through its legs and frame, arcs and ellipses turned into polylines,
// and a quad to pick it by.

import { acrossOf, type Frame } from "./frames.ts";
import { glyphFor, RING_RADIUS, type LegPoint, type Stroke, type TopPoint } from "./glyphs.ts";
import type { Leg, StitchPlacement } from "./legs.ts";
import { add, dot, normalize, scale, sub, type Vec3 } from "./vec.ts";

/** Segments per full turn when arcs and ellipses become polylines. */
const TURN_SEGMENTS = 16;
/** The smallest pick area, in units, so a dot or an oval is as easy to hit as a post. */
const MIN_HIT = 0.5;

export interface Drawn {
  lines: Vec3[][];
  dots: { at: Vec3; radius: number }[];
  hit: [Vec3, Vec3, Vec3, Vec3];
  out: Vec3;
  fallback: boolean;
}

/**
 * `lift` moves the glyph off the fabric along its `out`, so in 3D it sits on
 * the surface rather than in it. Also draws the legend's icons (legend.ts).
 */
export function drawPlacement(p: StitchPlacement, unit: number, lift = 0): Drawn {
  const glyph = glyphFor(p.stitch.type, p.stitch.side);
  const { frame, top } = p;
  const lines: Vec3[][] = [];

  for (const raw of p.legs) {
    const leg = raw.onRing ? clipToRing(raw, unit) : raw;
    const strokes = p.legs.length > 1 ? [...glyph.leg, ...glyph.joinLeg] : glyph.leg;
    for (const s of strokes) lines.push(legStroke(s, leg, frame, unit));
  }

  // The top frame: across and up, or along the chain for a chain's oval.
  const topU = glyph.alongChain ? frame.along : frame.across;
  const atTop = (u: number, v: number): Vec3 => add(top, add(scale(topU, u * unit), scale(frame.up, v * unit)));
  for (const s of glyph.top) lines.push(strokePoints(s, ([u, v]: TopPoint) => atTop(u, v), (c, du, dv) => atTop(c[0] + du, c[1] + dv)));
  if (glyph.ring) lines.push(strokePoints({ kind: "ellipse", center: [0, 0], rx: glyph.ring, ry: glyph.ring }, () => top, (_, du, dv) => atTop(du, dv)));

  const dots = glyph.dots.map(([u, v, r]) => ({ at: atTop(u, v), radius: r * unit }));
  const hit = hitQuad(lines, dots, top, frame, unit);
  if (lift) {
    const up = scale(frame.out, lift);
    const move = (q: Vec3) => add(q, up);
    return {
      lines: lines.map((l) => l.map(move)),
      dots: dots.map((d) => ({ ...d, at: move(d.at) })),
      hit: hit.map(move) as Drawn["hit"],
      out: frame.out,
      fallback: !!glyph.fallback,
    };
  }
  return { lines, dots, hit, out: frame.out, fallback: !!glyph.fallback };
}

/** Round 1 stands on the ring circle, not its centre. */
function clipToRing(leg: Leg, unit: number): Leg {
  const dir = normalize(sub(leg.top, leg.foot));
  const r = RING_RADIUS * unit;
  if (!dir || dot(sub(leg.top, leg.foot), dir) <= r * 1.5) return leg;
  return { ...leg, foot: add(leg.foot, scale(dir, r)) };
}

function legStroke(s: Stroke<LegPoint>, leg: Leg, frame: Frame, unit: number): Vec3[] {
  const span = sub(leg.top, leg.foot);
  const dir = normalize(span) ?? frame.up;
  const across = acrossOf(dir, frame);
  const at = (u: number, v: number, dv: number): Vec3 =>
    add(add(leg.foot, scale(span, v)), add(scale(dir, dv * unit), scale(across, u * unit)));
  return strokePoints(
    s,
    (p) => at(p.u, p.v, p.dv ?? 0),
    (c, du, dv) => at(c.u + du, c.v, (c.dv ?? 0) + dv),
  );
}

/**
 * A stroke as a polyline. `point` maps a stroke point; `offset` maps a centre
 * moved by (du, dv) units, for arcs and ellipses.
 */
function strokePoints<P>(s: Stroke<P>, point: (p: P) => Vec3, offset: (c: P, du: number, dv: number) => Vec3): Vec3[] {
  if (s.kind === "line") return [point(s.from), point(s.to)];
  if (s.kind === "polyline") return s.points.map(point);
  const [start, end, rx, ry] = s.kind === "arc" ? [s.start, s.end, s.radius, s.radius] : [0, 2 * Math.PI, s.rx, s.ry];
  const n = Math.max(2, Math.ceil((TURN_SEGMENTS * Math.abs(end - start)) / (2 * Math.PI)));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = start + ((end - start) * i) / n;
    out.push(offset(s.center, rx * Math.cos(a), ry * Math.sin(a)));
  }
  return out;
}

function hitQuad(lines: Vec3[][], dots: { at: Vec3; radius: number }[], top: Vec3, frame: Frame, unit: number): Drawn["hit"] {
  let [u0, u1, v0, v1] = [0, 0, 0, 0];
  const take = (p: Vec3, r = 0) => {
    const d = sub(p, top);
    const u = dot(d, frame.across);
    const v = dot(d, frame.up);
    u0 = Math.min(u0, u - r);
    u1 = Math.max(u1, u + r);
    v0 = Math.min(v0, v - r);
    v1 = Math.max(v1, v + r);
  };
  for (const line of lines) for (const p of line) take(p);
  for (const d of dots) take(d.at, d.radius);
  const grow = (a: number, b: number): [number, number] => {
    const need = MIN_HIT * unit - (b - a);
    return need > 0 ? [a - need / 2, b + need / 2] : [a, b];
  };
  [u0, u1] = grow(u0, u1);
  [v0, v1] = grow(v0, v1);
  const at = (u: number, v: number) => add(top, add(scale(frame.across, u), scale(frame.up, v)));
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}
