// Every example pattern bundled with CrochetPARADE must parse with the
// vendored parser (SPEC.md §10.2). Run after every vendor upgrade.

import { describe, expect, it } from "vitest";
import { parseStitchGraph } from "../src/cp/graph.ts";
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

// Stitch types that need not be worked into anything.
const FOUNDATION = new Set(["ch", "ring", "hidden"]);

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

      // The StitchGraph round-trips: same stitches per row as the row
      // summary, every edge end is a node, and every stitch that is not a
      // foundation is worked into something.
      const graph = parseStitchGraph(result.graphJson!);
      const perRow = result.rows.map((r) =>
        Object.values(r.byType).reduce((a, b) => a + b, 0),
      );
      const graphPerRow = perRow.map(() => 0);
      for (const s of graph.stitches) graphPerRow[s.row]! += 1;
      expect(graphPerRow).toEqual(perRow);
      const ids = new Set(graph.nodes.map((n) => n.id));
      expect(graph.edges.filter((e) => !ids.has(e.tail) || !ids.has(e.head))).toEqual([]);
      const unattached = graph.stitches.filter(
        (s) => !FOUNDATION.has(s.type) && s.workedInto.length === 0,
      );
      expect(unattached.map((s) => `${s.id} ${s.type}`)).toEqual([]);
    });
  }
});
