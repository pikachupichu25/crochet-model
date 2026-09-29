# Crochet Model App: Technical Specification

> Status: draft, not started  
> Last updated: 2026-09-29  
> Purpose: define how to build what [REQUIREMENTS.md](./REQUIREMENTS.md) asks for: modules, data types, the translation loop, the evaluation harness and the yarn renderer.

REQUIREMENTS.md says **what** the app must do and why. This document says **how**. Requirement IDs (FR-x.y, NFR-x) refer to REQUIREMENTS.md. Background on CrochetPARADE is in REQUIREMENTS.md §4, and on prior work in [RELATED_WORK.md](./RELATED_WORK.md).

## 0. Assumptions

This spec takes the defaults for the open decisions in REQUIREMENTS.md §11. Changing any of them changes the sections listed.

| Decision (REQUIREMENTS §11) | Assumed here | Affects |
| --- | --- | --- |
| 1. Licence | GPLv3; CrochetPARADE code is vendored (option A) | §3, §4 |
| 2. Delivery | Web app | §2 |
| 3. LLM hosting | Hosted Claude through the app's own server proxy | §5.6, §8 |
| 4. Dataset | StitchSwitch and CrochetBench for **private evaluation only** (§7.1) | §7 |
| 5. "Make 2" | Separate objects, placed side by side | §5.1 |
| 6. Realism bar | "A crocheter can name the stitch" | §6 |
| 7. UK terms | Detected and converted, with confirmation | §5.1 |

## 1. Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript everywhere (app, server, evaluation CLI) | One type system across the translation contract |
| App | Vite + React | Small, fast; no server rendering needed |
| 3D | three.js | CrochetPARADE uses it already; its GLTF exporter is reused |
| Heavy work | Web Workers (parser, layout, mesh building) | NFR-1: the UI must not freeze |
| Server | Node, one small HTTP service (Hono or Express) | Holds the API key; caches translations |
| LLM | Claude via `@anthropic-ai/sdk` | FR-2.7 |
| Schemas | Zod | Shared by the server, the structured-output schema and the evaluation harness |
| Tests | Vitest (units), Playwright (UI smoke tests) | — |

## 2. Repository layout

```text
crochet-model/
  REQUIREMENTS.md  SPEC.md  RELATED_WORK.md  CROCHET_CONVENTIONS.md  MATH.md
  vendor/crochetparade/        pinned copy of CrochetPARADE files (GPLv3); see §3
    COMMIT                     upstream commit hash
    parse64.js  graph64.js  graph64.wasm  …
  packages/
    core/                      pure TypeScript, runs in browser, worker and Node
      src/types.ts             shared types (§4)
      src/segment.ts           English → PatternRows (§5.1)
      src/cp/validator.ts      wraps processText (§3.2)
      src/cp/graph.ts          DOT text → StitchGraph (§3.3)
      src/cp/compare.ts        structure match (§7.3)
      src/stitchTemplates/     yarn-path templates (§6.2)
    translator/                LLM translation loop (§5); runs on the server
      src/prompt/grammar.md    our own grammar reference (FR-2.2)
      src/prompt/examples/     worked examples (§5.3)
      src/claude.ts            API calls (§5.6)
      src/loop.ts              translate → validate → repair (§5.5)
    server/                    HTTP proxy + translation cache (§8)
    app/                       React UI, workers, three.js renderer (§6, §9)
    eval/                      evaluation CLI and dataset loaders (§7)
      data/                    downloaded datasets; git-ignored (§7.1)
```

## 3. CrochetPARADE integration

### 3.1 Vendoring

