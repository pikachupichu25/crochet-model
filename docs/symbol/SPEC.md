# Symbol Mode: Technical Specification

> Status: S1 (2D chart) built; S2 and S3 not started  
> Last updated: 2026-10-02  
> Purpose: define how to build what [REQUIREMENTS.md](./REQUIREMENTS.md) asks for: the data that places each symbol, the symbol definitions, the three.js view, the legend and the SVG export.

[REQUIREMENTS.md](./REQUIREMENTS.md) in this folder says **what** symbol mode must do. This document says **how**. `SYM-FR-x.y` refers to that file; `§n` without a file name refers to this one; "main SPEC" is [../SPEC.md](../SPEC.md).

## 0. Assumptions

All four decisions in REQUIREMENTS §11 were settled on 2026-10-02.

| Decision (REQUIREMENTS §11) | Settled | Affects |
| --- | --- | --- |
| 1. Default mode | Symbols for 2D, structure for 3D | §6.1 |
| 2. 3D surface | Yes, on by default in 3D | §5.4 |
| 3. `sc` symbol | `×` only | §4.3 |
| 4. Loop and post marks | One mark each for now; sides told apart later ([ISSUE-003](../known_issues/ISSUE-003_symbol_mode_loop_and_post_marks_not_told_apart.md)) | §4.3, §4.6 |

## 1. Overview

```text
StitchGraph + positions (after TRANSFORM_OBJECT)        main SPEC §3.3, §3.4
  → legs: for each stitch, the points its symbol stands on          §3   core
  → frames: up, across and out for each stitch                      §3.4 core
  → symbol geometry: strokes and dots in world space, per stitch    §4   core
  → SymbolScene ──┬─▶ SymbolView: three.js fat lines + dots + hit quads   §5   app
                  ├─▶ Legend: inline SVG per symbol type             §6.3 app
                  └─▶ SVG chart export (2D)                           §7   core
```

Everything up to `SymbolScene` is pure TypeScript in `packages/core`, so it runs in Node for tests and for SVG export, and in the browser on the main thread. It is a function of the graph, the positions and the options (SYM-NFR-3). No worker is needed: a 3,000-stitch model is a few tens of thousands of points (§8).

Files (S1 built, except where marked):

```text
packages/core/src/symbols/
  legs.ts          StitchGraph + positions → Leg[] per stitch (§3); yarnUnit()
  frames.ts        per-stitch frame (§3.4); shared later with the yarn renderer (main SPEC §6.3)
  glyphs.ts        symbol definitions in leg and top frames (§4)
  draw.ts          one placement's glyph in world space, and its pick quad (§4.4)
  scene.ts         buildSymbolScene(): legs + frames + glyphs → SymbolScene (§4.5)
  legend.ts        legend keys (sc2inc, dc2tog, picot3), US names, counts, icons (§6.3)
  stitchTypes.ts   typeParts() and baseType(): base stitch and loop, post, reverse, spike affixes
  vec.ts           tuple vector helpers
  svg.ts           SymbolScene (2D) → SVG chart text (§7); S3
packages/core/test/symbols.test.ts   legs, ring rule, glyphs, scene, legend (§9)
packages/app/src/view/
  modelView.ts     ModelView: camera, controls, resize, render-on-demand, picking, highlights (§5.1)
  layer.ts         the Layer interface and view options
  structureLayer.ts  structure mode, moved out of the old structureView.ts unchanged
  symbolLayer.ts   symbol mode (§5.2 to §5.5)
  palette.ts       type palette and highlight colours, shared by both layers
packages/app/src/ui/
  ModelPanel.tsx   View control, colour per mode, legend; export buttons in S3 (§6)
  SymbolLegend.tsx the legend (§6.3)
```

## 2. What the graph gives, and what it does not

Symbol mode reads `StitchGraph` as `parseStitchGraph` builds it (main SPEC §3.3). These facts were checked with the vendored parser (commit `06e987b`) on 2026-10-02:

