// The symbol legend (docs/symbol/SPEC.md §6.3): which entry each stitch
// belongs to, the entry's US name, counts, and an icon drawn by the same glyph
// code as the view.
//
// The graph keeps only the base type of a composite stitch (a sc2inc is two
// `sc`), so composite names are rebuilt from the shape: one statement making
// several stitches on one foot is an increase; one stitch on several feet
// (not a chain space) is a decrease; three chains and a slip stitch in one
// statement are a picot.

import type { Stitch } from "../cp/graph.ts";
import { frameFor } from "./frames.ts";
import type { StitchPlacement } from "./legs.ts";
import { drawPlacement } from "./draw.ts";
import type { SymbolScene } from "./scene.ts";
import { typeParts, type BaseStitch } from "./stitchTypes.ts";
import type { Vec3 } from "./vec.ts";

/** The legend key of each placement, in the same order. */
export function legendKeys(placements: StitchPlacement[]): string[] {
  const byStatement = new Map<number, StitchPlacement[]>();
  for (const p of placements) {
    const list = byStatement.get(p.stitch.statement);
    if (list) list.push(p);
    else byStatement.set(p.stitch.statement, [p]);
  }
  return placements.map((p) => {
    const group = byStatement.get(p.stitch.statement)!;
    const types = group.map((g) => g.stitch.type).join(",");
    if (types === "ch,ch,ch,ss") return "picot3";
    const into = p.legs.filter((l) => !l.intoSpace);
    if (into.length > 1) return `${p.stitch.type}${into.length}tog`;
    if (
      group.length > 1 &&
      group.every((g) => g.stitch.type === p.stitch.type && g.legs.length === 1 && g.legs[0]!.footNode === p.legs[0]?.footNode)
    ) {
      return `${p.stitch.type}${group.length}inc`;
    }
    return p.stitch.type;
  });
}

export interface LegendEntry {
  key: string;
  /** US name, e.g. "single crochet", "single crochet 2 together". */
  name: string;
  /** How many the pattern has, counted as the pattern counts them: a sc2inc is one. */
  count: number;
  /** No symbol yet: drawn with the fallback mark. */
  fallback: boolean;
}

const BASE_NAMES: Record<BaseStitch, string> = {
  ch: "chain",
  ss: "slip stitch",
  sc: "single crochet",
  hdc: "half double crochet",
  dc: "double crochet",
  tr: "treble crochet",
  dtr: "double treble crochet",
  trtr: "triple treble crochet",
  ring: "magic ring",
  hidden: "hidden",
};

const BASE_ORDER: BaseStitch[] = ["ring", "ch", "ss", "sc", "hdc", "dc", "tr", "dtr", "trtr"];

const COMPOSITE = /^(.+?)(\d+)(inc|tog)$/;
const CLUSTER = /^(hdc|dc|tr)(\d)(puff|bobble|pc)$/;
const CLUSTER_NAMES: Record<string, string> = { puff: "puff", bobble: "bobble", pc: "popcorn" };

/** The US name of a legend key. Unknown types are named by their type. */
export function stitchName(key: string): string {
  if (key === "picot3") return "picot of 3 chains";
  const cluster = CLUSTER.exec(key);
  if (cluster) return `${CLUSTER_NAMES[cluster[3]!]} of ${cluster[2]} ${BASE_NAMES[cluster[1] as BaseStitch]}`;
  const composite = COMPOSITE.exec(key);
  if (composite) {
    const base = stitchName(composite[1]!);
    return composite[3] === "inc" ? `${composite[2]} ${base} in one stitch` : `${base} ${composite[2]} together`;
  }
  const parts = typeParts(key);
  if (!parts.base) return key;
  let name = BASE_NAMES[parts.base];
  if (parts.reverse) name = `reverse ${name}`;
  if (parts.long) name = `spike ${name}`;
  if (parts.post) name = `${parts.post} post ${name}`;
  if (parts.loop) name = `${name}, ${parts.loop} loop only`;
  return name;
}

