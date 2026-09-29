# Related Work: Computational Crochet Pattern Normalization

A survey of projects that use parsers, formal languages, or LLMs to standardize
crochet patterns. Compiled 2026-09-28/29 from web searches.

> **Verification note:** Section 1 comes from paper abstracts, READMEs, and
> search-result summaries. In Section 2, the Dias & Karim paper (§2.1) was read
> in full from the local PDF on 2026-09-29. CrochetBench (§2.2) is still from
> its abstract and repository. Items marked *(unverified)* were not opened
> directly.

---

## 1. Landscape (besides CrochetPARADE)

### 1.1 Academic: formal languages and parsers

- **Parsing Semi-structured Languages: A Crochet Pattern to Diagram Translation**
  by L. van Staden & L. van Zijl (Springer, 2023).
  Shows that the semi-structured English of crochet patterns is regular enough
  to parse with standard multi-phase compiler techniques. Parser 1 turns a
  written pattern into a uniform structured representation. Parser 2 turns that
  into a crochet diagram, which is used to measure how well parsing worked.
  *This is the closest prior work to parsing **normal** written patterns.*
- **Klara Seitz et al., Hasso Plattner Institute**
  - *Language and Tool Support for 3D Crochet Patterns: Virtual Crochet with a
    Graph Structure* (HPI Technical Report 137, 2021). A detailed study of how
    patterns are written, a stitch-graph representation used as a DSL, and a
    projectional editor with 2D and 3D views.
  - *Digital Crochet: Toward a Visual Language for Pattern Description*
    (ACM Onward! / SPLASH 2022). A visual, graph-based pattern language.
- **PKF (XML-based format)** and **Digital Representation of Crochet Symbols
  Sets**. Crochet stitch symbols stored as XML graphic primitives for use in
  charting software. *(A search snippet attributed PKF to "Digital Crochet", which
  doesn't fit that paper's abstract. Not verified.)*
- **AmiGo: Computational Design of Amigurumi Crochet Patterns**
  (ACM Symposium on Computational Fabrication, 2022). Works in the opposite
  direction: 3D mesh → stitch graph → readable instructions using only
  sc / inc / dec.
- **Design tool for automated crocheting of fabrics**. A Python design tool that
  produces instructions for a prototype crochet machine.

### 1.2 Open-source parsers and pattern languages

