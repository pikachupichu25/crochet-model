# crochet-model

Turn a crochet pattern written in ordinary English into [CrochetPARADE](https://www.crochetparade.org/) code with an LLM, check it with the CrochetPARADE parser, and show it as a 3D model that looks like real yarn.

Status: early. The pattern validator, the layout solver (in Web Workers), a ball-and-stick structure view, the evaluation harness (with scores for CrochetPARADE's rule-based translator) and the LLM translation loop are built. The translator has not yet been scored against the API. The review UI and the yarn renderer are not built yet.

## Layout

```text
docs/                   design docs (start with REQUIREMENTS.md, then SPEC.md)
packages/core/          TypeScript core: validator, stitch graph, layout, CLI
packages/app/           Vite web app: workers and 3D views
packages/translator/    LLM translation loop: prompt, provider adapters (Anthropic, OpenRouter, Gemini, OpenAI), validate and repair
packages/eval/          evaluation harness: dataset loaders, baseline runs, metrics
vendor/crochetparade/   pinned copy of the CrochetPARADE parser and solver (GPLv3)
```

## Docs

- [REQUIREMENTS.md](docs/REQUIREMENTS.md): what the app must do and why
- [SPEC.md](docs/SPEC.md): how it is built (modules, types, translation loop, evaluation, renderer)
- [CROCHET_CONVENTIONS.md](docs/CROCHET_CONVENTIONS.md): pattern abbreviations and US/UK terms
- [MATH.md](docs/MATH.md): layout models beyond CrochetPARADE's spring graph
- [RELATED_WORK.md](docs/RELATED_WORK.md): survey of parsers and LLM translation work

## Getting started

Needs Node 22.6 or later.

```bash
npm install
npm run dev          # start the web app
npm test             # unit tests
npm run typecheck
```

Validate a CrochetPARADE pattern from the command line:

```bash
npm run validate -- pattern.cp
npm run validate -- --text 'ring\n6sc\n6*[sc2inc]'
```

Exit code is 0 when the pattern parses and 1 when it does not; add `--json` for the full result. Run `npm run test:conformance` after upgrading the vendored parser.

Evaluate CrochetPARADE's rule-based translator (needs `python3`; see [SPEC.md §7](docs/SPEC.md)):

```bash
npm run eval -- fetch                                      # download the datasets (git-ignored)
npm run eval -- run --translator rules --dataset all       # about 3 minutes
npm run eval -- report packages/eval/runs/<run>
```

Evaluate the LLM translator. `--provider` picks `anthropic` (the default, with `claude-opus-5-5`), `openrouter`, `gemini` or `openai`; the key comes from `ANTHROPIC_API_KEY` (or `ant auth login`), `OPENROUTER_API_KEY`, `GEMINI_API_KEY` or `OPENAI_API_KEY`. Other providers need `--model`, and `--batch` is Anthropic only. Every run prints a cost estimate and refuses above US$5, or when no price is on file for the model, unless you add `--yes`:

```bash
npm run eval -- run --translator llm --dataset stitchswitch --limit 5
npm run eval -- run --translator llm --dataset stitchswitch --effort low --batch --yes
npm run eval -- run --translator llm --dataset stitchswitch --provider openrouter --model anthropic/claude-sonnet-5-5 --limit 5
npm run eval -- compare packages/eval/runs/<a> packages/eval/runs/<b>
```

The datasets are for local evaluation only: StitchSwitch states no licence and CrochetBench data is CC BY-NC 4.0.

## Licence

GPL-3.0-or-later, because the CrochetPARADE code in `vendor/` is GPLv3.
