// Browser host for the vendored CrochetPARADE parser, for use inside a Web
// Worker (no `vm` there). The parser source is wrapped in a function that is
// compiled once and called once per parse: every call gets fresh top-level
// variables, so no DEF: stitch, label or counter leaks between patterns.
//
// Unlike the Node vm host this is not a full sandbox: an assignment to an
// undeclared variable inside parse64.js would reach the worker's global scope.
// That is acceptable in a worker that does nothing else.

import {
  createValidator,
  runInScope,
  type ParserHost,
  type ParserScope,
} from "./validator.ts";

export function createScopeParserHost(parserSource: string): ParserHost {
  const makeScope = new Function(
    "alert",
    "console",
    `${parserSource}
return {
  processText: processText,
  get WARNINGS() { return WARNINGS; },
  get DIM() { return DIM; },
  set DIM(value) { DIM = value; },
};`,
  ) as (alert: (msg: unknown) => void, console: unknown) => ParserScope;

  const silent = () => {};
  const quiet = { log: silent, info: silent, warn: silent, error: silent, debug: silent, trace: silent };

  return {
    run(text, options) {
      return runInScope(makeScope(silent, quiet), text, options);
    },
  };
}

export function createScopeValidator(parserSource: string) {
  return createValidator(createScopeParserHost(parserSource));
}