| Pattern | What the graph reports |
| --- | --- |
| `sc2inc` | two stitches of type `sc`, one statement, the same single `workedInto` |
| `sc2tog` | one stitch of type `sc` with two `workedInto` |
| `dc2tog` | one stitch of type `dc` with two `workedInto` |
| `fpdc` | type `fpdc`, `side: "front"` |
| `scbl` | type `scbl`, `side: "back"` |
| `dc3bobble`, `hdc3puff`, `dc3pc` | their own type, with internal nodes `C`–`H` |
| `picot3` | three `ch` and one `ss` in one statement; the `ss` is worked into the stitch before the picot |
| `longdc` | type `longdc`, worked into a stitch two rows down |
| `3dc` into a `3ch.A!` space | each `dc` has `intoSpace: true`, **two** `workedInto` (the chains either side of the space), and an internal node `B` placed between them by gray edges; one of the three attaches straight into the middle chain instead |
| `ring` then `6sc` | the first `sc` is worked into the ring; **each later `sc` is worked into the `sc` before it** (CrochetPARADE models the ring as one node and round 1 as a chain of stitches tied to it) |

Three consequences:

1. **Increases and decreases need no special case.** One symbol per stitch, drawn from its bases to its top, fans out an increase and joins a decrease (SYM-FR-2.2).
2. **Two `workedInto` does not always mean a decrease.** A stitch into a chain space has two as well. The legs (§3) must look at `intoSpace` and the `B` node.
3. **Round 1 in a ring has no base in the graph's sense.** Drawn literally, its symbols would lie along the round, each standing on its neighbour. The legs (§3.2) must send them to the ring.

`Stitch.type` for composite stitches is the base type (`sc`, `dc`). The statement name (`sc2inc`) is not kept; the legend rebuilds it from the shape (§6.3).

## 3. Legs

A **leg** is a segment a symbol stands on: from a foot point (where the stitch is worked into) to the stitch's top node. Most stitches have one leg; a decrease has one per stitch it joins; a chain has none.

```ts
interface Leg {
  /** Where the foot is: a stitch's top node, a chain-space node, or the ring. */
  footNode: string;
  foot: Vec3;
  top: Vec3;
  /** The foot is a chain space (`intoSpace`), not a stitch's top. */
  intoSpace: boolean;
  /** The foot is a magic ring: the leg starts on the ring circle (§4.4). */
  onRing: boolean;
}

/** One stitch's placement. */
interface StitchPlacement {
  stitch: Stitch;
  legs: Leg[];                  // [] for ch, ring and stitches with no drawn form
  top: Vec3;
  frame: Frame;                 // §3.4
}

function placeStitches(graph: StitchGraph, positions: Record<string, number[]>): StitchPlacement[];
```

`Vec3` is `[x, y, z]`; 2D positions get `z = 0`.

### 3.1 Feet

For each stitch, in this order:

1. **No drawn form** (`hidden`, and the types in SYM-FR-2.5): no placement.
2. **`ch`, `ring`, `ss`:** no legs (a slip stitch is a dot at its top, §4.3).
3. **Into a chain space** (`intoSpace`): one leg, its foot at the statement's internal node that has incoming `constraint` edges (the `B` node in §2). If that node has no position, the foot is the mean of the `workedInto` tops.
4. **Otherwise:** one leg per `workedInto` stitch, its foot at that stitch's top node. Jacobian nodes (loop and post attachments) are not feet: the leg goes to the stitch worked into, and the loop or post mark (§4.3) shows the side.

### 3.2 Round 1 in a ring

After step 4, a leg whose foot is a stitch in the **same row**, where following same-row feet backwards ends at a stitch worked into a `ring`, is moved to that ring: `footNode` is the ring, `onRing` is true. This catches every stitch of a round worked into a magic ring (§2), and nothing else: in every other case CrochetPARADE never works a stitch into one of the same row except through a label or `@[%,…]`, and those are not chains back to a ring. A test pins this on the samples and the bundled examples (§9).

