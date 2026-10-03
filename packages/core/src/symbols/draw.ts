// One stitch's glyph in world space (docs/symbol/SPEC.md §4): its strokes
// mapped through its legs and frame, arcs and ellipses turned into polylines,
// and a quad to pick it by. A Fit keeps it clear of its neighbours
// (ISSUE-004): legs stop at the chain ovals they start from, an increase's ×
// moves up its arm, and a crowded symbol's decorations shrink.

import { acrossOf, type Frame } from "./frames.ts";
import { glyphFor, RING_RADIUS, type LegPoint, type Stroke, type TopPoint } from "./glyphs.ts";
import type { Leg, StitchPlacement } from "./legs.ts";
import { add, distance, dot, normalize, scale, sub, type Vec3 } from "./vec.ts";

/** Segments per full turn when arcs and ellipses become polylines. */
const TURN_SEGMENTS = 16;
/** The smallest pick area, in units, so a dot or an oval is as easy to hit as a post. */
const MIN_HIT = 0.5;
/** How far a leg stops short of an oval or the ring, in units: two half line widths and a hair. */
const FOOT_GAP = 0.08;
/** If a leg's strokes still reach into an oval, its foot steps up by this many units... */
const FOOT_STEP = 0.05;
/** ...but the leg keeps at least this length, in units. */
const MIN_LEG = 0.35;

/** A chain's oval in world space. */
export interface Oval {
  centre: Vec3;
  along: Vec3;
  up: Vec3;
  /** Semi-axes along the chain and across it, in world units. */
  rx: number;
  ry: number;
}

