import { readFileSync } from "node:fs";
import { createNodeValidator } from "@crochet-model/core/node";
import { segmentPattern } from "@crochet-model/core";
import { describe, expect, it } from "vitest";
import { countMatches, lastRowCount } from "@crochet-model/core";

const { validate } = createNodeValidator();
const read = (name: string) =>
  readFileSync(new URL(`../src/prompt/${name}`, import.meta.url), "utf8");

/** Each example: its English block and its CrochetPARADE block. */
function examples() {
  const out: { title: string; english: string; cp: string }[] = [];
  for (const part of read("examples.md").split(/^## /m).slice(1)) {
    const title = part.split("\n", 1)[0]!;
    const english = /```text\n([\s\S]*?)```/.exec(part)?.[1];
    const cp = /```cp\n([\s\S]*?)```/.exec(part)?.[1];
    if (!english || !cp) throw new Error(`example "${title}" lacks a block`);
    out.push({ title, english, cp });
  }
  return out;
}

describe("worked examples", () => {
  const all = examples();

  it("has examples", () => {
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it.each(all.map((e) => [e.title, e]))("%s parses and makes the stated counts", (_, e) => {
    const { rows } = segmentPattern(e.english);
    // The CP comments name each English row; rows are matched in order.
    const groups = e.cp.split(/^# .*$/m).slice(1);
    expect(groups).toHaveLength(rows.length);
    let prefix = "";
    rows.forEach((row, i) => {
      prefix += groups[i]!;
      const result = validate(prefix);
      expect(result.ok, `${row.label}: ${result.error?.message}`).toBe(true);
      if (row.statedCount !== undefined) {
        const check = lastRowCount(result);
        expect(countMatches(check, row.statedCount), `${row.label}: ${JSON.stringify(check)}`).toBe(true);
      }
    });
  });
});

describe("grammar reference", () => {
  it("names only built-in stitches in its idiom table", () => {
    const snippets = [...read("idioms.md").matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const bad = snippets.filter((s) => /\b(slst|tc|inc|dec)\b/.test(s));
    expect(bad).toEqual([]);
  });
});

describe("lastRowCount", () => {
  it("allows for a beginning chain that is not counted or counts as one", () => {
    const check = lastRowCount(validate("11ch,turn\nsk,10sc,turn\n3ch,sk,9dc"));
    expect(check).toEqual({ parsed: 12, leading: 3, accepted: [9, 10] });
    expect(countMatches(check, 10)).toBe(true);
    expect(countMatches(check, 11)).toBe(false);
  });

  it("does not discount a line made only of chains", () => {
    expect(lastRowCount(validate("11ch"))).toEqual({ parsed: 11, leading: 0, accepted: [11] });
  });

  it("never takes a single beginning chain as a stitch", () => {
    const check = lastRowCount(validate("5ch,turn\nsk,4sc,turn\nch,3sc"));
    expect(check).toEqual({ parsed: 4, leading: 1, accepted: [3] });
  });
});