/** Entries for the glyphs in a scene, in chart order; unknown types last. */
export function legendEntries(scene: SymbolScene): LegendEntry[] {
  const statements = new Map<string, Set<number>>();
  const fallback = new Map<string, boolean>();
  for (const g of scene.glyphs) {
    let set = statements.get(g.key);
    if (!set) statements.set(g.key, (set = new Set()));
    set.add(g.statement);
    fallback.set(g.key, g.fallback);
  }
  const entries = [...statements].map(([key, set]) => ({
    key,
    name: stitchName(key),
    count: set.size,
    fallback: fallback.get(key)!,
  }));
  return entries.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

function rank(entry: LegendEntry): number {
  if (entry.fallback) return 1000;
  const composite = COMPOSITE.exec(entry.key);
  const parts = typeParts(composite ? composite[1]! : entry.key);
  const base = parts.base ? BASE_ORDER.indexOf(parts.base) : 50;
  const variant = composite ? 100 : parts.loop || parts.post || parts.reverse || parts.long ? 200 : 0;
  const cluster = CLUSTER.exec(entry.key);
  if (cluster) return 300 + BASE_ORDER.indexOf(cluster[1] as BaseStitch);
  return (entry.key === "picot3" ? 300 : variant) + base;
}

export interface LegendIcon {
  /** Polylines in icon space: x right, y up, one unit = one yarn edge. */
  lines: [number, number][][];
  dots: { at: [number, number]; radius: number }[];
  /** [minX, minY, maxX, maxY] */
  box: [number, number, number, number];
}

const ICON_HEIGHT: Partial<Record<BaseStitch, number>> = { sc: 1, hdc: 1.4, dc: 1.9, tr: 2.4, dtr: 2.9, trtr: 3.4 };

/** The symbol of a legend key, drawn on a made-up stitch. */
export function legendIcon(key: string): LegendIcon {
  const composite = COMPOSITE.exec(key);
  const type = composite ? composite[1]! : key;
  const n = composite ? Number(composite[2]) : 1;
  const parts = typeParts(type);
  const cluster = CLUSTER.exec(type);
  const height = ICON_HEIGHT[(cluster?.[1] as BaseStitch | undefined) ?? parts.base ?? "hdc"] ?? 1.4;
  const placements: StitchPlacement[] = [];

  const stitch = (t: string): Stitch => ({ id: "", row: 0, index: 0, statement: 0, type: t, workedInto: [], intoSpace: false, nodeIds: [], labels: [], side: typeParts(t).loop ?? typeParts(t).post });
  const place = (t: string, top: Vec3, feet: Vec3[], prev?: Vec3, next?: Vec3) =>
    placements.push({
      stitch: stitch(t),
      top,
      legs: feet.map((foot) => ({ footNode: "", foot, top, intoSpace: false, onRing: false, clear: [] })),
      frame: frameFor(top, feet, prev, next, 2),
    });

  if (key === "picot3") {
    const tops: Vec3[] = [[-0.45, 0.45, 0], [0, 0.95, 0], [0.45, 0.45, 0]];
    tops.forEach((t, i) => place("ch", t, [], tops[i - 1] ?? [-0.5, 0, 0], tops[i + 1] ?? [0.5, 0, 0]));
    place("ss", [0, 0, 0], []);
  } else if (parts.base === "ch") {
    place("ch", [0, 0.5, 0], [], [-1, 0.5, 0], [1, 0.5, 0]);
  } else if (parts.base === "ss" || parts.base === "ring") {
    place(type, [0, 0.5, 0], []);
  } else if (composite?.[3] === "inc") {
    // An sc's × sits mid-leg, so its fan needs more room than a post's.
    const spacing = parts.base === "sc" ? 1.4 : 0.9;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * spacing;
      place(type, [x, height, 0], [[0, 0, 0]]);
    }
  } else if (composite?.[3] === "tog") {
    const feet: Vec3[] = Array.from({ length: n }, (_, i) => [(i - (n - 1) / 2) * 0.9, 0, 0]);
    place(type, [0, height, 0], feet);
  } else {
    place(type, [0, height, 0], [[0, 0, 0]]);
  }

  const lines: [number, number][][] = [];
  const dots: LegendIcon["dots"] = [];
  for (const p of placements) {
    const drawn = drawPlacement(p, 1);
    for (const line of drawn.lines) lines.push(line.map(([x, y]) => [x, y]));
    for (const d of drawn.dots) dots.push({ at: [d.at[0], d.at[1]], radius: d.radius });
  }
  const xs = [...lines.flat().map((p) => p[0]), ...dots.flatMap((d) => [d.at[0] - d.radius, d.at[0] + d.radius])];
  const ys = [...lines.flat().map((p) => p[1]), ...dots.flatMap((d) => [d.at[1] - d.radius, d.at[1] + d.radius])];
  return { lines, dots, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

