# ISSUE-004: Symbol mode symbols overlap each other

**Issue status:** open

**Fix status:** not_started

---

## Issue Description

Observed: in symbol mode (docs/symbol), many symbols touch or cross other symbols. On the granny square sample, 60% of symbols overlap another one; on the bundled granny `Square`, 42%; on `Flower2`, 57%. Posts run into chain ovals, posts in a chain space touch the chains around it, and the two `×` of a single-crochet increase cross each other.

Expected: no symbol overlaps another, as in a published chart. Two kinds of contact are part of the chart convention and are not overlaps: the legs of an increase meeting at their shared foot, and a stitch's post touching the top of the stitch it stands on.

Scope: the symbol geometry in `packages/core/src/symbols/` (`draw.ts`, `glyphs.ts`, `legs.ts`), so the view, the legend icons and the SVG export all change together. The layout is not the cause of most overlaps (see analysis) and is not to be changed: symbol mode draws stitches where the solver puts them (SYM-FR-3.9).

## Test Script for Issue

```bash
node --experimental-strip-types --no-warnings packages/core/scripts/symbol-overlap.ts
```

It lays out the samples and several bundled examples, finds every pair of symbols whose strokes come closer than one line width (0.06 units), sets aside the conventional contacts above, and counts the rest by cause. After the fix, a unit test in `packages/core/test/symbols.test.ts` should assert the real-overlap share on the granny, disc, ball and `Square` patterns stays below a threshold.

## Issue Analysis

Measured on 2026-10-03 with the script above (seed 0, 500 iterations). Columns are overlapping symbol pairs per cause; "share" is the share of symbols in at least one real overlap.

| Pattern | Share | 1 leg into its chain's oval | 2 leg in a space touches the space's chains | 3, 4 crowded ovals | 5 ss dot | 6 increase × | 7, 8 squeezed rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| swatch sample (2D) | 1% | 1 | | | | | |
| granny sample (2D) | 60% | 28 | 40 | 6 | | | |
| disc (2D, sc rounds) | 60% | | | | | 25 | 4 |
| ball sample (3D) | 21% | | | | | 22 | |
| `Square` (2D) | 42% | 48 | 81 | 12 | 13 | 11 | 8 |
| `Flower2` (2D) | 57% | 48 | 38 | 3 | 8 | 7 | 27 |
| `Swatch2` (2D) | 3% | 45 | | | | | |
| `Edging` (2D) | 30% | 47 | 8 | 7 | 10 | | |

Confirmed causes, most common first:

1. **A leg worked into a chain runs into that chain's oval.** The foot is the chain's top node, which is the oval's centre (`legs.ts`, §3.1 step 4), so the post or `×` reaches 0.18–0.42 units into the oval. Charts end the leg at the oval's edge. The magic ring already has this fix (`clipToRing` in `draw.ts`); chains do not.
2. **A leg into a chain space touches the chains either side.** Its foot is the space's `B` node, half way between two chains 1 unit apart. Chain ovals are 0.84 units long, so the gap between them is about 0.16 units, and a post standing in it (0.06 wide) touches both oval ends. Charts start the post just above the chain line.
3. **The two `×` of an increase cross.** Both legs share one foot, and the `×` sits at the middle of each leg (`glyphs.ts`, `cross()` at v = 0.5). With tops 1 unit apart the two centres are about 0.5 units apart, but each `×` is 0.56 units wide. This is every same-row overlap on the disc and the 3D ball. Charts draw the crosses higher up the arms of the V, where the arms are further apart.
4. **Crowded layouts.** Where the solver puts stitches closer than usual (neighbouring tops 0.83 units apart at the 10th percentile on `Flower2`, against 1.0 typically; `sc` legs as short as 0.82), fixed-size symbols (half-width 0.35, `HALF_WIDTH` in `glyphs.ts`) and 0.84-unit ovals collide with neighbours in the same or the next row (causes 3, 4, 7, 8).
5. **Slip-stitch dots at joins** sit on the node where the round's first and last stitches meet, so they land on another symbol's bar or oval. A minor cause.
6. **Round 1 crosses touch the ring circle** (3 pairs on the disc, not in the table): the leg is clipped at the ring, but the `×` at the middle of what is left is close enough to the circle to touch it.

Not causes: the solver's rest lengths are met to about 10% (main SPEC §3.4), so with the typical 1-unit spacing, causes 1–3 come from symbol geometry alone. Pick quads (`PlacedGlyph.hit`) overlap where the symbols do, so hovering in a crowded spot can pick the neighbour; fixing the overlaps fixes this too.

Requirement conflict: SYM-FR-3.9 says overlaps the layout forces are "shown as it is, not fixed". This issue asks for no overlap, so SYM-FR-3.9 should change to allow the renderer to move and shrink symbols (never the layout) to keep them apart.

## Proposed Fix

Smallest changes first, each measured with the script:

1. **Clip legs at the chain oval** (cause 1): generalise `clipToRing` to clip any leg whose foot is a chain at that chain's ellipse, plus a small gap (about 0.05 units). Expected to remove most of cause 1 on every pattern.
2. **Lift feet in chain spaces** (cause 2): start a leg into a space a short way (about 0.2 units) above its `B` node, or clip it against the space's two chain ovals as in step 1.
3. **Move increase crosses up the arms** (cause 3): for an `sc` sharing its foot with siblings, place the `×` where the arms are at least one `×` width apart (v ≈ 0.7 for two, higher for three), keeping v = 0.5 for a single leg.
4. **Fit symbols to the space they have** (cause 4): scale a symbol's width (the `×`, the bar, the slashes, the oval's length) down to fit the distance to its nearest neighbouring top, with a floor (about 60%) so symbols stay legible. A stitch squeezed below the floor still overlaps, as the layout forces.
5. **Slip-stitch dots** (cause 5): draw them smaller, or nudge them off the node toward their own leg.
6. Update SYM-FR-3.9 and docs/symbol/SPEC.md §4.4 with the new rules, add the overlap test, and re-check the samples in the browser.
