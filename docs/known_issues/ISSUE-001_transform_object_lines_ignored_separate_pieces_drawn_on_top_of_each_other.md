# ISSUE-001: TRANSFORM_OBJECT lines ignored, separate pieces drawn on top of each other

**Issue status:** closed

**Fix status:** fixed

---

## Issue Description

Observed: patterns made of several unconnected pieces (`start_anew`, `new`) drew all pieces overlapping at one spot. The bundled snowman (`textSnowman2`, "Amigurumi: simplistic snowman" on crochetparade.org) showed its body, head and hat as one blob, seen from above as a circle.

Expected: pieces placed as on crochetparade.org, where the snowman stands upright with its hat on top.

Scope: the 3D structure view in the M0 harness. Affects bundled examples that use `TRANSFORM_OBJECT:` (`textSnowman2`, `textTestObjectTransformWithFL`) and any user pattern with those lines. The solver output itself was correct: it matches the site's exactly.

## Test Script for Issue

```bash
npx vitest run packages/core/test/objectTransform.test.ts
```

## Issue Analysis

Confirmed:
- The solver lays out unconnected pieces on top of each other; nothing joins them.
- crochetparade.org's renderer (`mesh64.js`) moves them after layout using `TRANSFORM_OBJECT: object,tx,ty,tz,rx,ry,rz` lines, which the parser skips. The harness ignored these lines.
- Objects are the graph's connected components, numbered by their first node in the parser's output.
- Each piece is rotated about its centre of mass by Euler angles (radians, XYZ order, as three.js), then moved by (tx, ty, tz) in bounding radii of the whole model (the site centres the model and divides by its largest distance from the centre before transforming).

Known difference: the site takes each piece's centre of mass over every mesh it draws (stitch balls, edge midpoints, arrowheads); we take it over the piece's drawn nodes. Pieces land within 0.02 bounding radii of the site's positions.

## Proposed Fix

Done. Added `readObjectTransforms`, `objectNumbers` and `applyObjectTransforms` in `packages/core/src/cp/objectTransform.ts` (exported from core). `packages/app/src/main.ts` reads the transforms from the validated text and applies them to the layout before `view.setModel`. 2D layouts are left as they are. Tests in `packages/core/test/objectTransform.test.ts` cover parsing, component numbering, translation, rotation, and the snowman against piece centres and stitch positions read from the site's scene. Documented in SPEC.md §3.4.