### 3.3 Degenerate legs

A leg shorter than 0.25 × `unit` (§4.1), which happens when the solver squeezes a stitch, is lengthened to that along its direction, or along the stitch's `up` (§3.4) when foot and top coincide. The symbol stays readable; the hover tooltip still shows the real stitch.

### 3.4 Frames

Each placement has an orthonormal frame:

- **up**: from the mean foot to the top, normalised. A chain has no feet: up is the 2D normal of its along direction in 2D, and the mean up of its row's neighbours in 3D.
- **along**: from the previous to the next stitch's top in working order (yarn edges), made orthogonal to up. At the ends of a row, one-sided.
- **out**: in 2D, `+z`. In 3D, `up × along`, its sign made consistent across the fabric by the propagation in main SPEC §6.3.
- **across** = `out × up`: the in-surface direction perpendicular to the leg, used for the width of symbols.

`frames.ts` exports this so the yarn renderer (M4) can use the same frames.

## 4. Symbols

### 4.1 Units

- `unit` is the median length of yarn edges, as in structure mode. All widths are multiples of it, so symbols look the same at any pattern scale.
- Symbols are defined in a **leg frame**: `v` runs from foot (0) to top (1) along the leg and is scaled to the leg's length; `u` runs across, in units of `unit`, **not** scaled. So a stretched `dc` gets a longer post with the same bar width and the same slash angle (SYM-FR-3.2).

### 4.2 Primitives

```ts
type Stroke =
  | { kind: "line"; from: [u: number, v: number]; to: [number, number] }
  | { kind: "arc"; center: [number, number]; radius: number; start: number; end: number }  // radians, radius in units
  | { kind: "ellipse"; center: [number, number]; rx: number; ry: number };              // closed, in units

interface Dot { at: [u: number, v: number]; radius: number }   // filled

interface Glyph {
  /** Strokes on each leg, in the leg frame. */
  leg: Stroke[];
  /** Strokes once per stitch, in the top frame: origin at the top node, u across, v up in units. */
  top: Stroke[];
  dots: Dot[];
  /** How many slashes on the post (dc 1, tr 2, dtr 3, trtr 4). */
  slashes?: number;
}
```

Arcs and ellipses are turned into polylines when the scene is built (16 segments per full turn), so the renderer and the SVG writer only see lines and dots. The SVG writer keeps ellipses and arcs as `<ellipse>` and `<path>` for cleaner files (§7).

### 4.3 The symbol table

Sizes are in units; `w` is the half-width of a symbol, 0.35 by default.

| Type | Leg strokes | Top strokes | Notes |
| --- | --- | --- | --- |
| `ch` | — | ellipse, rx 0.45 along, ry 0.2 | top frame turned so u runs along the chain (SYM-FR-3.3) |
| `ss` | — | — | dot r 0.12 at the top (SYM-FR-3.4) |
| `sc` | `×`: two lines through (0, 0.5), half-size `w` across and 0.25 along v (in units) | — | always `×` (SYM-FR-2.4). A decrease: one `×` per leg at its middle, plus a line from each `×` to the top |
| `hdc` | post: line (0,0)→(0,1) | bar: (−w,0)→(w,0) | |
| `dc`, `tr`, `dtr`, `trtr` | post | bar | 1–4 slashes across the post, centred at v 0.5, spaced 0.15 units, each from (−0.6w, −0.1) to (0.6w, 0.1) |
| `rsc` | `×` | — | for now the same as `sc`; its own mark is ISSUE-003 (§4.6) |
| `longsc`, `longdc`, `longtr` | as `sc`/`dc`/`tr`, with the post drawn full length to the foot two rows down | | the long leg is the spike |
| `*bl` / `*fl` | base stitch's strokes, plus one arc under the foot, r 0.25, opening down | | the same arc for back and front loop for now (§4.6) |
| `fp*` / `bp*` | base stitch's strokes, plus one hook at the foot | | the same hook for front and back post for now (§4.6) |
| `ring` | — | circle r 0.5 at the ring node | SYM-FR-3.5 |
| `hdc3puff`–`hdc5puff` | S3 | | a closed oval of N posts |
| `dc3bobble`–`dc5bobble`, `tr4bobble` | S3 | | N posts joined at foot and top, each with slashes |
| `dc3pc`–`dc5pc` | S3 | | N posts fanned, closed by a cap arc |
| unknown | post | open square, side 0.3, at the top | SYM-FR-2.6 |

