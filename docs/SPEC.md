# Crochet Model App: Technical Specification

> Status: M0 and M1 built; M2 translator built for Claude, other providers and model sweep pending  
> Last updated: 2026-10-01  
> Purpose: define how to build what [REQUIREMENTS.md](./REQUIREMENTS.md) asks for: modules, data types, the translation loop, the evaluation harness, the server with user accounts and the yarn renderer.

REQUIREMENTS.md says **what** the app must do and why. This document says **how**. Requirement IDs (FR-x.y, NFR-x) refer to REQUIREMENTS.md. Background on CrochetPARADE is in REQUIREMENTS.md §4, and on prior work in [RELATED_WORK.md](./RELATED_WORK.md).

## 0. Assumptions

This spec takes the defaults for the open decisions in REQUIREMENTS.md §11. Changing any of them changes the sections listed.

| Decision (REQUIREMENTS §11) | Assumed here | Affects |
| --- | --- | --- |
| 1. Licence | GPLv3; CrochetPARADE code is vendored (option A) | §3, §4 |
| 2. Delivery | Web app | §2 |
| 3. LLM hosting | Bring your own key for any provider (Anthropic, OpenRouter, Google Gemini, OpenAI); the server calls the provider with it. No account is needed for any step: a guest's key lives only in the browser tab and is sent with each request. Signing in only adds saving keys, stored encrypted on the server | §5.6, §8 |
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
| Server | Node, one small HTTP service (Hono) | Holds users' encrypted API keys; calls the providers; caches translations |
| Accounts | Better Auth (email and password, cookie sessions) | Maintained library with SQLite storage and rate limits on sign-in; no hand-written password or session code |
| Database | SQLite (`better-sqlite3`) | Users, encrypted keys, settings, translation cache; one file, no separate service |
| LLM | One `TranslatorModel` interface, one adapter per provider: `@anthropic-ai/sdk` (Anthropic), `openai` (OpenAI, and OpenRouter through its OpenAI-compatible API), `@google/genai` (Gemini) | FR-2.7; the user chooses the provider and model (§5.6) |
| Schemas | Zod | Shared by the server, the structured-output schema and the evaluation harness |
| Tests | Vitest (units), Playwright (UI smoke tests) | — |

## 2. Repository layout

```text
crochet-model/
  docs/                        REQUIREMENTS.md  SPEC.md  RELATED_WORK.md  CROCHET_CONVENTIONS.md  MATH.md, paper PDF
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
    translator/                LLM translation loop (§5); Node, runs on the server and in the evaluation
      src/prompt/system.md     role, inputs and output rules
      src/prompt/grammar.md    our own grammar reference (FR-2.2)
      src/prompt/idioms.md     English idiom table (FR-2.3)
      src/prompt/examples.md   worked examples (§5.3)
      src/prompt.ts            request blocks, repair messages, prompt version (§5.2, §5.7)
      src/schema.ts            response schemas (§5.4)
      src/model.ts             TranslatorModel interface, provider-neutral request and reply (§5.6)
      src/providers/           one adapter per provider (§5.6)
        anthropic.ts           Messages and Batches API
        openaiCompat.ts        Chat Completions: OpenAI and OpenRouter
        gemini.ts              Gemini API
        capabilities.ts        what each model supports: structured output, effort, caching
      src/counts.ts            stated-count check (§5.5)
      src/loop.ts              translate → validate → repair (§5.5)
    server/                    HTTP API, accounts, key store, translation cache (§8)
      src/auth.ts              Better Auth setup (§8.2)
      src/keys.ts              encrypt, decrypt, check and redact API keys (§8.3)
    app/                       React UI, workers, three.js renderer (§6, §9)
    eval/                      evaluation CLI and dataset loaders (§7)
      data/                    downloaded datasets; git-ignored (§7.1)
      runs/                    run directories (§7.2); git-ignored
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

**Status: built (M0).** Code: `packages/core/src/cp/graph.ts` (`parseStitchGraph`). The parser worker parses the graph and sends it instead of `graphJson`, whose labels carry megabytes of HTML context. It feeds the structure comparison (§7.3), the review UI's row ↔ stitch links (FR-3.2) and the renderer (§6).

```ts
interface StitchGraph {
  stitches: Stitch[];           // top nodes, in working order
  edges: GraphEdge[];           // { tail, head, len, kind: "yarn" | "structure" | "constraint", color? }
  nodes: GraphNode[];           // { id, type, top, statement?, hidden }: every node, deduplicated
}

