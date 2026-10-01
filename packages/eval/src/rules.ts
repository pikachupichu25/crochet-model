// The rule-based baseline (docs/SPEC.md §7.4): CrochetPARADE's own
// English → CrochetPARADE translator, run headless.
//
// crochetparade.org translates in two halves. Python (in Pyodide) segments
// the English and proposes candidates for each row; deterministic_translator.js
// then picks and checks them against the parser (`buildStaticReviewModel`)
// and assembles the "checked CP block" the user sees. Here Python runs as a
// `python3` subprocess and the JS half in Node, with the default choices.
//
// Two outputs are kept:
// - `cp`: the checked block, as the site shows it. Rows Python marked as not
//   parsed are left out, so it often parses but is incomplete.
// - `compiledCp`: Python's own whole-pattern compile, with every row it could
//   read.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { PARSER_FILE, VENDOR_DIR } from "@crochet-model/core/node";

const BRIDGE = fileURLToPath(new URL("./rules_bridge.py", import.meta.url));
const TIMEOUT_MS = 120_000;

export interface RulesOutput {
  cp: string;
  compiledCp: string;
  /** Rows the translator found (instructions, sections, notes). */
  rows: number;
  /** Instruction rows whose candidate made it into `cp`. */
  instructionsIncluded: number;
  instructions: number;
  /** Set when the translator itself failed; `cp` is then empty. */
  error?: string;
}

interface Candidate {
  cpLines: string[];
}
interface BaseModel {
  previewCpText: string;
  rows: { kind: string }[];
}
interface StaticModel {
  previewCpText: string;
  rows: { kind: string; include: boolean; selectedCandidate: Candidate }[];
}
interface DeterministicTranslator {
  buildStaticReviewModel(base: BaseModel, options: object): StaticModel;
  _internal: { countFromStats(stats: object, dictionary: object): number };
}

const translator = createRequire(import.meta.url)(
  `${VENDOR_DIR}deterministic_translator.js`,
) as DeterministicTranslator;

// The site's browserValidator: parse, and report the last row's count from
// the parser's STATS global, as the translator expects.
const parser = new vm.Script(readFileSync(`${VENDOR_DIR}${PARSER_FILE}`, "utf8"), {
  filename: PARSER_FILE,
});
const silent = () => {};
const quiet = { log: silent, info: silent, warn: silent, error: silent, debug: silent, trace: silent };

function siteValidator(cpText: string) {
  const text = String(cpText ?? "").trim();
  if (!text) return { ok: true, error: "", lastCount: null };
  const scope = vm.createContext({ console: quiet, alert: silent }) as {
    processText?: (t: string, j: string) => unknown;
    STATS?: Record<string, object>;
    Dictionary?: object;
  };
  parser.runInContext(scope);
  try {
    scope.processText!(text, "");
    const stats = scope.STATS ?? {};
    const rows = Object.keys(stats).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const last = rows.length ? stats[rows[rows.length - 1]!] : undefined;
    return {
      ok: true,
      error: "",
      lastCount: last ? translator._internal.countFromStats(last, scope.Dictionary ?? {}) : null,
    };
  } catch (e) {
    return { ok: false, error: String((e as { message?: unknown })?.message ?? e), lastCount: null };
  }
}

export function translateWithRules(english: string, prevCount?: number): RulesOutput {
  const py = spawnSync("python3", [BRIDGE], {
    input: JSON.stringify({ text: english, prevCount: prevCount ?? null }),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (py.error || py.status !== 0) {
    const why = py.error?.message ?? py.stderr.trim().split("\n").pop() ?? `exit ${py.status}`;
    return { cp: "", compiledCp: "", rows: 0, instructions: 0, instructionsIncluded: 0, error: why };
  }
  const base = JSON.parse(py.stdout) as BaseModel;
  const model = translator.buildStaticReviewModel(base, { validator: siteValidator, choices: {} });
  const instructions = model.rows.filter((r) => r.kind === "instruction");
  return {
    cp: model.previewCpText,
    compiledCp: base.previewCpText,
    rows: model.rows.length,
    instructions: instructions.length,
    instructionsIncluded: instructions.filter(
      (r) => r.include && r.selectedCandidate.cpLines.some(isCode),
    ).length,
  };
}

/** A line the parser reads: not blank and not a `#` comment. */
export function isCode(line: string): boolean {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
}

export function codeOnly(cp: string): string {
  return cp.split("\n").filter(isCode).join("\n");
}