export interface Fit {
  /** Scale of everything but leg length (widths, the ×, slashes, ovals, dots); 1 unless crowded. */
  scale?: number;
  /** Where the × sits on each leg, as a fraction of it; 0.5 unless an increase moves it up. */
  mid?: number;
  /** The drawn oval of a chain, for legs that must stay clear of it. */
  ovals?: (chainId: string) => Oval | undefined;
  /** Moves a symbol with no legs (a slip-stitch dot) off its node, in world units. */
  offset?: Vec3;
}

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
export function drawPlacement(p: StitchPlacement, unit: number, lift = 0, fit: Fit = {}): Drawn {
  const glyph = glyphFor(p.stitch.type, p.stitch.side);
  const { frame, top } = p;
  const lines: Vec3[][] = [];
  const k = fit.scale ?? 1;
  const mid = fit.mid ?? 0.5;

  const strokes = p.legs.length > 1 ? [...glyph.leg, ...glyph.joinLeg] : glyph.leg;
  for (const raw of p.legs) {
    // What the leg's strokes must stay out of: the chain ovals and the ring it starts from.
    const blockers = raw.clear.map((id) => fit.ovals?.(id)).filter((o) => o !== undefined);
    if (raw.onRing) blockers.push({ centre: raw.foot, along: frame.across, up: frame.up, rx: RING_RADIUS * unit, ry: RING_RADIUS * unit });
    let leg = raw.onRing ? clipToRing(raw, unit) : raw;
    for (const oval of blockers) leg = clipAtOval(leg, oval, FOOT_GAP * unit);
    // Decorations near the foot (the ×, a loop mark) can still reach in: step the foot up.
    let drawn = strokes.map((s) => legStroke(s, leg, frame, unit * k, mid));
    for (let n = 0; n < 12 && blockers.some((o) => reaches(drawn, o, FOOT_GAP * unit)); n++) {
      const dir = normalize(sub(leg.top, leg.foot));
      if (!dir || distance(leg.foot, leg.top) - FOOT_STEP * unit < MIN_LEG * unit) break;
      leg = { ...leg, foot: add(leg.foot, scale(dir, FOOT_STEP * unit)) };
      drawn = strokes.map((s) => legStroke(s, leg, frame, unit * k, mid));
    }
    lines.push(...drawn);
  }

  // The top frame: across and up, or along the chain for a chain's oval.
  const topU = glyph.alongChain ? frame.along : frame.across;
  const atTop = (u: number, v: number, size = unit * k): Vec3 => add(top, add(scale(topU, u * size), scale(frame.up, v * size)));
  for (const s of glyph.top) lines.push(strokePoints(s, ([u, v]: TopPoint) => atTop(u, v), (c, du, dv) => atTop(c[0] + du, c[1] + dv)));
  // The ring keeps its size: round 1's legs are clipped to it.
  if (glyph.ring) lines.push(strokePoints({ kind: "ellipse", center: [0, 0], rx: glyph.ring, ry: glyph.ring }, () => top, (_, du, dv) => atTop(du, dv, unit)));

  let dots = glyph.dots.map(([u, v, r]) => ({ at: atTop(u, v), radius: r * unit * k }));
  if (fit.offset && !p.legs.length) {
    const move = (q: Vec3) => add(q, fit.offset!);
    lines.forEach((l, i) => (lines[i] = l.map(move)));
    dots = dots.map((d) => ({ ...d, at: move(d.at) }));
  }
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

/** Round 1 stands just outside the ring circle, not on its centre. */
function clipToRing(leg: Leg, unit: number): Leg {
  const dir = normalize(sub(leg.top, leg.foot));
  const r = (RING_RADIUS + FOOT_GAP) * unit;
  if (!dir || dot(sub(leg.top, leg.foot), dir) <= r * 1.5) return leg;
  return { ...leg, foot: add(leg.foot, scale(dir, r)) };
}

/**
 * Moves the foot up the leg to where it leaves the oval grown by `gap`,
 * when the leg starts inside it or enters it near the foot. A leg worked
 * into a chain starts at the oval's centre; one in a chain space starts
 * between two ovals.
 */
export function clipAtOval(leg: Leg, oval: Oval, gap: number): Leg {
  const span = sub(leg.top, leg.foot);
  const rel = sub(leg.foot, oval.centre);
  const [ax, ay] = [oval.rx + gap, oval.ry + gap];
  // The leg in the oval's plane, scaled to a unit circle: (x0 + t xd, y0 + t yd).
  const x0 = dot(rel, oval.along) / ax;
  const y0 = dot(rel, oval.up) / ay;
  const xd = dot(span, oval.along) / ax;
  const yd = dot(span, oval.up) / ay;
  const a = xd * xd + yd * yd;
  if (a < 1e-12) return leg;
  const b = 2 * (x0 * xd + y0 * yd);
  const c = x0 * x0 + y0 * y0 - 1;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return leg;
  const t1 = (-b - Math.sqrt(disc)) / (2 * a);
  const t2 = (-b + Math.sqrt(disc)) / (2 * a);
  // Only near the foot, and never past most of the leg.
  if (t2 <= 0 || t1 > 0.5 || t2 > 0.9) return leg;
  return { ...leg, foot: add(leg.foot, scale(span, t2)) };
}

/** True when any stroke comes within `gap` of the oval (sampled along each segment, in the oval's plane). */
function reaches(lines: Vec3[][], oval: Oval, gap: number): boolean {
  const [ax, ay] = [oval.rx + gap, oval.ry + gap];
  const inside = (p: Vec3) => {
    const d = sub(p, oval.centre);
    const x = dot(d, oval.along) / ax;
    const y = dot(d, oval.up) / ay;
    return x * x + y * y < 1;
  };
  for (const line of lines)
    for (let i = 1; i < line.length; i++)
      for (let t = 0; t <= 1; t += 0.125) if (inside(add(line[i - 1]!, scale(sub(line[i]!, line[i - 1]!), t)))) return true;
  return false;
}

/** `size` is the world size of one unit of decoration; `mid` replaces v for points that follow the mid point. */
function legStroke(s: Stroke<LegPoint>, leg: Leg, frame: Frame, size: number, mid: number): Vec3[] {
  const span = sub(leg.top, leg.foot);
  const dir = normalize(span) ?? frame.up;
  const across = acrossOf(dir, frame);
  const at = (u: number, v: number, dv: number): Vec3 =>
    add(add(leg.foot, scale(span, v)), add(scale(dir, dv * size), scale(across, u * size)));
  const vOf = (p: LegPoint) => (p.mid ? mid : p.v);
  return strokePoints(
    s,
    (p) => at(p.u, vOf(p), p.dv ?? 0),
    (c, du, dv) => at(c.u + du, vOf(c), (c.dv ?? 0) + dv),
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