interface Stitch {
  id: string;                   // the node name, e.g. "3,12|40"
  row: number;                  // 0-based, as CrochetPARADE counts
  index: number;                // position within its row
  statement: number;            // statement uid; a sc2inc gives two stitches one statement
  type: string;                 // "sc", "ch", "scbl", or a DEF: name; a dc2tog is "dc"
  workedInto: string[];         // ids of the stitches it attaches to
  intoSpace: boolean;           // attaches into a chain space or post, not a stitch's top
  side?: "back" | "front";      // back/front loop and post stitches
  nodeIds: string[];            // its top node, then its statement's internal nodes
  labels: string[];             // labels defined on it
  color?: string;               // the COLOR: in effect, as written ("Red", "#969696")
}
```

What M0 established by reading `export_to_dot` in `parse64.js` and probing all bundled examples:

- **Statements and top nodes.** Every stitch statement gets a uid (the number after `|`); `sk` takes one and makes no node, so uids have gaps. A statement has zero or more top nodes, named `row,index|uid`: a sc2inc has two, a picot3 four (`ch`, `ch`, `ch`, `ss`), a dc2tog one. The label is `type|context|colour`, where context is HTML. A `start_anew` is a top node of type `hidden`, and no yarn edge runs into it.
- **Internal nodes** are named `row,index<X>|uid`, with row,index from the statement's first top node and X the letter from the stitch definition, sometimes with a digit (`2,6C|6`, `3,0C0|138`). Puffs, bobbles and popcorns use them, and so do stitches worked into a chain space (a hidden `B` node). Custom `DEF:` stitches can give them other types (`line`, `dc`).
- **Loop and post stitches** insert a hidden node named `<target>a<head>_jacobian<j>` between the stitch worked into and the stitch's node; j > 0 is the back loop or back post, j < 0 the front. The solver input adds a matching orientation quadruple.
- **Space interpolation.** An attachment between two points of a post can create a hidden node named `$<p0>--<p1>:<d0>:<d1>|<uids>`, which can be emitted more than once. None of the bundled examples produce one; nodes are deduplicated by name anyway.
- **Edge colours.** Blue is the yarn from stitch to stitch; at most one blue edge enters a node. Red is structure: the attachment to the stitch worked into, and springs inside a stitch. Gray places a hidden node, such as the point in a chain space between two stitches. The first stitch of a turned row has both a blue and a red edge from the last stitch of the row before, because it is worked into it.
- **Worked into** is found by walking back from the top node over red and gray edges, through the statement's own internal nodes, jacobian and `$` nodes, until other stitches are reached. At an internal node fed by other internal nodes, only those are followed: a popcorn ties the previous stitch to one of its internal nodes (`!-0.33-D`), and that is not an attachment. A path through a gray edge sets `intoSpace`.
- **Conformance** (§10.2) checks, for every bundled example, that the graph has the same stitches per row as the row summary, that every edge end is a node, and that every stitch other than `ch`, `ring` and `hidden` is worked into something. All pass; no chain is ever worked into anything.

### 3.4 Layout

**Status: built (M0).** Code: `packages/core/src/cp/layout.ts` (runtime-agnostic), `nodeSolver.ts` (Node loader); `packages/app/src/workers/` (parser and layout workers, promise clients). The solver itself is described in the ply-split-braiding [`docs/elastic/README.md`](../../ply-split-braiding/docs/elastic/README.md) §2.

What M0 established:

- **Input is `simpleDot`.** Its first line is the dimension, set by the parser's `DIM` global (so `validate(text, { dimension })` must be called with the dimension wanted). Then come nodes (`"name"`, or `"name" {x,y,z}` to fix a position), edges (`"a" -- "b" restLength`), 3D orientation quadruples (`"a"---"b"---"c"---"d"---h`), and the pattern's `DOT:` settings as bare lines. The solver reads settings from any non-node, non-edge line, and a later line wins, so the app's overrides (`start=…` seed, `iterations=…`) are appended at the end.
- **Output** is one `{"name": "…","pos": "x,y[,z]"},` line per node, including internal nodes. It is deterministic for a given input and seed.
- **2D folds.** An unlucky seed can leave part of a 2D layout mirrored, overlapping the rest and pinched to a point; the solver does not notice. `layoutUnfolded` (core `cp/fold.ts`) counts crossing edges: flat fabric crosses about 1% of its edges (where stitches fan out of one base), a fold 13–20%. Above 5% it lays out again with the next seed (the pattern's `start=` or 0, then +1, +2, …), up to 5 seeds, and keeps the layout with the fewest crossings. A seed typed in the app turns retrying off. 3D is not checked: an inside-out model has no crossings to count.
- **Loading.** `graph64.js` reads settings from a pre-existing global `Module` (`print`, `wasmBinary`, `onRuntimeInitialized`). Its own `var Module` would hide a global under `require()`, so Node runs it in a `vm` context and the Worker runs it through `new Function("Module", source)`. The Emscripten build does not export `lengthBytesUTF8`; `TextEncoder` gives the byte length.
- **Progress** comes from the solver's stdout: one `Iteration = N Error = E` line per step, and `Failed to converge. Learning rate reduced to: …` when it restarts (the attempt number goes up and the iteration count starts again). The Worker forwards these at most every 50 ms; they arrive on the main thread while the synchronous solve is still running.
- **Cancel** terminates the Worker; the next layout starts a fresh one. `performLayout` cannot be interrupted from inside.
- **Speed:** a 271-node amigurumi ball takes about 130–190 ms in the browser at 500 iterations; a 155-node flat swatch about 40 ms. On the test ball the mean edge length is within 10% of its rest length, matching the manual's claim.
- **Large patterns are slow.** The 4,646-stitch `textHat` takes about 120 s at 500 iterations, in Node and in the browser alike; the 482-stitch granny square about 0.5 s. Cost grows much faster than the node count. A 20-row amigurumi (NFR-1: first layout within 10 s) is far below this, but large pieces will need incremental layout or fewer iterations (M5).
- The result buffer returned by `performLayout` is never freed (upstream does not free it either), and WASM memory does not shrink. `LayoutClient` replaces its Worker after every 50 finished layouts.
- **Separate pieces.** Pieces not joined by any edge (`start_anew`, `new`) are laid out on top of each other. crochetparade.org's Object Transform tool moves them apart after the layout and saves the moves in the pattern as `TRANSFORM_OBJECT: object,tx,ty,tz,rx,ry,rz`, which the parser skips and only the site's renderer reads. Objects are the connected components, numbered by their first node in the parser's output. Each is rotated about its centre of mass by Euler angles (radians, XYZ order, as three.js), then moved by (tx, ty, tz) in bounding radii of the whole model. `applyObjectTransforms` (core `cp/objectTransform.ts`) does the same on a 3D layout; the app applies it before drawing. The snowman example uses it; 2 of the 60 bundled examples do.

## 4. Core types

These are the contract between the modules. They live in `packages/core/src/types.ts` (built in M2, with the additions noted after the block).

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
  provider: ProviderId;         // "anthropic" | "openrouter" | "gemini" | "openai"
  model: string;                // the provider's id, e.g. "claude-opus-5-5", "anthropic/claude-opus-5-5"
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
  provider: ProviderId;                      // what translated it, for the cache key and the export
  model: string;
}
```

Built in M2 with these additions: `PatternRow.span` (rows a range label stands for), `SegmentedPattern` (rows, notes and the UK-terms flag), `Usage` with cache writes, `Attempt.rejected` (why the loop did not accept it), and `source: "gold"` for rows given to the translator already translated (the gold prefix of a CrochetBench step item).

The CrochetPARADE text is assembled from `translations` in row order. `#` comments carry the English and the section headers (FR-6.1). User-edited rows (`source: "user"`) are never overwritten by re-translation (FR-3.3).

## 5. Translation

### 5.1 Segmentation (no LLM)

`segment.ts` splits the English into `PatternRow`s with rules, not an LLM, so that row ids are stable and cheap to compute:

- A row starts at a label (`Rnd 3:`, `Row 12`, `R1`, `Round 1-3`). A label range such as `Rnds 4–7` becomes one row with a repeat count, and translates to one line per round.
- Wrapped lines are joined. Prose (materials, gauge, notes) is kept as notes, not rows.
- Stated counts are read with a small set of patterns (FR-1.4). An unreadable count leaves `statedCount` undefined; it is not guessed.
- UK terms are detected by vocabulary (for example `treble` and `double crochet` with no `single crochet`). The UI asks before converting (FR-1.2). The mapping table lives in [CROCHET_CONVENTIONS.md](./CROCHET_CONVENTIONS.md).

CrochetPARADE's `deterministic_translator.js` already does similar splitting (`segmentEnglishPattern`, `parseDeclaredCount`). Compare the two on the evaluation set; keep ours only if it is at least as good.

**Status: built (M2).** Code: `packages/core/src/segment.ts` (`segmentPattern`, `statedCount`). Lines are classified one at a time: a label starts a row; a header (an all-caps line, or a short line ending in `:`) starts a section and carries `(make N)`; `Notes:` and bullet lines are notes; a blank line closes the open row or note. Any other line continues the open row or note, because real patterns (CrochetBench project texts) are hard-wrapped mid-sentence, except that a line starting `Rep`, `Fasten off`, `Join` or `With A` after a full stop starts a new unlabelled row. After a blank line or header, a line that reads like an instruction (`With A, ch 16.`) becomes an unlabelled row; prose becomes a note. Finishing lines with no label ("Fasten off.") are notes. Row ids are an FNV-1a hash of section, label, text and position, so they need no Node or browser crypto. On StitchSwitch it yields exactly one row per English line for all 109 patterns. The comparison with CrochetPARADE's segmenter is not done yet.

### 5.2 One request per row

Each row is one model request. The translator walks the rows in order, because each row's CrochetPARADE depends on the rows before it (labels, stitch counts, turning).

Request layout, ordered so the stable parts are cached (§5.6). Every provider caches a stable prefix, explicitly (Anthropic, and Anthropic or Gemini models through OpenRouter) or automatically (OpenAI, Gemini), so the same order serves all of them:

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

Structured outputs guarantee a parseable response. The Zod schema is converted once to JSON Schema and each adapter sends it in its provider's form (§5.6); the reply is parsed with the same Zod schema whatever the provider. Models that cannot constrain output to a schema are not offered:

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

`confidence` is sent as a plain string and normalised in code (`confidenceOf`): the Anthropic SDK's schema conversion (`zodOutputFormat`, which drops keywords structured outputs do not support) turns the enum into a description, so it is not enforced. The other providers support different subsets of JSON Schema, so the schema keeps to the common part (objects, arrays, strings, integers, nullable) and enforces nothing else. The format is sent as plain JSON so the same request works in a batch.

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
- **The repair conversation is append-only.** Each repair adds the model's previous response and a new user message; earlier turns are never edited or removed. The previous response is replayed in the provider's own form (`ModelReply.raw`, §5.6): Claude models bind their thinking blocks to the exact conversation, and Gemini needs its thought signatures returned unchanged.
- **After an invalid row,** the next rows are still translated, against the prefix without the failed row. Their counts will usually be off, so they are flagged, not repaired, until the user fixes the failed row.
**Status: built (M2).** Code: `packages/translator/src/loop.ts` (`translatePattern`, `translateWhole`), tested with a scripted model in `test/loop.test.ts`. Decisions made while building it:

- **Stated counts allow for a beginning chain** (`counts.ts`). The parser counts every chain; patterns usually do not count a turning chain, and count a chain-3 as one stitch. A line that starts with L chains and makes T stitches in all matches T − L, or T − L + 1 when L ≥ 2. A single chain is never taken as a stitch: allowing it would hide an off-by-one in every "ch 1, …" row. The evaluation's step-level count metric uses the same rule.
- **A deliberate count difference stops the repairs.** When the model's `expectedCount` equals the parser's count and not the stated one, it has said the English counts differently (for example skipped chains counted as a dc); the row is accepted as `count_mismatch` without more requests.
- **A row that parses with the wrong count joins the prefix** as `count_mismatch`; only rows that do not parse are left out. Leaving out a row with one stitch too many would break every row after it.
- **"Labels only" is checked by graph.** An amendment is accepted when the amended prefix parses and makes the same canonical stitch graph as before (`canonicalRows`, §7.3): labels are exactly what cannot change the graph. This answers open question 4.
- **Questions.** The loop takes an `answer` callback. When it picks an option with CrochetPARADE, that option replaces the best guess if it parses; the answer is added to user block 1 for later rows. Without an answer the row is `needs_answer` and its best guess stays in the prefix.
- **Errors.** A refusal or an unusable response is a failed attempt. Bad requests, authentication errors and unknown models (4xx other than 429) are thrown, not recorded as translation failures (`isFatal`). With several providers this becomes the error classes in §5.6.
- **Whole mode** (`translateWhole`) asks for every row in one request (`WholeResponse`), validates the whole, and repairs it as a whole for parse errors and stated-count mismatches.

- **Rule-based candidate (FR-2.9).** Not built in M2: the rule-based translator splits patterns differently, so its candidates first need aligning to our rows. Deferred to M3. When CrochetPARADE's own translator yields a valid candidate for the row, compare it with the LLM's. The same stitch graph raises confidence to `high`; a different graph shows both candidates to the user.

### 5.6 LLM providers

The loop talks to one interface, `TranslatorModel.send(ModelRequest) → ModelReply`. One adapter per provider maps it to that provider's API. In the app the user picks the provider and model and pays with their own key (§8); in the evaluation they are `--provider` and `--model` (§7.2).

**Status:** the Anthropic adapter is built (M2), as `ClaudeModel` and `BatchModel` in `packages/translator/src/model.ts`, with Anthropic types in `ModelRequest`. Planned: the provider-neutral request below, moving the Claude code to `providers/anthropic.ts`, and the OpenAI-compatible and Gemini adapters.

#### Providers

