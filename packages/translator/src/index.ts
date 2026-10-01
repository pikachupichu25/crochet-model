// LLM translation of English patterns into CrochetPARADE (docs/SPEC.md §5).
// Node only: it reads its prompt files and the vendored parser from disk.

export { countMatches, lastRowCount, type CountCheck } from "./counts.ts";
export {
  assemble,
  isFatal,
  settingsOf,
  translatePattern,
  translateWhole,
  type QuestionContext,
  type TranslateInput,
  type TranslateOptions,
  type TranslateResult,
} from "./loop.ts";
export {
  BatchModel,
  ClaudeModel,
  customId,
  requestParams,
  type Effort,
  type ModelReply,
  type ModelRequest,
  type TranslatorModel,
} from "./model.ts";
export { promptVersion, systemPrompt } from "./prompt.ts";
export { RowResponse, WholeResponse } from "./schema.ts";
