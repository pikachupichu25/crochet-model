import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { chrF } from "../src/chrf.ts";
import type { EvalItem } from "../src/datasets.ts";
import { translateWithRules } from "../src/rules.ts";
import { checkGold, scoreItem } from "../src/score.ts";

describe("chrF", () => {
  it("is 100 for identical text and ignores whitespace", () => {
    expect(chrF("6sc, turn", "6sc,turn")).toBeCloseTo(100);
  });

  it("is 0 for an empty or unrelated hypothesis", () => {
    expect(chrF("", "6sc")).toBe(0);
    expect(chrF("xyz", "6sc")).toBe(0);
  });

  it("weights recall over precision", () => {
    // Half the reference, no extra text; then the full reference plus as much again.
    const short = chrF("abcdef", "abcdefghijkl");
    const long = chrF("abcdefghijklmnopqrstuvwx", "abcdefghijkl");
    expect(long).toBeGreaterThan(short);
  });
});

const item = (over: Partial<EvalItem>): EvalItem => ({
  dataset: "stitchswitch",
  id: "t",
  name: "t",
  english: "",
  ...over,
});

describe("scoreItem", () => {
  it("scores a gold translation written differently as an exact match", () => {
    const s = scoreItem(
      item({ gold: "9ch,turn\nsk,2sc,dc,2sc,dc,2sc" }),
      "# comment\n9ch,turn\nsk,[2sc,>,dc]*3",
    );
    expect(s).toMatchObject({ nonEmpty: true, parses: true, counts: { checked: 2, matched: 2 } });
    expect(s.structure).toMatchObject({ exact: true, score: 1 });
  });

  it("scores an output with only comments as empty, with no structure credit", () => {
    const s = scoreItem(item({ gold: "ring.R\n5sc@R" }), "# REVIEW: could not parse");
    expect(s).toMatchObject({ nonEmpty: false, parses: false, counts: { matched: 0 } });
    expect(s.structure).toMatchObject({ exact: false, score: 0, goldStitches: 6 });
    expect(s.chrF).toBe(0);
  });

  it("validates a step translation after its gold prefix and checks the stated count", () => {
    const step = item({
      dataset: "crochetbench-step",
      context: [{ english: "Ch 7", cp: "7ch,turn" }],
      statedCount: 6,
    });
    expect(scoreItem(step, "sk,6sc")).toMatchObject({ parses: true, counts: { matched: 1 } });
    expect(scoreItem(step, "sk,5sc")).toMatchObject({ parses: true, counts: { matched: 0 } });
    expect(scoreItem(step, "sc@Q").error?.kind).toBe("label_not_found");
  });

  it("has no gold to check when every earlier step's CP is blank", () => {
    const step = item({ dataset: "crochetbench-step", context: [{ english: "Ch 4", cp: "" }] });
    expect(checkGold(step)).toBeUndefined();
    expect(scoreItem(step, "4ch")).toMatchObject({ parses: true });
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("translateWithRules", () => {
  it("runs CrochetPARADE's rule-based translator headless", () => {
    const out = translateWithRules(
      "Row 1: Ch 7\nRow 2: Sc in 2nd ch from hook and in each ch across, turn. (6)",
    );
    expect(out.error).toBeUndefined();
    expect(out.instructions).toBe(2);
    expect(out.cp.split("\n")[0]).toBe("7ch");
    expect(out.compiledCp).toContain("7ch");
  });

  it("takes the previous row's count as context", () => {
    const out = translateWithRules("2nd rnd: 2 sc in each sc around. 12 sts.", 6);
    expect(out.cp).toBe("6*[sc2inc]");
  });
});
