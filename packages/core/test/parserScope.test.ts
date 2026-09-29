// The Worker host (new Function scope) must give the same results as the
// Node vm host. `new Function` also exists in Node, so this runs without a browser.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNodeValidator, PARSER_FILE, VENDOR_DIR } from "../src/node.ts";
import { createScopeValidator } from "../src/cp/parserScope.ts";

const scope = createScopeValidator(readFileSync(`${VENDOR_DIR}${PARSER_FILE}`, "utf8"));
const node = createNodeValidator();

const CASES = [
  "ring\n6sc\n6*[sc,sc2inc]",
  "10ch,turn\nsk,9sc,turn\n9sc",
  "3ch\n3sc\n2*[sc,dc@A]",
  "3ch\nslst,2sc",
  "3ch,turn,sc",
];

describe("scope host (used in the Web Worker)", () => {
  for (const text of CASES) {
    it(`matches the vm host: ${JSON.stringify(text)}`, () => {
      const a = scope.validate(text);
      const b = node.validate(text);
      expect(a.ok).toBe(b.ok);
      expect(a.rows).toEqual(b.rows);
      expect(a.error?.kind).toBe(b.error?.kind);
      expect(a.error?.message).toBe(b.error?.message);
      expect(a.simpleDot).toBe(b.simpleDot);
    });
  }

  it("does not leak DEF: stitches between calls", () => {
    expect(scope.validate("DEF: foo=Copy(sc)\n3ch\n3foo").ok).toBe(true);
    expect(scope.validate("3ch\n3foo").error?.kind).toBe("stitch_not_defined");
  });

  it("honours the dimension option", () => {
    expect(scope.validate("3ch", { dimension: 2 }).simpleDot!.startsWith("2\n")).toBe(true);
    expect(scope.validate("3ch").simpleDot!.startsWith("3\n")).toBe(true);
  });
});
