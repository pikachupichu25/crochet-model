# crochet-model

Turn a crochet pattern written in ordinary English into [CrochetPARADE](https://www.crochetparade.org/) code with an LLM, check it with the CrochetPARADE parser, and show it as a 3D model that looks like real yarn.

Status: early. The pattern validator, the layout solver (in Web Workers), a ball-and-stick structure view, the evaluation harness (with scores for CrochetPARADE's rule-based translator), the LLM translation loop, and the app with its server (guest keys, optional accounts with saved keys, review UI, row ↔ stitch links) are built. The translator has not yet been scored against the API. The yarn renderer is not built yet.

## Layout

```text
docs/                   design docs (start with REQUIREMENTS.md, then SPEC.md)
packages/core/          TypeScript core: validator, stitch graph, layout, CLI
packages/app/           React web app: pattern input, review, model view; harness.html is the M0 developer harness
packages/server/        API server: translation with the user's key, accounts, encrypted saved keys, cache
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
npm run server       # the API on port 5181 (translation, accounts)
npm run dev          # the app on http://localhost:5180, proxying /api to the server
npm run dev:all      # both of the above in one terminal; Ctrl-C stops both
npm test             # unit tests
npm run typecheck
```

The samples work without the server or a key. Translating needs the server and an API key for one of the providers; accounts are optional and only save keys and settings. In development the server keeps its SQLite file and generated secrets in `packages/server/data/` (git-ignored) and prints verification and password-reset links to its output instead of sending mail. See [SPEC.md §8](docs/SPEC.md) for `KEY_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and the other settings.

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

Evaluate the LLM translator. `--provider` picks `anthropic` (the default, with `claude-opus-5-5`), `openrouter`, `gemini` or `openai`; the key comes from `ANTHROPIC_API_KEY` (or `ant auth login`), `OPENROUTER_API_KEY`, `GEMINI_API_KEY` or `OPENAI_API_KEY`. Other providers need `--model`, and `--batch` is Anthropic only. Every run prints a cost estimate and refuses above US$5, or when no price is on file for the model, unless you add `--yes`. `--provider claude-code` runs `claude -p` on your Claude Code login instead of an API key (`claude auth login` first): it counts against your plan's usage limits, has no US$ cost guard, and is for quick checks, not the final sweep:

```bash
npm run eval -- run --translator llm --dataset stitchswitch --limit 5
npm run eval -- run --translator llm --dataset stitchswitch --effort low --batch --yes
npm run eval -- run --translator llm --dataset stitchswitch --provider openrouter --model anthropic/claude-sonnet-5-5 --limit 5
npm run eval -- run --translator llm --dataset stitchswitch --provider claude-code --model sonnet --limit 5
npm run eval -- compare packages/eval/runs/<a> packages/eval/runs/<b>
```

The datasets are for local evaluation only: StitchSwitch states no licence and CrochetBench data is CC BY-NC 4.0.

## Licence

GPL-3.0-or-later, because the CrochetPARADE code in `vendor/` is GPLv3.
