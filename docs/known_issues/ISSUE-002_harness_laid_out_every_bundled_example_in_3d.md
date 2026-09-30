# ISSUE-002: Harness laid out every bundled example in 3D

**Issue status:** closed

**Fix status:** fixed

---

## Issue Description

Observed: the M0 harness chose 3D for every bundled CrochetPARADE example (only its own `Flat swatch (2D)` example got 2D). The granny square (`textSquare`) was laid out in 3D instead of flat.

Expected: the same dimension crochetparade.org uses for each example. The site lays out five in 2D: `Flower2` (Irish crochet: flower 1), `Square` (granny square), `Edging`, `Swatch2` (listed as "Swatch 1") and `Doily`. All others are 3D.

Scope: example selection in the harness only. A user can still switch the dimension by hand.

## Test Script for Issue

```bash
npm run dev   # then pick "Square" in the example list: the dimension box shows 2D and Lay out gives a flat granny square
```

## Issue Analysis

Confirmed: the dimension is not in the pattern text. crochetparade.org keeps it in a `textOptions` table in its index.html (`[label, text, dimension]`) and sets `DIM` when an example is chosen. The harness had no such table and used `name.includes("2D")`, which no bundled example matches.

## Proposed Fix

Done. Added `FLAT_EXAMPLES` (Flower2, Square, Edging, Swatch2, Doily) to `packages/app/src/main.ts`; choosing one of these sets the dimension to 2D. Checked in the browser: the granny square lays out flat with seed 1, as on the site (46 of 1071 edges crossing, below the fold threshold). Documented in SPEC.md §6.5.
