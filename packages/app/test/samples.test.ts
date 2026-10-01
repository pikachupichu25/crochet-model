import { segmentPattern } from "@crochet-model/core";
import { createNodeValidator } from "@crochet-model/core/node";
import { countMatches, lastRowCount } from "@crochet-model/translator";
import { describe, expect, it } from "vitest";
import { SAMPLES } from "../src/samples.ts";

const { validate } = createNodeValidator();

describe("samples", () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}: one translation per row, parsing with every stated count`, () => {
      const { rows, ukTerms } = segmentPattern(sample.english);
      expect(ukTerms).toBe(false);
      expect(rows).toHaveLength(sample.cp.length);
      let prefix = "";
      for (const [i, row] of rows.entries()) {
        prefix = [prefix, sample.cp[i]].filter(Boolean).join("\n");
        const result = validate(prefix);
        expect(result.error?.message, `${row.label}`).toBeUndefined();
        expect(countMatches(lastRowCount(result), row.statedCount), `${row.label} count`).toBe(true);
        if (row.span > 1) expect(sample.cp[i]!.split("\n")).toHaveLength(row.span);
      }
    });
  }
});
