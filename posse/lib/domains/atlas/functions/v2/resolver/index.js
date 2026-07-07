// @ts-check
//
// Resolver barrel. ViewBuilder + tests import from here.

export { resolveEdges } from "./resolve.js";
export {
  buildNameIndexes,
  lookupByName,
  lookupByQualifiedName,
} from "./name-index.js";
export {
  buildImportContexts,
  resolveModulePathCandidates,
  resolveModuleSpecifier,
  RESOLVABLE_EXTENSIONS,
} from "./import-context.js";
export {
  calibrateResolutionConfidence,
  defaultConfidenceForStrategy,
  toEdgeConfidence,
} from "./confidence.js";
