import { describe, expect, it } from "vitest";
import type { ItemRecord } from "../src/run.ts";
import type { ItemScore } from "../src/score.ts";
import { loadSuspects, summariesWithClean, suspectIds, type SuspectGold } from "../src/suspect.ts";

const record = (id: string, exact: boolean): ItemRecord => {
  const score: ItemScore = {
    nonEmpty: true,
    parses: true,
    structure: { exact, matched: exact ? 2 : 1, goldStitches: 2, outputStitches: 2, score: exact ? 1 : 0.5 },
  };
  return { id, name: id, ms: 1, outputs: { llm: "" }, scores: { llm: score }, rows: { found: 1, kept: 1 } };
};

describe("gold-suspect.json", () => {
  it("is well formed and copies no dataset text", () => {
    const suspects = loadSuspects();
    expect(suspects.length).toBeGreaterThan(0);
    for (const s of suspects) {
      expect(["suspected", "confirmed", "rejected"]).toContain(s.status);
      expect(s.issue && s.evidence && s.found).toBeTruthy();
      expect(s.rows.every((r) => Number.isInteger(r) && r >= 1)).toBe(true);
      // Our own words only: no CrochetPARADE fragments from the gold.
      expect(`${s.issue} ${s.evidence}`).not.toMatch(/@\[|\d+(sc|dc|tr|ch)\b|\(\d*ch,/);
    }
  });
});

describe("summariesWithClean", () => {
  it("adds a summary without suspect items, and skips rejected ones", () => {
    const suspects: SuspectGold[] = [
      { dataset: "stitchswitch", id: "ss-011", rows: [3], status: "suspected", issue: "", evidence: "", found: "" },
      { dataset: "stitchswitch", id: "ss-012", rows: [3], status: "rejected", issue: "", evidence: "", found: "" },
    ];
    expect([...suspectIds("stitchswitch", suspects)]).toEqual(["ss-011"]);
    const records = [record("ss-010", true), record("ss-011", false), record("ss-012", true)];
    const [all, clean] = summariesWithClean("stitchswitch", ["llm"], records);
    expect(all!.structureExact).toBeCloseTo(2 / 3);
    // The real list has ss-011 as suspected.
    expect(clean).toMatchObject({ output: "llm (excl. 1 suspect gold)", items: 2, structureExact: 1, excludedSuspect: ["ss-011"] });
  });

  it("adds nothing when no suspect item ran", () => {
    expect(summariesWithClean("stitchswitch", ["llm"], [record("ss-001", true)])).toHaveLength(1);
  });
});