The type is matched after stripping the loop, post, reverse and spike affixes (`typeParts()` in core `stitchTypes.ts`), so `fptrbl` (if a pattern defines one) still gets a `tr` with a hook and an arc. The structure view's palette uses the same `baseType()`.

### 4.4 Placement rules

- A leg with `onRing` starts at the ring circle: the foot is moved toward the top by the ring radius.
- A post stitch with several legs (`dc2tog`) draws the post and slashes on each leg and **one** bar at the top. A `sc` decrease draws one `×` per leg (table above).
- Picots need no rule: their three `ch` ovals and the `ss` dot are drawn as such, and the `ss` sits on the stitch the picot closes on.
- The `×` of an `sc` is placed at the middle of the leg, not at the top, as charts do. Its top node is still the hover and pick point.

### 4.5 The scene

As built in S1. S2 adds `"rows"` to `colorMode`, and `yarnPath` and `rowLabels` to the scene (SYM-FR-4.4, 4.6).

```ts
interface SymbolOptions {
  colorMode: "ink" | "yarn" | "type";            // SYM-FR-4.3
}

interface SymbolScene {
  dimension: 2 | 3;
  unit: number;
  glyphs: PlacedGlyph[];        // one per drawn stitch, in working order; the ring is one too
  bounds: { min: Vec3; max: Vec3 };
}

interface PlacedGlyph {
  stitchId: string;
  statement: number;            // the legend counts statements, so a sc2inc counts once
  key: string;                  // the legend key (§6.3), e.g. "sc2inc"
  colorKey: string;             // what colorMode resolves: "ink", a COLOR: name, a base type
  lines: Vec3[][];              // polylines in world space
  dots: { at: Vec3; radius: number }[];
  hit: [Vec3, Vec3, Vec3, Vec3]; // quad covering the glyph, in its frame plane (SYM-FR-4.2)
  out: Vec3;                    // for far-side fading in 3D
  fallback: boolean;            // drawn with the fallback mark (SYM-FR-2.6)
}

function buildSymbolScene(graph: StitchGraph, positions: Record<string, number[]>, dimension: 2 | 3, options: SymbolOptions): SymbolScene;
```

Colour keys, not colours, are stored: the view and the SVG writer resolve them against the theme (SYM-FR-4.5), so a theme change does not rebuild the scene.

### 4.6 Loop, post and reverse marks

For now each family has **one** mark: one arc for back and front loop, one hook for front and back post, and `rsc` drawn as `sc` (REQUIREMENTS §11, decision 4). `Stitch.side` is not used by the glyphs yet; the tooltip and legend still name the exact type. Telling the sides apart needs the CYC orientation of each mark checked first, and is tracked in [ISSUE-003](../known_issues/ISSUE-003_symbol_mode_loop_and_post_marks_not_told_apart.md). The glyph lookup keeps the side as an input so that fix touches only `glyphs.ts`.

## 5. Symbol view

### 5.1 One view, two layers

The old `structureView.ts` became `ModelView` (`modelView.ts`): camera, `OrbitControls`, lights, resize, render-on-demand, `fit()`, `focusSelection()`, hover and click detection. What it draws is a **layer**, chosen by `options.mode`; switching mode rebuilds only the layer inside the same scene, so the camera stays where it is and the layout is not re-run (SYM-FR-1.2). Layers were chosen over subclasses of a base view so one canvas and one camera serve both modes.

