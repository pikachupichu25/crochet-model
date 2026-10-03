# Symbol Mode: Requirements

> Status: S1, S2 and S3 built; the crocheter checks in §7 are pending  
> Last updated: 2026-10-02  
> Purpose: add a view mode that draws the laid-out model with standard crochet chart symbols, one symbol per stitch, instead of spheres at nodes and cylinders along edges.

This is a feature of the model view described in [../REQUIREMENTS.md](../REQUIREMENTS.md) §6.4 to §6.5. How it is built is in [SPEC.md](./SPEC.md). The chart conventions it follows are in [../CROCHET_CONVENTIONS.md](../CROCHET_CONVENTIONS.md) ("Chart-symbol conventions"). Requirement IDs here start with `SYM-`; plain `FR-x.y` and `NFR-x` refer to the main REQUIREMENTS.md.

## 1. Summary

Structure mode (FR-5.6, level 1) shows the stitch graph exactly, but it looks like a molecule model. A crocheter cannot tell an `sc` from a `dc` without hovering over it. The yarn renderer (FR-5.1 to FR-5.7) will fix that by drawing real yarn, but it is a large piece of work (M4) and it hides the structure under the yarn.

Crocheters already have a visual language for stitches: the **chart symbol**. A chain is an oval, a slip stitch a dot, a single crochet a `×`, a double crochet a `T` with one slash. Charts are read worldwide, across US, UK and Japanese terms. Symbol mode puts one of these symbols on every stitch of the laid-out model:

```text
structure mode                          symbol mode
  ●───●───●───●     (top nodes,           ×   ×   ×   ×      row 2: 4 sc
  │   │   │   │      yarn and                                 
  ●───●───●───●      attachment edges)  ⬭  ⬭  ⬭  ⬭       foundation: 4 ch
```

Each symbol is placed and oriented by the layout: its foot sits on the stitch it is worked into and its top on the stitch's own top node. So the view is a chart of the pattern as the solver shapes it, in 2D for flat pieces and on the surface in 3D.

Symbol mode needs no new data from the parser or the solver. It uses the stitch graph (SPEC §3.3) and the layout (SPEC §3.4) that structure mode already uses.

## 2. Who it is for

- **The pattern reader** knows charts better than code or graphs. Symbol mode lets them check the model against a chart they already have, or read a written pattern as a chart.
- **The pattern designer** wants a chart to publish next to the written pattern. A 2D symbol view, exported as SVG, is a first draft of that chart.
- **The CrochetPARADE user** wants to see stitch types at a glance while editing, without switching the colour mode to "By stitch" and remembering a palette.

## 3. Goals and non-goals

### 3.1 Goals

Symbol mode must let a user:

1. switch the model view between structure and symbols at any time, without laying out again;
2. tell every MVP stitch type (FR-5.8) apart by its symbol, using the standard chart shapes;
3. see increases fan out from one base and decreases join at one top, as charts show them;
4. read a 2D piece (swatch, granny square, doily) as a chart, and a 3D piece (amigurumi, hat) as a chart drawn on its surface;
5. keep everything structure mode offers: hover info, row ↔ stitch links (FR-3.2), colour modes and fit;
6. see a legend of the symbols in the current model;
7. export a 2D symbol view as an SVG chart.

### 3.2 Non-goals

- **Reading charts.** Turning a chart image into a pattern is still out of scope (main REQUIREMENTS §3.2).
- **A chart editor.** Symbols are drawn from the pattern. They are not dragged, added or deleted by hand; the code is the only thing the user edits.
- **A hand-drawn chart layout.** Published charts are often idealised: rounds on perfect circles, rows on a grid. Symbol mode draws stitches where the solver puts them. A "tidy" layout that snaps rows to a grid or rounds to circles is a later idea (§10).
- **Every symbol set.** One symbol set, based on the Craft Yarn Council (CYC) chart symbols, is enough. No variants or alternatives (SYM-FR-2.4).
- **Replacing the yarn renderer.** Symbol mode is a third level of detail next to structure and yarn, not a substitute for M4.

## 4. Background: how chart symbols work

A crochet chart draws each stitch as a symbol standing on the stitch it is worked into. Symbols are drawn in the direction the stitch stands: in rows they stand upright; in rounds they point away from the centre. The height of a symbol follows the height of the stitch, so a round of `dc` sits further out than a round of `sc`.

