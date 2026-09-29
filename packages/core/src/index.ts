// Browser-safe entry point: nothing here imports Node modules.
// Node hosts live under "@crochet-model/core/node".

export {
  createValidator,
  NON_COUNTING_TYPES,
  runInScope,
  summariseRows,
  toParseError,
  type Dimension,
  type HostOutcome,
  type ParseError,
  type ParseErrorKind,
  type ParseOptions,
  type ParserHost,
  type ParserScope,
  type RowSummary,
  type ValidationResult,
} from "./cp/validator.ts";
export { createScopeParserHost, createScopeValidator } from "./cp/parserScope.ts";
export {
  buildSolverInput,
  createSolver,
  parseLayoutOutput,
  parseProgressLine,
  readDimension,
  readIterations,
  type EmscriptenSolver,
  type LayoutProgress,
  type LayoutResult,
  type Solver,
  type SolverLoader,
  type SolverSettings,
} from "./cp/layout.ts";
export {
  parseStitchGraph,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type Stitch,
  type StitchGraph,
} from "./cp/graph.ts";
export { mapRowsToLines } from "./cp/sourceLines.ts";