```ts
interface Layer {
  build(ctx: BuildContext): void;                   // adds meshes to ctx.group
  stitchAt(raycaster: THREE.Raycaster): Stitch | undefined;
  paint(state: PaintState): void;                   // hover, bases, selection, legend highlight
  resize?(width: number, height: number): void;
}

class ModelView {
  setModel(graph: StitchGraph, layout: LayoutResult): void;
  setOptions(options: Partial<{ mode: "structure" | "symbols"; colorMode: "yarn" | "type" | "ink"; showInternal: boolean }>): void;
  setSelection(ids: Iterable<string>): void;
  setHighlightKey(key: string | undefined): void;   // legend hover, SYM-FR-5.3
  focusSelection(): void;
  fit(): void;
  onHover; onPick;
  onLegend: (entries: LegendEntry[] | undefined) => void;  // after each build; undefined in structure mode
}
```

`snapshot()` for PNG export (SYM-FR-6.2) comes in S3. The harness and the eval and datasets pages use `ModelView` in structure mode until S3 gives them the View select.

### 5.2 Lines

WebGL ignores `lineWidth` above 1 on most platforms (SYM-NFR-4), so lines use three.js's fat lines: `LineSegments2` with `LineSegmentsGeometry` and `LineMaterial` from `three/addons/lines/`. All glyph polylines go into **one** `LineSegments2` (one draw call), with per-vertex colour.

- `worldUnits: true`, line width 0.06 × `unit`: lines scale with the model like ink on paper (SYM-NFR-2).
- Colours live in the instance colour attribute; hover, selection and legend highlight rewrite colours only, never geometry (as `paint()` does in structure mode).
- A range table maps each glyph to its segment range, so repainting one glyph touches only its segments.

### 5.3 Dots and circles

Slip-stitch dots are an `InstancedMesh` of flat discs (`CircleGeometry`, 12 segments) oriented to the glyph's `out` in 3D and facing `+z` in 2D. The ring circle and chain ovals are lines (§4.2), not discs.

### 5.4 3D

