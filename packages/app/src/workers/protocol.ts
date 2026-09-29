// Messages between the main thread and the two workers.

import type {
  Dimension,
  LayoutProgress,
  LayoutResult,
  SolverSettings,
  ValidationResult,
} from "@crochet-model/core";

export interface ValidateRequest {
  id: number;
  text: string;
  dimension?: Dimension;
  /** Leave out graphJson (it can be megabytes) when only counts and errors are needed. */
  withGraph?: boolean;
}

export type ParserResponse =
  | { id: number; type: "result"; result: ValidationResult; ms: number }
  | { id: number; type: "error"; message: string };

export interface LayoutRequest {
  id: number;
  simpleDot: string;
  settings?: SolverSettings;
}

export type LayoutResponse =
  | { id: number; type: "progress"; progress: LayoutProgress }
  | { id: number; type: "result"; result: LayoutResult }
  | { id: number; type: "error"; message: string };