| Project | Description |
|---|---|
| [christel](https://github.com/fwolfst/christel) (Ruby) | "Crochet Pattern Language" (CPL), Treetop grammar, `cpl` CLI. Stated goal: become the standard way to write patterns. Small, not very active. Syntax: `10 ch, 4 sc`, `6 sc in ring, slst`. |
| CROML (Crochet Obvious Minimal Language) | Minimal language parsed with regex and converted to JSON. Described in a [Medium post](https://medium.com/@kagibari.crocheting/developing-croml-crochet-obvious-minimal-language-cf91184fc560). *(unverified)* |
| [stitch-grapher](https://github.com/bilgesucakir/stitch-grapher) (Java/Spring) | Custom DSL parser (`(sc, inc)x6`, `3sc`), validation, stitch-connectivity graph, 2D/3D rendering. Early stage. |
| [Crochet-Pattern-Checker](https://github.com/arbabkhan007/Crochet-Pattern-Checker) (Python) | Parses US-style pattern text, checks stitch math, outputs SVG, OBJ meshes, and PDFs. Early stage. |
| [Crochendo](https://github.com/charln2/Crochendo) (Android/Java) | Parses raw text into Row/Stitch objects and fills in implied steps. Early stage; mainly scarves. |
| [Crochet-Pattern-Process](https://github.com/TalMizrahii/Crochet-Pattern-Process) (Java) | Regex over amigurumi text to estimate time, yarn, and cost. |
| [obsidian-crochet-weaver](https://github.com/evanlyu/obsidian-crochet-weaver) | Obsidian plugin that draws stitch charts from text. *(unverified)* |
| [CrochetPARADE_Remesher](https://github.com/stassev/CrochetPARADE_Remesher) | 3D model → CrochetPARADE instructions. *(unverified)* |
| [CrochetPhoto2Pattern](https://github.com/paulkooer/CrochetPhoto2Pattern) | AI photo → amigurumi pattern, checked with deterministic rules. *(unverified)* |
| [crochet3d.com](https://crochet3d.com/editor), [Amigurumi Designer](https://amigurumi-designer.vercel.app/) | Web apps that turn `sc, inc, dec, ch` + repeats into a live 3D model. *(unverified)* |

### 1.3 Nearby work

- **Crochet Charts** by Stitch Works, open source under GPLv3
  ([iPenguin/CrochetCharts](https://github.com/iPenguin/CrochetCharts)).
  A chart editor with a stitch symbol library; not a parser.
- **Craft Yarn Council standards**: the human-written standard for crochet
  abbreviations and symbols. A good mapping target for normalization.
- **Knitting is further along**: KnitSpeak, [knotty](https://github.com/t0mpr1c3/knotty),
  KnitPick, KnitA11y (both compile written patterns into stitch graphs), and
  CMU's formal semantics for Knitout. Useful design examples.

### 1.4 Observations

- Only van Staden & van Zijl (rule-based) and Dias & Karim (LLM, see §2.1)
  parse **normal** written patterns. Every other project defines its own new syntax.
- The most common internal model is a **stitch graph** (Seitz, AmiGo,
  stitch-grapher, KnitA11y).

---

## 2. LLMs converting crochet patterns → CrochetPARADE

### 2.1 Dias & Karim (Heriot-Watt University)

*Translation of User Crochet Patterns to CrochetPARADE Syntax Using Large
Language Models.* AAAI Summer Symposium Series 2025, Vol. 6 No. 1, pp. 200–208.
[Paper](https://ojs.aaai.org/index.php/AAAI-SS/article/view/36054) ·
local copy [05499-SuSS.DiasR.pdf](./05499-SuSS.DiasR.pdf) (read in full 2026-09-29) ·
dataset [rachaelteresa/StitchSwitch](https://github.com/rachaelteresa/StitchSwitch)

- **Problem:** CrochetPARADE's syntax is precise but differs from how crocheters
  normally write patterns. Converting by hand needs spatial reasoning and an
  understanding of how stitches fit together, which beginners find hard.
- **Data:** 109 English patterns, each hand-translated to CrochetPARADE,
  checked by parsing in CrochetPARADE, and compared by eye with the pattern's
  photo where one existed. Stored as CSV with the original pattern, the
  translation and the intended shape.
  - Sources: patterns written by the authors, plus public-domain patterns from
    freevintagecrochet.com and antiquepatternlibrary.org.
  - Each pattern is tagged with feature classes:

    | Class | Feature | Example |
    | --- | --- | --- |
    | B | Base: stitches, repeats, increases, decreases (every pattern has it) | `6*[sc,sc2inc]` |
    | L | Labels | `2sc.A` |
    | A | Attachment points | `sc@A` |
    | P | "Premature endings" (`<`, `>` in repeats) | `[2sc,>,dc]*3` |

    Combinations such as LA (labels and attachment together) are reported
    separately. Counters and advanced attachment ("subset C") are **not** in the
    dataset.
  - Split: 8 train/test folds, about 1/8 of each class held out per fold. No
    validation set.
- **Models:** all open, 3B–8B: Llama 3.2 3B, Llama 3.1 8B, DeepSeek-R1-Distill-Llama-8B,
  Qwen2 7B, Mistral 7B. No hosted frontier model was tested.
- **Methods:** baseline (no examples), few-shot (3 example patterns prepended),
  and LoRA fine-tuning with Unsloth, 8-fold cross-validation.
- **Metrics:**
  - *Correctness* = the output parses in CrochetPARADE with no error.
  - *Accuracy* = the output builds the same thing as the reference: stitch
    counts and stitch types compared by hovering over stitches in
    CrochetPARADE's 3D view. This was done **by hand** (over 1,500 comparisons),
    because exact text match was too strict (label names, redundant brackets).
  - chrF (character n-gram F-score) between output and reference.
- **Results (overall, %):**

  | Model | Few-shot accuracy | Few-shot correctness | Fine-tuned accuracy | Fine-tuned correctness | chrF (fine-tuned) |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Llama 3.2 3B | 8.7 | 17.5 | 46.0 | 68.0 | 0.737 |
  | Llama 3.1 8B | 22.3 | 35.0 | 69.2 | 79.8 | 0.819 |
  | Mistral 7B | 18.4 | 34.0 | 69.2 | 86.5 | 0.837 |
  | Qwen2 7B | 24.3 | 40.8 | 70.2 | **87.5** | 0.839 |
  | DeepSeek-R1-Distill-Llama-8B | 15.5 | 24.0 | **74.0** | 82.5 | **0.851** |

  - Baseline (no examples): no model produced valid output. Models invented
    syntax (`REP`), stitch names (`slst` for `ss`), even a meaning for the
    name "CrochetPARADE".
  - Few-shot: every model scored 0% accuracy on classes L and LA.
  - Fine-tuned per class: B is easy (84–92% accuracy); LA is the hardest
    (14–43%).
- **Error analysis** (parser errors of the fine-tuned models):
  - "Label not Found": an attachment refers to a label never defined, or
    defined later. The most common error.
  - "Stitch not Defined": wrong stitch names (`slst`, `tc`).
  - "ID not Found": a row has more stitches than the row below can hold.
  - One stitch type swapped (sc for tr) still parses, but turns a cone into a
    disc. Correctness alone misses this.
- **Caveats when reading the numbers:**
  - The abstract and conclusion call 74% "syntactic accuracy", but in the
    tables 74% is *accuracy* (structure match). Correctness for the same model
    is 82.5%.
  - Test sets are small (about 14 patterns per fold) and accuracy was judged by
    hand, so differences of a few points between models are not meaningful.
- **Future work named by the authors:** add subset C (counters, advanced
  attachment); reinforcement learning; user feedback on outputs.
- **Dataset as published** (checked 2026-09-29): the repository holds
  `README.md` and `StitchSwitchDataset.csv` (109 rows; columns
  `Original Pattern`, `crochetPARADE Pattern`, `Name`, `Variation`). Last push
  2025-04-15. **No licence file**, so default copyright applies: fine for local
  evaluation, but ask the authors before redistributing or publishing results.
  The fold splits used in the paper are not published. The `Variation` column
  uses `A`, `X`, `Y`, `XY`, `YA` and blank (51 rows), not the paper's B/L/A/P,
  and the mapping is not documented.

### 2.2 CrochetBench

*CrochetBench: Can Vision-Language Models Move from Describing to Doing in
Crochet Domain?* arXiv [2511.09483](https://arxiv.org/abs/2511.09483)
(Nov 2025, revised Jul 2026).
Code: [Peiyu-Georgia-Li/crochetBench](https://github.com/Peiyu-Georgia-Li/crochetBench)

- **Scope:** 6,085 patterns across 55 categories, >98% with images, from
  beginner to expert.
- **How it uses CrochetPARADE:** CrochetPARADE's DSL is the intermediate
  representation. Model output is compiled, so validity and structure are
  checked automatically instead of by text similarity.
- **Tasks:** stitch classification, instruction grounding, and two conversion
  tasks:
  - written pattern → CrochetPARADE
  - photo of finished piece → CrochetPARADE
- **Main finding:** scores drop sharply when grading moves from "looks similar"
  to "compiles and builds the right thing." Models struggle with:
  - keeping stitch counts and structure consistent over long patterns
  - reasoning about 3D shape
  - capturing the overall geometry and layout of the finished piece
- **Data for the CrochetPARADE task (Task D), from the repository**
  (checked 2026-09-29; code MIT, **data CC BY-NC 4.0**, patterns from
  Yarnspirations with permission for research and personal use):
  - *D-step*: `data/step_level_test_1_2.json`, `_3_4.json`, `_5_6.json`
    (54 + 36 + 33 = 123 records in the files; the README says 52/34/33). Each record
    is a full pattern plus a `prompt` holding the English and CrochetPARADE of
    the previous steps, then the English of the next step. **There is no gold
    answer for the next step**; it is scored by whether the output parses
    ("Valid Pattern Rate").
  - *D-proj*: `data/project_level_test.json`, 100 full patterns with a photo
    link and no gold CrochetPARADE. Scored by parse rate and by visual
    similarity (DINO) between a CrochetPARADE render and the photo.
  - Validation runs CrochetPARADE's parser headless in Node
    (`benchmark_task/verify_crochet_pattern.js`, using the older `parse57.js`).
  - Scripts exist for Claude, GPT-4o, Gemini, Qwen, Gemma and others, so a new
    model can be run on the same data.
- **Still unknown (PDF not read):**
  - per-model numbers
  - how the step-level prefix CrochetPARADE was produced

### 2.3 Takeaways

- A small fine-tuned open model (8B) handles a good share of text →
  CrochetPARADE conversions.
- Compiling the output catches failures that text similarity misses. Long,
  repetitive patterns and 3D pieces are the hardest.
- *(Inference, not reported by either paper as far as seen)*: the CrochetPARADE
  compiler is a natural feedback signal for a generate → compile → fix loop.

---

## Sources

- [Parsing Semi-structured Languages (Springer)](https://link.springer.com/chapter/10.1007/978-3-031-39652-6_5)
- [Language and Tool Support for 3D Crochet Patterns (HPI PDF)](http://www.hpi.uni-potsdam.de/hirschfeld/publications/media/SeitzLinckeReinHirschfeld_2021_LanguageAndToolSupportFor3DCrochetPatternsVirtualCrochetWithAGraphStructure_HPI137.pdf)
- [Digital Crochet (ACM)](https://dl.acm.org/doi/10.1145/3563835.3567657)
- [Digital Crochet (ResearchGate)](https://www.researchgate.net/publication/365931841_Digital_Crochet_Toward_a_Visual_Language_for_Pattern_Description)
- [Digital Representation of Crochet Symbols Sets](https://www.researchgate.net/publication/363524466_Digital_Representation_of_Crochet_Symbols_Sets)
- [AmiGo (ACM)](https://dl.acm.org/doi/10.1145/3559400.3562005)
- [Design tool for automated crocheting](https://www.researchgate.net/publication/373648708_Design_tool_for_automated_crocheting_of_fabrics)
- [Dias & Karim, AAAI-SS 2025](https://ojs.aaai.org/index.php/AAAI-SS/article/view/36054)
- [CrochetBench (arXiv)](https://arxiv.org/abs/2511.09483)
- [CrochetPARADE](https://github.com/crochetparade/CrochetPARADE)
- [GitHub crochet-pattern topic](https://github.com/topics/crochet-pattern)
- [Craft Yarn Council: How to Read a Crochet Pattern](https://www.craftyarncouncil.com/standards/how-to-read-crochet-pattern)
- [knotty](https://github.com/t0mpr1c3/knotty)
- [KnitA11y (ACM)](https://dl.acm.org/doi/full/10.1145/3706599.3719709)
- [Knitout semantics (CMU)](https://textiles-lab.github.io/publications/2023-knitout-semantics/)
