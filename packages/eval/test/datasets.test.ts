import { describe, expect, it } from "vitest";
import {
  loadCrochetBenchStep,
  loadStitchSwitch,
  parseCsv,
  parseStepPrompt,
} from "../src/datasets.ts";

describe("parseCsv", () => {
  it("reads quoted fields with commas, newlines and quotes", () => {
    expect(parseCsv('a,b\n"x, y","1\n2"\n"say ""hi""",\r\nlast,')).toEqual([
      ["a", "b"],
      ["x, y", "1\n2"],
      ['say "hi"', ""],
      ["last", ""],
    ]);
  });
});

describe("loadStitchSwitch", () => {
  it("reads the columns by name, dropping the BOM and trimming names", () => {
    const csv =
      '﻿Original Pattern,crochetPARADE Pattern,Name ,Variation\n' +
      '"Row 1: Make a magic ring \r\nRow 2: 5 sc in ring","ring.R\n5sc@R",Snail ,Y\n' +
      "R1: Ch 7,7ch,Chain ,\n";
    const items = loadStitchSwitch(csv);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "ss-001",
      name: "Snail",
      english: "Row 1: Make a magic ring \nRow 2: 5 sc in ring",
      gold: "ring.R\n5sc@R",
      variation: "Y",
    });
    expect(items[1]!.variation).toBeUndefined();
  });
});

describe("parseStepPrompt", () => {
  it("splits the earlier steps from the target", () => {
    const prompt =
      "Previous NL and DSL:\nNL: With A, ch 16.\nDSL:16ch,turn\n\n\n" +
      "NL: 1st row: 1 hdc in 3rd ch from hook.\nDSL:2sk, 14hdc, turn\n\n" +
      "Now translate the NL into DSL:\nNL:2nd row: Ch 2. Turn. 15 sts\nDSL:\n";
    expect(parseStepPrompt(prompt)).toEqual({
      context: [
        { english: "With A, ch 16.", cp: "16ch,turn" },
        { english: "1st row: 1 hdc in 3rd ch from hook.", cp: "2sk, 14hdc, turn" },
      ],
      target: "2nd row: Ch 2. Turn. 15 sts",
    });
  });

  it("accepts the DL: typo and multi-line steps", () => {
    const prompt =
      "Previous NL and DSL:\nNL: Rnd 1: 6 sc\nin ring.\nDSL:ring\n6sc\n\n" +
      "NL:Rnd 2: inc around.\nDL:6*[sc2inc]\n\n\n" +
      "Now translate the NL into DSL:\nNL: Rnd 3: sc around. 12 sts\nDSL:\n";
    const { context } = parseStepPrompt(prompt);
    expect(context).toEqual([
      { english: "Rnd 1: 6 sc\nin ring.", cp: "ring\n6sc" },
      { english: "Rnd 2: inc around.", cp: "6*[sc2inc]" },
    ]);
  });

  it("gives step items ids by split and position, with the stated count", () => {
    const records = [
      {
        id: "X",
        pattern_name: " Hat ",
        instructions: "",
        prompt: "Previous NL and DSL:\nNL: ch 4\nDSL:4ch\n\nNow translate the NL into DSL:\nNL: sc across. 3 sts.\nDSL:\n",
      },
    ];
    expect(loadCrochetBenchStep(records, "step_1_2")[0]).toMatchObject({
      id: "step_1_2-001",
      name: "Hat",
      english: "sc across. 3 sts.",
      statedCount: 3,
    });
  });

  it("keeps an https image link and drops any other", () => {
    const record = (image_link: string) => ({
      id: "X",
      pattern_name: "Hat",
      instructions: "",
      image_link,
      prompt: "Now translate the NL into DSL:\nNL: ch 4\nDSL:\n",
    });
    const [https, http] = loadCrochetBenchStep([record("https://example.com/a.jpg"), record("http://example.com/b.jpg")], "step_1_2");
    expect(https!.imageUrl).toBe("https://example.com/a.jpg");
    expect(http!.imageUrl).toBeUndefined();
  });
});
