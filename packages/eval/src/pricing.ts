// Dollar cost of a run (docs/SPEC.md §7.2, §7.3 metric 5). Prices are US$
// per million tokens, standard rates as of 2026-09; the Batches API halves
// all of them. Cache writes are for the 5-minute cache.

import type { Usage } from "@crochet-model/core";
import type { ModelInfo, ProviderId } from "@crochet-model/translator";

type Price = NonNullable<ModelInfo["price"]>;

/**
 * Prices on file. OpenRouter publishes its prices in its model list, so they
 * come from there (`listed`); OpenAI and Gemini prices are not on file yet, so
 * their runs need --yes and report no cost.
 */
const PRICES: Partial<Record<ProviderId, Record<string, Price>>> = {
  anthropic: {
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
};

export function priceOf(provider: ProviderId, model: string, listed?: Price): Price | undefined {
  return PRICES[provider]?.[model] ?? listed;
}

/** US$, or undefined for a model with no price. Cache prices default to the input price. */
export function costOf(price: Price | undefined, usage: Usage, batch: boolean): number | undefined {
  if (!price) return undefined;
  const dollars =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * (price.cacheRead ?? price.input) +
      usage.cacheWriteTokens * (price.cacheWrite ?? price.input)) /
    1e6;
  return batch ? dollars / 2 : dollars;
}