- Copy the files needed from [stassev/CrochetPARADE](https://github.com/stassev/CrochetPARADE) into `vendor/crochetparade/` and record the upstream commit in `COMMIT`. At minimum: `parse64.js`, `graph64.js`, `graph64.wasm` and the dictionary of built-in stitches.
- The file names carry a version (`parse64.js`; CrochetBench's validator loads an older `parse57.js`). Upgrading is a deliberate change: bump the files, re-run the conformance suite (§10.2), and record the new commit.
- Do not edit vendored files. Adapt them in wrapper code only, so upgrades stay a file copy.

### 3.2 Validator

**Status: built (M0).** Code: `packages/core/src/cp/validator.ts` (runtime-agnostic), `nodeParser.ts` (Node host), `sourceLines.ts`; CLI `npm run validate`.

The parser is a browser script with globals. It needs only `alert` (for warnings) and `console`; it does not touch the DOM. The Node host:

1. compiles `parse64.js` once, and runs it in a **fresh `vm` context per call** (about 0.4 ms), so no `DEF:` stitch, label or counter can leak between patterns;
2. stubs `alert` and `console`, and reads the parser's `WARNINGS` global;
3. calls `processText(text, "")`, which returns `[graphJson, simpleDot]` or throws.

The browser host (`parserScope.ts`, used in `parser.worker.ts`) wraps the parser source in `new Function`, compiled once and called per parse, so each parse gets fresh top-level variables. It is not a full sandbox (an undeclared assignment would reach the worker's globals), which is acceptable in a worker that does nothing else. A test checks that it returns the same results as the Node host.

```ts
interface ValidationResult {
  ok: boolean;
  error?: ParseError;           // { kind, message, row?, line?, raw }
  rows: RowSummary[];           // { row, line?, stitches, byType } per CrochetPARADE row
  warnings: string[];
  graphJson?: string;           // parser output 1: {dimen, elements: [nodes, edges]}
  simpleDot?: string;           // parser output 2: stitch-level graph, DOT-like text
}

type ParseErrorKind =
  | "label_not_found"           // "Label not found: A" — the most common LLM error (Dias & Karim)
  | "stitch_not_defined"        // "Stitch type not defined in Dictionary…" — e.g. slst, tc
  | "position_not_found"        // "ID not found", "Stitch at that position not found"
  | "attach_into_future"        // "Cannot attach into the future…"
  | "turn_not_at_end"           // "Turning can happen only at the end of a row."
  | "syntax"                    // "Unbalanced brackets…" and similar
  | "other";
```

What M0 established about the parser (vendored commit `06e987b`):

- **Errors** carry the row in a `row/round: N` line (0-based CrochetPARADE rows). Messages can embed HTML and JSON dumps; `message` is cleaned to one line, and `raw` keeps the original. The parser often `warn()`s the same text it then throws; such duplicates are dropped from `warnings`.
- **Rows to lines.** The parser does not report source lines. `sourceLines.ts` rebuilds the mapping (skipping blank, `#` and directive lines, and `...` continuations) and gives up when brackets span lines or `\…\` comments are used. On success the mapping is used only if it agrees with the parser's row count.
- **Stitch counts** come from `graphJson`, not from the parser's `STATS` (which counts statements by type). Each top-level stitch node is named `row,index|statement` and its label starts with its type. Internal nodes have a letter suffix (`1,0C|4`) and are skipped. `stitches` counts top nodes except `ss`, `ring`, `tie` and `hidden`. A `sc2inc` adds two `sc`; a `sc2tog` adds one; a user `DEF:` stitch appears under its top-node type. `picot3` adds 3 `ch` and 1 `ss`, so a pattern that does not count picots will disagree: the translator must allow for this.
- **Over-long rows are not an error.** `5ch` then `9sc` parses. The stated-count check (§5.5) is the only thing that catches a row with too many stitches.
- **The parser is slow on large patterns.** Of the 60 bundled examples, `textDoily` takes 28 s and `textChevron` 3 s (their graph JSON is 5–7 MB); the rest take under 2 s. Typical LLM-sized patterns take a few milliseconds. Validating growing prefixes of a very large pattern would multiply this, so the repair loop validates the accepted prefix plus one row, not every prefix.
- **Conformance:** 59 of the 60 bundled examples parse. `textSwatch1` fails upstream too: it uses `cl3`, which is not in the built-in Dictionary.
- **StitchSwitch gold:** all 109 reference translations parse with the vendored parser.

`kind` is derived from the message text. The repair prompt (§5.5) gives targeted advice for each kind.

### 3.3 Stitch graph

`graphJson` (and, where simpler, `simpleDot`) is parsed into a typed graph. Nodes carry `name` (`row,index|statement`, with letter-suffixed internal nodes), `label` (`type|context|colour`) and `attachmentLabel` (labels defined on the stitch). Edges carry `tail`, `head`, `len` (rest length) and `color`: blue for the yarn running from stitch to stitch, red for the attachment to the stitch worked into. It feeds the structure comparison (§7.3), the review UI's row ↔ stitch links (FR-3.2) and the renderer (§6).

```ts
interface StitchGraph {
  stitches: Stitch[];           // in working order
  edges: GraphEdge[];           // from the full DOT: node pairs with rest lengths
  nodes: GraphNode[];           // top nodes, bottom nodes, hidden nodes
}

interface Stitch {
  id: string;                   // CrochetPARADE's node id, e.g. "3,12"
  row: number;                  // 0-based, as CrochetPARADE counts
  index: number;                // position within its row
  type: string;                 // "sc", "dc2tog", "ch", or a DEF: name
  workedInto: string[];         // ids of the stitches it attaches to
  nodeIds: string[];            // its nodes in the full graph
  color?: string;
}
```

**Remaining spike (M0):** confirm the node and edge format against `export_to_dot` in `parse64.js` (the notes above come from probing outputs, not from reading that function), including how multi-top stitches, loop-only and post stitches, and `start_anew` objects appear.

### 3.4 Layout

**Status: built (M0).** Code: `packages/core/src/cp/layout.ts` (runtime-agnostic), `nodeSolver.ts` (Node loader); `packages/app/src/workers/` (parser and layout workers, promise clients). The solver itself is described in the ply-split-braiding [`docs/elastic/README.md`](../ply-split-braiding/docs/elastic/README.md) §2.

What M0 established:

- **Input is `simpleDot`.** Its first line is the dimension, set by the parser's `DIM` global (so `validate(text, { dimension })` must be called with the dimension wanted). Then come nodes (`"name"`, or `"name" {x,y,z}` to fix a position), edges (`"a" -- "b" restLength`), 3D orientation quadruples (`"a"---"b"---"c"---"d"---h`), and the pattern's `DOT:` settings as bare lines. The solver reads settings from any non-node, non-edge line, and a later line wins, so the app's overrides (`start=…` seed, `iterations=…`) are appended at the end.
- **Output** is one `{"name": "…","pos": "x,y[,z]"},` line per node, including internal nodes. It is deterministic for a given input and seed.
- **Loading.** `graph64.js` reads settings from a pre-existing global `Module` (`print`, `wasmBinary`, `onRuntimeInitialized`). Its own `var Module` would hide a global under `require()`, so Node runs it in a `vm` context and the Worker runs it through `new Function("Module", source)`. The Emscripten build does not export `lengthBytesUTF8`; `TextEncoder` gives the byte length.
- **Progress** comes from the solver's stdout: one `Iteration = N Error = E` line per step, and `Failed to converge. Learning rate reduced to: …` when it restarts (the attempt number goes up and the iteration count starts again). The Worker forwards these at most every 50 ms; they arrive on the main thread while the synchronous solve is still running.
- **Cancel** terminates the Worker; the next layout starts a fresh one. `performLayout` cannot be interrupted from inside.
- **Speed:** a 271-node amigurumi ball takes about 130–190 ms in the browser at 500 iterations; a 155-node flat swatch about 40 ms. On the test ball the mean edge length is within 10% of its rest length, matching the manual's claim.
- The result buffer returned by `performLayout` is never freed (upstream does not free it either). A long session leaks a little WASM memory per layout; if that matters, recycle the Worker every N layouts.

## 4. Core types

These are the contract between the modules. They live in `packages/core/src/types.ts`.

```ts
/** One instruction line of the English pattern. */
interface PatternRow {
  id: string;                   // stable: hash of section + text + position
  section?: string;             // "Head", "Arms (make 2)"
  label: string;                // "Rnd 3", "Row 12"
  text: string;                 // the instruction, with the label removed
  statedCount?: number;         // "(18)", "[18 sts]", "— 18 sc"
  makeCount?: number;           // "make 2"
}

/** The translation of one English row. */
interface RowTranslation {
  rowId: string;
  cp: string;                   // one or more CrochetPARADE lines
  source: "llm" | "rules" | "user";
  status: "valid" | "count_mismatch" | "invalid" | "needs_answer";
  confidence: "high" | "medium" | "low";
  assumptions: string[];
  question?: Question;
  attempts: Attempt[];          // for the debug view and the evaluation logs
}

interface Question {
  text: string;
  options: { label: string; cp?: string }[];   // 2–4 options
  answer?: number;              // index chosen by the user
}

interface Attempt {
  cp: string;
  validation: ValidationResult;
  model: string;                // e.g. "claude-opus-5-5"
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

/** A whole translated pattern: the thing saved, cached and exported. */
interface TranslatedPattern {
  english: string;
  rows: PatternRow[];
  translations: Record<string, RowTranslation>;
  answers: Record<string, number>;           // question answers, by row id
  colors: Record<string, string>;            // "A" → "navy"
  promptVersion: string;                     // §5.7
}
```

The CrochetPARADE text is assembled from `translations` in row order. `#` comments carry the English and the section headers (FR-6.1). User-edited rows (`source: "user"`) are never overwritten by re-translation (FR-3.3).

## 5. Translation

### 5.1 Segmentation (no LLM)

`segment.ts` splits the English into `PatternRow`s with rules, not an LLM, so that row ids are stable and cheap to compute:

- A row starts at a label (`Rnd 3:`, `Row 12`, `R1`, `Round 1-3`). A label range such as `Rnds 4–7` becomes one row with a repeat count, and translates to one line per round.
- Wrapped lines are joined. Prose (materials, gauge, notes) is kept as notes, not rows.
- Stated counts are read with a small set of patterns (FR-1.4). An unreadable count leaves `statedCount` undefined; it is not guessed.
- UK terms are detected by vocabulary (for example `treble` and `double crochet` with no `single crochet`). The UI asks before converting (FR-1.2). The mapping table lives in [CROCHET_CONVENTIONS.md](./CROCHET_CONVENTIONS.md).

CrochetPARADE's `deterministic_translator.js` already does similar splitting (`segmentEnglishPattern`, `parseDeclaredCount`). Compare the two on the evaluation set; keep ours only if it is at least as good.

### 5.2 One request per row

Each row is one Messages API request. The translator walks the rows in order, because each row's CrochetPARADE depends on the rows before it (labels, stitch counts, turning).

Request layout, ordered so the stable parts are cached (§5.6):

| Block | Content | Changes | Cached |
| --- | --- | --- | --- |
| system 1 | Role, output rules, the grammar reference `grammar.md`, the idiom table (FR-2.3), worked examples | Only with the prompt version | yes (breakpoint 1) |
| user 1 | The whole English pattern, with row ids; user answers given so far; colour names | Once per pattern (answers append at the end) | yes (breakpoint 2) |
| user 2 | The CrochetPARADE of the rows already accepted; the target row id; its stated count; the previous row's parsed count | Every row | no |

The model sees the whole pattern, so it can read ahead ("the ch-3 spaces made in round 2 are used in round 4"). It only writes the target row.

**Labels made for later rows.** A later row may need a label on an earlier row (English: "work into the ch-3 spaces of Rnd 2"; CrochetPARADE: `3ch.A[k++]` in Rnd 2). The response may therefore include `amendPrevious`: replacements for earlier rows that only add labels. The loop re-validates the amended prefix. An amendment that changes anything other than label syntax is rejected. This targets the most common failure in Dias and Karim ("Label not Found").

### 5.3 Prompt content

- **`grammar.md`** is written by us from the grammar, not copied from the CrochetPARADE manual, which is CC BY-NC-SA (REQUIREMENTS §7.2). It covers the language subset in REQUIREMENTS §4.2, the built-in stitch list from the vendored dictionary (generated, so it cannot drift), and the three known parser errors with their usual causes.
- **Worked examples** come from CrochetPARADE's built-in example patterns (about 60 `text…` variables in `parse64.js`, described as public domain) and from patterns we write ourselves. **Never from the evaluation datasets** (§7.1). Each example is an English row, the target CrochetPARADE, and one sentence on why.
- The prompt asks the model to prefer asking over guessing, and gives the question format.

### 5.4 Output schema

Structured outputs (`output_config.format` with a Zod schema, parsed by `client.messages.parse`) guarantee a parseable response:

```ts
const RowResponse = z.object({
  cp: z.string(),                       // CrochetPARADE for the target row only
  expectedCount: z.number().int().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  assumptions: z.array(z.string()),
  question: z.object({
    text: z.string(),
    options: z.array(z.object({ label: z.string(), cp: z.string().nullable() })),
  }).nullable(),
  amendPrevious: z.array(z.object({ rowId: z.string(), cp: z.string() })),
});
```

If `question` is set, `cp` is the model's best guess. It is validated and shown, but the row stays `needs_answer` until the user picks an option (FR-2.6).

### 5.5 Validate and repair

```text
for each row, in order:
  response ← ask(row)
  repeat up to 3 times:
    result ← validate(accepted prefix + response.amendPrevious + response.cp)
    if result.ok and (no stated count or last row count = stated count): accept; break
    response ← ask(row, conversation so far + repair message)
  if not accepted: mark invalid, keep the best attempt, continue with the next row
```

- **The repair message** quotes the parser error, names the row, and gives the advice for its `ParseErrorKind`. For example, `label_not_found`: "Label `A` is used here but not defined earlier. Define it where the English first makes the stitch or space, using `amendPrevious`." For a count mismatch: "Stated count 18, parsed count 17."
- **Best attempt** ranking: parses with the right count > parses with the wrong count > does not parse; ties go to the smaller count error.
- **The repair conversation is append-only.** Each repair adds the model's previous response and a new user message; earlier turns are never edited or removed. Current Claude models bind their thinking to the exact conversation, and editing history breaks that.
- **After an invalid row,** the next rows are still translated, against the prefix without the failed row. Their counts will usually be off, so they are flagged, not repaired, until the user fixes the failed row.
- **Rule-based candidate (FR-2.9).** When CrochetPARADE's own translator yields a valid candidate for the row, compare it with the LLM's. The same stitch graph raises confidence to `high`; a different graph shows both candidates to the user.

### 5.6 Claude API usage

- **Model:** `claude-opus-5-5` by default, configurable per deployment and per evaluation run. The evaluation (§7) decides whether a cheaper model (`claude-sonnet-5-5`, `claude-haiku-4-5`) is good enough; do not switch without that evidence.
- **Thinking and effort:** adaptive thinking is always on for Opus 5.5 and cannot be disabled. Set `output_config.effort` explicitly: the Opus 5.5 default is `medium`. Start at `medium` for translation and `high` for repair attempts, then tune with the evaluation.
- **Caching:** `cache_control: {type: "ephemeral"}` on system block 1 and user block 1 (§5.2). Log `usage.cache_read_input_tokens`; if it stays at zero across the rows of one pattern, something in the cached prefix is changing (a timestamp or unsorted JSON, for example).
- **Refusals:** check `stop_reason` before reading content. The live app sends `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta. Crochet text should rarely trigger a refusal; this is a guard, not a feature. The Batches API rejects `fallbacks`, so evaluation runs omit it and count refusals as failures.
- **Errors:** retry 429, 5xx and connection errors with the SDK's built-in retries. Surface 400s as bugs, not as translation failures.
- **Token logging:** every `Attempt` records usage. NFR-4 (cost per pattern) is measured from these logs.

### 5.7 Prompt versions

`promptVersion` is a hash of `grammar.md`, the examples, the system text, the schema and the model settings. It is part of the translation cache key (FR-2.8) and of every evaluation result. Changing the prompt invalidates the cache.

## 6. Yarn renderer

### 6.1 Pipeline

```text
StitchGraph + positions
  → per-stitch frame (up, along, out)                            §6.3
  → template yarn path, scaled into the frame                    §6.2
  → one continuous path per colour run, in working order
  → smoothed curve (centripetal Catmull-Rom), sampled by arc length
  → tube mesh (radius = yarn thickness), with a ply-twist normal map
```

Mesh building runs in a Worker and returns typed arrays. Rebuilding for colour or thickness changes does not re-run the layout.

### 6.2 Stitch templates

A template is a list of control points in a unit stitch frame. The origin is the bottom attachment point; y runs from bottom to top; x runs along the row; z points out of the fabric's front. Named anchor points join neighbouring stitches:

```ts
interface StitchTemplate {
  type: string;                        // "sc", "dc", …
  height: number;                      // nominal, in stitch units
  path: Vec3[];                        // the yarn through this stitch, in working order
  anchors: {
    in: number;                        // index where the yarn arrives from the previous stitch
    out: number;                       // index where it leaves for the next
    topFront: number;                  // front leg of the top loop: where later stitches work (front loop only)
    topBack: number;                   // back leg of the top loop (back loop only)
  };
}
```

- MVP templates, per FR-5.8: `ch`, `ss`, `sc`, `hdc`, `dc`, `tr`, `sc2inc`, `sc2tog`, `dc2tog`, the `bl`/`fl` variants, `fpdc`, `bpdc`, `ring`.
- Increases are composed from the base template: two posts into one bottom point. Decreases share one top loop between two posts.
- Templates are authored by hand against reference photos. `packages/app/dev/templates.html` shows a single stitch and a 5×5 swatch of it, with the photo alongside.
- Stitches with no template use tubes along their graph edges (FR-5.7).

### 6.3 Frames

For stitch *s* with laid-out nodes:

- **up** = top node − bottom node, normalised;
- **along** = next stitch's top − previous stitch's top, made orthogonal to up;
- **out** = up × along, with its sign made consistent across the fabric by propagating from the first stitch through neighbours, flipping any that disagree with the majority of its neighbours.

The template is scaled on each axis so its anchors meet the actual node positions: a stretched stitch looks stretched.

### 6.4 Overlaps

The solver does not prevent overlaps. The renderer offsets loops that share a place along **out**: the front loop over the back loop, and a post stitch around the stitch it wraps, by one yarn diameter. It does not attempt collision resolution.

### 6.5 Levels of detail

As FR-5.6: structure (spheres and cylinders), yarn (tubes), yarn + texture. Above a stitch threshold, set during M3 by measurement, the default drops to structure mode. Tube segments per stitch and radial segments per ring both fall with distance from the camera.

## 7. Evaluation harness

The evaluation answers two questions: is the pipeline good enough to ship, and which model and settings to use. It also lets newer models be tested on the same data as soon as they are released.

### 7.1 Datasets

| Dataset | What it holds | Gold CrochetPARADE? | Licence | Use |
| --- | --- | --- | --- | --- |
| [StitchSwitch](https://github.com/rachaelteresa/StitchSwitch) (Dias & Karim) | `StitchSwitchDataset.csv`: 109 rows of `Original Pattern`, `crochetPARADE Pattern`, `Name`, `Variation` | **Yes**, hand-made | **None stated** | Main structure-match benchmark |
| [CrochetBench](https://github.com/Peiyu-Georgia-Li/crochetBench) Task D-step | `data/step_level_test_{1_2,3_4,5_6}.json`: 123 prompts (the README says 119), each giving the English and CrochetPARADE of the previous steps and the English of the next step | Only for the *previous* steps, not for the target | Data CC BY-NC 4.0 | Parse rate on long, real patterns |
| CrochetBench Task D-proj | `data/project_level_test.json`: 100 full patterns (Yarnspirations) with a photo link | No | Data CC BY-NC 4.0 | Parse rate and count match on whole patterns |
| CrochetPARADE examples | about 60 patterns in `parse64.js` | Yes (they are the code), but no English | GPLv3 code; patterns stated public domain | Parser conformance (§10.2); prompt examples |
| Our own set | Patterns we write, English + gold | Yes | Ours | Held-out test set and regression suite |

Rules that follow from the licences:

- **StitchSwitch has no licence.** By default, all rights are reserved. Use it locally for evaluation. Do not commit it to this repository, do not ship it in the app, and do not use its patterns as prompt examples. Ask the authors for a licence before any public or commercial use.
- **CrochetBench data is non-commercial (CC BY-NC 4.0).** It is fine for research evaluation. It must not be shipped in, or used to train or prompt, a commercial product.
- Both datasets are downloaded by `eval fetch` into `eval/data/`, which is git-ignored, pinned to a commit hash recorded in `eval/data/SOURCES.json`.

Observed details that the loaders must handle:

- StitchSwitch's `Variation` column uses `A`, `X`, `Y`, `XY` and `YA`, with 51 rows blank. The paper's classes are B, L, A and P. The mapping is not documented. From the rows, `Y` appears on patterns using labels such as `ring.R` and `X` probably marks early repeat endings, but **confirm with the authors** before reporting per-class results. Blank means base only.
- StitchSwitch patterns write one English line per row in the form `Row N:` or `RN:`, and the CrochetPARADE has one line per row. Rows can be aligned by line.
- CrochetBench prompts embed their prefix as `NL:` / `DSL:` pairs followed by the target `NL:`. The loader parses these into rows, so the same translator code runs on them.
- The two datasets use different CrochetPARADE parser versions (CrochetBench validated with `parse57.js`; we vendor `parse64.js`). Re-validate every gold translation with our vendored parser, and report any that fail rather than silently dropping them.

### 7.2 Runs

```text
eval run --dataset stitchswitch --model claude-opus-5-5 --effort medium \
         --mode row|whole [--no-repair] [--no-rules] [--limit N] [--batch]
eval report runs/<run-id>
eval compare runs/<a> runs/<b>
```

- **Modes:** `row` is the app's loop (§5.5). `whole` translates the whole pattern in one request, as the paper did, so our numbers can be compared with theirs.
- **Ablations:** `--no-repair` (one attempt only) and `--no-rules` (no rule-based candidate) show what each part adds.
- **Batch runs:** `--batch` sends first attempts through the Message Batches API at half price. Repairs depend on earlier results, so each repair round is a further batch; the run records how many rounds it took. Results come back in any order and are matched by `custom_id` (`<dataset>:<patternId>:<rowId>:<attempt>`).
- **Reproducibility:** a run directory stores the config, the prompt version, the vendored CrochetPARADE commit, the dataset commit, every request and response, and the token usage. `eval report` works from the directory alone.
- **Models:** any model in the Models API can be named with `--model`. Adding a new Claude model needs no code change. Other providers can be added later behind the same `translateRow` interface, but are out of scope here.
- **Cost guard:** a run first estimates its cost from token counts and asks for confirmation above a threshold (default US$5).

### 7.3 Metrics

Per pattern, then per class and overall:

1. **Parses:** `validate(output).ok`.
2. **Count match:** the fraction of rows whose parsed count equals the stated count (English) or the gold count (gold CrochetPARADE).
3. **Structure match:** the output's `StitchGraph` is isomorphic to the gold graph. Compare row by row: stitch types in order, and for each stitch the (row, index) positions it is worked into. Label names, bracket style and repeat grouping do not matter, because they vanish in the graph. Report both the exact match rate and a partial score: the fraction of stitches that match.
4. **Questions:** the number of rows that asked the user. The evaluation answers automatically with the option whose `cp` gives the gold graph, if any, and counts it; a question with no correct option counts as a failure.
5. **Cost and time:** tokens, dollars and wall-clock per pattern.
6. **chrF** against gold, for comparison with Dias & Karim only.

Datasets with no gold (CrochetBench) report metrics 1, 2 and 5.

### 7.4 Baselines

- **CrochetPARADE rule-based translator** (`deterministic_translator.js`), run headless on each dataset.
- **Dias & Karim published numbers** (RELATED_WORK.md §2.1): 74% accuracy and 82.5% correctness for their best fine-tuned 8B model. Their accuracy was judged by hand over 8 folds, so the comparison is approximate.
- **Our previous run**, via `eval compare`, to catch regressions when prompts change.

## 8. Server

| Endpoint | Purpose |
| --- | --- |
| `POST /api/translate` | Body: `{ english, answers, colors, edits }`. Streams one `RowTranslation` per row as server-sent events, as rows finish (NFR-1). |
| `POST /api/translate/row` | Re-translates one row: after an answer, a rejected assumption, or a fix to an earlier row. |
| `GET /api/health` | Model name, prompt version, vendored CrochetPARADE commit. |

- The server runs the same `packages/translator` loop as the evaluation, including validation, in a Node `vm` context (§3.2). The browser re-validates for display, but the server's result is the one recorded.
- **Cache:** key = hash(English, answers, colours, row id, prompt version, model). Stored in SQLite. A shared or reloaded pattern is served from the cache without calling the model (NFR-5).
- **Privacy (NFR-3):** pattern text is sent to Anthropic for translation. It is not logged on our server except in the cache, and the cache can be turned off. The first translation asks the user to confirm.
- **Limits:** per-IP rate limit and a per-pattern row cap (default 300 rows) to bound cost.

## 9. App

- **Screens:** Input (paste, samples, UK/US check) → Review (three columns, questions, code editor; FR-3.x) → Model (2D/3D view, level of detail, tension, flip; FR-4.x, FR-5.x). The review and model views are side by side on wide screens.
- **State:** one `TranslatedPattern` in a store (Zustand or React context), saved to `localStorage` per pattern as a convenience; export is the durable format (FR-6.x).
- **Code editor:** CodeMirror 6 with a small CrochetPARADE mode (stitch names, `@`, labels, `COLOR:`/`DEF:`/`DOT:` lines) and inline parser errors from the worker.
- **Row ↔ stitch links:** `Stitch.row` maps to `PatternRow` through the order of the assembled text (§4). Hover and click on either side highlight the other (FR-3.2).

## 10. Testing

### 10.1 Unit tests

- `segment.ts`: a table of English snippets → rows, counts and labels, including ranges (`Rnds 4–7`), wrapped lines and UK terms.
- `validator.ts`: known-good and known-bad snippets, including one of each `ParseErrorKind`.
- `compare.ts`: pairs that must match (same graph, different labels or brackets: `[2sc,>,dc]*3` vs `2sc,dc,2sc,dc,2sc`) and pairs that must not (sc swapped for tr, as in the paper's cone example).
- `loop.ts`: the translator loop with a fake model that returns scripted responses, to test repair, `amendPrevious` rejection, and best-attempt ranking without API calls.

### 10.2 Conformance

Every CrochetPARADE example pattern in the vendored `parse64.js` must parse, and its `StitchGraph` must round-trip through `graph.ts` with the same stitch count. This runs on every vendor upgrade.

### 10.3 Evaluation as a gate

A small fixed subset (our own patterns only, about 20) runs in CI on prompt changes, through the Batches API, and fails the build if structure match drops by more than 5 points from the last accepted run. The full datasets run by hand, not in CI, because of cost and licences.

## 11. Milestones

Refines REQUIREMENTS.md §10 with the spikes this spec depends on.

| Milestone | Deliverables | Exit check |
| --- | --- | --- |
| **M0 Spike** | Vendor CrochetPARADE; validator wrapper in Node and a Worker; DOT → `StitchGraph`; call the solver from a Worker; render structure mode | Conformance suite passes (§10.2); 5 examples render as on crochetparade.org |
| **M1 Evaluation first** | Dataset loaders (§7.1); `compare.ts`; rule-based baseline scores | Baseline table for StitchSwitch and CrochetBench |
| **M2 Translate** | Segmentation; prompt v1; row loop with repair; `eval run` with `--batch`; first model and effort sweep | Row mode beats the rule-based baseline on structure match |
| **M3 App** | Server; review UI; code editor; row ↔ stitch links | A new user translates and renders a sample pattern unaided |
| **M4 Yarn** | Templates for the MVP stitch set; frames; tube meshes; levels of detail | Stitch-recognition test passes (REQUIREMENTS §9) |
| **M5 Polish** | Exports, incremental layout, performance | NFR-1 and NFR-2 met |

Evaluation comes before the translator on purpose: without the harness there is no way to tell whether a prompt change helped.

## 12. Open questions

1. **StitchSwitch class codes.** What do `X` and `Y` in the `Variation` column mean, and does blank mean class B? Ask the authors; until then, report StitchSwitch results overall, not per class.
2. **StitchSwitch licence.** Ask the authors whether evaluation results may be published and whether the data may be redistributed.
3. **Parser internals (M0).** The row number in parse errors; how per-row counts are exposed; the DOT format.
4. **`amendPrevious`.** Is "labels only" a strict enough rule to check automatically? The alternative is to require the model to rewrite the whole prefix, which is simpler to check but costs more tokens.
5. **Whole vs row mode.** If whole-pattern translation scores better on structure match, the app may use it for the first pass and row mode only for repairs. Decide from M2 results.

## 13. References

- [REQUIREMENTS.md](./REQUIREMENTS.md), [RELATED_WORK.md](./RELATED_WORK.md), [CROCHET_CONVENTIONS.md](./CROCHET_CONVENTIONS.md), [MATH.md](./MATH.md).
- CrochetPARADE: [repository](https://github.com/stassev/CrochetPARADE): `parse64.js` (`processText` returns `[dot, simpleDot]`), `translator_ui.js`, `deterministic_translator.js`, `graph.cpp`.
- StitchSwitch dataset: [rachaelteresa/StitchSwitch](https://github.com/rachaelteresa/StitchSwitch) (last push 2025-04-15; no licence file).
- CrochetBench: [Peiyu-Georgia-Li/crochetBench](https://github.com/Peiyu-Georgia-Li/crochetBench) (code MIT, data CC BY-NC 4.0; Task D data in `data/`; headless validator `benchmark_task/verify_crochet_pattern.js`).
- Dias and Karim (2025), local copy [05499-SuSS.DiasR.pdf](./05499-SuSS.DiasR.pdf).
