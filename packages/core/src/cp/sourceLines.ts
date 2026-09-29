// Maps CrochetPARADE rows to the input lines they come from.
//
// CrochetPARADE numbers rows itself and skips blank lines, comments and
// directive lines (COLOR:, DEF:, …). The parser does not report the line of a
// row, so the mapping is rebuilt here from the same rules. Where the rules
// cannot be sure (multi-line comments, brackets spanning lines, which repeat
// whole rows), the mapping is abandoned and callers fall back to row numbers.

const DIRECTIVE = /^\s*[A-Z][A-Z_]*\s*:/; // COLOR:, DEF:, DOT:, BACKGROUND:, SORT_LABEL:, …

/**
 * Returns lines[row] = 1-based line number, or undefined when the text uses
 * constructs this mapping does not handle.
 */
export function mapRowsToLines(text: string): number[] | undefined {
  const lines = text.replace(/\r/g, "").split("\n");
  const rows: number[] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("\\")) return undefined; // \ multi-line comment \
    const code = line.replace(/#.*$/, "").trim();
    if (code === "" || DIRECTIVE.test(code)) continue;
    for (const ch of code) {
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth--;
    }
    if (depth !== 0) return undefined; // a bracket spans lines: rows are repeated
    if (code.startsWith("...")) continue; // continues the previous row
    rows.push(i + 1);
  }
  return rows;
}
