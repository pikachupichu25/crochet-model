// Dollar cost of a run or a translation (docs/SPEC.md §7.2, §7.3 metric 5, §8.4). Prices are US$
// per million tokens, standard rates as of 2026-09; the Batches API halves
// all of them. Cache writes are for the 5-minute cache.

import type { Usage } from "@crochet-model/core";
import type { Effort, ModelInfo, ProviderId } from "./model.ts";
import { documentSystemPrompt, systemPrompt } from "./prompt.ts";

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

/** Output tokens assumed per request, by effort. */
export const OUTPUT_TOKENS: Record<Effort, number> = { low: 800, medium: 1500, high: 3000, xhigh: 5000, max: 8000 };

/**
 * A rough upper estimate of one pattern in row mode, from characters (about
 * 3.5 per token): one request per row, with half again for repairs; the
 * system prompt and the pattern are written to the cache once and read back
 * on every request.
 */
export function estimatePattern(english: string, rows: number, effort: Effort, price: Price | undefined): { dollars?: number; requests: number; usage: Usage } {
  const systemTokens = systemPrompt().length / 3.5;
  const patternTokens = english.length / 3.5 + 15 * rows;
  const requests = Math.max(1, rows) * 1.5;
  const usage: Usage = {
    cacheWriteTokens: systemTokens + patternTokens,
    cacheReadTokens: requests * (systemTokens + patternTokens),
    inputTokens: requests * (300 + (english.length / 3.5) * 0.5),
    outputTokens: requests * OUTPUT_TOKENS[effort],
  };
  return { dollars: costOf(price, usage, false), requests: Math.round(requests), usage };
}

/**
 * The same for document mode: one request for the whole pattern, with half
 * again for repairs, each sending the system prompt and the pattern and
 * writing every row's CrochetPARADE (about 30 tokens a row) after its thinking.
 */
export function estimateDocument(english: string, rows: number, effort: Effort, price: Price | undefined): { dollars?: number; requests: number; usage: Usage } {
  const systemTokens = documentSystemPrompt().length / 3.5;
  const requests = 1.5;
  const usage: Usage = {
    cacheWriteTokens: systemTokens,
    cacheReadTokens: (requests - 1) * systemTokens,
    inputTokens: requests * (english.length / 3.5 + 100),
    outputTokens: requests * (OUTPUT_TOKENS[effort] * 2 + 30 * Math.max(1, rows)),
  };
  return { dollars: costOf(price, usage, false), requests: 2, usage };
}
