// Node host for the vendored CrochetPARADE parser.
//
// The parser is compiled once and run in a fresh vm context for every call,
// so no state (DEF: stitches, labels, counters) can leak between patterns. A
// fresh context costs well under a millisecond.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  createValidator,
  runInScope,
  type ParserHost,
  type ParserScope,
} from "./validator.ts";

export const PARSER_FILE = "parse64.js";

export const VENDOR_DIR = fileURLToPath(
  new URL("../../../../vendor/crochetparade/", import.meta.url),
);

const DEFAULT_PARSER_PATH = `${VENDOR_DIR}${PARSER_FILE}`;

const silent = () => {};
export const silentConsole = {
  log: silent,
  info: silent,
  warn: silent,
  error: silent,
  debug: silent,
  trace: silent,
};

export function createNodeParserHost(
  parserPath: string = DEFAULT_PARSER_PATH,
): ParserHost {
  const script = new vm.Script(readFileSync(parserPath, "utf8"), {
    filename: PARSER_FILE,
  });

  return {
    run(text, options) {
      // Warnings go through alert() and are also kept in the WARNINGS global.
      const context = vm.createContext({ console: silentConsole, alert: silent });
      script.runInContext(context);
      return runInScope(context as unknown as ParserScope, text, options);
    },
  };
}

/** A validator backed by the vendored parser. */
export function createNodeValidator(parserPath?: string) {
  return createValidator(createNodeParserHost(parserPath));
}

/** Names and texts of the example patterns bundled in parse64.js (`text…` globals). */
export function bundledExamples(
  parserPath: string = DEFAULT_PARSER_PATH,
): Record<string, string> {
  const context = vm.createContext({ console: silentConsole, alert: silent });
  new vm.Script(readFileSync(parserPath, "utf8")).runInContext(context);
  const examples: Record<string, string> = {};
  for (const [name, value] of Object.entries(context)) {
    if (/^text[A-Z]/.test(name) && typeof value === "string") {
      examples[name] = value;
    }
  }
  return examples;
}

/** Names of the stitches built into parse64.js (its `Dictionary`), in its order. */
export function builtinStitches(parserPath: string = DEFAULT_PARSER_PATH): string[] {
  const context = vm.createContext({ console: silentConsole, alert: silent });
  new vm.Script(readFileSync(parserPath, "utf8")).runInContext(context);
  return Object.keys((context as { Dictionary?: object }).Dictionary ?? {});
}