| | Anthropic | OpenRouter | Google Gemini | OpenAI |
| --- | --- | --- | --- | --- |
| API | Messages API | Chat Completions (OpenAI-compatible), `baseURL` `https://openrouter.ai/api/v1` | Gemini API (`generateContent`) | Chat Completions |
| SDK | `@anthropic-ai/sdk` | `openai` | `@google/genai` | `openai` |
| Structured output | `output_config.format` | `response_format: {type: "json_schema", strict: true}` | `responseMimeType: "application/json"` + `responseJsonSchema` | `response_format: {type: "json_schema", strict: true}` |
| Effort | `output_config.effort`, adaptive thinking | `reasoning: {effort}` | `thinkingConfig` (level or budget, by model) | `reasoning_effort` |
| Caching | `cache_control` on system 1 and user 1 | `cache_control` passed on for Anthropic and Gemini models; automatic for others | implicit, on a stable prefix | automatic, on a stable prefix |
| Model list | Models API | `GET /models` (with `supported_parameters` and prices) | `models.list` | `GET /models` |
| Batches (evaluation) | Message Batches API | none | later | later |
| Cost | `pricing.ts` | reported in each response's `usage` | `pricing.ts` | `pricing.ts` |

OpenRouter gives one key access to many hosts' models, so it is the route for providers without their own adapter. Base URLs are fixed in code; users cannot enter their own (§8.3).

#### Provider-neutral request and reply

```ts
type ProviderId = "anthropic" | "openrouter" | "gemini" | "openai";

interface ModelRequest {
  id: string;                         // unique within a run; the batch custom_id
  provider: ProviderId;
  model: string;
  effort: Effort;                     // "low" | "medium" | "high" | "xhigh" | "max"
  system: TextBlock[];
  messages: Turn[];
  schema: Record<string, unknown>;    // JSON Schema from the Zod schema (§5.4)
  maxTokens: number;
}

interface TextBlock { text: string; cache: boolean }   // cache: end of a cached prefix (§5.2)

type Turn =
  | { role: "user"; blocks: TextBlock[] }
  | { role: "assistant"; text: string; raw: unknown };  // raw: the provider's own reply content

interface ModelReply {
  text: string;                       // the JSON answer
  raw: unknown;                       // replayed unchanged in repair turns (§5.5)
  stopReason: "end" | "max_tokens" | "refusal" | "other";
  usage: Usage;                       // input, output, cache read, cache write tokens
  costUsd?: number;                   // when the provider reports it (OpenRouter)
  model: string;                      // the model that answered
}
```

- **Effort** maps to the provider's nearest level, clamped to what the model accepts (`capabilities.ts`). Models without reasoning get none. This replaces today's Haiku special case.
- **Capabilities** (structured output, effort levels, explicit caching, batches) come from rules on model ids for Anthropic, Gemini and OpenAI, and from `supported_parameters` in OpenRouter's model list. A model without schema-constrained output is not offered in the app and is refused by the evaluation.
- **Usage** is normalised: OpenAI-compatible `prompt_tokens` and Gemini `promptTokenCount` include cached tokens, so the cached part moves to `cacheReadTokens`; Gemini's thinking tokens count as output.
- **Stop reasons** are normalised: Anthropic `refusal`, OpenAI-compatible `content_filter` and Gemini `SAFETY`, `RECITATION` or `PROHIBITED_CONTENT` all become `refusal`, which is a failed attempt (§5.5).

#### Errors

Each adapter sorts errors into classes; the loop and the server act on the class, not on provider codes.

| Class | Typical cause | Action |
| --- | --- | --- |
| `retryable` | 429 rate limit, 5xx, connection error | SDK retries with back-off; after that, the row fails and the user can retry |
| `key_rejected` | 401, 403 | Stop the pattern; in the app, mark the user's key `invalid` (§8.3) and ask for a new one |
| `no_credit` | OpenRouter 402, OpenAI `insufficient_quota`, Gemini quota exhausted | Stop the pattern; tell the user their provider account is out of credit |
| `bad_model` | 404 or unknown model | Stop; ask the user to choose another model |
| `bad_request` | other 400s | A bug in our request: log it (without the key), stop the pattern |

Only `retryable` errors and refusals are recorded as translation attempts; the rest stop the pattern (`isFatal`).

#### Models and defaults

- **Recommended models.** `packages/translator/models.json` lists, per provider, the models the evaluation has scored, with their structure-match score and cost per 20-row pattern. The app shows these first, and every other model the user's key can list under "Not evaluated", with a warning. Adding a model needs no code change; adding a provider needs an adapter.
- **Default:** `claude-opus-5-5` on Anthropic, until the sweep (§7) says otherwise. Each other provider's default is its best-scoring recommended model. Do not change a default without evaluation evidence.

#### Anthropic adapter (built)

