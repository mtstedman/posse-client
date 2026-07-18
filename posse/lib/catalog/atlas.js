// ATLAS-domain catalogue.
//
// Phase names, transport choices, vector backends, role order, server defaults,
// and the provider→transport map. Set forms are derived so the value list
// cannot drift from the validator.

// ATLAS v2 has labeled options for the admin UI; the value-only Set is derived.
//
// `v2` is a deprecated alias for `on` — kept in the validator (and visible
// in the admin dropdown with the deprecation label) so existing DB rows keep
// loading. `normalizeAtlasV2Mode` collapses both to the canonical `on` at the
// boundary, so downstream code only sees `on`. Pick one for new docs/configs:
// `on`.
export const ATLAS_V2_MODE_VALUES = Object.freeze([
  Object.freeze({ value: "off", label: "off (disabled)" }),
  Object.freeze({ value: "shadow", label: "shadow (deprecated alias for on)" }),
  Object.freeze({ value: "preferred", label: "preferred (deprecated alias for on)" }),
  Object.freeze({ value: "on", label: "on (v2 authoritative)" }),
  Object.freeze({ value: "v2", label: "v2 (deprecated alias for on)" }),
  Object.freeze({ value: "required", label: "required (v2 fail-closed)" }),
]);
export const VALID_ATLAS_V2_MODES = new Set(
  ATLAS_V2_MODE_VALUES.map((entry) => (entry && typeof entry === "object" ? entry.value : entry)),
);

export const ATLAS_PHASE_VALUES = Object.freeze(["research", "planning", "assessment", "dev"]);
export const VALID_ATLAS_PHASES = new Set(ATLAS_PHASE_VALUES);

export const ATLAS_TRANSPORT_VALUES = Object.freeze(["v2"]);
export const VALID_ATLAS_TRANSPORTS = new Set(ATLAS_TRANSPORT_VALUES);

export const ATLAS_BOOT_REINDEX_POLICY_VALUES = Object.freeze(["always", "missing", "smart"]);
export const VALID_ATLAS_BOOT_REINDEX_POLICIES = new Set(ATLAS_BOOT_REINDEX_POLICY_VALUES);

export const ATLAS_SCIP_RESTAGE_POLICY_VALUES = Object.freeze(["never", "missing", "smart", "always"]);
export const VALID_ATLAS_SCIP_RESTAGE_POLICIES = new Set(ATLAS_SCIP_RESTAGE_POLICY_VALUES);
export const ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT = 24;

export const ATLAS_AUTO_FEEDBACK_VALUES = Object.freeze(["off", "dry-run", "write"]);
export const VALID_ATLAS_AUTO_FEEDBACK_MODES = new Set(ATLAS_AUTO_FEEDBACK_VALUES);

export const ATLAS_TREE_COMPRESSION_MODE_VALUES = Object.freeze(["off", "deterministic", "ml"]);
export const VALID_ATLAS_TREE_COMPRESSION_MODES = new Set(ATLAS_TREE_COMPRESSION_MODE_VALUES);

// Historical raw values that mean "v2 is OFF". Kept for the mode normalizer
// so older persisted/settings values degrade predictably.
export const ATLAS_V2_FLAG_OFF_VALUES = new Set(["0", "false", "no", "off", "legacy"]);

// Historical/raw truthy values that collapse to the canonical `on` mode.
// Other authority modes (`shadow`, `preferred`, `required`) are kept distinct.
export const ATLAS_V2_FLAG_ON_VALUES = new Set(["1", "true", "yes", "on", "v2"]);

// ATLAS SCIP mode is an admin/DB-backed setting. `on` consumes staged `.scip`
// files and attempts to stage one first when an indexer command is configured
// or auto-detected.
export const ATLAS_SCIP_MODE_VALUES = Object.freeze(["off", "on", "on-demand", "both"]);
export const VALID_ATLAS_SCIP_MODES = new Set(ATLAS_SCIP_MODE_VALUES);

// Languages with centrally managed SCIP indexer entries. This list feeds both
// the admin selector and the stager's auto-detection filter.
export const ATLAS_SCIP_LANGUAGE_OPTIONS = Object.freeze([
  Object.freeze({ value: "typescript", label: "TypeScript / JavaScript / TSX" }),
  Object.freeze({ value: "python", label: "Python" }),
  Object.freeze({ value: "php", label: "PHP" }),
  Object.freeze({ value: "go", label: "Go" }),
  Object.freeze({ value: "rust", label: "Rust" }),
  // scip-clang ships Linux/macOS binaries only; on Windows the indexer must
  // be provided manually (WSL, or atlas_scip_index_command override). The
  // option still lists everywhere so the setting round-trips identically to
  // the Rust candidate table (atlas_core scip_indexer_candidates).
  Object.freeze({ value: "clang", label: "C / C++ (scip-clang)" }),
]);
export const ATLAS_SCIP_LANGUAGE_VALUES = Object.freeze(ATLAS_SCIP_LANGUAGE_OPTIONS.map((entry) => entry.value));
export const ATLAS_SCIP_DEFAULT_LANGUAGE_VALUES = Object.freeze(["typescript", "python", "php"]);
export const VALID_ATLAS_SCIP_LANGUAGES = new Set(ATLAS_SCIP_LANGUAGE_VALUES);

