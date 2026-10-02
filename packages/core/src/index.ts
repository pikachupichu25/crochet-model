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
  readSeed,
  type EmscriptenSolver,
  type LayoutProgress,
  type LayoutResult,
  type Solver,
  type SolverLoader,
  type SolverSettings,
} from "./cp/layout.ts";
export {
  countEdgeCrossings,
  DEFAULT_MAX_SEEDS,
  FOLD_CROSSING_RATIO,
  isFolded,
  layoutUnfolded,
  type CrossingCount,
  type FoldCheck,
  type UnfoldedLayoutResult,
  type UnfoldOptions,
} from "./cp/fold.ts";
export {
  parseStitchGraph,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type Stitch,
  type StitchGraph,
} from "./cp/graph.ts";
export { canonicalRows, compareStructure, type StructureMatch } from "./cp/compare.ts";
export { segmentPattern, statedCount } from "./segment.ts";
export type * from "./types.ts";
export { mapRowsToLines } from "./cp/sourceLines.ts";
export {
  applyObjectTransforms,
  objectNumbers,
  readObjectTransforms,
  type ObjectTransform,
} from "./cp/objectTransform.ts";
export { ukToUs } from "./ukTerms.ts";
export { countMatches, lastRowCount, type CountCheck } from "./counts.ts";
export { buildSymbolScene, type PlacedGlyph, type SymbolColorMode, type SymbolOptions, type SymbolScene } from "./symbols/scene.ts";
export type { Surface } from "./symbols/surface.ts";
export { legendEntries, legendIcon, stitchName, type LegendEntry, type LegendIcon } from "./symbols/legend.ts";
export { baseType, typeParts, type BaseStitch, type TypeParts } from "./symbols/stitchTypes.ts";
export type { Vec3 } from "./symbols/vec.ts";
