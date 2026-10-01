# Vendored CrochetPARADE

Unmodified files from [stassev/CrochetPARADE](https://github.com/stassev/CrochetPARADE) by Svetlin Tassev, licensed GPLv3 (see [LICENSE](./LICENSE)).

| File | Role |
| --- | --- |
| `parse64.js` | Pattern parser. `processText(text, "")` returns `[graphJson, simpleDot]` or throws. Also defines the built-in stitch `Dictionary` and about 60 example patterns (`text…` globals). |
| `graph64.js`, `graph64.wasm` | Layout solver (Emscripten build of `graph.cpp`). Exports `ccall`, `_malloc`, `_free`, `stringToUTF8`, `UTF8ToString`, and `_performLayout`. |
| `deterministic_translator.js` | Rule-based English → CrochetPARADE translator, browser half: ranks and validates the candidates the Python half proposes (`buildStaticReviewModel`). The evaluation baseline (docs/SPEC.md §7.4). |
| `python/crochetparade_translator/` | Rule-based translator, Python half (standard library only). crochetparade.org runs it in Pyodide; the evaluation runs it with `python3`. |
| `package.json` | Ours, not upstream: marks these files as CommonJS inside this ESM repository. |

- Upstream commit: see [COMMIT](./COMMIT).
- Checksums: see [SHA256SUMS](./SHA256SUMS) (`shasum -a 256 -c SHA256SUMS` in this directory).

## Rules

- **Do not edit these files.** Adapt them in wrapper code (`packages/core/src/cp/`), so an upgrade is a plain file copy.
- **To upgrade:** copy the new files, update `COMMIT` and `SHA256SUMS`, then run `npm test`. The conformance test parses every built-in example pattern and fails if a previously passing one breaks.
- The file names carry a version (`parse64.js`). If upstream renames them, update `PARSER_FILE` in `packages/core/src/cp/nodeParser.ts`.
