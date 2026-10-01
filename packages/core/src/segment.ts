// English pattern → PatternRows, by rules (docs/SPEC.md §5.1). No LLM, so row
// ids are stable and cheap.
//
// Lines are classified one by one:
// - a **label** (`Rnd 3:`, `Row 12`, `R1`, `Rows 4-7`, `1st row:`,
//   `4th to 10th rows:`, `Set-up row:`) starts a row;
// - a **header** (an all-caps line such as `PANEL A (make 4)`, or a short
//   line ending in `:` such as `Head:`) starts a section;
// - `Notes:` and bullet lines (`•`) are notes;
// - a blank line ends the current row or note.
// Any other line continues the open row or note (patterns are often
// hard-wrapped mid-sentence), or, after a blank line or header, starts an
// unlabelled row when it reads like an instruction (`With A, ch 16.`) and a
// note when it does not (`Gauge: …`).

import type { PatternNote, PatternRow, SegmentedPattern } from "./types.ts";

const ORD = "(?:st|nd|rd|th)";
const UNIT = "(?:rows?|rnds?|rounds?)";
const RANGE = "(?:-|–|—|to|through|thru|and|&)";
const SIZES = "(?:\\s*\\([^)]*\\))?";

const LABELS: { re: RegExp; label: (m: RegExpExecArray) => [string, number] }[] = [
  {
    // Row 3, Rnds 4-7, R1, Round 1 (RS), Rows 3-45 (51, 54):
    re: new RegExp(`^((?:rows?|rnds?|rounds?|r)\\s*(\\d+)(?:\\s*${RANGE}\\s*(\\d+))?)${SIZES}\\s*[:.)]?\\s*`, "i"),
    label: (m) => [m[1]!, span(m[2], m[3])],
  },
  {
    // 1st row:, 4th to 10th rows:
    re: new RegExp(`^((\\d+)${ORD}(?:\\s*${RANGE}\\s*(\\d+)${ORD})?\\s+${UNIT})${SIZES}\\s*[:.]?\\s*`, "i"),
    label: (m) => [m[1]!, span(m[2], m[3])],
  },
  {
    re: new RegExp(`^((?:set-?up|foundation)\\s+${UNIT})${SIZES}\\s*[:.]?\\s*`, "i"),
    label: (m) => [m[1]!, 1],
  },
];

function span(from: string | undefined, to: string | undefined): number {
  if (to === undefined) return 1;
  const n = Number(to) - Number(from) + 1;
  return n >= 1 ? n : 1;
}

const STITCH_WORDS =
  /\b(ch|chain|sc|hdc|dc|tr|dtr|sl\s?st|slst|ss|inc|dec|sk|skip|sts?|stitch(?:es)?|rep|repeat|blo|flo|fp\w+|bp\w+|join|magic ring|mr|single crochet|double crochet|treble)\b/i;

const NEW_SENTENCE_ROW = /^(rep(?:eat)?\b|fasten off\b|join\b|with [A-Z]{1,2}\b)/i;

const BULLET = /^[•·▪●]\s*/;
const MAKE = /\(?\bmake\s+(\d+)\)?/i;

function labelOf(line: string): { label: string; span: number; text: string } | undefined {
  for (const { re, label } of LABELS) {
    const m = re.exec(line);
    if (m) {
      const [name, n] = label(m);
      return { label: name.trim(), span: n, text: line.slice(m[0].length).trim() };
    }
  }
  return undefined;
}

function isHeader(line: string): boolean {
  const bare = line.replace(MAKE, "").replace(/[:\s]+$/, "").trim();
  if (!bare || /\d/.test(bare)) return false;
  const letters = bare.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 2 && letters === letters.toUpperCase()) return true;
  // Short title ending in a colon: "Head:", "Arms (make 2):"
  return /:\s*$/.test(line) && bare.split(/\s+/).length <= 4 && !STITCH_WORDS.test(bare);
}

