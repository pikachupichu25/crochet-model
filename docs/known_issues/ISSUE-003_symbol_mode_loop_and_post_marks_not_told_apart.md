# ISSUE-003: Symbol mode loop and post marks not told apart

**Issue status:** open

**Fix status:** not_started

---

## Issue Description

Observed (by design, until fixed): symbol mode (docs/symbol) draws one placeholder mark for all loop-only stitches and one for all post stitches. Back loop (`scbl`, `dcbl`, …) and front loop (`scfl`, `dcfl`, …) get the same mark; front post (`fpsc`, `fpdc`, …) and back post (`bpsc`, `bpdc`, …) get the same mark.

Expected: the Craft Yarn Council (CYC) chart convention, where the back-loop and front-loop arcs, and the front-post and back-post hooks, face opposite ways, so a crocheter can tell the side from the symbol alone.

Scope: the symbol table in `packages/core/src/symbols/glyphs.ts` (docs/symbol/SPEC.md §4.3) and the legend. The side is already known: `Stitch.side` is `"back"` or `"front"` for these stitches (SPEC.md §3.3). The hover tooltip and the legend name the exact stitch type, so the information is not lost, only not shown in the symbol. `rsc` (reverse sc) is in the same state: it uses the `sc` mark until its CYC mark is checked.

## Test Script for Issue

```bash
npx vitest run packages/core/test/symbols   # once S1 is built: add a case that scbl and scfl (and fpdc and bpdc) produce different strokes
```

## Issue Analysis

Confirmed:
- CYC charts draw these marks as mirror pairs, and published charts use them.
- The graph gives the side for every loop and post stitch, so no parser or graph change is needed.

Not confirmed: which orientation means which side (arc opening up or down for back loop; hook direction for front post). This was not checked against the CYC chart while writing the spec, so it was left out rather than guessed (docs/symbol/REQUIREMENTS.md §11, decision 4).

## Proposed Fix

1. Draw the CYC chart symbols (craftyarncouncil.com/standards/crochet-chart-symbols) and one published chart that uses them next to the app's marks.
2. In `glyphs.ts`, split the placeholder into back/front loop arcs and front/back post hooks chosen by `Stitch.side`, with a comment naming the source; add the reverse-sc mark the same way.
3. Add the test above, and update the legend entries and docs/symbol/SPEC.md §4.3.