export const ATLAS_ROLE_ORDER = Object.freeze([
  "researcher",
  "planner",
  "assessor",
  "dev",
  "artificer",
  "delegator",
]);

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3939;
export const DEFAULT_SERVER_NAME = "atlas-v2";

// Canonical ATLAS embedding model identities. Jina remains the production
// default; CodeRank is staged for a future explicit model selector and must
// not be activated merely because its runtime method is available.
export const ATLAS_JINA_MODEL = Object.freeze({
  label: "Jina v2 code (ONNX)",
  provider: "jina-v2-code",
  indexModel: "local-onnx",
  modelName: "jinaai/jina-embeddings-v2-base-code",
  modelId: "jina-v2-code",
  mlModelId: "jina-code-embeddings",
  mlModelDirectory: "jina-code-embeddings",
  mlProfileId: "jina-code-embeddings-v1",
  artifactTask: "embedding",
  artifactPublisher: "jina",
  artifactRelease: "v2-base-code-q8",
  artifactArchiveFormat: "tar+zstd",
  dim: 768,
  dtype: "q8",
});

export const ATLAS_CODERANK_MODEL = Object.freeze({
  label: "CodeRankEmbed int8 (ONNX)",
  provider: "nomic-ai/CodeRankEmbed",
  indexModel: "local-onnx",
  modelName: "nomic-ai/CodeRankEmbed",
  modelId: "coderank-embed-int8",
  mlModelId: "coderank-embed-int8",
  mlModelDirectory: "coderank-embed-int8",
  mlProfileId: "coderank-embed-v1",
  artifactTask: "embedding",
  artifactPublisher: "nomic",
  artifactRelease: "coderank-embed-int8-v1",
  artifactArchiveFormat: "tar+zstd",
  dim: 768,
  dtype: "int8",
});

// Only models that are fully wired through the native artifact/runtime path
// belong in this selector. CodeRank remains staged above until that contract is
// complete; adding it here will automatically expose it in admin settings.
export const ATLAS_EMBEDDING_MODEL_OPTIONS = Object.freeze([
  Object.freeze({ value: ATLAS_JINA_MODEL.modelId, label: ATLAS_JINA_MODEL.label }),
  Object.freeze({ value: ATLAS_CODERANK_MODEL.modelId, label: ATLAS_CODERANK_MODEL.label }),
]);
export const VALID_ATLAS_EMBEDDING_MODEL_IDS = new Set(
  ATLAS_EMBEDDING_MODEL_OPTIONS.map((entry) => entry.value),
);
export const DEFAULT_ATLAS_EMBEDDING_MODEL_ID = ATLAS_JINA_MODEL.modelId;

export function normalizeAtlasEmbeddingModelId(value) {
  const modelId = String(value || "").trim().toLowerCase();
  return VALID_ATLAS_EMBEDDING_MODEL_IDS.has(modelId)
    ? modelId
    : DEFAULT_ATLAS_EMBEDDING_MODEL_ID;
}

export function atlasEmbeddingModelForId(value) {
  const modelId = normalizeAtlasEmbeddingModelId(value);
  return modelId === ATLAS_CODERANK_MODEL.modelId
    ? ATLAS_CODERANK_MODEL
    : ATLAS_JINA_MODEL;
}

export const DEFAULT_ATLAS_EMBEDDING_PROVIDER = ATLAS_JINA_MODEL.provider;

// Provider → how that provider consumes ATLAS.
//   transport: "mcp"      — exposed through the Posse MCP gateway
//   transport: "embedded" — exposed through in-process function-tool wrappers
export const PROVIDER_ATLAS_SUPPORT = Object.freeze({
  claude: Object.freeze({
    transport: "mcp",
    rationale: "Claude consumes ATLAS through the Posse MCP gateway.",
  }),
  openai: Object.freeze({
    transport: "embedded",
    rationale: "OpenAI uses in-process function tools, so ATLAS should be exposed through embedded tool wrappers.",
  }),
  grok: Object.freeze({
    transport: "embedded",
    rationale: "Grok uses in-process function tools, so ATLAS should be exposed through embedded tool wrappers.",
  }),
  codex: Object.freeze({
    transport: "mcp",
    rationale: "Codex consumes ATLAS through Posse MCP gateway config overrides.",
  }),
});
