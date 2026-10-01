# Crochet Model App: Product Requirements

> Status: draft, not started  
> Last updated: 2026-10-01  
> Purpose: turn a crochet pattern written in ordinary English into CrochetPARADE code with an LLM, then show it as a model that looks like real crocheted yarn, not a ball-and-stick graph.

Related docs in this folder: [CROCHET_CONVENTIONS.md](./CROCHET_CONVENTIONS.md) (pattern abbreviations and US/UK terms, the input side of translation), [MATH.md](./MATH.md) (layout models beyond CrochetPARADE's spring graph) and [RELATED_WORK.md](./RELATED_WORK.md) (survey of parsers and LLM translation work). CrochetPARADE's layout solver was studied in the ply-split-braiding project ([`docs/elastic/README.md`](../../ply-split-braiding/docs/elastic/README.md) §2); that study is reused here rather than repeated.

## 1. Summary

A crocheter pastes a pattern such as:

```text
Rnd 1: 6 sc in a magic ring. (6)
Rnd 2: 2 sc in each st around. (12)
Rnd 3: *sc, inc* 6 times. (18)
```

The app does three things:

1. **Translate.** An LLM rewrites the pattern in the [CrochetPARADE](https://www.crochetparade.org/) language, one output line per row or round.
2. **Check.** The CrochetPARADE parser checks the result. Stitch counts are compared with the counts the pattern states. Errors go back to the LLM for repair. Anything still unclear is shown to the user as a question.
3. **Visualize.** The checked code becomes a stitch graph. The graph is laid out in 2D or 3D and drawn as yarn: loops, posts and chains that read as real stitches.

The CrochetPARADE code is the contract between the three stages. The user can read and edit it, and any other CrochetPARADE user can open it unchanged.

## 2. Who it is for

- **The pattern reader.** Has a written pattern, perhaps from a blog or a PDF, and wants to see what it makes before buying yarn. Does not want to learn a pattern language.
- **The pattern designer.** Writes patterns in English and wants to catch count errors, puckering and wrong shaping before test crocheters do.
- **The CrochetPARADE user.** Already knows the language. Wants a faster first draft of the code and a nicer render for sharing.

## 3. Goals and non-goals

### 3.1 Goals

The MVP must let a user:

1. paste an English pattern and get valid CrochetPARADE code back;
2. see, row by row, which English line produced which code line, and where the translation is uncertain;
3. answer the app's questions about ambiguous lines instead of fixing code by hand;
4. edit the code directly and re-render;
5. view the result in 3D (amigurumi, hats) or 2D (swatches, granny squares, doilies);
6. see a render in which a single crochet, a double crochet and a chain are recognisable by eye;
7. export the CrochetPARADE text and a 3D model.

### 3.2 Non-goals for the MVP

- Reading patterns from photos, charts or PDFs (text only; charts are a later phase).
- Photorealistic, path-traced rendering. The target is "reads as crochet", not "indistinguishable from a photo".
- Physical simulation of yarn: no stuffing, gravity or yarn-on-yarn contact.
- Knitting, Tunisian crochet, or crochet techniques CrochetPARADE cannot express.
- Writing new patterns from a description ("make me a bunny"). This is harder and less reliable; see §4.7.
- Storing patterns in user accounts. Accounts hold only saved API keys and settings (§6.7); export is how a pattern is kept.
- An LLM budget paid by the app. Every LLM call uses the user's own key.

## 4. Background: how CrochetPARADE works

This section records the study the app is built on. Sources are the CrochetPARADE repository (read on 2026-09-29, last push 2026-05-26): `README.md`, `Manual.md`, `capabilities.md`, `index.html` (built-in stitch table), `translator_ui.js` and `deterministic_translator.js`. The layout solver was read earlier from `graph.cpp`; see [ply-split-braiding `docs/elastic/README.md`](../../ply-split-braiding/docs/elastic/README.md) §2.

### 4.1 Pipeline

```text
pattern text ──parse──▶ stitch graph ──layout──▶ node positions ──render──▶ 3D view / exports
 (CrochetPARADE     (nodes = stitch tops    (spring solver,          (spheres + cylinders,
  language)          and internal points;    graph.cpp → WASM)        three.js)
                     edges = yarn, each
                     with a rest length)
```

| Stage | Where it runs in CrochetPARADE | Output |
| --- | --- | --- |
| Parse and check | `parse64.js`, entry point `processText(text, …)`; throws an error with a message when the pattern is invalid | stitch graph plus per-row stitch statistics |
| Layout | `graph.cpp`, compiled with Emscripten to `graph64.wasm` | x, y (and z) for every node |
| Render | three.js in `index.html` | spheres at nodes, cylinders along edges |
| Export | `GLTFExporter.js`, SVG.js, periphery tool (`periphery64.wasm`) | GLTF, SVG charts, DOT graph, STL/OBJ surface |

Everything runs in the browser. No pattern text leaves the device.

### 4.2 The language, as far as the app needs it

Each line is a row or round. Stitches are separated by commas. By default, each stitch is worked into the next stitch of the previous row, and `turn` reverses that direction for the next row. Everything else in the language is a way to override that default.

| Feature | Syntax | Example |
| --- | --- | --- |
| Row or round | new line | — |
| Stitch count | number prefix or `N*` | `6sc`, `8*ch` |
| Repeat a group | `N*[ … ]` or `[ … ]*N` | `6*[sc,sc2inc]` |
| Start or end a repeat part-way | `<`, `>` inside the group | `[2sc,>,dc]*3` → `2sc,dc,2sc,dc,2sc` |
| Turn the work | `turn`, last on the line | `sk,9sc,turn` |
| Skip a stitch | `sk` | `4sk` |
| Magic ring | `ring` | — |
| Increase / decrease | built-ins | `sc2inc`, `sc2tog` |
| Back / front loop only | suffix | `scbl`, `scfl` |
| Post stitches | prefix | `fpdc`, `bpdc` |
| Work into a given stitch | `@[row,stitch]`, 0-based, negative counts from the end, `%` = current | `dc@[-1,3]`, `ss@[%,0]` |
| Work into the Nth stitch of a type | `@[type:row,n]` | `@[sc:-1,3]` |
| Relative to the last attachment | `@[@]`, `@[@+2]` | `dc,dc@[@]` (two dc in one stitch) |
| Label a stitch or chain space | `.Name`, `.Name[k]` | `4ch.A!` |
| Work into a label | `@Name` | `5sc@A` |
| Counters | `$k=0$`, `k++` | `$k=0$, 8*[5ch.C[k++]+!, sk, sc]` |
| Colour | `COLOR:` line (X11 name or hex) | `COLOR: navy` |
| New stitch | `DEF:` alias, copy or raw subgraph | `DEF: rsc=Copy(sc)` |
| Solver settings | `DOT:` line | `DOT: start=12` |
| Comment | `#` | `# Round 3` |

The hard part of translation is not the stitch names. It is attachment: English says "in the next ch-3 space", "in the same stitch", "in the top of the beginning chain", "skip 2". In CrochetPARADE each of these becomes an explicit label or `@` reference. §6.2 is built around this.

### 4.3 The stitch graph

Each stitch is a small subgraph: named top nodes, bottom nodes (attachment points), optional hidden nodes, and connections with rest lengths in stitch units. A `dc` is taller than an `sc` because its connection is longer. Raw definitions use the form:

```text
DEF: name=&comment^top_nodes:bottom_nodes~attachments:other_nodes:connections
```

Parsing the pattern chains these subgraphs into one graph. The graph records topology (what is worked into what) and target lengths. It does not record which way a loop wraps or where the yarn crosses. The realistic renderer (§6.5) has to add that information.

### 4.4 Layout

The solver ([ply-split-braiding `docs/elastic/README.md`](../../ply-split-braiding/docs/elastic/README.md) §2) treats every edge as a spring at its rest length. It adds weak, annealed springs between every pair of nodes at their graph distance, runs gradient descent from a random start (500 iterations by default), then a short damped pass. In 3D it also projects paired nodes along the local surface normal to give the fabric a front and back.

Consequences for this app:

- The cost is O(n²) per iteration, because every pair of nodes interacts. Patterns with thousands of stitches take seconds to minutes in the browser. The app must show progress and must not freeze the UI.
- There is no convergence test and no collision handling. Yarn can pass through yarn.
- A 3D model can come out inside-out. The documented fix is a different seed (`DOT: start=…`), so the app should offer "flip" as a one-click re-run with a new seed.
- Target lengths are met to roughly 10%. Deviations of about 15% are flagged as tight or loose stitches. The tension view is useful to designers, and the app should keep it.

### 4.5 Rendering today

CrochetPARADE draws **spheres at nodes and cylinders along edges**, with yarn thickness and colour adjustable. This shows the structure exactly, but it looks like a molecule model, not crochet. Closing that gap is the main thing this app adds on top of CrochetPARADE (§6.5).

### 4.6 CrochetPARADE already has a translator

`deterministic_translator.js` and `translator_ui.js` (with a Python back end run in Pyodide) are a **rule-based** English-to-CrochetPARADE translator. It splits the English into rows, strips prose, reads stated stitch counts such as `(12)`, generates candidate translations per row, and **checks each candidate with `processText`**. The user picks candidates in a review table, row by row. It works best on "modern toy phrasing" (`Rep from * around`, simple increases).

This matters for the app in two ways:

- The review model (per-row candidates, a validator in the loop, stated counts as a check) is proven. The app should copy the shape of it, with the LLM as a better candidate generator for phrasing the rules miss.
- The rule-based translator is a free baseline. The LLM path has to beat it on the evaluation set (§9), or it is not worth its cost.

### 4.7 Prior work on LLM translation

- Dias and Karim, [*Translation of User Crochet Patterns to CrochetPARADE Syntax Using Large Language Models*](https://ojs.aaai.org/index.php/AAAI-SS/article/view/36054), AAAI Symposium Series 6(1), 2025. Local copy: [05499-SuSS.DiasR.pdf](./05499-SuSS.DiasR.pdf); full summary in [RELATED_WORK.md](./RELATED_WORK.md) §2.1. The dataset ([StitchSwitch](https://github.com/rachaelteresa/StitchSwitch)) has 109 English patterns paired with hand-made CrochetPARADE translations. Each pattern is tagged by the features it uses: base stitches and repeats, labels, attachment points, and early repeat endings. Only small open models (3B–8B) were tested. Findings that shape this app:
  - With no examples, no model produced valid code. The models invented syntax and stitch names. **A grammar reference and worked examples in the prompt are required** (FR-2.2).
  - Fine-tuned DeepSeek-R1-Distill-Llama-8B scored best: 74% structure match ("accuracy") and 82.5% parse rate ("correctness"). The abstract calls 74% "syntactic accuracy", but the tables show it is the structure-match figure.
  - **Labels and attachment points are the hard part.** Few-shot, every model scored 0% on patterns using labels. Fine-tuned, patterns using both labels and attachment points scored only 14–43%. The most common parser error was "Label not Found": a label referenced before it was defined. This is why FR-2.3 and the repair loop (FR-2.5) focus on attachment.
  - Parsing is not enough. A single swapped stitch (sc for tr) still parses but turns a cone into a disc. This supports structure match as the headline metric (§9).
  - Structure match was checked **by hand**, by hovering over stitches in CrochetPARADE. This app has to automate that comparison (§9).
  - **The 109 patterns are the first candidate for this app's evaluation set** (§9).
- Li, Huang and Chawla, [*CrochetBench*](https://arxiv.org/abs/2511.09483v1), 2025. Local copy: [crochetbench.pdf](./crochetbench.pdf); summary in [RELATED_WORK.md](./RELATED_WORK.md) §2.2. Uses CrochetPARADE as an executable target. Model scores drop sharply when the measure changes from text similarity to "does it compile and produce the right structure". The authors blame weak long-range symbolic reasoning. The lesson for this app: measure by parsing and counting, not by string match, and put a validator in the loop.
- Greer and Mould, *Modeling crochet patterns with a force-directed graph layout* (Eurographics digital library, 2025). An independent force-directed approach to the same layout problem. Worth reading before changing the solver.

## 5. System overview

```text
┌──────────────┐   ┌─────────────────────────────────────────┐   ┌────────────┐   ┌──────────────────┐
│ English      │──▶│ Translate                               │──▶│ Layout     │──▶│ Yarn renderer    │
│ pattern      │   │  1 segment into rows, read stated counts│   │ (CP solver │   │ stitch templates │
│              │   │  2 LLM: row → CP line (+ confidence,    │   │  in a Web  │   │ swept into tubes │
│              │   │    questions)                           │   │  Worker)   │   │                  │
│              │   │  3 validate with CP parser + counts     │   │            │   │                  │
│              │   │  4 repair loop (errors back to LLM)     │   │            │   │                  │
│              │   │  5 user review: answer questions, edit  │   │            │   │                  │
└──────────────┘   └─────────────────────────────────────────┘   └────────────┘   └──────────────────┘
                                   │ CrochetPARADE text (the contract; editable, exportable)
```

## 6. Functional requirements

### 6.1 Pattern input

- **FR-1.1** Accept pasted plain text in US crochet terms.
- **FR-1.2** Detect UK terms (for example "double crochet" used alongside "treble" with no "single crochet"). Ask the user to confirm, and convert UK to US before translation. Never guess silently.
- **FR-1.3** Keep non-instruction text (materials, gauge, notes, section headers such as "Head", "Arms (make 2)") and show it next to the rows. Section headers become `#` comments. "Make 2" becomes separate objects (`start_anew`), or one object plus a note; see §11.
- **FR-1.4** Read stated counts at the end of a row in any common form: `(12)`, `[12 sts]`, `— 12 sc`, `12 stitches total`.
- **FR-1.5** Include a sample library of patterns that translate cleanly, covering: a flat row swatch, a granny square, an amigurumi ball, a hat.

### 6.2 LLM translation

- **FR-2.1** Translate **row by row, with context**. Each request contains the full pattern for context, the rows translated so far (as CrochetPARADE), and the target row. The response is structured:
  ```json
  { "row": 3, "cp": "6*[sc,sc2inc]", "count": 18, "confidence": "high",
    "assumptions": ["'inc' read as 2 sc in the same stitch"],
    "question": null }
  ```
  Row by row keeps errors local and lets the review UI line rows up (FR-3.1). A whole-pattern mode can be tried as an alternative in evaluation (§9).
- **FR-2.2** The system prompt contains a **grammar reference written for this app**: the subset in §4.2, the built-in stitch list, and a table of English idioms mapped to CrochetPARADE constructs. It also contains a small set of worked examples: rows, rounds with a join, chain spaces, and "in the same stitch". The reference is written from the grammar, not copied from the CrochetPARADE manual. The manual is CC BY-NC-SA, which restricts commercial reuse; see §7.2.
- **FR-2.3** The idiom table covers at least:

  | English | CrochetPARADE approach |
  | --- | --- |
  | "in a magic ring" / "MR" | `ring` then stitches |
  | "inc" / "2 sc in next st" | `sc2inc` |
  | "dec" / "invdec" / "sc2tog" | `sc2tog` (invisible decrease rendered as `sc2tog`, noted as an assumption) |
  | "sl st to first st to join" | `ss@[%,0]` or the equivalent |
  | "ch 3 (counts as dc)" | a chain group standing in for a stitch, recorded as an assumption |
  | "ch 1, turn" | `ch,turn` placement per CrochetPARADE rules |
  | "in the next ch-3 sp" | label the chain group when made (`3ch.A[k]`), then attach with `@A[k]` |
  | "in the same st" | `@[@]` |
  | "skip next 2 sts" | `2sk` |
  | "BLO" / "FLO" | `…bl` / `…fl` stitch variants |
  | "FPdc" / "BPdc" | `fpdc` / `bpdc` |
  | "*…; rep from * N times" / "around" | `N*[…]`; "around" resolved from the previous row's count |
  | colour changes ("change to B") | `COLOR:` line, with the colour name the user picked for B |

- **FR-2.4** **Validate every row** before accepting it. Run the CrochetPARADE parser (`processText`) on the prefix up to and including that row, and compare the parser's stitch count for the row with the stated count (FR-1.4), when one is stated.
- **FR-2.5** **Repair loop.** On a parse error or count mismatch, send the parser's error message (or "expected 18, got 17") back to the LLM and ask for a fix. Stop after 3 attempts per row. Then mark the row as failed, keep the best attempt, and ask the user.
- **FR-2.6** **Ask, do not invent.** When the English is ambiguous (for example "work evenly around", "dec 6 times evenly", or a missing count), the LLM returns a `question` with 2 to 4 concrete options. When an option can be written as code, it carries the code. The user's answer is added to the context for the rest of the pattern.
- **FR-2.7** The user chooses the **provider and model** and supplies their own API key (§6.7). The MVP providers are Anthropic (Claude), OpenRouter, Google Gemini and OpenAI; OpenRouter covers other model makers with one key. Models the evaluation has scored are recommended first, with their score and cost; others can be chosen with a warning that they are not evaluated. The default is a current Claude model until the evaluation shows a better choice. The server makes the calls, so the browser never talks to a provider directly. A later option is a self-hosted fine-tuned small model, following Dias and Karim (§4.7).
- **FR-2.8** Cache translations by (pattern text hash, row, prompt version, provider, model). Re-rendering or editing one row must not re-translate the whole pattern.
- **FR-2.9** Run the rule-based CrochetPARADE translator (§4.6) as well, when it produces a valid candidate. If it agrees with the LLM, raise confidence. If it disagrees, show both.

### 6.3 Review and editing

- **FR-3.1** Show three columns side by side: English row, CrochetPARADE line, status (valid, count match, confidence, open question).
- **FR-3.2** Clicking a row highlights its stitches in the model. Clicking a stitch in the model highlights its row. CrochetPARADE's hover information (row, position, stitch type) is the data source.
- **FR-3.3** The CrochetPARADE text is editable, with syntax highlighting and inline parser errors. Manual edits are kept, and a later re-translation of other rows must not overwrite them.
- **FR-3.4** Show every assumption the LLM made as a note on its row. The user can dismiss a note or reject it, which re-translates that row.
- **FR-3.5** Show a summary before rendering: rows translated, rows with open questions, rows that failed. Rendering with failed rows is allowed. Failed rows are left out, and the render says so.

### 6.4 Layout

- **FR-4.1** Use the CrochetPARADE solver, run in a Web Worker so the UI stays responsive. Show progress by iteration, and support cancel.
- **FR-4.2** Offer 2D or 3D. Choose automatically from the pattern (rounds that close with increases and decreases → 3D; rows or flat motifs → 2D), and let the user change the choice.
- **FR-4.3** Expose a small set of settings: quality (iterations), seed, and "flip inside-out" (a re-run with a new seed). Other `DOT:` settings are available only by editing the code.
- **FR-4.4** When only the last rows changed, use incremental layout: keep the existing positions and place only the new stitches, as CrochetPARADE's `Ctrl+Enter` does. Offer a full recompute.
- **FR-4.5** Keep the tension view: colour stitches that are more than about 15% longer or shorter than their target.

### 6.5 Realistic stitch rendering

This is the part CrochetPARADE does not provide. The layout gives positions for the nodes of each stitch subgraph. The renderer turns them into yarn.

- **FR-5.1 Stitch templates.** Each built-in stitch type has a yarn-path template: a 3D polyline, in a local frame, of the path the yarn follows through the stitch. That is the front and back of the top loop, the post, yarn-overs wrapped around the post for `hdc`, `dc` and `tr`, and the loop pulled through the stitch below. Templates start and end on the stitch's attachment and top nodes, so neighbouring stitches join into one continuous strand.
- **FR-5.2 Local frame.** Build each stitch's frame from its laid-out nodes: "up" runs from bottom node to top node, "along" runs from the previous stitch to the next, and "out" is the surface normal (their cross product, with the sign kept consistent across the fabric). Scale the template to the actual node distances, so a stretched stitch looks stretched.
- **FR-5.3 Continuous yarn.** Join the templates in working order into one curve per colour run. Smooth it (centripetal Catmull-Rom or similar) and sweep it into a tube mesh whose radius is the yarn thickness.
- **FR-5.4 Yarn surface.** Twist the ply along the tube with a normal map or a procedural shader. Add slight fuzz (for example a shell or fibre texture) that the user can turn off. Keep the colour from `COLOR:`.
- **FR-5.5 Interpenetration.** Offset loops that sit in the same place (a front loop over a back loop, a post passing through the stitch below) along "out" by at least one yarn diameter. The solver has no collision handling. The renderer must hide the worst crossings, not fix the layout.
- **FR-5.6 Levels of detail.** Offer three modes, switchable at any time:
  1. **Structure**: CrochetPARADE's spheres and cylinders (always available, cheapest, exact);
  2. **Yarn**: tubes with templates (default);
  3. **Yarn + texture**: adds ply twist and fuzz.

  Structure mode switches on automatically above a stitch-count threshold, set during M3 by measurement.
- **FR-5.7 Unknown stitches.** Stitches with no template (user `DEF:` raw stitches, rare built-ins) fall back to tubes along their graph edges. They must still render, and they are listed as "simplified" in the stats.
- **FR-5.8** The MVP set of templates: `ch`, `ss`, `sc`, `hdc`, `dc`, `tr`, `sc2inc`, `sc2tog`, `dc2tog`, the `bl`/`fl` variants of these, `fpdc`, `bpdc`, `ring`. Bobbles, popcorns, puffs and picots come in the next phase.

### 6.6 Export

- **FR-6.1** CrochetPARADE text, with the English as `#` comments above each row.
- **FR-6.2** A GLTF file of the yarn render (Blender-compatible), as well as CrochetPARADE's structure GLTF.
- **FR-6.3** PNG snapshots of the current view.
- **FR-6.4** An "Open in CrochetPARADE" action: copy the text and open crochetparade.org, for the tools this app does not replicate (charts, periphery, STL, remesher).

### 6.7 API keys and accounts

- **FR-7.1** **No account is needed for any step**, including LLM translation. A user without an account enters an API key for the chosen provider; the app keeps it only for that browser tab and never stores it on the server.
- **FR-7.2** **Saving a key needs an account.** A signed-in user can save one key per provider and is not asked again. Saved keys are encrypted on the server, never shown again in full (only the last 4 characters) and never sent back to the browser.
- **FR-7.3** A key is checked with its provider when entered or saved. A key the provider rejects, now or later, is reported to the user with a prompt to replace it.
- **FR-7.4** A key is never saved without the user choosing to. Entering a key while signed out offers "sign in to save this key".
- **FR-7.5** A signed-in user can list and delete saved keys, and delete their account, which deletes every saved key at once.
- **FR-7.6** Keys never appear in logs, caches, error messages or exports.
- **FR-7.7** Sign-in is by email and password, with email verification before the first key is saved and password reset by email. Settings (default provider, model, effort) are saved to the account when signed in, and kept in the browser otherwise.

## 7. Integration with CrochetPARADE

### 7.1 Options

| Option | How | For | Against |
| --- | --- | --- | --- |
| **A. Embed** | Vendor the parser (`parse64.js`), the solver (`graph64.wasm`) and the stitch dictionary. Call them from the app. | Exact behaviour, including every stitch and every attachment rule, with no reimplementation. Validation in the LLM loop is identical to what users see in CrochetPARADE. | GPLv3: the app's code has to be GPLv3 too. The parser is a large script written for a single page with globals (`processText`, `alert`), so it must be wrapped and its UI calls intercepted, as `translator_ui.js` already does with `withAlertSuppressed`. |
| **B. Reimplement** | Write the parser and solver from the grammar, which is in the public domain, and from the solver description in [ply-split-braiding `docs/elastic`](../../ply-split-braiding/docs/elastic/README.md). | Free choice of licence. Typed code that is easy to test and to extend with the extra data the renderer needs (loop orientation). | Large effort. Parsing edge cases will diverge, so code that validates here may fail in CrochetPARADE, and the other way round. |
| **C. Hybrid** | A for the MVP. Later, B for the parser only, with a conformance test suite that runs both on the same corpus. | Fast start, and a path off GPL if needed. | Two parsers during the transition. |

**Recommendation: A for the MVP.** The app is useless if its code does not open in CrochetPARADE, and embedding is the only way to guarantee that. Revisit if a non-GPL licence becomes a requirement.

### 7.2 Licences

- CrochetPARADE code: **GPLv3**. Embedding it (option A) makes the app GPLv3.
- CrochetPARADE manual: **CC BY-NC-SA 4.0**. Do not paste it into prompts or the app's help. Write our own grammar reference (FR-2.2).
- The grammar itself is stated to be in the public domain, and showcase patterns are public domain. Both are usable as few-shot examples and test data.
- Dias and Karim dataset: check its licence before using it (§11).

## 8. Non-functional requirements

- **NFR-1 Latency.** A 20-row amigurumi pattern: translation finishes within 30 s with no repairs, and the first 3D layout within 10 s on a 2022-era laptop. Translated rows appear as they finish; the user does not wait for the whole pattern.
- **NFR-2 Scale.** Handles 3,000 stitches in yarn mode at 30 fps or better. Above that, falls back to structure mode (FR-5.6).
- **NFR-3 Privacy.** Pattern text is sent to the LLM provider the user chose (through OpenRouter, also to the host of the chosen model), and the app names the provider before the first translation with it. Layout and rendering stay local. No pattern is stored on a server without the user choosing to save it; the translation cache can be turned off. API keys follow FR-7.x.
- **NFR-4 Cost.** LLM cost falls on the user's own provider account, so the app shows an estimate before translating and the actual cost after. Log token use per translation. The target is under US$0.05 for a 20-row pattern with the default model; measure it in M1 and revise.
- **NFR-5 Reproducibility.** Same CrochetPARADE text + same seed + same settings → same layout. LLM output is cached (FR-2.8), so a shared pattern re-renders without calling the LLM again.
- **NFR-6 Platforms.** Current desktop Chrome, Safari and Firefox, with WebGL2. On tablets it must work, but may be slower.

## 9. Evaluation

Translation quality is measured, not judged by eye.

- **Corpus.** At least 50 patterns with hand-checked CrochetPARADE gold translations, split into flat rows, rounds (amigurumi), motifs with chain spaces (granny, doily) and textured work (post stitches, BLO). Sources: the Dias and Karim dataset (if its licence allows), CrochetPARADE showcase patterns, and public-domain patterns.
- **Metrics per pattern, from weakest to strongest:**
  1. **Parses**: the whole output is accepted by `processText`.
  2. **Count match**: the share of rows whose parser count equals the stated count.
  3. **Structure match**: the stitch graph equals the gold graph (same stitch types; same attachment for each stitch). This is the headline metric. It is computed automatically by comparing the parsed graphs. Dias and Karim did this comparison by hand, which does not scale to repeated runs. Text similarity is not reported, because CrochetBench shows it overstates quality. chrF may be logged, but only for comparison with Dias and Karim.
  4. **Questions asked**: the number of user questions per pattern. Fewer is better, but only if structure match holds.
- **Baselines.** The CrochetPARADE rule-based translator (§4.6), and the LLM with no validator loop. The full pipeline must beat both on structure match. Dias and Karim's published scores are a third reference point, per feature class. The best fine-tuned 8B model reached 74% structure match and 82.5% parse rate. Comparisons with their numbers are approximate: their scores come from 8 small test folds (about 14 patterns each), judged by hand.
- **Breakdown.** Report every metric per feature class (base, labels, attachment, early endings, labels + attachment), as Dias and Karim do. The overall score hides the hard classes.
- **Rendering.** A fixed set of reference photos (sc swatch, dc swatch, granny square, amigurumi ball), shown next to the yarn render. Five crocheters are asked "which stitch is this?" for each render. Target: 80% correct for sc, hdc, dc and ch.

## 10. Milestones

| Milestone | Scope | Exit check |
| --- | --- | --- |
| **M0 Spike** | Wrap `processText` and `graph64.wasm` in a Worker. Render CrochetPARADE's own showcase patterns as spheres and cylinders. | 5 showcase patterns render the same as on crochetparade.org. |
| **M1 Translate** | FR-2.x with the validator and repair loop; evaluation harness (§9) and corpus. | Structure match beats the rule-based baseline on the corpus. |
| **M2 Review UI** | FR-1.x, FR-3.x, FR-7.x; English ↔ code ↔ model highlighting; key entry, accounts and saved keys. | A new user, without an account, enters their own key, translates and renders a sample pattern with no help. |
| **M3 Yarn render** | FR-5.1 to FR-5.7 for the MVP stitch set; set the level-of-detail threshold. | Stitch-recognition test (§9) passes. |
| **M4 Polish** | Exports, incremental layout, samples, performance targets. | NFR-1 and NFR-2 met. |

## 11. Decisions to confirm

1. **Licence.** Is a GPLv3 app acceptable (option A), or must the app avoid GPL (option B, much more work)?
2. **Delivery.** A web app only, or also a desktop or mobile app? This spec assumes a web app.
3. ~~**LLM hosting.**~~ Settled (2026-10-01): bring your own key, for a choice of providers (FR-2.7). No account is needed; an account only saves keys (§6.7). The server calls the provider, so there is still a server, but no app-paid API budget.
4. **Dataset.** StitchSwitch (Dias and Karim, 109 gold pairs) has no licence, and CrochetBench data (no gold translations for the target rows) is CC BY-NC 4.0. Both are usable for private evaluation (SPEC.md §7.1). Do we ask the StitchSwitch authors for a licence, and who writes our own gold set for public or commercial use?
5. **"Make 2" and assembly.** Render duplicate parts as separate objects placed side by side, or leave assembly out of scope?
6. **Realism bar.** Is "a crocheter can name the stitch" (§9) the right bar, or is the goal closer to product-photo quality? A higher bar means a path tracer or offline render, which is outside this spec.
7. **UK terms.** Support them in the MVP (FR-1.2), or US only?

## 12. Acceptance criteria (MVP)

- [ ] Pasting each of the sample patterns produces CrochetPARADE text that parses, with every stated count matched.
- [ ] Every translated row shows its English source, status and assumptions. Clicking a row highlights its stitches in the model, and clicking a stitch highlights its row.
- [ ] An ambiguous line produces a question with concrete options, and choosing one updates that row and the rows after it.
- [ ] A row that still fails after 3 repairs is marked failed, the best attempt is kept, and the rest of the pattern still renders.
- [ ] Hand edits to the code survive re-translation of other rows.
- [ ] The amigurumi sample renders as a closed 3D shape. The granny square renders flat in 2D. "Flip inside-out" fixes an inverted 3D render.
- [ ] In yarn mode, sc, hdc, dc and ch are told apart correctly by at least 80% of test crocheters.
- [ ] Unknown stitches render as simplified tubes and are listed as such.
- [ ] Exported CrochetPARADE text renders the same shape on crochetparade.org.
- [ ] The user is told that pattern text goes to the LLM provider before the first translation.
- [ ] Without an account, a user can enter a key for each MVP provider, translate a sample pattern and render it.
- [ ] A signed-in user can save a key, translate in a later visit without entering it again, and delete it; the key is never shown in full after saving.
- [ ] A rejected or out-of-credit key gives a clear message naming the provider, not a translation failure.

## 13. Sources

- CrochetPARADE: [site](https://www.crochetparade.org/), [repository](https://github.com/stassev/CrochetPARADE) (`README.md`, `Manual.md`, `capabilities.md`, `index.html`, `translator_ui.js`, `deterministic_translator.js`, `graph.cpp`).
- Solver reading in the ply-split-braiding project: [ply-split-braiding `docs/elastic/README.md`](../../ply-split-braiding/docs/elastic/README.md) §2.
- Dias, R. and Karim, K. (2025). [Translation of User Crochet Patterns to CrochetPARADE Syntax Using Large Language Models](https://ojs.aaai.org/index.php/AAAI-SS/article/view/36054). *Proceedings of the AAAI Symposium Series* 6(1), 200–208. Local copy: [05499-SuSS.DiasR.pdf](./05499-SuSS.DiasR.pdf).
- Li, P., Huang, X. and Chawla, N. V. (2025). [CrochetBench: Can Vision-Language Models Move from Describing to Doing in Crochet Domain?](https://arxiv.org/abs/2511.09483v1). Local copy: [crochetbench.pdf](./crochetbench.pdf).
- Greer, É. and Mould, D. (2025). *Modeling crochet patterns with a force-directed graph layout*. Eurographics digital library (linked from the CrochetPARADE README).
