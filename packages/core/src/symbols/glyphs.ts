// The chart symbol for each stitch type (docs/symbol/SPEC.md §4), as strokes
// in two local frames:
//
// - the leg frame: v runs from foot (0) to top (1) and is scaled to the leg's
//   length; `dv` adds an offset along the leg in units; u runs across, in
//   units. So a stretched dc gets a longer post with the same bar and slashes.
// - the top frame: origin at the top node, u across and v up, both in units.
//
// Loop and post stitches each get one mark for both sides for now
// (docs/known_issues/ISSUE-003): `side` is passed in but not yet used.

import { typeParts, type BaseStitch } from "./stitchTypes.ts";

export interface LegPoint {
  u: number;
  v: number;
  dv?: number;
  /** v follows the stitch's mid point instead (0.5 unless an increase moves it up its arm). */
  mid?: true;
}
export type TopPoint = [u: number, v: number];

export type Stroke<P> =
  | { kind: "line"; from: P; to: P }
  | { kind: "polyline"; points: P[] }
  /** Radians, counter-clockwise from +u. */
  | { kind: "arc"; center: P; radius: number; start: number; end: number }
  | { kind: "ellipse"; center: P; rx: number; ry: number };

export interface Glyph {
  /** Drawn on every leg. */
  leg: Stroke<LegPoint>[];
  /** Drawn on every leg of a stitch with several legs (a decrease), after `leg`. */
  joinLeg: Stroke<LegPoint>[];
  /** Drawn once, at the top. */
  top: Stroke<TopPoint>[];
  /** Filled dots at the top: [u, v, radius] in units. */
  dots: [number, number, number][];
  /** The chain oval lies along the chain, not across the stitch. */
  alongChain?: boolean;
  /** The ring circle: radius in units, centred on the ring node. */
  ring?: number;
  /** No symbol for this type yet (SYM-FR-2.6). */
  fallback?: boolean;
}

/** Half-width of a symbol, in units. */
export const HALF_WIDTH = 0.35;
/** Half-width and half-height of the × of a single crochet, in units. */
export const CROSS_HALF_WIDTH = HALF_WIDTH * 0.8;
export const CROSS_HALF_HEIGHT = 0.25;
export const RING_RADIUS = 0.5;

const SLASHES: Partial<Record<BaseStitch, number>> = { dc: 1, tr: 2, dtr: 3, trtr: 4 };

const empty = (): Glyph => ({ leg: [], joinLeg: [], top: [], dots: [] });

const POST: Stroke<LegPoint> = { kind: "line", from: { u: 0, v: 0 }, to: { u: 0, v: 1 } };
const BAR: Stroke<TopPoint> = { kind: "line", from: [-HALF_WIDTH, 0], to: [HALF_WIDTH, 0] };

/** The × of a single crochet, centred on the leg's mid point. */
function cross(): Stroke<LegPoint>[] {
  const w = CROSS_HALF_WIDTH;
  const h = CROSS_HALF_HEIGHT;
  return [
    { kind: "line", from: { u: -w, v: 0.5, dv: -h, mid: true }, to: { u: w, v: 0.5, dv: h, mid: true } },
    { kind: "line", from: { u: -w, v: 0.5, dv: h, mid: true }, to: { u: w, v: 0.5, dv: -h, mid: true } },
  ];
}

/** Slashes across a post at v 0.5; `u` moves them onto a curved post. */
function slashes(n: number, u = 0, width = 0.6 * HALF_WIDTH): Stroke<LegPoint>[] {
  const out: Stroke<LegPoint>[] = [];
  const spacing = 0.15;
  for (let i = 0; i < n; i++) {
    const dv = (i - (n - 1) / 2) * spacing;
    out.push({ kind: "line", from: { u: u - width, v: 0.5, dv: dv - 0.1 }, to: { u: u + width, v: 0.5, dv: dv + 0.1 } });
  }
  return out;
}

/** A post from foot to top bowed out by `bulge` units at its middle. */
function bowedPost(bulge: number): Stroke<LegPoint> {
  const points: LegPoint[] = [];
  for (let i = 0; i <= 8; i++) points.push({ u: bulge * Math.sin((Math.PI * i) / 8), v: i / 8 });
  return { kind: "polyline", points };
}