- **Thinking and effort:** adaptive thinking is always on for Opus 5.5 and cannot be disabled. Set `output_config.effort` explicitly: the Opus 5.5 default is `medium`. Start at `medium` for translation and `high` for repair attempts, then tune with the evaluation. Haiku 4.5 gets neither `effort` nor adaptive thinking, which it rejects.
- **Caching:** `cache_control: {type: "ephemeral"}` on system block 1 and user block 1 (§5.2). Log `usage.cache_read_input_tokens`; if it stays at zero across the rows of one pattern, something in the cached prefix is changing (a timestamp or unsorted JSON, for example). The same check applies to the cached-token counts of the other providers.
- **Refusals:** check `stop_reason` before reading content. The live app sends `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta. Crochet text should rarely trigger a refusal; this is a guard, not a feature. The Batches API rejects `fallbacks`, so evaluation runs omit it and count refusals as failures.
- **Batches:** `BatchModel` sends requests through the Message Batches API: since each pattern's loop waits on one request at a time, it collects requests until every running loop is waiting, then sends them as one batch (the first rows of every pattern, then the next round, and so on).

**Token logging:** every `Attempt` records provider, model and usage, whatever the provider. NFR-4 (cost per pattern) is measured from these logs.

### 5.7 Prompt versions

`promptVersion` is a hash of `grammar.md`, the examples, the system text, the schema and the model settings. It is part of the translation cache key (FR-2.8) and of every evaluation result, together with the provider and model. Changing the prompt invalidates the cache. The prompt text is the same for every provider; if one provider needs different wording, that is a separate prompt version, chosen by the evaluation.

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

**Structure mode: built (M0).** Code: `packages/app/src/view/structureView.ts`. Stitches are spheres and edges are cylinders, each kind one `InstancedMesh`; sizes scale with the median yarn edge length. Colour is the pattern's `COLOR:` or the stitch type. Internal nodes and gray edges are hidden unless asked for. Hovering a stitch highlights it and the stitches it is worked into. It renders on demand, not in a loop. 2D layouts are viewed face-on. The harness lays out the bundled examples in the dimension crochetparade.org uses for each (five are 2D).

**M0 render check (2026-09-30).** Five examples were run on crochetparade.org and in the harness: simplistic snowman (`textSnowman2`), baby bootie, apple, granny square (2D) and simple flower with post stitches. The site serves the same `parse64.js` as the vendored copy. For all five, the solver input (`simpleDot`) and every output position are identical to the site's, and the drawn shapes match. The snowman matched only after `TRANSFORM_OBJECT:` support (§3.4); a test checks its pieces against positions read from the site's scene.


As FR-5.6: structure (spheres and cylinders), yarn (tubes), yarn + texture. Above a stitch threshold, set during M3 by measurement, the default drops to structure mode. Tube segments per stitch and radial segments per ring both fall with distance from the camera.

## 7. Evaluation harness

The evaluation answers two questions: is the pipeline good enough to ship, and which model and settings to use. It also lets newer models be tested on the same data as soon as they are released.

**Status: built for the rule-based baseline (M1).** Code: `packages/eval/src/` (`fetch.ts`, `datasets.ts`, `rules.ts` with `rules_bridge.py`, `score.ts`, `chrf.ts`, `run.ts`, `summary.ts`, CLI `cli.ts`); structure match in `packages/core/src/cp/compare.ts`. Commands: `npm run eval -- fetch`, `npm run eval -- run --translator rules --dataset <name|all> [--limit N]`, `npm run eval -- report <run-dir>…`. The LLM translator, `--model`, `--mode`, `--batch`, the cost guard and `eval compare` come with M2.

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

What M1 established (StitchSwitch commit `262ff43`, CrochetBench commit `4f834d5`):

- **StitchSwitch:** 109 items (`ss-001`…, in CSV order). All 109 gold translations parse with `parse64.js`.
- **CrochetBench step:** 123 items (54 + 36 + 33; the README's 119 is wrong at this commit). One prompt writes `DL:` for `DSL:`, and 5 steps span several lines; the loader reads prompts line by line and accepts both. In 5 items every earlier DSL is blank, so there is no gold prefix to check. Of the rest, 2 gold prefixes do not parse: `turn` written as a stitch (`step_1_2-016`) and `inc2sc`, which is not a stitch (`step_3_4-010`). These are reported as gold failures and left out of the rates.
- **Stated counts** are read from the end of the target step only in plain forms (`Turn. 15 sts.`, `(18)`, `[18 sts]`, `turn—18 sc`); counts for several sizes or several stitch kinds are not read. 31 of the 123 targets have one.
- **CrochetBench project:** 100 records, but one ("Home Spa Bath Mat") has no `instructions`, so 99 items. Ids keep the record position (`project-001`…).

### 7.2 Runs

```text
eval run --dataset stitchswitch --provider anthropic --model claude-opus-5-5 --effort medium \
         --mode row|whole [--no-repair] [--no-rules] [--limit N] [--batch]
eval report runs/<run-id>
eval compare runs/<a> runs/<b>
```

- **Modes:** `row` is the app's loop (§5.5). `whole` translates the whole pattern in one request, as the paper did, so our numbers can be compared with theirs.
- **Ablations:** `--no-repair` (one attempt only) and `--no-rules` (no rule-based candidate) show what each part adds.
- **Batch runs (Anthropic only for now):** `--batch` sends first attempts through the Message Batches API at half price. Repairs depend on earlier results, so each repair round is a further batch; the run records how many rounds it took. Results come back in any order and are matched by `custom_id` (`<dataset>:<patternId>:<rowId>:<attempt>`).
- **Reproducibility:** a run directory stores the config, the prompt version, the vendored CrochetPARADE commit, the dataset commit, every request and response, and the token usage. `eval report` works from the directory alone.
- **Providers and models:** `--provider anthropic|openrouter|gemini|openai` (default `anthropic`) and `--model` with the provider's model id. Any model the provider lists can be named; adding a model needs no code change. Keys come from the environment (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`), never from the server's key store. The run directory records the provider. A model reached both directly and through OpenRouter is scored once on each route: hosts can differ.
- **Cost guard:** a run first estimates its cost from token counts and asks for confirmation above a threshold (default US$5).

**Status: built (M2), not yet run against the API.** `npm run eval -- run --translator llm --dataset <name> [--model ID] [--effort …] [--repair-effort …] [--mode row|whole] [--no-repair] [--batch] [--limit N] [--ids a,b] [--concurrency N] [--max-cost USD] [--yes]`, and `npm run eval -- compare <run-a> <run-b>`. Not built: `--no-rules` (no rule-based candidate yet, §5.5). Details:

