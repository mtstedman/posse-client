// @ts-check
//
// Stable Atlas v2 capability surface. This is intentionally descriptive, not
// an execution switchboard: retrieval code still owns whether a feature runs.

export const ATLAS_V2_CAPABILITY_SCHEMA_VERSION = 1;

const FEATURE_FLAG_KEYS = Object.freeze({
  predictivePrefetch: ["atlasPredictivePrefetch", "predictivePrefetch", "predictivePrefetchEnabled"],
  graphDerivedState: ["atlasGraphDerivedState", "graphDerivedState", "graphDerivedStateEnabled"],
  indexDiagnostics: ["atlasIndexDiagnostics", "indexDiagnostics", "indexDiagnosticsEnabled"],
  semanticEnrichment: ["atlasSemanticEnrichment", "semanticEnrichment", "semanticEnrichmentEnabled"],
  nativeEmbeddings: [],
  editPlanning: ["atlasEditPlanning", "editPlanning", "editPlanningEnabled"],
  tokenEfficiencyV2: ["atlasTokenEfficiencyV2", "tokenEfficiencyV2", "tokenEfficiencyV2Enabled"],
  liveReconciliation: ["atlasLiveReconciliation", "liveReconciliation", "liveReconciliationEnabled"],
});

/**
 * @typedef {"enabled" | "available" | "disabled" | "partial" | "planned" | "unavailable"} AtlasCapabilityStatus
 *
 * @typedef {Object} AtlasCapabilityItem
 * @property {AtlasCapabilityStatus} status
 * @property {boolean} implemented
 * @property {boolean} enabled
 * @property {string} stage
 * @property {string} summary
 * @property {string | null} reason
 *
 * @typedef {Object} AtlasCapabilities
 * @property {number} schemaVersion
 * @property {"atlas-v2"} engine
 * @property {Record<keyof typeof FEATURE_FLAG_KEYS, boolean>} flags
 * @property {Record<string, AtlasCapabilityItem>} items
 */

/**
 * @param {{
 *   config?: Record<string, unknown>,
 *   policy?: Record<string, unknown> | null,
 *   embeddingStatus?: { enabled?: boolean, provider?: string | null, reason?: string | null } | null,
 * }} [args]
 * @returns {AtlasCapabilities}
 */
export function buildAtlasCapabilities(args = {}) {
  const config = args.config && typeof args.config === "object" ? args.config : {};
  const policy = args.policy && typeof args.policy === "object" ? args.policy : null;
  const embeddingStatus = args.embeddingStatus || null;
  const flags = buildCapabilityFlags(config);
  const runtimeEnabled = policy ? policy.runtimeEnabled === true : false;
  const memoryEnabled = policy ? policy.memoryEnabled !== false : true;
  const embeddingsEnabled = embeddingStatus?.enabled === true;
  const embeddingReason = embeddingStatus?.reason || null;

  return {
    schemaVersion: ATLAS_V2_CAPABILITY_SCHEMA_VERSION,
    engine: "atlas-v2",
    flags,
    items: {
      workflow: capability("enabled", true, true, "shipped", "Multi-step Atlas workflow composition is available.", null),
      conditionalFetch: capability("enabled", true, true, "shipped", "Cards, code windows, slices, and overviews support ETag-style conditional fetch.", null),
      compactWireFormat: capability("enabled", true, true, "shipped", "Slice output supports compact, agent, and packed columnar formats.", null),
      retrievalCache: capability("enabled", true, true, "shipped", "Process-local card and slice cache is available.", null),
      memory: capability(memoryEnabled ? "enabled" : "disabled", true, memoryEnabled, "shipped", "Repo-scoped Atlas memory tools are policy-gated.", memoryEnabled ? null : "policy_disabled"),
      runtime: capability(runtimeEnabled ? "enabled" : "disabled", true, runtimeEnabled, "shipped", "Repo-scoped runtime execution is policy-gated.", runtimeEnabled ? null : "policy_disabled"),
      liveBuffers: capability("enabled", true, true, "shipped", "Draft buffer push/checkpoint/status feed live reconciliation telemetry.", null),
      scipIngest: capability("enabled", true, true, "shipped", "SCIP ingestion can overlay compiler-grade cross references.", null),
      nativeEmbeddings: capability(
        embeddingsEnabled ? "enabled" : "unavailable",
        true,
        embeddingsEnabled,
        "shipped",
        "posse-atlas owns Jina ONNX encoding and posse-vector owns nearest-neighbor search.",
        embeddingsEnabled ? null : embeddingReason || "native_embeddings_unavailable",
      ),
      semanticSearch: capability(
        embeddingsEnabled ? "enabled" : "disabled",
        true,
        embeddingsEnabled,
        "shipped",
        "Semantic symbol search uses the mandatory native Jina and posse-vector pipeline.",
        embeddingsEnabled ? null : embeddingReason || "embeddings_disabled",
      ),
      predictivePrefetch: capability("enabled", true, true, "shipped", "Symbol search predicts likely follow-up cards, warms the retrieval cache, and reports hit/waste telemetry.", null),
      graphDerivedState: capability("enabled", true, true, "shipped", "View DBs materialize clusters, process chains, centrality, and graph rankings.", null),
      indexDiagnostics: capability("enabled", true, true, "shipped", "Index refresh can return structured phase timings and progress metadata with includeDiagnostics.", null),
      semanticEnrichment: capability("enabled", true, true, "shipped", "Repo status surfaces exact edge provenance, SCIP bindings, and symbol-resolution coverage.", null),
      editPlanning: capability("partial", true, true, "shipped", "Preview-only edit plans produce symbol/file-scoped preconditions; applying edits remains delegated to scoped write tools.", null),
      tokenEfficiencyV2: capability("enabled", true, true, "shipped", "Slices support packed columnar responses, slice ETags, and per-card known ETag refs.", null),
      liveReconciliation: capability("partial", true, true, "shipped", "Buffer-overlay reconciliation reports debounce, queue, dependency-frontier, and checkpoint telemetry; filesystem watcher is still planned.", null),
      codeModeLadder: capability("enabled", true, true, "shipped", "Code-mode ladder validation records card, skeleton, hot-path, and raw-window ordering with advisory warnings.", null),
    },
  };
}

/**
 * @param {Record<string, unknown>} config
 * @returns {Record<keyof typeof FEATURE_FLAG_KEYS, boolean>}
 */
export function buildCapabilityFlags(config = {}) {
  /** @type {Record<string, boolean>} */
  const flags = {};
  for (const [name, keys] of Object.entries(FEATURE_FLAG_KEYS)) {
    flags[name] = name === "nativeEmbeddings" || keys.some((key) => configFlag(config[key]));
  }
  return /** @type {Record<keyof typeof FEATURE_FLAG_KEYS, boolean>} */ (flags);
}

/**
 * @param {boolean} enabled
 * @param {string} summary
 * @returns {AtlasCapabilityItem}
 */
function planned(enabled, summary) {
  return capability("planned", false, enabled, "planned", summary, enabled ? "configured_pending_implementation" : null);
}

/**
 * @param {AtlasCapabilityStatus} status
 * @param {boolean} implemented
 * @param {boolean} enabled
 * @param {string} stage
 * @param {string} summary
 * @param {string | null} reason
 * @returns {AtlasCapabilityItem}
 */
function capability(status, implemented, enabled, stage, summary, reason) {
  return { status, implemented, enabled, stage, summary, reason };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function configFlag(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}
