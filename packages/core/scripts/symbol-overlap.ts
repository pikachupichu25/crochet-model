// Measures where symbols overlap in symbol mode, and why (ISSUE-004).
// Lays out the samples and some bundled examples, finds every pair of
// symbols whose strokes come closer than the line width, and sorts the pairs
// by cause. Conventional contact (an increase fan meeting at its foot, a
// stitch standing on the top of the one below) is counted separately.
//
//   node --experimental-strip-types --no-warnings packages/core/scripts/symbol-overlap.ts

import { createNodeValidator, bundledExamples } from "../src/node.ts";
import { createNodeSolver } from "../src/cp/nodeSolver.ts";
import { parseStitchGraph } from "../src/cp/graph.ts";
import { applyObjectTransforms, readObjectTransforms } from "../src/cp/objectTransform.ts";
import { placeStitches, yarnUnit, type StitchPlacement } from "../src/symbols/legs.ts";
import { drawPlacement } from "../src/symbols/draw.ts";
import { glyphFor, type LegPoint, type Stroke } from "../src/symbols/glyphs.ts";
import { distance, sub, dot, add, scale, type Vec3 } from "../src/symbols/vec.ts";

const v = createNodeValidator();
const solver = await createNodeSolver();
const rep = (l: string, n: number) => Array(n).fill(l).join("\n");
const ex = bundledExamples();
const CASES: [string, string, 2 | 3][] = [
  ["swatch", "16ch,turn\nsk,15sc,turn\n" + rep("ch,15sc,turn", 8), 2],
  ["granny", ["4ch.R,ss@[%,0]", "3ch,2dc@R,2ch.A[0],3dc@R,2ch.A[1],3dc@R,2ch.A[2],3dc@R,2ch.A[3],ss@[%,2]",
    "ss@A[0],3ch,2dc@A[0],2ch.B[0],3dc@A[0],ch.C[0],3dc@A[1],2ch.B[1],3dc@A[1],ch.C[1],3dc@A[2],2ch.B[2],3dc@A[2],ch.C[2],3dc@A[3],2ch.B[3],3dc@A[3],ch.C[3],ss@[%,3]",
    "ss@B[0],3ch,2dc@B[0],2ch,3dc@B[0],ch,3dc@C[0],ch,3dc@B[1],2ch,3dc@B[1],ch,3dc@C[1],ch,3dc@B[2],2ch,3dc@B[2],ch,3dc@C[2],ch,3dc@B[3],2ch,3dc@B[3],ch,3dc@C[3],ch,ss@[%,3]"].join("\n"), 2],
  ["disc-2D", "ring\n6sc\n6*sc2inc\n6*[sc,sc2inc]\n6*[2sc,sc2inc]\n6*[3sc,sc2inc]", 2],
  ["ball-3D", "ring.R\n6sc@R\n6*sc2inc\n6*[sc,sc2inc]\n6*[2sc,sc2inc]\n" + rep("24sc", 4) + "\n6*[2sc,sc2tog]\n6*[sc,sc2tog]\n6*sc2tog", 3],
  ["Square", ex.textSquare!, 2], ["Flower2", ex.textFlower2!, 2], ["Swatch2", ex.textSwatch2!, 2], ["Edging", ex.textEdging!, 2],
];

type Seg = { a: Vec3; b: Vec3; glyph: number; part: string };
function segDist(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a < 1e-12 && e < 1e-12) return distance(p1, p2);
  if (a < 1e-12) { t = Math.min(1, Math.max(0, f / e)); }
  else { const c = dot(d1, r);
    if (e < 1e-12) { s = Math.min(1, Math.max(0, -c / a)); }
    else { const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); } } }
  return distance(add(p1, scale(d1, s)), add(p2, scale(d2, t)));
}