- **Preflight.** Before anything else the run asks the provider's model list for the chosen model (free), checks its capabilities (§5.6), so missing credentials or a wrong model id stop it before a run directory exists.
- **Cost guard.** The estimate is rough (characters ÷ 3.5 for input, an assumed output per request by effort) and is printed every time; above `--max-cost` (default US$5), or for a model with no price on file (`pricing.ts`, keyed by provider and model; OpenRouter prices come from its model list), the run refuses unless `--yes` is given. Actual cost comes from the recorded usage.
- **Inputs.** StitchSwitch rows keep their 1:1 alignment with the gold lines, which also lets questions be answered from the gold (§7.3, metric 4). A CrochetBench step item is its earlier steps given as gold rows plus the target; only the target's translation is scored. Project items are segmented with `segmentPattern`. Items whose gold does not parse are skipped, not sent.
- **The run directory** also holds `prompt.txt` (the system prompt) and `requests.jsonl` (every request without the shared system prompt, and every reply's text, stop reason, usage and model). `items.jsonl` holds each row's translation with all its attempts.
- **Concurrency.** Direct runs translate `--concurrency` patterns at a time (default 4); rows within a pattern are always sequential.

### 7.3 Metrics

Per pattern, then per class and overall:

1. **Parses:** `validate(output).ok`.
2. **Count match:** the fraction of rows whose parsed count equals the stated count (English) or the gold count (gold CrochetPARADE).
3. **Structure match:** the output's `StitchGraph` is isomorphic to the gold graph. Compare row by row: stitch types in order, and for each stitch the (row, index) positions it is worked into. Label names, bracket style and repeat grouping do not matter, because they vanish in the graph. Report both the exact match rate and a partial score: the fraction of stitches that match.
4. **Questions:** the number of rows that asked the user. The evaluation answers automatically with the option whose `cp` gives the gold graph, if any, and counts it; a question with no correct option counts as a failure.
5. **Cost and time:** tokens, dollars and wall-clock per pattern.
6. **chrF** against gold, for comparison with Dias & Karim only.

Datasets with no gold (CrochetBench) report metrics 1, 2 and 5.

How M1 computes them (`score.ts`, `compare.ts`):

- **Rows kept** is the share of instruction rows the translator kept in its output: for the LLM, rows that are not `invalid`.
- **Parses** needs at least one line the parser reads; an output of only `#` comments counts as empty, not as parsing. A step item is parsed as its gold prefix followed by the output.
- **Count match** with gold: per gold CrochetPARADE row, the output's row with the same number has the same stitch count (`RowSummary.stitches`). With a stated count (step items): the last row after the output has that count, allowing for a beginning chain as the translator does (§5.5). Averaged per item, then over items.
- **Structure match** compares stitches by position, because statement uids differ between texts that make the same graph. `hidden` top nodes (`start_anew`) and rows left empty are dropped, the rest are renumbered (row, index), and each stitch becomes its type plus the sorted positions it is worked into. Exact match: every row equal. Partial score: stitches equal at the same position, over the larger of the two stitch counts, so a missing or extra stitch early in a row costs the rest of that row. `ring` then `6sc` is not `ring.R` then `6sc@R`: without `@R` CrochetPARADE works each sc into the one before.
- **chrF** is sentence-level with sacrebleu's defaults (character 6-grams, beta 2, whitespace removed), on the output's code lines.

### 7.4 Baselines

- **CrochetPARADE rule-based translator**, run headless on each dataset (`rules.ts`). crochetparade.org translates in two halves: a Python package (run in Pyodide) splits the English and proposes candidates per row, and `deterministic_translator.js` checks them with the parser and assembles the "checked CP block". Both are vendored (§3.1); the evaluation runs the Python half with `python3` and the JS half in Node, with the default choices. Step items give the translator only the target step, with the gold prefix's last row count as its row context. Two outputs are scored:
  - **rules**: the checked block, as the site shows it. Rows the Python half could not read are left out (after one such row, every row up to the next restart), so it is short.
  - **rules-compiled**: the Python half's own whole-pattern compile, which keeps every row it could read. Rows it could not read become `# REVIEW` comments, so "parses" on patterns with no gold overstates it.
- **Dias & Karim published numbers** (RELATED_WORK.md §2.1): 74% accuracy and 82.5% correctness for their best fine-tuned 8B model. Their accuracy was judged by hand over 8 folds, so the comparison is approximate.
- **Our previous run**, via `eval compare`, to catch regressions when prompts change.

**Rule-based baseline (M1, 2026-09-30).** CrochetPARADE `06e987b`, `parse64.js`. Rates are over items whose gold parses. Count match is n/a for project items (no gold, no row alignment); structure and chrF need gold, so only StitchSwitch has them. A full run of all three datasets takes about 3 minutes. The step-level count match was first published as 23.3% for both outputs, with stated counts compared strictly; since M2 it allows for a beginning chain (§7.3), and most step targets start with one.

| Dataset | Output | Items | Gold fails | Parses | Count match (items) | Structure exact | Structure partial | chrF | Rows kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| StitchSwitch | rules | 109 | 0 | 45.9% | 26.5% (109) | 8.3% | 23.8% | 22.2 | 27.0% |
| StitchSwitch | rules-compiled | 109 | 0 | 93.6% | 34.8% (109) | 6.4% | 27.9% | 36.3 | – |
| CrochetBench step | rules | 123 | 2 | 36.4% | 63.3% (30) | – | – | – | 27.7% |
| CrochetBench step | rules-compiled | 123 | 2 | 59.5% | 66.7% (30) | – | – | – | – |
| CrochetBench project | rules | 99 | 0 | 67.7% | – | – | – | – | 23.8% |
| CrochetBench project | rules-compiled | 99 | 0 | 90.9% | – | – | – | – | – |

- **The bar for M2** is structure match on StitchSwitch: 8.3% exact, 27.9% partial at best. The rule-based translator reads about a quarter of the rows; the LLM loop has to read nearly all of them.
- **Where it fails.** In the checked block, most output that does not parse on CrochetBench project comes from one upstream bug: the Python half's internal `__restart__` marker leaks into 22 of the 99 outputs, and the parser rejects it as an unknown stitch. On StitchSwitch nothing in the checked block fails to parse; it is just short or empty. Structure misses that do parse are real: a slip stitch into the ring instead of into the first sc, `7ss` for "slip stitch into the first stitch of Row 1", a magic ring for "Ch 2".
- **Not comparable with Dias & Karim** except loosely: their 74% is hand-judged over 8 folds, this is an automatic graph comparison over all 109.

## 8. Server

The server runs the translator loop with the caller's key and caches results. Every step works without an account; an account only lets a user save keys (and settings) on the server instead of entering a key each visit. The server never sends a key back to the browser.

**Where the key comes from,** per request:

1. **Guest, or a signed-in user who has not saved a key for this provider:** the browser sends the key in the `X-Provider-Key` header. The server uses it for that request only and never stores it.
2. **Signed-in user with a saved key for this provider:** the server decrypts the saved key (§8.3). A key in the header, if any, takes precedence for that request.

Without either, `/api/translate*` and `/api/models` return 409 `{ error: "no_key", provider }` and the app asks for a key.

### 8.1 Endpoints

| Endpoint | Purpose |
| --- | --- |
| `/api/auth/*` | Sign up, sign in, sign out, email verification, password reset, session (Better Auth's routes, §8.2). |
| `GET /api/keys` | The user's saved keys: provider, last 4 characters, status, added and last used dates. Never the key. |
| `PUT /api/keys/:provider` | Body: `{ key }`. Checks the key with the provider (§8.3), then saves it encrypted, replacing any old one. |
| `DELETE /api/keys/:provider` | Deletes the key. |
| `GET /api/models/:provider` | Models the key can use, recommended ones first, with capabilities and price (§5.6). Doubles as the guest's key check. Cached for 1 hour per saved key; not cached for header keys. |
| `GET` / `PUT /api/settings` | Signed in only. Default provider, model and effort; translation cache on or off. Guests keep the same settings in `localStorage`. |
| `POST /api/translate` | Body: `{ english, answers, colors, edits, provider?, model? }`. Streams one `RowTranslation` per row as server-sent events, as rows finish (NFR-1). Provider and model come from the body, else the user's settings. |
| `POST /api/translate/row` | Re-translates one row: after an answer, a rejected assumption, or a fix to an earlier row. |
| `DELETE /api/account` | Deletes the user, their keys, settings and sessions at once. |
| `GET /api/health` | Prompt version, vendored CrochetPARADE commit, enabled providers. |

Only `/api/keys`, `/api/settings` and `DELETE /api/account` need a signed-in session. `/api/translate*` and `/api/models` work for everyone, with the key sources above. A saved key with status `invalid` is not used.

### 8.2 Accounts (FR-7.5, FR-7.7)

- **Sign-in:** email and password through Better Auth, with email verification before the first key is saved and password reset by email. Passwords are hashed by the library (scrypt); we write no password or session code ourselves. Google and GitHub sign-in can be added later through the same library.
- **Sessions:** an HTTP-only, `Secure`, `SameSite=Lax` cookie pointing to a server-side session row; 30 days, renewed on use. Every request that changes state must carry an `Origin` header matching the app's origin (CSRF guard).
- **Abuse:** sign-up and sign-in are rate limited per IP and per email (library settings).
- **Without an account,** a visitor can do everything: paste a pattern, translate it with their own key, answer questions, edit CrochetPARADE by hand, render and export. The samples' translations ship with the app, so they need no key at all. The account exists only to save keys and settings.
- **Tables** (SQLite; Better Auth owns `user`, `session`, `account` and `verification`):

```sql
CREATE TABLE provider_key (
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,              -- anthropic | openrouter | gemini | openai
  ciphertext   BLOB NOT NULL,              -- AES-256-GCM, tag appended
  nonce        BLOB NOT NULL,              -- 12 random bytes, new on every save
  key_version  INTEGER NOT NULL,           -- which master key encrypted it
  last4        TEXT NOT NULL,
  status       TEXT NOT NULL,              -- ok | invalid | unchecked
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE user_settings (
  user_id  TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT, model TEXT, effort TEXT,
  cache_enabled INTEGER NOT NULL DEFAULT 1
);
```

### 8.3 API keys (FR-7.1 to FR-7.6)

- **Guest keys** are kept in the tab's memory only, not in `localStorage` or `sessionStorage`, so a reload or a new tab asks again; this keeps a key off a shared computer's disk and out of reach of anything else that later runs on the page's origin. They travel over HTTPS in `X-Provider-Key` and are never written to the server's disk, the cache or the logs. The app offers "Sign in to save this key" next to the key field.
- **Saved keys: one per user and provider.** The browser sends a key once, over HTTPS, when the user saves it. The server never returns it; the app shows the provider, the last 4 characters and the status. Signing in after entering a guest key offers to save it; it is never saved without the user choosing to.
- **Checked on save:** the server lists the provider's models with the key (free). A key the provider rejects is not saved. A provider that cannot be reached saves the key as `unchecked`.
- **Encrypted at rest:** AES-256-GCM with a fresh 12-byte nonce. The additional authenticated data is `user_id:provider`, so a ciphertext copied to another user's row does not decrypt. The master key comes from the `KEY_ENCRYPTION_KEY` environment variable (32 bytes, base64), never from the database or the repository. `key_version` allows rotation: a script re-encrypts every row under the new master key. A cloud KMS can replace the environment variable later without changing the table.
- **In use:** a key is decrypted for one translation, held in memory only, and passed to the adapter. The same rules hold for a guest's header key. It is never logged (the logger redacts `x-provider-key`, `authorization`, `x-api-key` and `x-goog-api-key` headers and any field named `key`), never put in error messages sent to the browser, in the cache or in request logs. For a saved key, `last_used_at` is updated.
- **Rejected in use:** a `key_rejected` error (§5.6) stops the translation and the app asks for a new key; for a saved key it also sets the status to `invalid`.
- **No custom base URLs.** Each provider's address is fixed in code. Letting users enter one would let them point the server at internal hosts, and would send their key wherever they typed.

### 8.4 Translation

- The server runs the same `packages/translator` loop as the evaluation, including validation, in a Node `vm` context (§3.2), with the provider, model and key of the user who asked. The browser re-validates for display, but the server's result is the one recorded.
- **Cache:** key = hash(English, answers, colours, row id, prompt version, provider, model). Stored in SQLite and shared between users: an entry only answers a request with the same English text, so it reveals nothing the requester did not send, and a hit costs nothing (NFR-5). A user who turns the cache off (an account setting, or a guest's local setting sent with the request) neither reads nor writes it.
- **Cost:** spending is on the user's own provider account. Before a translation the app shows an estimate for the chosen model (§7.2's rough estimate); after it, the cost from the recorded usage (NFR-4). Patterns estimated above US$1 ask for confirmation.
- **Privacy (NFR-3):** pattern text is sent to the provider the user chose; through OpenRouter, to OpenRouter and to the host of the chosen model. It is not stored on our server except in the cache, which the user can turn off. The first translation with each provider asks the user to confirm, naming the provider. A guest's key is forgotten when the tab closes. Saved keys are listed and can be deleted at any time; deleting the account deletes them at once.
- **Limits:** validation uses server CPU, so translations are rate limited per user when signed in and per IP for guests, with at most 2 at a time for either; per-pattern row cap (default 300 rows) to bound the user's spend.

## 9. App

- **Screens:** Input (paste, samples, UK/US check) → Review (three columns, questions, code editor; FR-3.x) → Model (2D/3D view, level of detail, tension, flip; FR-4.x, FR-5.x). The review and model views are side by side on wide screens.
- **No sign-in wall.** Every screen works signed out; "Sign in" sits in the header and is only needed to save keys.
- **Account screens:** Sign in / sign up; Settings with **API keys** (one card per provider: add or replace a key, last 4 characters, status, delete, a link to where the provider issues keys) and **Translation** (default provider, model and effort; recommended models first with their score and cost per 20-row pattern; cache on or off). Guests get the Translation settings too, stored in `localStorage`.
- **Model picker:** in the Input screen next to Translate: provider, a key field (filled with "saved key ••••1a2b" when the signed-in user has one, otherwise empty with a link to where the provider issues keys), and model, listed once the key is entered. Translate is disabled until there is a key.
- **State:** one `TranslatedPattern` in a store (Zustand or React context), saved to `localStorage` per pattern as a convenience; export is the durable format (FR-6.x).
- **Code editor:** CodeMirror 6 with a small CrochetPARADE mode (stitch names, `@`, labels, `COLOR:`/`DEF:`/`DOT:` lines) and inline parser errors from the worker.
- **Row ↔ stitch links:** `Stitch.row` maps to `PatternRow` through the order of the assembled text (§4). Hover and click on either side highlight the other (FR-3.2).

## 10. Testing

### 10.1 Unit tests

- `segment.ts`: a table of English snippets → rows, counts and labels, including ranges (`Rnds 4–7`), wrapped lines and UK terms.
- `validator.ts`: known-good and known-bad snippets, including one of each `ParseErrorKind`.
- `compare.ts`: pairs that must match (same graph, different labels or brackets: `[2sc,>,dc]*3` vs `2sc,dc,2sc,dc,2sc`) and pairs that must not (sc swapped for tr, as in the paper's cone example).
- `loop.ts`: the translator loop with a fake model that returns scripted responses, to test repair, `amendPrevious` rejection, and best-attempt ranking without API calls.
- `providers/*`: each adapter against recorded provider responses (no network): request mapping (schema, effort, cache markers), usage and stop-reason normalisation, error classes, and replaying `raw` in repair turns.
- `keys.ts`: encrypt → decrypt round trip; a ciphertext moved to another user or provider fails; the key never appears in logs or API responses (a test greps captured log output for a planted key).
- Server: a guest translates with a header key and nothing about the key is written to the database, cache or logs; `/api/keys` and `/api/settings` reject requests without a session; a missing key gives 409; a cross-origin `Origin` is rejected; one user cannot read, replace or use another user's key.

### 10.2 Conformance

Every CrochetPARADE example pattern in the vendored `parse64.js` must parse, and its `StitchGraph` must round-trip through `graph.ts` with the same stitch count. This runs on every vendor upgrade.

### 10.3 Evaluation as a gate

A small fixed subset (our own patterns only, about 20) runs in CI on prompt changes, through the Batches API, and fails the build if structure match drops by more than 5 points from the last accepted run. The full datasets run by hand, not in CI, because of cost and licences.

## 11. Milestones

Refines REQUIREMENTS.md §10 with the spikes this spec depends on.

| Milestone | Deliverables | Exit check |
| --- | --- | --- |
| **M0 Spike** (done) | Vendor CrochetPARADE; validator wrapper in Node and a Worker; DOT → `StitchGraph`; call the solver from a Worker; render structure mode | Conformance suite passes (§10.2); 5 examples render as on crochetparade.org (§6.5) |
| **M1 Evaluation first** (done) | Dataset loaders (§7.1); `compare.ts`; rule-based baseline scores | Baseline table for StitchSwitch and CrochetBench (§7.4) |
| **M2 Translate** (built for Claude; providers and sweep pending) | Segmentation; prompt v1; row loop with repair; `eval run` with `--batch`; provider-neutral `TranslatorModel` with Anthropic, OpenAI-compatible (OpenAI, OpenRouter) and Gemini adapters (§5.6); first model and effort sweep across providers; `models.json` | Row mode beats the rule-based baseline on structure match with at least one model per provider |
| **M3 App** | Server with guest keys, optional accounts and encrypted key store (§8); key settings and model picker; review UI; code editor; row ↔ stitch links | A new user, without an account, enters their own key, translates and renders a sample pattern unaided; signing in and saving the key also works |
| **M4 Yarn** | Templates for the MVP stitch set; frames; tube meshes; levels of detail | Stitch-recognition test passes (REQUIREMENTS §9) |
| **M5 Polish** | Exports, incremental layout, performance | NFR-1 and NFR-2 met |

Evaluation comes before the translator on purpose: without the harness there is no way to tell whether a prompt change helped.

## 12. Open questions

1. **StitchSwitch class codes.** What do `X` and `Y` in the `Variation` column mean, and does blank mean class B? Ask the authors; until then, report StitchSwitch results overall, not per class.
2. **StitchSwitch licence.** Ask the authors whether evaluation results may be published and whether the data may be redistributed.
3. ~~**Parser internals (M0).**~~ Settled: see §3.2 and §3.3.
4. ~~**`amendPrevious`.**~~ Settled: "labels only" is checked by comparing stitch graphs (§5.5).
5. **Whole vs row mode.** If whole-pattern translation scores better on structure match, the app may use it for the first pass and row mode only for repairs. Decide from M2 results.
6. **One prompt for every provider?** The prompt was written and tuned on Claude. If another provider's models score much worse, decide whether to tune a per-provider prompt version (§5.7) or only recommend the models that do well.
7. **Hosting the key store.** Where the server runs, and whether `KEY_ENCRYPTION_KEY` moves to a cloud KMS before launch. Needed before M3 ships to real users.
8. **A free tier.** Should new users without a key get a few translations on a key the app pays for? Not in this spec; it would need the per-IP and per-user budgets the original proxy design had.

## 13. References

- [REQUIREMENTS.md](./REQUIREMENTS.md), [RELATED_WORK.md](./RELATED_WORK.md), [CROCHET_CONVENTIONS.md](./CROCHET_CONVENTIONS.md), [MATH.md](./MATH.md).
- CrochetPARADE: [repository](https://github.com/stassev/CrochetPARADE): `parse64.js` (`processText` returns `[dot, simpleDot]`), `translator_ui.js`, `deterministic_translator.js`, `graph.cpp`.
- StitchSwitch dataset: [rachaelteresa/StitchSwitch](https://github.com/rachaelteresa/StitchSwitch) (last push 2025-04-15; no licence file).
- CrochetBench: [Peiyu-Georgia-Li/crochetBench](https://github.com/Peiyu-Georgia-Li/crochetBench) (code MIT, data CC BY-NC 4.0; Task D data in `data/`; headless validator `benchmark_task/verify_crochet_pattern.js`).
- Dias and Karim (2025), local copy [05499-SuSS.DiasR.pdf](./05499-SuSS.DiasR.pdf).