/** `n` posts spread evenly across ±`spread` units. */
const spreadOf = (n: number, spread: number) => Array.from({ length: n }, (_, i) => (n === 1 ? 0 : -spread + (2 * spread * i) / (n - 1)));

/** Puffs, bobbles and popcorns: `hdc3puff`, `dc4bobble`, `dc5pc`, `tr4bobble`. */
const CLUSTER = /^(hdc|dc|tr)(\d)(puff|bobble|pc)$/;

function clusterGlyph(base: BaseStitch, n: number, kind: string): Glyph {
  const g = empty();
  const yarnOvers = SLASHES[base] ?? 0;
  if (kind === "puff") {
    // A closed oval of posts meeting at foot and top.
    for (const b of spreadOf(n, 0.3)) g.leg.push(bowedPost(b));
  } else if (kind === "bobble") {
    // Bowed posts joined at foot and top, each with its slashes, under one bar.
    for (const b of spreadOf(n, 0.3)) g.leg.push(bowedPost(b), ...slashes(yarnOvers, b, 0.12));
    g.top.push(BAR);
  } else {
    // Popcorn: straight posts fanned from the foot, closed by a cap across their tops.
    for (const x of spreadOf(n, 0.3)) g.leg.push({ kind: "line", from: { u: 0, v: 0 }, to: { u: x, v: 1 } }, ...slashes(yarnOvers, x / 2, 0.12));
    g.top.push({ kind: "ellipse", center: [0, 0], rx: 0.42, ry: 0.14 });
  }
  return g;
}

/** One arc for back and front loop alike (ISSUE-003), hugging the foot. */
const LOOP_MARK: Stroke<LegPoint> = { kind: "arc", center: { u: 0, v: 0, dv: -0.05 }, radius: 0.25, start: 0, end: Math.PI };

/** One hook for front and back post alike (ISSUE-003), curling from the foot. */
const POST_MARK: Stroke<LegPoint> = { kind: "arc", center: { u: 0.15, v: 0 }, radius: 0.15, start: Math.PI, end: 2 * Math.PI };

const cache = new Map<string, Glyph>();

/** The symbol for a stitch type. */
export function glyphFor(type: string, _side?: "back" | "front"): Glyph {
  let glyph = cache.get(type);
  if (!glyph) {
    glyph = buildGlyph(type);
    cache.set(type, glyph);
  }
  return glyph;
}

function buildGlyph(type: string): Glyph {
  const cluster = CLUSTER.exec(type);
  if (cluster) return clusterGlyph(cluster[1] as BaseStitch, Number(cluster[2]), cluster[3]!);
  const parts = typeParts(type);
  const g = empty();
  switch (parts.base) {
    case "ch":
      g.top.push({ kind: "ellipse", center: [0, 0], rx: 0.42, ry: 0.18 });
      g.alongChain = true;
      return g;
    case "ss":
      g.dots.push([0, 0, 0.12]);
      return g;
    case "ring":
      g.ring = RING_RADIUS;
      return g;
    case "sc": {
      // A decrease joins each leg's × to the shared top.
      g.leg.push(...cross());
      g.joinLeg.push({ kind: "line", from: { u: 0, v: 0.5, dv: 0.25, mid: true }, to: { u: 0, v: 1 } });
      break;
    }
    case "hdc":
    case "dc":
    case "tr":
    case "dtr":
    case "trtr":
      g.leg.push(POST, ...slashes(SLASHES[parts.base] ?? 0));
      g.top.push(BAR);
      break;
    default: {
      // Unknown: a plain post with an open square on top.
      const s = 0.15;
      g.leg.push(POST);
      g.top.push(
        { kind: "line", from: [-s, 0], to: [s, 0] },
        { kind: "line", from: [s, 0], to: [s, 2 * s] },
        { kind: "line", from: [s, 2 * s], to: [-s, 2 * s] },
        { kind: "line", from: [-s, 2 * s], to: [-s, 0] },
      );
      g.fallback = true;
      return g;
    }
  }
  if (parts.loop) g.leg.push(LOOP_MARK);
  if (parts.post) g.leg.push(POST_MARK);
  return g;
}
