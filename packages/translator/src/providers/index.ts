// One adapter per provider, chosen by id (docs/SPEC.md §5.6). Base URLs are
// fixed here; callers pass only a key (§8.3).

import type { AppProviderId, ModelInfo, ProviderId, TranslatorModel } from "../model.ts";
import { ClaudeModel, listAnthropicModels } from "./anthropic.ts";
import { ClaudeCodeModel } from "./claudeCode.ts";
import { GeminiModel, listGeminiModels } from "./gemini.ts";
import { CompatModel, listCompatModels } from "./openaiCompat.ts";

/** Where each provider's key is read from when none is passed (the evaluation). */
export const API_KEY_ENV: Record<AppProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * The model each provider starts on in the app (SPEC §5.6). Only Anthropic
 * has one until the sweep scores the others; there the user picks.
 */
export const DEFAULT_MODELS: Partial<Record<AppProviderId, string>> = { anthropic: "claude-opus-5-5" };

export interface ProviderOptions {
  /** The user's key; the provider's environment variable when omitted. */
  apiKey?: string;
  /** Anthropic only: server-side fallback on a refusal, for the live app (SPEC §5.6). */
  fallbacks?: boolean;
}

/** A direct (not batched) model for the provider. */
export function createModel(provider: ProviderId, options: ProviderOptions = {}): TranslatorModel {
  switch (provider) {
    case "anthropic":
      return new ClaudeModel(options);
    case "gemini":
      return new GeminiModel(options);
    case "openai":
    case "openrouter":
      return new CompatModel(provider, options);
    case "claude-code":
      // Uses the Claude Code login; a key is not used.
      return new ClaudeCodeModel();
  }
}

/** The models the key can use. Free to call; also checks the key. */
export function listModels(provider: AppProviderId, options: ProviderOptions = {}): Promise<ModelInfo[]> {
  switch (provider) {
    case "anthropic":
      return listAnthropicModels(options);
    case "gemini":
      return listGeminiModels(options);
    case "openai":
    case "openrouter":
      return listCompatModels(provider, options);
  }
}
