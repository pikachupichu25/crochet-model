# crochet-model

Turn a crochet pattern written in ordinary English into [CrochetPARADE](https://www.crochetparade.org/) code with an LLM, check it with the CrochetPARADE parser, and show it as a 3D model that looks like real yarn.

Status: early. The pattern validator, the layout solver (in Web Workers) and a ball-and-stick structure view are built. Translation and the yarn renderer are not built yet.

## Layout

```text
docs/                   design docs (start with REQUIREMENTS.md, then SPEC.md)
packages/core/          TypeScript core: validator, stitch graph, layout, CLI
packages/app/           Vite web app: workers and 3D views
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

## Licence

GPL-3.0-or-later, because the CrochetPARADE code in `vendor/` is GPLv3.
