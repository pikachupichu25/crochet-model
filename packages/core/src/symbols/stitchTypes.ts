// What a stitch type is made of, read from its name: the base stitch and its
// loop, post and spike affixes. Shared by the structure view's palette and the
// symbol table (docs/symbol/SPEC.md §4.3).

export type BaseStitch = "ch" | "ss" | "sc" | "hdc" | "dc" | "tr" | "dtr" | "trtr" | "ring" | "hidden";

export interface TypeParts {
  /** Undefined when the name is not a known stitch (a DEF: name, a puff). */
  base?: BaseStitch;
  /** `bl` / `fl`: worked in one loop only. */
  loop?: "back" | "front";
  /** `fp` / `bp`: worked around the post. */
  post?: "front" | "back";
  /** `r`: reverse (crab) stitch. */
  reverse?: boolean;
  /** `long`: a spike stitch, worked into a row further down. */
  long?: boolean;
}

const PARTS = /^(fp|bp)?(r)?(long)?(ch|ss|sc|hdc|dc|tr|dtr|trtr|ring|hidden)(bl|fl)?$/;

export function typeParts(type: string): TypeParts {
  const m = PARTS.exec(type);
  if (!m) return {};
  return {
    base: m[4] as BaseStitch,
    post: m[1] === "fp" ? "front" : m[1] === "bp" ? "back" : undefined,
    reverse: m[2] ? true : undefined,
    long: m[3] ? true : undefined,
    loop: m[5] === "bl" ? "back" : m[5] === "fl" ? "front" : undefined,
  };
}

/** "scbl" → "sc", "fpdc" → "dc"; unknown types are returned as they are. */
export function baseType(type: string): string {
  return typeParts(type).base ?? type;
}
