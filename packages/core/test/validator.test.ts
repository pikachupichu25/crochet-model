import { describe, expect, it } from "vitest";
import { createNodeValidator } from "../src/cp/nodeParser.ts";

const { validate } = createNodeValidator();

const counts = (text: string) => validate(text).rows.map((r) => r.stitches);

describe("valid patterns", () => {
  it("counts an amigurumi start: ring, 6 sc, 6 increases", () => {
    const result = validate("ring\n6sc\n6*[sc2inc]");
    expect(result.ok).toBe(true);
    // the ring itself is not a stitch
    expect(counts("ring\n6sc\n6*[sc2inc]")).toEqual([0, 6, 12]);
    expect(result.rows[2]!.byType).toEqual({ sc: 12 });
  });

  it("counts rows with turns and skips", () => {
    expect(counts("10ch,turn\nsk,9sc,turn\n9sc")).toEqual([10, 9, 9]);
  });

  it("counts a decrease as one stitch and leaves slip stitches out", () => {
    const result = validate("6ch,turn\nsk,sc2tog,sc,ss,hdc");
    expect(result.rows[1]!.stitches).toBe(3);
    expect(result.rows[1]!.byType).toEqual({ sc: 2, ss: 1, hdc: 1 });
  });

  it("does not count the internal nodes of a bobble", () => {
    expect(counts("4ch,turn\ndc3bobble,fpdc,scbl")).toEqual([4, 3]);
  });

  it("maps rows to lines past comments, blanks and directives", () => {
    const text = "# start\n3ch,turn\n\nCOLOR: red\n3sc";
    const result = validate(text);
    expect(result.rows.map((r) => r.line)).toEqual([2, 5]);
  });

  it("keeps a row that only has a slip stitch join", () => {
    expect(counts("ring\n6sc,ss@[%,0]")).toEqual([0, 6]);
  });

  it("does not leak DEF: stitches from one call into the next", () => {
    expect(validate("DEF: foo=Copy(sc)\n3ch\n3foo").ok).toBe(true);
    const second = validate("3ch\n3foo");
    expect(second.ok).toBe(false);
    expect(second.error?.kind).toBe("stitch_not_defined");
  });

  it("returns the parser's graph output", () => {
    const result = validate("3ch\n3sc");
    const graph = JSON.parse(result.graphJson!);
    expect(graph.elements.some((e: { type: string }) => e.type === "edge")).toBe(true);
    expect(result.simpleDot).toContain('"1,2|5"');
  });
});

describe("invalid patterns", () => {
  it("reports a label used before it is defined", () => {
    const result = validate("3ch\n3sc\n2*[sc,dc@A]");
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      kind: "label_not_found",
      message: "Label not found: A",
      row: 2,
      line: 3,
    });
  });

  it("reports an unknown stitch name, as LLMs write slst for ss", () => {
    const result = validate("3ch\nslst,2sc");
    expect(result.error?.kind).toBe("stitch_not_defined");
    expect(result.error?.message).toContain("slst");
    expect(result.error?.row).toBe(1);
  });

  it("reports an attachment to a stitch that does not exist", () => {
    // a slip stitch join on its own line is a new, empty row
    const result = validate("ring\n6sc\nss@[%,0]");
    expect(result.error?.kind).toBe("position_not_found");
  });

  it("reports a turn in the middle of a row, without the JSON dump", () => {
    const result = validate("3ch,turn,sc");
    expect(result.error?.kind).toBe("turn_not_at_end");
    expect(result.error?.message).toBe(
      "Turning can happen only at the end of a row.",
    );
    expect(result.error?.row).toBe(0);
  });

  it("reports unbalanced brackets as a syntax error", () => {
    expect(validate("3ch\n[sc,dc").error?.kind).toBe("syntax");
  });

  it("does not repeat the error as a warning", () => {
    expect(validate("3ch\n3sc\n2*[sc,dc@A]").warnings).toEqual([]);
  });

  it("keeps the full parser message for debugging", () => {
    const result = validate("6sc@Z");
    expect(result.error?.raw).toContain("stage: find_label");
  });
});

describe("known parser behaviour", () => {
  it("accepts more stitches than the row below has", () => {
    // The parser does not reject this; the stated-count check must catch it.
    expect(counts("5ch\n9sc")).toEqual([5, 9]);
  });
});
