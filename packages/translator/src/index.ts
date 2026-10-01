// LLM translation of English patterns into CrochetPARADE (docs/SPEC.md §5).
// Node only: it reads its prompt files and the vendored parser from disk.

export { countMatches, lastRowCount, type CountCheck } from "./counts.ts";
export {
  assemble,
  settingsOf,
  translatePattern,
  translateWhole,
  type QuestionContext,
  type TranslateInput,
  type TranslateOptions,
  type TranslateResult,
} from "./loop.ts";
export {
  isFatal,
  kindOfStatus,
  ModelError,
  EVAL_PROVIDERS,
  PROVIDERS,
  type AppProviderId,
  type Effort,
  type ErrorKind,
  type ModelInfo,
  type ModelReply,
  type ModelRequest,
  type ProviderId,
  type StopReason,
  type TextBlock,
  type TranslatorModel,
  type Turn,
} from "./model.ts";
export { anthropicError, BatchModel, ClaudeModel, customId, requestParams } from "./providers/anthropic.ts";
export { compatError, compatParams, CompatModel } from "./providers/openaiCompat.ts";
export { GeminiModel, geminiError, geminiParams } from "./providers/gemini.ts";
export { API_KEY_ENV, createModel, listModels, type ProviderOptions } from "./providers/index.ts";
export { ClaudeCodeModel, claudeCodeStatus } from "./providers/claudeCode.ts";
export { promptVersion, systemPrompt } from "./prompt.ts";
export { outputFormat, portableSchema, RowResponse, WholeResponse } from "./schema.ts";