function labels(p: StitchPlacement): string[] {
  const g = glyphFor(p.stitch.type, p.stitch.side);
  const out: string[] = [];
  const legName = (s: Stroke<LegPoint>) => s.kind === "arc" ? "mark" : s.kind === "polyline" ? "post" : s.kind === "ellipse" ? "cap" :
    (s.kind === "line" && s.from.v === 0 && s.to.v === 1) ? "post" : p.stitch.type.replace(/bl|fl|^fp|^bp/g, "").startsWith("sc") || p.stitch.type === "rsc" ? "cross" : "slash";
  for (let i = 0; i < p.legs.length; i++) {
    for (const s of g.leg) out.push(legName(s));
    if (p.legs.length > 1) for (const _ of g.joinLeg) out.push("join");
  }
  for (const s of g.top) out.push(s.kind === "ellipse" ? "oval" : g.fallback ? "square" : "bar");
  if (g.ring) out.push("ring");
  return out;
}

const base = (t: string) => t.replace(/bl$|fl$/, "").replace(/^fp|^bp/, "");
for (const [name, text, dim] of CASES) {
  const r = v.validate(text, { dimension: dim });
  if (!r.ok) { console.log(name, "parse error", r.error?.message); continue; }
  const g = parseStitchGraph(r.graphJson!);
  const L = solver.layout(r.simpleDot!);
  const pos = dim === 3 ? applyObjectTransforms(g, L.positions, readObjectTransforms(text)) : L.positions;
  const u = yarnUnit(g, pos);
  const ps = placeStitches(g, pos, u, dim);
  const segs: Seg[] = [];
  ps.forEach((p, i) => {
    const d = drawPlacement(p, u, dim === 3 ? 0.15 * u : 0);
    const lab = labels(p);
    d.lines.forEach((line, k) => { for (let j = 1; j < line.length; j++) segs.push({ a: line[j - 1]!, b: line[j]!, glyph: i, part: lab[k] ?? "?" }); });
    d.dots.forEach((dd) => segs.push({ a: dd.at, b: dd.at, glyph: i, part: "dot" }));
  });
  const width = 0.06 * u;
  const near = 0.15 * u;
  const causes = new Map<string, Set<string>>();
  const touching = new Map<string, { i: number; j: number; parts: Set<string>; cls: string }>();
  // shared nodes: feet and tops
  const feet = ps.map((p) => new Set(p.legs.map((l) => l.footNode)));
  const topId = ps.map((p) => p.stitch.id);
  const pointOf = (id: string) => { const q = pos[id]; return q ? [q[0]!, q[1]!, q[2] ?? 0] as Vec3 : undefined; };
  for (let x = 0; x < segs.length; x++) for (let y = x + 1; y < segs.length; y++) {
    const s = segs[x]!, t = segs[y]!;
    if (s.glyph === t.glyph) continue;
    const extra = (s.part === "dot" ? 0.12 * u : 0) + (t.part === "dot" ? 0.12 * u : 0);
    if (segDist(s.a, s.b, t.a, t.b) > width + extra) continue;
    const [i, j] = s.glyph < t.glyph ? [s.glyph, t.glyph] : [t.glyph, s.glyph];
    const P = ps[i]!, Q = ps[j]!;
    // classify
    const shared = [...feet[i]!].filter((f) => feet[j]!.has(f));
    const stacked = feet[j]!.has(topId[i]!) || feet[i]!.has(topId[j]!);
    const contactNear = (id: string) => { const n = pointOf(id); return n && Math.min(segDist(s.a, s.b, n, n), segDist(t.a, t.b, n, n)) < near; };
    let cls: string;
    if (shared.some(contactNear)) cls = "A shared foot (fan)";
    else if (stacked && contactNear(feet[j]!.has(topId[i]!) ? topId[i]! : topId[j]!)) cls = "B stands on stitch below";
    else cls = P.stitch.row === Q.stitch.row ? "C same row" : "D different rows";
    const partOf = (k: number) => (s.glyph === k ? s.part : t.part);
    const spaceChains = (f: string) => new Set(g.edges.filter((e) => e.kind === "constraint" && e.head === f).map((e) => e.tail));
    const cause = (() => {
      const pi = partOf(i), pj = partOf(j);
      for (const [o, other] of [[i, j], [j, i]] as const) {
        if (partOf(o) !== "oval") continue;
        const O = ps[o]!, X = ps[other]!;
        if (X.legs.some((l) => l.footNode === O.stitch.id)) return "1 leg runs into the oval of the chain it is worked into";
        if (X.legs.some((l) => l.intoSpace && spaceChains(l.footNode).has(O.stitch.id))) return "2 leg into a chain space touches that space's chains";
        if (partOf(other) === "oval") return "3 neighbouring chain ovals touch (chains closer than the oval)";
        return "4 oval vs a symbol it has no relation to (crowded layout)";
      }
      if (pi === "dot" || pj === "dot") return "5 slip-stitch dot on another symbol (joins)";
      if (pi === "cross" && pj === "cross") {
        const sameFoot = P.legs.some((l) => Q.legs.some((m) => m.footNode === l.footNode));
        if (sameFoot) return "6 crosses of an increase fan collide mid-leg";
        return P.stitch.row === Q.stitch.row ? "7 crosses of neighbours collide (row squeezed)" : "8 crosses of adjacent rows collide (rows squeezed)";
      }
      if (cls.startsWith("A") || cls.startsWith("B")) return "0 conventional: " + cls.slice(2);
      return `9 other: ${pi} x ${pj}`;
    })();
    causes.set(cause, (causes.get(cause) ?? new Set()).add(`${i},${j}`));
    const key = `${i},${j}`;
    const e = touching.get(key) ?? { i, j, parts: new Set(), cls };
    if (cls < e.cls) e.cls = cls;
    e.parts.add([`${base(P.stitch.type)}.${s.glyph === i ? s.part : t.part}`, `${base(Q.stitch.type)}.${s.glyph === j ? s.part : t.part}`].sort().join(" x "));
    touching.set(key, e);
  }
  const byCls = new Map<string, number>(); const byParts = new Map<string, number>();
  for (const e of touching.values()) {
    byCls.set(e.cls, (byCls.get(e.cls) ?? 0) + 1);
    if (e.cls >= "C") for (const p of e.parts) byParts.set(`${e.cls[0]} ${p}`, (byParts.get(`${e.cls[0]} ${p}`) ?? 0) + 1);
  }
  // spacing of neighbouring tops in a row, and leg lengths
  const gaps: number[] = []; const legs: Record<string, number[]> = {};
  for (let k = 1; k < ps.length; k++) if (ps[k]!.stitch.row === ps[k - 1]!.stitch.row) gaps.push(distance(ps[k]!.top, ps[k - 1]!.top) / u);
  for (const p of ps) for (const l of p.legs) (legs[base(p.stitch.type)] ??= []).push(distance(l.foot, l.top) / u);
  const q = (a: number[], f: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]?.toFixed(2); };
  const involved = new Set([...touching.values()].filter((e) => e.cls >= "C").flatMap((e) => [e.i, e.j]));
  console.log(`\n== ${name} (${dim}D): ${ps.length} symbols, ${involved.size} (${(100 * involved.size / ps.length).toFixed(0)}%) in a real overlap (not a fan or a stitch standing on the one below)`);
  console.log("  pairs by class:", Object.fromEntries([...byCls].sort()));
  console.log("  top-to-top gap in a row (units) p10/p50/p90:", q(gaps, 0.1), q(gaps, 0.5), q(gaps, 0.9));
  console.log("  leg length p10/p50/p90:", Object.fromEntries(Object.entries(legs).map(([k, a]) => [k, `${q(a, 0.1)}/${q(a, 0.5)}/${q(a, 0.9)}`])));
  console.log("  pairs by cause:", [...causes].sort().map(([k, set]) => `\n    ${k}: ${set.size}`).join(""));
  console.log("  C/D part pairs:", [...byParts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}: ${n}`).join("; "));
}
