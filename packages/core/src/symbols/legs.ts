// Where each stitch's symbol stands (docs/symbol/SPEC.md §3): legs from the
// points it is worked into up to its own top node, and a frame to draw in.

import type { Stitch, StitchGraph } from "../cp/graph.ts";
import { frameFor, orientFrames, type Frame } from "./frames.ts";
import { distance, mean, normalize, scale, add, sub, vec, type Vec3 } from "./vec.ts";

export interface Leg {
  /** A stitch's top node, a chain-space node, or the ring. */
  footNode: string;
  foot: Vec3;
  top: Vec3;
  /** The foot is a chain space, not a stitch's top. */
  intoSpace: boolean;
  /** The foot is a magic ring: the symbol starts on the ring circle. */
  onRing: boolean;
  /**
   * Chains whose ovals the leg must stay clear of (ISSUE-004): the chain it
   * is worked into, or the chains either side of its chain space.
   */
  clear: string[];
}

export interface StitchPlacement {
  stitch: Stitch;
  /** Empty for ch, ring and ss. */
  legs: Leg[];
  top: Vec3;
  frame: Frame;
}

/** Types that are drawn with no symbol at all (SYM-FR-2.5). */
export const UNDRAWN_TYPES = new Set(["hidden", "sk", "turn", "tie", "tie_up", "start_at", "start_anew", "start_a_new_chain"]);

/** Types whose symbol has no legs: chains have no base, a slip stitch is a dot. */
const LEGLESS_TYPES = new Set(["ch", "ring", "ss"]);

/** Legs shorter than this many units are lengthened so the symbol stays readable (SPEC §3.3). */
const MIN_LEG = 0.25;

/**
 * Places every drawn stitch. `unit` is the typical yarn edge length
 * (`yarnUnit`). Stitches with no position are left out.
 */
export function placeStitches(
  graph: StitchGraph,
  positions: Record<string, number[]>,
  unit: number,
  dimension: 2 | 3,
): StitchPlacement[] {
  const at = (id: string): Vec3 | undefined => {
    const p = positions[id];
    return p ? vec(p) : undefined;
  };
  const byId = new Map(graph.stitches.map((s) => [s.id, s]));

  // Internal nodes placed by gray edges: the point inside a chain space.
  // ...and the stitches either side of each such point.
  const spaceNodes = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== "constraint") continue;
    const tails = spaceNodes.get(e.head);
    if (tails) tails.push(e.tail);
    else spaceNodes.set(e.head, [e.tail]);
  }
  const isChain = (id: string) => byId.get(id)?.type === "ch";

  const ringOf = (stitch: Stitch, foot: Stitch): Stitch | undefined => {
    // Round 1 worked into a ring: CrochetPARADE may tie each stitch to the one
    // before it in the same row instead of to the ring (SPEC §2). Follow those
    // back to the ring.
    let f: Stitch | undefined = foot;
    const seen = new Set<string>();
    while (f && f.type !== "ring" && f.row === stitch.row && f.workedInto.length === 1 && !seen.has(f.id)) {
      seen.add(f.id);
      f = byId.get(f.workedInto[0]!);
    }
    return f?.type === "ring" ? f : undefined;
  };

  const placements: StitchPlacement[] = [];
  const drawn = graph.stitches.filter((s) => !UNDRAWN_TYPES.has(s.type) && at(s.id));
  const raw = drawn.map((stitch) => {
    const top = at(stitch.id)!;
    const legs: Leg[] = [];
    if (!LEGLESS_TYPES.has(stitch.type)) {
      if (stitch.intoSpace) {
        const space = stitch.nodeIds.find((id) => spaceNodes.has(id) && at(id));
        const feet = space ? [at(space)!] : stitch.workedInto.map(at).filter((p) => p !== undefined);
        const clear = (space ? spaceNodes.get(space)! : stitch.workedInto).filter(isChain);
        if (feet.length) legs.push({ footNode: space ?? stitch.workedInto[0]!, foot: mean(feet), top, intoSpace: true, onRing: false, clear });
      } else {
        for (const id of stitch.workedInto) {
          const foot = byId.get(id);
          const ring = foot && ringOf(stitch, foot);
          const footNode = ring?.id ?? id;
          const p = at(footNode);
          if (p) legs.push({ footNode, foot: p, top, intoSpace: false, onRing: !!ring, clear: isChain(footNode) ? [footNode] : [] });
        }
      }
    }
    return { stitch, legs, top };
  });

  // A magic ring sits at the centre of the round worked into it. CrochetPARADE
  // may put the ring node next to the first stitch instead (a plain `ring`
  // without a label), which would draw the ring over round 2.
  for (const ring of raw.filter((r) => r.stitch.type === "ring")) {
    const onIt = raw.flatMap((r) => r.legs.filter((l) => l.onRing && l.footNode === ring.stitch.id).map((l) => ({ r, l })));
    if (onIt.length < 3) continue;
    const centre = mean(onIt.map(({ r }) => r.top));
    ring.top = centre;
    for (const { l } of onIt) l.foot = centre;
  }

  for (let i = 0; i < raw.length; i++) {
    const { stitch, legs, top } = raw[i]!;
    const prev = raw[i - 1]?.top;
    const next = raw[i + 1]?.top;
    const frame = frameFor(top, legs.map((l) => l.foot), prev, next, dimension);
    for (const leg of legs) {
      // A squeezed stitch: lengthen its leg downwards, keeping the top.
      if (distance(leg.foot, leg.top) < MIN_LEG * unit) {
        const down = normalize(sub(leg.foot, leg.top)) ?? scale(frame.up, -1);
        leg.foot = add(leg.top, scale(down, MIN_LEG * unit));
      }
    }
    placements.push({ stitch, legs, top, frame });
  }
  if (dimension === 3) orient(placements, graph);
  return placements;
}

/** Neighbours are the stitches joined by yarn or worked into: within one piece only. */
function orient(placements: StitchPlacement[], graph: StitchGraph): void {
  const index = new Map(placements.map((p, i) => [p.stitch.id, i]));
  const neighbours = placements.map(() => new Set<number>());
  const join = (a: number | undefined, b: number | undefined) => {
    if (a === undefined || b === undefined || a === b) return;
    neighbours[a]!.add(b);
    neighbours[b]!.add(a);
  };
  for (const e of graph.edges) if (e.kind === "yarn") join(index.get(e.tail), index.get(e.head));
  placements.forEach((p, i) => p.legs.forEach((l) => join(i, index.get(l.footNode))));
  const frames = placements.map((p) => p.frame);
  orientFrames(frames, placements.map((p) => p.top), neighbours.map((n) => [...n]));
  placements.forEach((p, i) => (p.frame = frames[i]!));
}

/** The median length of the yarn edges: the size symbols are drawn at. */
export function yarnUnit(graph: StitchGraph, positions: Record<string, number[]>): number {
  const lengths: number[] = [];
  for (const e of graph.edges) {
    if (e.kind !== "yarn") continue;
    const a = positions[e.tail];
    const b = positions[e.head];
    if (a && b) lengths.push(distance(vec(a), vec(b)));
  }
  lengths.sort((x, y) => x - y);
  return lengths[Math.floor(lengths.length / 2)] || 1;
}