The shapes most charts share (CYC; see CROCHET_CONVENTIONS.md):

| Stitch | Symbol |
| --- | --- |
| chain `ch` | oval, long axis along the chain |
| slip stitch `ss` | small solid dot (or a small solid oval) |
| single crochet `sc` | `×` (some charts use `+`) |
| half double `hdc` | `T`: a post with a bar on top |
| double `dc` | `T` with one slash across the post |
| treble `tr` | `T` with two slashes |
| double treble `dtr` | `T` with three slashes |
| increase (`sc2inc`, `dc2inc`, …) | two or more symbols spreading from one base |
| decrease (`sc2tog`, `dc2tog`, …) | two or more posts meeting at one top |
| back loop / front loop only | a small arc under the symbol |
| front post / back post | a hook at the foot of the post |
| magic ring | a circle (or loop) at the centre |
| picot | a small loop of chain ovals closed with a dot |
| puff, bobble, popcorn | posts joined at the top, at the top and bottom, or closed by a cap |

Two observations make symbol mode practical:

- **Most of the chart convention falls out of the graph.** The stitch graph already records, for every stitch, its type, the stitch or space it is worked into, and its top node. An increase is two stitches with the same base; a decrease is one stitch with two bases; a picot is three chains and a slip stitch. Drawing one symbol per stitch from its bases to its top gives the fan and the join with no special case.
- **The symbol shapes are facts, not artwork.** The CYC publishes them as a standard. The app draws its own symbols from a few strokes; it does not copy any symbol image (§8).

## 5. Functional requirements

### 5.1 Mode and switching

- **SYM-FR-1.1** The model view has a **View** control with *Structure* and *Symbols* (and *Yarn* once M4 is built). It sits with the existing Dimension, Quality and Colour controls in the model panel.
- **SYM-FR-1.2** Switching view mode **does not re-run the layout**. It reuses the graph and positions already laid out, including `TRANSFORM_OBJECT:` moves (SPEC §3.4).
- **SYM-FR-1.3** The chosen mode is remembered in the browser, separately for 2D and 3D layouts.
- **SYM-FR-1.4** The default mode is *Symbols* for 2D layouts and *Structure* for 3D layouts (decided 2026-10-02, §11).
- **SYM-FR-1.5** Symbol mode is available wherever the structure view is: the main app, the M0 harness, and the eval and datasets pages (they share `StructureView`).

### 5.2 Symbols

- **SYM-FR-2.1** Every stitch in the MVP set (FR-5.8) has a symbol: `ch`, `ss`, `sc`, `hdc`, `dc`, `tr`, `sc2inc`, `sc2tog`, `dc2tog`, the `bl`/`fl` variants, `fpdc`, `bpdc`, `ring`. The other built-ins with an obvious chart symbol are included too: `dtr`, `trtr`, `fpsc`/`bpsc`, `fphdc`/`bphdc`, `fptr`/`bptr`, `rsc` (reverse sc), `longsc`/`longdc`/`longtr` (spike stitches), `picot3`.
- **SYM-FR-2.2** **Composite stitches are drawn from their parts.** An increase is drawn as one symbol per stitch it makes, all standing on the same base. A decrease is drawn as one symbol with one leg per base, the legs meeting at the top. This follows from the graph (§4) and must hold for any `XNinc` and `XNtog` the parser accepts, not only the ones in the table.
- **SYM-FR-2.3** **Puffs, bobbles and popcorns** (`hdc3puff`–`hdc5puff`, `dc3bobble`–`dc5bobble`, `tr4bobble`, `dc3pc`–`dc5pc`) get their own symbols. They are second phase (§9, S3); until then they use the fallback (SYM-FR-2.6).
- **SYM-FR-2.4** `sc` is always drawn as `×`. There is no `+` setting and no other symbol-set variant.
- **SYM-FR-2.5** Stitches with no drawn form (`sk`, `turn`, `tie_up`, `start_at`, `start_anew`, hidden tops) get no symbol.
- **SYM-FR-2.6** **Unknown stitches** (user `DEF:` stitches, built-ins with no symbol yet) still get a mark: a plain post from base to top with a small open square at the top. They are named in the legend as "no symbol" with their type, and the hover tooltip shows the type as usual. A `DEF: x=Copy(sc)` or alias of a known stitch uses that stitch's symbol when the graph shows its type (SPEC §3.3 gives the top node's type).

### 5.3 Placement

