// Dollar cost of a run (docs/SPEC.md §7.2, §7.3 metric 5). Prices are US$
// per million tokens, standard rates as of 2026-09; the Batches API halves
// all of them. Cache writes are for the 5-minute cache.

import type { Usage } from "@crochet-model/core";

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export function knownPrice(model: string): boolean {
  return model in PRICES;
}

/** US$, or undefined for a model with no price on file. */
export function costOf(model: string, usage: Usage, batch: boolean): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  const dollars =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1e6;
  return batch ? dollars / 2 : dollars;
}
