// Validate CrochetPARADE text from a file, an argument or stdin.
//
//   npm run validate -- pattern.cp
//   npm run validate -- --text 'ring\n6sc\n6*[sc2inc]'
//   cat pattern.cp | npm run validate
//   add --json for the full result
//
// Exit code 0 when the pattern parses, 1 when it does not, 2 on usage errors.

import { readFileSync } from "node:fs";
import { createNodeValidator } from "../cp/nodeParser.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const rest = args.filter((a) => a !== "--json");

let text: string;
if (rest[0] === "--text" && rest[1] !== undefined) {
  text = rest[1].replace(/\\n/g, "\n");
} else if (rest[0] !== undefined) {
  text = readFileSync(rest[0], "utf8");
} else if (!process.stdin.isTTY) {
  text = readFileSync(0, "utf8");
} else {
  console.error("usage: validate [--json] (<file> | --text '<pattern>' | < stdin)");
  process.exit(2);
}

const result = createNodeValidator().validate(text);

if (json) {
  const { graphJson, simpleDot, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
} else if (result.ok) {
  console.log("valid");
  for (const r of result.rows) {
    const where = r.line === undefined ? `row ${r.row}` : `row ${r.row} (line ${r.line})`;
    const types = Object.entries(r.byType).map(([t, n]) => `${n} ${t}`).join(", ");
    console.log(`  ${where}: ${r.stitches} stitches  [${types}]`);
  }
} else {
  const e = result.error!;
  const where =
    e.row === undefined ? "" : e.line === undefined ? ` (row ${e.row})` : ` (row ${e.row}, line ${e.line})`;
  console.log(`invalid: ${e.kind}${where}\n  ${e.message}`);
}
for (const w of result.warnings) console.log(`warning: ${w}`);

process.exit(result.ok ? 0 : 1);
