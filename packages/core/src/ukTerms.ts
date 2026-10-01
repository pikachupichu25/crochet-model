// UK to US crochet terms (FR-1.2; docs/CROCHET_CONVENTIONS.md). UK names are
// one step taller than US ones: the UK "double crochet" is the US single
// crochet. The app converts only after the user confirms.

const WORDS: [RegExp, string][] = [
  [/triple treble(?: crochet)?/, "double treble crochet"],
  [/double treble(?: crochet)?/, "treble crochet"],
  [/half treble(?: crochet)?/, "half double crochet"],
  [/treble(?: crochet)?/, "double crochet"],
  [/double crochet/, "single crochet"],
];

const ABBREVIATIONS: Record<string, string> = { trtr: "dtr", dtr: "tr", htr: "hdc", tr: "dc", dc: "sc" };

const OTHER: Record<string, string> = { miss: "skip", missed: "skipped", tension: "gauge" };

// Longest first at each position: "double treble" before "double crochet",
// "dtr" before "tr". Abbreviations may carry a plural or a count suffix
// ("trs", "dc2tog", "tr3inc").
const PATTERN = new RegExp(
  [
    ...WORDS.map(([re]) => `(?:${re.source})s?\\b`),
    "(?:trtr|dtr|htr|tr|dc)s?\\b",
    "(?:trtr|dtr|htr|tr|dc)(?=\\d+(?:tog|inc)\\b)",
    "(?:missed|miss|tension)\\b",
  ]
    .map((p) => `\\b${p}`)
    .join("|"),
  "gi",
);

/** The pattern in US terms. Capitalised words stay capitalised. */
export function ukToUs(text: string): string {
  return text.replace(PATTERN, (match) => {
    const lower = match.toLowerCase();
    let out: string | undefined = ABBREVIATIONS[lower] ?? OTHER[lower];
    if (out === undefined && lower.endsWith("s") && ABBREVIATIONS[lower.slice(0, -1)]) {
      out = `${ABBREVIATIONS[lower.slice(0, -1)]}s`;
    }
    if (out === undefined) {
      const plural = lower.endsWith("s") ? "s" : "";
      const word = lower.replace(/s$/, "");
      const entry = WORDS.find(([re]) => new RegExp(`^${re.source}$`).test(word));
      out = entry ? entry[1] + plural : match;
    }
    if (match === match.toUpperCase() && match.length <= 4) return out.toUpperCase();
    return /^[A-Z]/.test(match) ? out[0]!.toUpperCase() + out.slice(1) : out;
  });
}
