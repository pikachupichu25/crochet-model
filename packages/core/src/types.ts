// Shared types between segmentation, the translator, the evaluation and the
// app (docs/SPEC.md §4).

import type { ValidationResult } from "./cp/validator.ts";

/** One instruction line of the English pattern. */
export interface PatternRow {
  /** Stable: a hash of section, text and position. */
  id: string;
  /** "Head", "Arms (make 2)". */
  section?: string;
  /** "Rnd 3", "Rows 4-7"; "" for an unlabelled instruction ("Ch 16."). */
  label: string;
  /** The instruction, with the label removed. */
  text: string;
  /** "(18)", "[18 sts]", "— 18 sc", "Turn. 18 sts." */
  statedCount?: number;
  /** "(make 2)" on the section. */
  makeCount?: number;
  /** Rows this line stands for: "Rnds 4–7" is 4. */
  span: number;
}

/** Text that is not an instruction: materials, gauge, notes. */
export interface PatternNote {
  section?: string;
  text: string;
}

export interface SegmentedPattern {
  rows: PatternRow[];
  notes: PatternNote[];
  /** UK terms detected; the UI asks before converting (FR-1.2). */
  ukTerms: boolean;
}

export type RowStatus = "valid" | "count_mismatch" | "invalid" | "needs_answer";

export interface Question {
  text: string;
  /** 2–4 options. */
  options: { label: string; cp: string | null }[];
  /** Index chosen by the user. */
  answer?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Attempt {
  cp: string;
  /** Without graphJson and simpleDot, which are large. */
  validation: Omit<ValidationResult, "graphJson" | "simpleDot">;
  /** "anthropic", "openrouter", "gemini" or "openai". */
  provider: string;
  model: string;
  usage: Usage;
  /** Why the loop did not accept it, when it did not. */
  rejected?: string;
}

/** The translation of one English row. */
export interface RowTranslation {
  rowId: string;
  /** One or more CrochetPARADE lines. */
  cp: string;
  source: "llm" | "rules" | "user" | "gold";
  status: RowStatus;
  confidence: "high" | "medium" | "low";
  assumptions: string[];
  question?: Question;
  attempts: Attempt[];
  /** Answered from the translation cache: no request was sent for it (SPEC §8.4). */
  cached?: boolean;
}

/** A whole translated pattern: the thing saved, cached and exported. */
export interface TranslatedPattern {
  english: string;
  rows: PatternRow[];
  translations: Record<string, RowTranslation>;
  /** Question answers, by row id. */
  answers: Record<string, number>;
  /** "A" → "navy". */
  colors: Record<string, string>;
  promptVersion: string;
  /** What translated it, for the cache key and the export (SPEC §5.7). */
  provider?: string;
  model?: string;
}
