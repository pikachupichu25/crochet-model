// Every example pattern bundled with CrochetPARADE must parse with the
// vendored parser (SPEC.md §10.2). Run after every vendor upgrade.

import { describe, expect, it } from "vitest";
import {
  bundledExamples,
  createNodeValidator,
} from "../src/cp/nodeParser.ts";

// Upstream examples that fail with upstream's own parser at the vendored commit.
const KNOWN_FAILURES: Record<string, string> = {
  // uses a `cl3` stitch that is not in the built-in Dictionary
  textSwatch1: "stitch_not_defined",
};

// The parser itself is slow on these (measured at the vendored commit:
// textDoily 28 s, textChevron 3 s). They run only with CP_SLOW=1, via
// `npm run test:conformance`.
const SLOW = new Set(["textDoily", "textChevron"]);
const runSlow = process.env.CP_SLOW === "1";

const examples = bundledExamples();
const { validate } = createNodeValidator();

describe("bundled CrochetPARADE examples", () => {
  it("finds the example patterns", () => {
    expect(Object.keys(examples).length).toBeGreaterThanOrEqual(50);
  });

  for (const [name, text] of Object.entries(examples)) {
    const slow = SLOW.has(name);
    it.skipIf(slow && !runSlow)(name, { timeout: slow ? 120_000 : 10_000 }, () => {
      const result = validate(text);
      if (name in KNOWN_FAILURES) {
        expect(result.error?.kind).toBe(KNOWN_FAILURES[name]);
        return;
      }
      expect(result.error?.message).toBeUndefined();
      expect(result.rows.length).toBeGreaterThan(0);
    });
  }
});
