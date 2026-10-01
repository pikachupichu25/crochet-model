// What each model accepts, by provider (docs/SPEC.md §5.6). Effort maps to the
// provider's nearest level, clamped to what the model takes; models without
// reasoning get none.

import type { Effort } from "../model.ts";

const ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** The highest level in `levels` that is not above `effort`, or the lowest one. */
function clamp<T extends string>(effort: Effort, levels: readonly T[], as: (e: Effort) => T): T {
  for (let i = ORDER.indexOf(effort); i >= 0; i--) {
    const level = as(ORDER[i]!);
    if (levels.includes(level)) return level;
  }
  return levels[0]!;
}

// --- Anthropic ---------------------------------------------------------------

/** Adaptive thinking and `output_config.effort`; Haiku 4.5 rejects both. */
export function anthropicSettings(model: string, effort: Effort): { thinking?: { type: "adaptive" }; effort?: Effort } {
  if (model.startsWith("claude-haiku-4")) return {};
  return { thinking: { type: "adaptive" }, effort };
}

// --- OpenAI ------------------------------------------------------------------

/** OpenAI models that reason and take `reasoning_effort`. */
function openaiReasons(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model) && !/-chat/.test(model);
}

/** `reasoning_effort` for an OpenAI model, or undefined for one that does not reason. */
export function openaiEffort(model: string, effort: Effort): Effort | undefined {
  if (!openaiReasons(model)) return undefined;
  // xhigh and max exist only on some models; high is accepted by all that reason.
  return clamp<Effort>(effort, ["low", "medium", "high"], (e) => e);
}

/** OpenAI chat models with JSON Schema output: gpt-4o and later, o-series, gpt-5 on. */
export function openaiStructuredOutput(model: string): boolean {
  return /^(gpt-4o|gpt-4\.1|gpt-[5-9]|o\d)/.test(model);
}

// --- OpenRouter --------------------------------------------------------------

/** `reasoning.effort` on OpenRouter, which takes low, medium and high. */
export function openrouterEffort(effort: Effort): "low" | "medium" | "high" {
  return clamp(effort, ["low", "medium", "high"] as const, (e) => (e === "xhigh" || e === "max" ? "high" : e));
}

/**
 * Models OpenRouter caches only when the request marks the prefix with
 * `cache_control` (Anthropic and Gemini); others cache automatically.
 */
export function openrouterExplicitCache(model: string): boolean {
  return model.startsWith("anthropic/") || model.startsWith("google/gemini");
}

// --- Gemini ------------------------------------------------------------------

export type GeminiThinking = { thinkingLevel: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" } | { thinkingBudget: number };

/**
 * Gemini 3 takes a thinking level (Pro: low and high; Flash also minimal and
 * medium); Gemini 2.5 a token budget. Older models do not think.
 */
export function geminiThinking(model: string, effort: Effort): GeminiThinking | undefined {
  const name = model.replace(/^models\//, "");
  if (/^gemini-[3-9]/.test(name)) {
    const levels = /flash/.test(name) ? (["LOW", "MEDIUM", "HIGH"] as const) : (["LOW", "HIGH"] as const);
    const as = (e: Effort) => (e === "low" ? "LOW" : e === "medium" ? "MEDIUM" : "HIGH");
    return { thinkingLevel: clamp(effort, levels as readonly ("LOW" | "MEDIUM" | "HIGH")[], as) };
  }
  if (/^gemini-2\.5/.test(name)) {
    const budgets: Record<Effort, number> = { low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 24576 };
    return { thinkingBudget: budgets[effort] };
  }
  return undefined;
}

/** Gemini models with JSON Schema output: 2.0 and later. */
export function geminiStructuredOutput(model: string): boolean {
  return /^gemini-([2-9]|\d{2})/.test(model.replace(/^models\//, ""));
}
