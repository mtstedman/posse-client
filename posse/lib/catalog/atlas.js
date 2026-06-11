// ATLAS-domain catalogue.
//
// Mode enums, phase names, transport choices, vector backends, role order,
// server defaults, and the provider→transport map. Set forms are derived so
// the value list cannot drift from the validator.

export const ATLAS_MODE_VALUES = Object.freeze(["off", "on", "shadow", "preferred", "required", "split"]);
export const VALID_ATLAS_MODES = new Set(ATLAS_MODE_VALUES);

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

export const ATLAS_VECTOR_BACKEND_VALUES = Object.freeze(["auto", "usearch", "off"]);
export const VALID_ATLAS_VECTOR_BACKENDS = new Set(ATLAS_VECTOR_BACKEND_VALUES);

export const ATLAS_REMOTE_ENCODER_MODE_VALUES = Object.freeze(["off", "shadow", "preferred", "required"]);
export const VALID_ATLAS_REMOTE_ENCODER_MODES = new Set(ATLAS_REMOTE_ENCODER_MODE_VALUES);

export const ATLAS_WI_EMBEDDINGS_VALUES = Object.freeze(["off", "on_demand", "on"]);
export const VALID_ATLAS_WI_EMBEDDINGS = new Set(ATLAS_WI_EMBEDDINGS_VALUES);

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
  Object.freeze({ value: "typescript", label: "TypeScript / JavaScript" }),
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
