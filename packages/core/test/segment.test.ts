import { describe, expect, it } from "vitest";
import { segmentPattern, statedCount } from "../src/segment.ts";

const rowsOf = (text: string) =>
  segmentPattern(text).rows.map(({ label, text, span, section, statedCount, makeCount }) => ({
    label,
    text,
    span,
    ...(section ? { section } : {}),
    ...(statedCount !== undefined ? { statedCount } : {}),
    ...(makeCount !== undefined ? { makeCount } : {}),
  }));

describe("segmentPattern", () => {
  it("reads the common label forms", () => {
    const rows = rowsOf(
      [
        "R1: Ch 7, turn",
        "Row 2: sc across (6)",
        "Rnd 3. 2 sc in each st [12 sts]",
        "Round 4 (RS): sc around — 12 sc",
        "1st row: 1 hdc in 3rd ch from hook. Turn. 15 sts.",
        "Set-up row: (WS). 1 sc in 2nd ch from hook.",
      ].join("\n"),
    );
    expect(rows.map((r) => [r.label, r.statedCount])).toEqual([
      ["R1", undefined],
      ["Row 2", 6],
      ["Rnd 3", 12],
      ["Round 4", 12],
      ["1st row", 15],
      ["Set-up row", undefined],
    ]);
    expect(rows[3]!.text).toBe("sc around — 12 sc");
  });

  it("reads ranges as one row spanning several", () => {
    const rows = rowsOf(
      "Rnds 4–7: sc around (24)\n4th to 10th rows: Rep 2nd and 3rd rows.\nRows 3-45 (51, 54): Repeat Row 2.",
    );
    expect(rows.map((r) => [r.label, r.span])).toEqual([
      ["Rnds 4–7", 4],
      ["4th to 10th rows", 7],
      ["Rows 3-45", 43],
    ]);
  });

  it("joins hard-wrapped lines and keeps notes and sections apart", () => {
    const text = [
      "Notes:",
      "• Ch 3 at beg of rows counts",
      "as dc.",
      "",
      "THROW",
      "Ch 161 (multiple of 3 ch + 2).",
      "Set-up row: (WS). 1 sc in 2nd ch",
      "from hook. *Ch 4. Skip next 2 ch.",
      "1 sc in next ch. Rep from * to end",
      "of row. Turn. 54 sc and 53 ch-4 sps.",
      "Rep last 2 rows until work measures 51\".",
      "BORDER",
      "1st rnd: Ch 3. Work dc evenly around.",
    ].join("\n");
    const { rows, notes } = segmentPattern(text);
    expect(notes.map((n) => n.text)).toEqual(["Ch 3 at beg of rows counts as dc."]);
    expect(rows.map((r) => [r.section, r.label, r.text])).toEqual([
      ["THROW", "", "Ch 161 (multiple of 3 ch + 2)."],
      [
        "THROW",
        "Set-up row",
        "(WS). 1 sc in 2nd ch from hook. *Ch 4. Skip next 2 ch. 1 sc in next ch. Rep from * to end of row. Turn. 54 sc and 53 ch-4 sps.",
      ],
      ["THROW", "", "Rep last 2 rows until work measures 51\"."],
      ["BORDER", "1st rnd", "Ch 3. Work dc evenly around."],
    ]);
  });

  it("reads make counts from section headers", () => {
    const rows = rowsOf("Arms (make 2):\nRnd 1: 6 sc in magic ring (6)\nPANEL A (make 4)\nWith A, ch 16.");
    expect(rows).toEqual([
      { label: "Rnd 1", text: "6 sc in magic ring (6)", span: 1, section: "Arms (make 2)", statedCount: 6, makeCount: 2 },
      { label: "", text: "With A, ch 16.", span: 1, section: "PANEL A (make 4)", makeCount: 4 },
    ]);
  });

  it("keeps prose that is not an instruction as a note", () => {
    const { rows, notes } = segmentPattern("Gauge: 4 inches square.\n\nRow 1: ch 5");
    expect(notes.map((n) => n.text)).toEqual(["Gauge: 4 inches square."]);
    expect(rows).toHaveLength(1);
  });

  it("gives stable ids that change with the text", () => {
    const a = segmentPattern("Row 1: ch 5\nRow 2: sc across");
    const b = segmentPattern("Row 1: ch 5\nRow 2: sc across");
    const c = segmentPattern("Row 1: ch 6\nRow 2: sc across");
    expect(a.rows.map((r) => r.id)).toEqual(b.rows.map((r) => r.id));
    expect(a.rows[0]!.id).not.toBe(c.rows[0]!.id);
    expect(new Set(a.rows.map((r) => r.id)).size).toBe(2);
  });

  it("flags UK terms", () => {
    expect(segmentPattern("Row 1: 1 dc in each st, 1 tr in last").ukTerms).toBe(true);
    expect(segmentPattern("Row 1: 1 htr in each st").ukTerms).toBe(true);
    expect(segmentPattern("Row 1: sc across, dc, tr").ukTerms).toBe(false);
  });
});

describe("statedCount", () => {
  it.each([
    ["2 sc in each sc around. 12 sts.", 12],
    ["1 hdc in each ch to end. Turn. 15 sts", 15],
    ["*sc, inc* around (18)", 18],
    ["*sc, inc* around (18 sts)", 18],
    ["*sc, inc* around [18 sts]", 18],
    ["sc across; turn—18 sc.", 18],
    ["sc around. 24 stitches total", 24],
  ])("reads %j", (text, count) => {
    expect(statedCount(text)).toBe(count);
  });

  it.each([
    "Ch 1, sc in each st across. Turn.",
    "sc in next st, 2 dc",
    "sc across; turn—3 (4, 4) sc.",
    "Turn. 106 sc, 52 ch-1 sps and 2 dc.",
  ])("leaves %j unread", (text) => {
    expect(statedCount(text)).toBeUndefined();
  });
});