/** FNV-1a, so ids need no Node or browser crypto. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function segmentPattern(english: string): SegmentedPattern {
  const rows: PatternRow[] = [];
  const notes: PatternNote[] = [];
  let section: string | undefined;
  let makeCount: number | undefined;
  let open: { kind: "row"; row: PatternRow } | { kind: "note"; note: PatternNote } | undefined;
  let notesMode = false;
  let lastLine = "";

  const startRow = (label: string, n: number, text: string) => {
    const row: PatternRow = { id: "", section, label, text, span: n };
    if (makeCount !== undefined) row.makeCount = makeCount;
    rows.push(row);
    open = { kind: "row", row };
  };
  const startNote = (text: string) => {
    const note: PatternNote = { section, text };
    notes.push(note);
    open = { kind: "note", note };
  };

  for (const raw of english.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      open = undefined;
      notesMode = false;
      lastLine = "";
      continue;
    }
    const label = labelOf(line);
    if (label) {
      notesMode = false;
      startRow(label.label, label.span, label.text);
    } else if (/^notes?\s*:/i.test(line)) {
      notesMode = true;
      const rest = line.replace(/^notes?\s*:\s*/i, "");
      if (rest) startNote(rest);
      else open = undefined;
    } else if (BULLET.test(line)) {
      startNote(line.replace(BULLET, ""));
    } else if (!notesMode && isHeader(line)) {
      section = line.replace(/:\s*$/, "").trim();
      const make = MAKE.exec(section);
      makeCount = make ? Number(make[1]) : undefined;
      open = undefined;
    } else if (
      open &&
      !(open.kind === "row" && /[.!)]$/.test(lastLine) && NEW_SENTENCE_ROW.test(line))
    ) {
      if (open.kind === "row") open.row.text = join(open.row.text, line);
      else open.note.text = join(open.note.text, line);
    } else if (!notesMode && STITCH_WORDS.test(line) && /\d|\bch\b|\bsc\b/i.test(line)) {
      startRow("", 1, line);
    } else {
      startNote(line);
    }
    lastLine = line;
  }

  rows.forEach((row, i) => {
    row.id = `r${hash(`${row.section ?? ""}\n${row.label}\n${row.text}\n${i}`)}`;
    const count = statedCount(row.text);
    if (count !== undefined) row.statedCount = count;
  });
  return { rows, notes, ukTerms: looksUk(english) };
}

function join(a: string, b: string): string {
  return a ? `${a} ${b}` : b;
}

/**
 * The stitch count a row ends with: `Turn. 15 sts.`, `(18)`, `(18 sts)`,
 * `[18 sts]`, `turn—18 sc`, `18 stitches total`. Counts for several sizes
 * (`3 (4, 4) sc`) or several stitch kinds (`106 sc, 52 ch-1 sps`) are not
 * read: an unread count stays undefined rather than guessed (FR-1.4).
 */
export function statedCount(text: string): number | undefined {
  const tail = text.trim().replace(/[.;\s]+$/, "");
  const unit = "(?:sts?|stitches|sc|hdc|dc|tr)";
  const forms = [
    // Its own sentence, or after a dash: not the last stitch of "…, 2 dc".
    new RegExp(`(?:^|[.—–]\\s*|\\s-\\s*)(\\d+)\\s+${unit}(?:\\s+total)?$`, "i"),
    new RegExp(`\\((\\d+)(?:\\s+${unit})?(?:\\s+total)?\\)$`, "i"),
    new RegExp(`\\[(\\d+)(?:\\s+${unit})?(?:\\s+total)?\\]$`, "i"),
  ];
  for (const re of forms) {
    const m = re.exec(tail);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * UK patterns have no single crochet: their "dc" is the US sc. They are
 * flagged when they use dc or treble and never sc, or use "htr".
 */
function looksUk(text: string): boolean {
  if (/\bhtr\b|half treble/i.test(text)) return true;
  const hasSc = /\b(sc|single crochet)\b/i.test(text);
  return !hasSc && /\b(dc|double crochet)\b/i.test(text) && /\b(tr|treble)\b/i.test(text);
}