- **SYM-FR-3.1** A symbol stands **from its base to its top**: the base is the laid-out position of the stitch worked into (or, for a stitch worked into a chain space, the position of that space); the top is the stitch's own top node.
- **SYM-FR-3.2** The **height of a symbol is its laid-out length**, so taller stitches look taller and stretched stitches look stretched. The width of a symbol (the `×`, the top bar, the slashes, the oval) is the same for every stitch, sized from the typical yarn edge length, so symbols stay legible when a stitch is short or long.
- **SYM-FR-3.3** **Chains** have no base. A chain's oval is centred on its top node, with its long axis along the chain (from the previous stitch to the next).
- **SYM-FR-3.4** **Slip stitches** are a dot at the top node. The dot sits where the slip stitch joins, as charts draw joins.
- **SYM-FR-3.5** **Magic ring:** a circle centred on the ring node. Round 1's legs start at the circle, not at its centre.
- **SYM-FR-3.6** **Loop and post marks** sit at the foot of the symbol. For now there is **one** loop mark for both back and front loop, and **one** post mark for both front and back post; the side shows in the tooltip and the legend. Telling the sides apart by symbol is [ISSUE-003](../known_issues/ISSUE-003_symbol_mode_loop_and_post_marks_not_told_apart.md).
- **SYM-FR-3.7** In **2D**, symbols lie in the layout plane and are viewed face-on.
- **SYM-FR-3.8** In **3D**, each symbol lies on the fabric surface, in the plane of its stitch (up and along), raised slightly off the surface toward the front. A faint shaded surface, built from the structure, is drawn under the symbols so the 3D shape reads and the far side is hidden; it is on by default and can be turned off. With the surface off, symbols on the far side are faded so the near side reads first.
- **SYM-FR-3.9** Symbols must not overlap ([ISSUE-004](../known_issues/ISSUE-004_symbol_mode_symbols_overlap_each_other.md)). Two contacts are the chart convention and allowed: the legs of an increase meeting at their shared foot, and a post touching the top of the stitch it stands on. To keep symbols apart the renderer may stop a leg short of the chain or ring it starts from, move an `sc`'s `×` along its leg or a slip-stitch dot off its node, and shrink a crowded symbol's decorations to 60% of their size. It never changes the layout: where the solver packs stitches tighter than that, they still overlap (decided 2026-10-03).

### 5.4 Interaction and colour

