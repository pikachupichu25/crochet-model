// Runs the vendored CrochetPARADE parser off the main thread.

import { createScopeValidator } from "@crochet-model/core";
import parserSource from "../../../../vendor/crochetparade/parse64.js?raw";
import type { ParserResponse, ValidateRequest } from "./protocol.ts";

const validator = createScopeValidator(parserSource);

self.onmessage = (event: MessageEvent<ValidateRequest>) => {
  const { id, text, dimension, withGraph = true } = event.data;
  const started = performance.now();
  let response: ParserResponse;
  try {
    const result = validator.validate(text, { dimension });
    if (!withGraph) delete result.graphJson;
    response = { id, type: "result", result, ms: performance.now() - started };
  } catch (error) {
    // validate() reports pattern errors in its result; this is a bug in our code.
    response = { id, type: "error", message: String((error as Error)?.message ?? error) };
  }
  self.postMessage(response);
};
