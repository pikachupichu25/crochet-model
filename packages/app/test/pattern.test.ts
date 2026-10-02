import { segmentPattern, type RowTranslation } from "@crochet-model/core";
import { describe, expect, it } from "vitest";
import { assemble, exportText, guessDimension, parserRowLabel, parserRowOwners, summarise, type Translations } from "../src/pattern.ts";
import { SAMPLES } from "../src/samples.ts";

const t = (rowId: string, cp: string, extra: Partial<RowTranslation> = {}): RowTranslation => ({
  rowId, cp, source: "llm", status: "valid", confidence: "high", assumptions: [], attempts: [], ...extra,
});

function sample(id: string) {
  const s = SAMPLES.find((x) => x.id === id)!;
  const { rows, notes } = segmentPattern(s.english);
  const translations: Translations = Object.fromEntries(rows.map((r, i) => [r.id, t(r.id, s.cp[i]!)]));
  return { rows, notes, translations };
}

describe("pattern helpers", () => {
  it("leaves failed rows out of the code and maps parser rows to English rows", () => {
    const { rows, translations } = sample("ball");
    translations[rows[2]!.id] = t(rows[2]!.id, "6*[sc,sc2inc", { status: "invalid" });
    const { text, parts } = assemble(rows, translations);
    expect(text).not.toContain("6*[sc,sc2inc");
    const owners = parserRowOwners(parts, 2 + 1 + 1 + 4 + 3)!;
    expect(owners[0]).toBe(rows[0]!.id); // the ring
    expect(owners[1]).toBe(rows[0]!.id); // Rnd 1
    expect(owners.filter((o) => o === rows[4]!.id)).toHaveLength(4); // Rnds 5-8
    expect(parserRowOwners(parts, 99)).toBeUndefined();
  });

  it("labels parser rows with their English row, numbering inside a range", () => {
    const { rows, translations } = sample("ball");
    const { parts } = assemble(rows, translations);
    const owners = parserRowOwners(parts, 12)!;
    expect([1, 2, 5, 6, 8, 9].map((r) => parserRowLabel(r, owners, rows))).toEqual(["Rnd 1", "Rnd 2", "Rnd 5", "Rnd 6", "Rnd 8", "Rnd 9"]);
    expect(parserRowLabel(3, undefined, rows)).toBe("4");
  });

  it("exports the English as comments above each row", () => {
    const { rows, notes, translations } = sample("swatch");
    const text = exportText(rows, notes, translations);
    expect(text).toContain("# Row 1: Ch 16.\n16ch,turn\n# Row 2:");
  });

  it("guesses 2D for rows and flat motifs, 3D for shaped rounds", () => {
    for (const s of SAMPLES) {
      const { rows, translations } = sample(s.id);
      expect(guessDimension(rows, translations), s.id).toBe(s.dimension);
    }
  });

  it("counts questions, failures and edits for the summary", () => {
    const { rows, translations } = sample("ball");
    translations[rows[1]!.id]!.status = "needs_answer";
    translations[rows[2]!.id]!.status = "invalid";
    translations[rows[3]!.id]!.source = "user";
    expect(summarise(rows, translations)).toMatchObject({ rows: 8, translated: 8, questions: 1, failed: 1, edited: 1 });
  });
});