- **SYM-FR-4.1** Hover, click and selection work as in structure mode: hovering a symbol shows its type, row and stitch number and highlights the stitches it is worked into; clicking selects its row in the review (FR-3.2); selecting a row highlights its symbols and turns the camera to them.
- **SYM-FR-4.2** The hit area of a symbol covers its whole drawn extent, not only its top node, so thin symbols are easy to point at.
- **SYM-FR-4.3** Colour modes: *Yarn colour* (the pattern's `COLOR:`), *By stitch* (the existing type palette), and *Ink* (all symbols in one dark colour on a light background, like a printed chart). *Ink* is the default in symbol mode.
- **SYM-FR-4.4** An *Alternate rows* colour mode draws every other row or round in a second colour, as many published charts do, so neighbouring rounds are told apart.
- **SYM-FR-4.5** The symbol view follows the app's light and dark themes; *Ink* uses the theme's text colour on its background.
- **SYM-FR-4.6** Optional overlays, off by default: the **yarn path** (thin line from stitch to stitch in working order) and **row numbers** (the row or round number next to each row's first stitch, the English label when the row ↔ stitch mapping is available).

### 5.5 Legend

- **SYM-FR-5.1** The model panel shows a **legend** of the symbols in the current model: the symbol, the stitch name in US terms and its abbreviation, and how many there are. Only symbols present are listed.
- **SYM-FR-5.2** Composite stitches are listed by their pattern name (`sc2inc`, `dc2tog`) with their composite symbol, not split into parts.
- **SYM-FR-5.3** Hovering a legend entry highlights every stitch of that type in the view.
- **SYM-FR-5.4** Unknown stitches are listed last, under "No symbol" (SYM-FR-2.6).

### 5.6 Export

- **SYM-FR-6.1** A 2D symbol view exports as an **SVG chart**: the symbols in their current colours, the legend, and row numbers if shown. The file opens in a browser and in vector editors (Inkscape, Illustrator) with each symbol as its own group, so a designer can tidy it by hand.
- **SYM-FR-6.2** PNG snapshot of the current view, 2D or 3D (FR-6.3 applies to symbol mode too).
- **SYM-FR-6.3** SVG export of a 3D view is not required. If offered, it is a projection of the current camera view and says so.

## 6. Non-functional requirements

- **SYM-NFR-1 Speed.** Building the symbols for a laid-out model of 3,000 stitches takes under 100 ms on a 2022-era laptop, and the view keeps 30 fps or better while orbiting (NFR-2). Switching mode feels instant.
- **SYM-NFR-2 Legibility.** At the default zoom after "Fit", every symbol of a 500-stitch model is at least 8 px tall on a 1440 × 900 viewport. Line widths scale with the model, like ink on paper, not with the screen.
- **SYM-NFR-3 Reproducibility.** Same graph and positions give the same symbols. Symbol building is a pure function of them and the options.
- **SYM-NFR-4 Platforms.** As NFR-6. Lines must render with real width on all three browsers (WebGL `lineWidth` above 1 is not supported in practice, so it cannot be relied on).
- **SYM-NFR-5 Accessibility.** Symbols are told apart by shape, never only by colour. The legend is text, readable by a screen reader.

## 7. Evaluation

Symbol mode is judged by whether crocheters can read it, measured the same way as the yarn render (main REQUIREMENTS §9).

- **Chart match.** For the granny square and flat swatch samples, a crocheter compares the 2D symbol view with a published chart of the same pattern and confirms every round or row has the right symbols in the right order.
- **Symbol recognition.** Five crocheters are shown single symbols cut from the view (`ch`, `ss`, `sc`, `hdc`, `dc`, `tr`, an increase, a decrease, `scbl`, `fpdc`) and asked "which stitch is this?". Target: 90% correct. The bar is higher than for the yarn render (80%) because these are the shapes crocheters already know.
- **3D readability.** On the amigurumi ball sample, a crocheter can point to the round where increases stop, using only symbol mode.

## 8. Licences

- The CYC chart symbols are a published standard. The app uses the *conventions* (which shape means which stitch) and draws every symbol from its own strokes (SPEC §4). It does not copy CYC's symbol images or fonts.
- Symbol fonts and icon sets with crochet symbols exist; none are used, to avoid their licences and to keep symbols recolourable and exportable as plain strokes.
- Chart images in the evaluation datasets (CrochetBench photos) are not used to make or test symbols.

## 9. Milestones

Symbol mode is independent of the yarn renderer and can be built before M4.

| Milestone | Scope | Exit check |
| --- | --- | --- |
| **S1 2D chart** | Symbols for SYM-FR-2.1, 2.2, 2.5, 2.6; placement SYM-FR-3.1 to 3.7; view toggle; hover, click, selection; *Ink*, *Yarn colour*, *By stitch*; legend | The granny square and swatch samples pass the chart match check (§7) |
| **S2 3D** | Placement on the surface with the shaded surface and far-side fading (SYM-FR-3.8); *Alternate rows*; row-number and yarn-path overlays | The ball sample passes the 3D readability check |
| **S3 Export and more symbols** | SVG and PNG export; puff, bobble and popcorn symbols; symbol mode on the eval and datasets pages | Symbol recognition test passes (§7); an exported SVG opens in Inkscape with one group per symbol |

## 10. Later ideas

- **Tidy chart layout.** Snap rows to a grid and rounds to concentric circles, keeping the stitch order, to get a chart that looks hand-drawn. This needs its own layout pass, not the CrochetPARADE solver.
- **Symbols on the yarn render.** Show a small symbol over each stitch of the yarn view while hovering a row.
- **Chart input.** Once chart reading exists (main REQUIREMENTS §3.2, later phase), the same symbol definitions can be used to recognise symbols.

## 11. Decisions

Settled 2026-10-02:

1. **Default mode.** Symbols for 2D layouts, structure for 3D (SYM-FR-1.4).
2. **3D surface.** Yes: a faint shaded surface under the symbols, on by default in 3D (SYM-FR-3.8).
3. **`sc` symbol.** `×` only (SYM-FR-2.4).
4. **Loop and post marks.** One mark for loop stitches and one for post stitches until the CYC orientation of each side is checked (SYM-FR-3.6); tracked as [ISSUE-003](../known_issues/ISSUE-003_symbol_mode_loop_and_post_marks_not_told_apart.md).