- Each glyph is offset along its `out` by 0.15 × `unit`, so it sits on top of the fabric, not inside it.
- **Surface** (SYM-FR-3.8, on by default): a mesh triangulated from the stitch graph (each stitch's top, its feet and its row neighbours), drawn in a faint shade of the background colour with polygon offset, so the 3D shape reads and the far side's symbols are hidden behind it. Its normals come from the frames' `out` (§3.4). A checkbox turns it off.
- **Far-side fading**, used when the surface is off: in the line shader (an `onBeforeCompile` patch of `LineMaterial`), a per-vertex `out` attribute is compared with the view direction; symbols facing away are drawn at 25% opacity. Depth test stays on, depth write off for faded segments, so near symbols are never hidden by far ones.

### 5.5 Picking

`stitchAt` raycasts against an invisible `InstancedMesh` of quads, one per glyph, built from `PlacedGlyph.hit`. Chains and slip stitches get a quad of at least 0.5 × 0.5 units, so they are as easy to hit as posts. The hit returns the glyph's stitch, so the tooltip, `onPick` and row selection code in `ModelPanel` stay unchanged (SYM-FR-4.1).

### 5.6 Colours

| `colorMode` | Resolves to |
| --- | --- |
| `ink` | CSS `--ink` (the theme's text colour) for every glyph |
| `yarn` | the stitch's `COLOR:`, as structure mode; unknown names fall back to grey |
| `type` | `TYPE_COLORS` from structure mode, moved to a shared module |
| `rows` | `--ink` on even rows, `--ink-alt` (new token, a blue in light theme, a light blue in dark) on odd rows |

Hover, base and selection colours are the existing `HOVER_COLOR`, `BASE_COLOR` and `SELECT_COLOR`.

## 6. App changes

### 6.1 Model panel

- A **View** select (Structure, Symbols) before the Dimension select. The choice is saved **per dimension** in `localStorage` under `view.mode` (`{"2": "symbols", "3": "structure"}`), read and written in a `try`. A dimension with no saved choice gets the default: symbols for 2D, structure for 3D (SYM-FR-1.4). Saving per dimension keeps both rules: a user who turns symbols off for a flat piece still gets the 3D default, and the other way round.
- The **Colour** select gains *Ink* in symbol mode (*Alternate rows* in S2). Each mode keeps its own colour for the session: symbols start on *Ink*, structure on *Yarn colour*.
- A **Symbols** menu (a small popover) with: yarn path, row numbers, and in 3D, surface (on by default).
- **Export**: "PNG" always; "SVG chart" in symbol mode on a 2D layout.

### 6.2 Row numbers

`rowLabels` (§4.5) put each row's number next to its first drawn stitch, offset by 0.6 × `unit` against `along`. When the row ↔ English mapping exists (main SPEC §9, "Row ↔ stitch"), the label is the English row label (`Rnd 3`); otherwise CrochetPARADE's row number plus one. In the view they are HTML elements positioned by projecting each anchor every render, hidden when behind the model, so they stay crisp at any zoom. In the SVG export they are `<text>`.

### 6.3 Legend

`SymbolLegend` lists the `type` keys of the scene's glyphs, with counts, in a fixed order: `ch`, `ss`, `sc`, `hdc`, `dc`, `tr`, `dtr`, `trtr`, then composites, loop and post variants, specials, then "No symbol".

- **Composite names** (`legend.ts`): stitches sharing a statement and a single foot, n of them, are `{type}{n}inc`; a stitch with n feet that are not a chain space is `{type}{n}tog`; a statement of three `ch` and an `ss` is `picot3`. A `sc2inc` and a `sc2tog` are one legend entry each, not two `sc`. Counts are statements, so `6*sc2inc` counts 6.
- Each entry's symbol is drawn by the same `glyphs.ts` definitions into a small inline `<svg>` (§7), so the legend always matches the view.
- Names come from a table in `legend.ts` (US terms, with the key shown as the abbreviation: "single crochet `sc`", "single crochet 2 together `sc2tog`"). UK names are not shown; the app converts UK patterns to US before translation (FR-1.2).
- Hovering an entry calls `setHighlightType(type)` (SYM-FR-5.3).

### 6.4 Other pages

The harness, `eval.html` and `datasets.html` use `StructureView` directly or through `CpModel.tsx`. In S3 they get the same View select; `CpModel` takes a `mode` prop so the two models on the eval page switch together.

## 7. SVG export

`svg.ts` writes a 2D `SymbolScene` as a standalone SVG:

- `viewBox` from the scene bounds plus a margin of 2 units, y flipped (layout y points up, SVG y down).
- One `<g id="s-{stitchId}" class="sym sym-{type}">` per glyph, so a designer can select and move symbols in a vector editor (SYM-FR-6.1). Lines are `<path>`; chain ovals `<ellipse>`; dots `<circle>`. `stroke-width` is the view's line width in the same units; `stroke-linecap="round"`.
- Colours are written resolved, from the current colour mode and theme.
- A legend group laid out under the chart, using the same entries as §6.3, and row labels as `<text>` when shown.
- The pattern's title (first `#` comment, if any) as the SVG `<title>`; the CrochetPARADE text is not embedded.

A 3D scene is refused by `svg.ts` (SYM-FR-6.3); the app does not offer the button.

## 8. Performance

Budget for 3,000 stitches (SYM-NFR-1): about 3,000 glyphs × up to 12 segments ≈ 36,000 segments in one `LineSegments2`, plus a few hundred dot instances and 3,000 hit quads. Building the scene is a linear pass over stitches and edges; the target is under 100 ms, measured in S1 on the `textHat` example (4,646 stitches) and the samples. If it is slower, the scene builder moves into the layout worker and returns typed arrays, as the yarn mesh builder is planned to (main SPEC §6.1).

## 9. Testing

Unit tests in `packages/core/test/symbols.test.ts`, all in Node with the vendored parser and solver:

- **Legs** on small patterns: `sc2inc` gives two placements with the same foot; `sc2tog` and `dc2tog` give one placement with two legs; `3dc` into a chain space gives three one-legged placements, and those with `intoSpace` stand on their `B` node, not on the two chains either side; `ring` + `6sc` gives six legs with `onRing`; `fpdc` and `scbl` legs end at the stitch worked into, not at the jacobian node; `ch`, `ring` and `ss` have no legs.
- **Ring rule** (§3.2) on every bundled example with a magic ring (`textEarth` left out: its parse takes 2 s and slows the conformance run beside it): no leg is marked `onRing` unless its row has a stitch worked into a `ring`, and every stitch worked straight into a ring is.
- **Glyphs:** every built-in in `builtinStitches()` (core `nodeParser.ts`) maps to a glyph or to the fallback, and only the S3 types to the fallback; this test fails when a vendor upgrade adds a stitch type. Until ISSUE-003 is fixed, `scbl` and `scfl` (and `fpdc` and `bpdc`) give the same strokes; the test asserts this so the fix has to change it on purpose.
- **Scene:** for a fixed graph and positions, a stretched `dc` keeps its bar width and slash angle (§4.1); `bounds` contains every point; a 2D scene has `z = 0` everywhere.
- **Composite names:** the samples' legends list `sc2inc` and `sc2tog` with the counts the pattern states.
- **SVG** (S3): the granny square sample's SVG parses as XML, has one `<g class="sym …">` per drawn stitch, and matches a stored snapshot.

In the browser, during S1 and S2, by the preview workflow: switch modes on each sample, check the console is clean, hover and click a symbol and see the review row selected, and screenshot each sample in symbol mode for the chart match check (REQUIREMENTS §7).

## 10. Milestones

As REQUIREMENTS §9, with the files each touches.

| Milestone | Files | Exit check |
| --- | --- | --- |
| **S1 2D chart** (built) | `legs.ts`, `frames.ts` (2D), `glyphs.ts` (all but S3 types), `draw.ts`, `scene.ts`, `legend.ts`; `modelView.ts` with structure and symbol layers; View select, colour modes, legend | Unit tests (§9) pass; granny square and swatch match a published chart (crocheter check pending) |
| **S2 3D** | `frames.ts` (3D, sign propagation), surface, far-side fading, row labels, yarn path | Ball sample: the round where increases stop is findable in symbol mode |
| **S3 Export and more** | `svg.ts`, PNG snapshot, puff, bobble and popcorn glyphs, harness and eval/datasets pages | Symbol recognition test passes; SVG opens in Inkscape with one group per symbol |

## 11. Open questions

1. **Spike stitches.** A `longdc` has one foot two rows down. Charts draw it as a long post reaching down; the graph gives the right foot already. Check on a real pattern that the long post does not cross the row below confusingly, and if it does, draw the part over the skipped row dashed.
2. **Stitches into the yarn before** (`ss` closing a picot, joins `ss@[%,0]`). Charts draw only the dot; the graph's foot is ignored for `ss` (it has no legs in the table). Confirm that no common pattern relies on seeing where a slip stitch attaches.
3. **Turning chains standing in for a stitch** ("ch 3 counts as dc"). The graph has three `ch`; charts often draw a `dc` symbol or three ovals stacked upward. Symbol mode draws the ovals where the solver puts them. Decide with users whether that is enough.
4. **Dense first rounds.** Round 2 of an amigurumi puts 12 symbols on 6 feet close together. Measure on the ball sample whether the symbols overlap enough to need a smaller `w` near the ring.
