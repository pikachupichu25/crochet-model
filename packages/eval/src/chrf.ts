// Sentence-level chrF (Popović 2015) with sacrebleu's defaults: character
// n-grams up to 6, no word n-grams, beta 2, whitespace removed. Used only to
// compare with Dias & Karim, who report it (docs/SPEC.md §7.3).

const ORDER = 6;
const BETA = 2;

function ngrams(text: string, n: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= text.length; i++) {
    const g = text.slice(i, i + n);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/** 0–100. */
export function chrF(hypothesis: string, reference: string): number {
  const hyp = hypothesis.replace(/\s+/g, "");
  const ref = reference.replace(/\s+/g, "");
  let precision = 0;
  let recall = 0;
  let orders = 0;
  for (let n = 1; n <= ORDER; n++) {
    const h = ngrams(hyp, n);
    const r = ngrams(ref, n);
    const hTotal = Math.max(0, hyp.length - n + 1);
    const rTotal = Math.max(0, ref.length - n + 1);
    if (hTotal === 0 && rTotal === 0) continue;
    let match = 0;
    for (const [g, c] of h) match += Math.min(c, r.get(g) ?? 0);
    precision += hTotal ? match / hTotal : 0;
    recall += rTotal ? match / rTotal : 0;
    orders += 1;
  }
  if (orders === 0) return 100;
  precision /= orders;
  recall /= orders;
  if (precision + recall === 0) return 0;
  const b2 = BETA * BETA;
  return (100 * (1 + b2) * precision * recall) / (b2 * precision + recall);
}
