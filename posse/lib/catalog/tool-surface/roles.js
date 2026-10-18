// @ts-check
import { readonlySet } from "../readonly-collections.js";

import { INTERNAL_ATLAS_SURFACE_ACTIONS } from "../internal-tools.js";

export const HIDDEN_ATLAS_SURFACE_ACTIONS = Object.freeze(readonlySet([
  ...INTERNAL_ATLAS_SURFACE_ACTIONS,
  "symbol.card",
  "symbol.overview",
  "agent.feedback",
  "agent.feedback.query",
  "buffer.status",
  "context",
  "info",
  "policy.get",
  "repo.overview",
  "repo.quality",
  "repo.status",
  "tree.overview",
  "tree.branch",
  "tree.scope",
  "tree.expand",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "runtime.queryOutput",
  "context.summary",
  "usage.stats",
]));

export const CATALOG_SCHEMA_OVERRIDE_KEYS = Object.freeze([
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "pattern",
  "uniqueItems",
]);

export const SYSTEM_PREFETCH_CAPABLE_ATLAS_ACTIONS = Object.freeze(readonlySet([
  "code.survey",
]));

export const REMOTE_ATLAS_INTERNAL_TOOLS = Object.freeze([
  "traverse_ref",
  "fetch_ref",
  "repo.overview",
  "tree.overview",
  "tree.scope",
  "tree.branch",
  "tree.expand",
  "symbol.search",
  "symbol.card",
  "symbol.overview",
  "symbol.callers",
  "symbol.get",
  "slice.build",
  "slice.refresh",
  "context",
  "context.summary",
  "code.db",
  "code.structure",
  "code.skeleton",
  "code.lens",
  "code.window",
  "review.delta",
  "review.analyze",
  "review.risk",
  "memory.surface",
  "memory.get",
  "policy.get",
  "usage.stats",
]);

export const TOOL_ROLE_LIBRARY = Object.freeze({
  baseToolAllowlists: Object.freeze({
    dev: Object.freeze({
      // The read lane is the db-mode dev surface (task_mode:"db" runs with
      // allowWrite:false): read/inspect tools plus project_db_query — whose
      // write capability comes from the projectDbWrite override, not the
      // file-write grant. No file mutation tools on this lane.
      read: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "project_db_query", "inspect_environment"],
      // Exact files_to_create are materialized as empty files before a code
      // dev/fix provider starts, then moved into files_to_modify. write_file
      // remains registered for compatibility/artificer output but must not be
      // issued on this surface; edit_file can populate the empty file.
      write: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "request_scope", "edit_file", "move_file", "make_dir", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "extract_image_text", "run_unit_test", "project_db_query", "inspect_environment", "install_dependencies", "setup_database"],
    }),
    artificer: Object.freeze({
      read: ["ack_operator_feedback"],
      write: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "move_file", "make_dir", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "clean_image", "compose_sprite_sheet", "extract_image_text", "download_file", "bash"],
      imageGeneration: ["generate_image"],
    }),
    // Assessor carries project_db_query on the READ lane so it can verify the
    // claimed end state of db-mode dev work with SELECT/inspection; the
    // execution capability cap keeps it read-only regardless of the operator
    // grant, and the contract gate drops the tool when no read grant exists.
    assessor: Object.freeze({
      read: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "read_image_metadata", "validate_artifact_output", "extract_image_text", "view_image", "run_scoped_checks", "run_unit_test", "bash", "project_db_query", "inspect_environment"],
      write: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "read_image_metadata", "validate_artifact_output", "extract_image_text", "view_image", "run_scoped_checks", "run_unit_test", "bash", "project_db_query", "inspect_environment"],
    }),
    researcher: Object.freeze({
      read: ["ack_operator_feedback", "read_file", "chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
      write: ["ack_operator_feedback", "read_file", "chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
    }),
    // The planner never gets file-write tools, but it carries project_db_query
    // so it can inspect data while planning and execute a database-only work
    // item itself; the issued capability and operator grant decide whether
    // that is read-only or read/write.
    planner: Object.freeze({
      read: ["ack_operator_feedback", "get_brief", "read_file", "list_files", "search_files", "git_history", "inspect_file", "run_unit_test", "project_db_query", "inspect_environment", "setup_environment"],
      write: ["ack_operator_feedback", "get_brief", "read_file", "list_files", "search_files", "git_history", "inspect_file", "run_unit_test", "project_db_query", "inspect_environment", "setup_environment"],
    }),
    // Internal one-turn JSON model passes are not Jobs and therefore cannot
    // possess an Agent-bound MCP gate. Their prompts explicitly prohibit tool
    // use, and this empty contract keeps that boundary true at the CLI layer.
    model_pass: Object.freeze({ read: [], write: [] }),
    preflight: Object.freeze({ read: [], write: [] }),
    default: Object.freeze({
      read: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
      write: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "bash"],
    }),
  }),
  deterministicMcp: Object.freeze({
    read: Object.freeze(["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"]),
    write: Object.freeze(["request_scope", "write_file", "edit_file", "move_file", "make_dir", "prune_artifact_output"]),
    // Read-only image inspection (dev/artificer/assessor). clean_image and
    // compose_sprite_sheet are mutations gated to artificer separately — keep
    // them out of this set.
    imageHelpers: Object.freeze(["read_image_metadata", "validate_artifact_output"]),
    imageMutation: Object.freeze(["clean_image", "compose_sprite_sheet"]),
    imageGeneration: Object.freeze(["generate_image"]),
    ocr: Object.freeze(["extract_image_text"]),
    // Pixel-level image inspection for the assessor's visual criteria. The
    // remote ceiling is assessor-only; the local issuance narrows it further
    // to image assessments.
    imageView: Object.freeze(["view_image"]),
    // The artificer's only external fetch lane. Remote issuance must also
    // grant asset fetching; provider-native web tools stay off for the role.
    assetDownload: Object.freeze(["download_file"]),
    shellRoles: Object.freeze(["artificer", "assessor"]),
    writeRoles: Object.freeze(["dev", "artificer"]),
    imageHelperRoles: Object.freeze(["dev", "artificer", "assessor"]),
    imageGenerationRoles: Object.freeze(["artificer"]),
    assetDownloadRoles: Object.freeze(["artificer"]),
  }),
  atlasRoutes: Object.freeze({
    researcher: Object.freeze({
      phase: "research",
      tools: Object.freeze([]),
      internalTools: REMOTE_ATLAS_INTERNAL_TOOLS,
      rationale: "Remote policy issues the researcher ATLAS surface for bounded investigation.",
    }),
    planner: Object.freeze({
      phase: "planning",
      tools: Object.freeze([]),
      internalTools: REMOTE_ATLAS_INTERNAL_TOOLS,
      rationale: "Remote policy issues the planner ATLAS surface for scope narrowing and decomposition confidence.",
    }),
    assessor: Object.freeze({
      phase: "assessment",
      tools: Object.freeze([]),
      internalTools: REMOTE_ATLAS_INTERNAL_TOOLS,
      rationale: "Remote policy issues the assessor ATLAS surface for review/risk and focused evidence.",
    }),
    dev: Object.freeze({
      phase: "dev",
      tools: Object.freeze([]),
      internalTools: REMOTE_ATLAS_INTERNAL_TOOLS,
      rationale: "Remote policy issues the developer ATLAS surface for targeted retrieval.",
    }),
    artificer: Object.freeze({
      phase: null,
      tools: Object.freeze([]),
      internalTools: Object.freeze(["traverse_ref", "fetch_ref"]),
      rationale: "Artificer produces non-code deliverables; ATLAS retrieval is not in scope, but remote policy may issue missing-content traversal.",
    }),
  }),
});

export const ROLE_TOOL_ALLOWLISTS = TOOL_ROLE_LIBRARY.baseToolAllowlists;

export const DETERMINISTIC_READ_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.read;

export const DETERMINISTIC_WRITE_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.write;

export const DETERMINISTIC_IMAGE_HELPER_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageHelpers;

export const DETERMINISTIC_IMAGE_MUTATION_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageMutation;

export const DETERMINISTIC_IMAGE_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageGeneration;

export const DETERMINISTIC_OCR_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.ocr;

export const DETERMINISTIC_IMAGE_VIEW_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageView;

export const DETERMINISTIC_ASSET_DOWNLOAD_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.assetDownload;

// Native benchmark teams own the whole workflow in one provider session, so
// they need the same opt-in web lane that Posse splits across researcher,
// assessor, and dev roles. Dev (and fix, which runs as dev) holds web access
// as a fallback for external facts or source files that research did not
// deliver, so a missing input does not strand the job behind an operator gate.
// The account toggle and the remote-issued web policy still fail closed.
export const WEB_TOOL_ROLES = readonlySet(["researcher", "assessor", "dev", "native"]);

export const GATED_ROLES = readonlySet(["researcher", "planner", "dev", "assessor"]);

export const MEANINGFUL_ATLAS_ACTIONS = readonlySet([
  "symbol.search",
  "symbol.card",
  "symbol.overview",
  "symbol.callers",
  "symbol.get",
  "edit.plan",
  "code.skeleton",
  "code.lens",
  "code.window",
  "code.survey",
  "code.structure",
  "review.delta",
  "review.analyze",
  "review.risk",
  "memory.surface",
  "memory.get",
  "memory.feedback",
]);

// Legacy ToolGate compatibility vocabulary. The MCP runtime no longer
// enforces ATLAS-first admission; native tool catalog entries use native access.
export const GATED_NATIVE_TOOLS = readonlySet([
  "chain_read",
  "chain_verdict",
  "search_files",
  "read_file",
]);

export const TOOL_OBSERVATION_ALIASES = Object.freeze({
  bash: "bash",
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  glob: "list_files",
  grep: "search_files",
  shell: "bash",
  exec_command: "bash",
});

export const ATLAS_MUTATING_ACTIONS = readonlySet([
  "buffer.push",
  "buffer.checkpoint",
  "file.write",
  "index.refresh",
  // memory.store and memory.feedback are intentionally NOT here: curating a
  // development memory is not a repo mutation (Posse `write` = repo write).
  // They are surfaced per-route via the route tool-lists (store: assessor;
  // feedback: assessor/dev/planner/research roles) rather than blocked as mutating actions.
  "policy.set",
  "repo.register",
  "runtime.execute",
  "scip.ingest",
  "workflow",
]);

export const ATLAS_FALLBACK_ONLY_ACTIONS = readonlySet([
  "file.read",
]);

// Actions the handoff prefetch runs on the agent's behalf with better input
// than the agent could reconstruct. Keep their schemas and internal role
// routes intact while the whole tree suite is reversibly disabled on the
// agent-facing surface.
export const ATLAS_PREFETCH_ONLY_ACTIONS = readonlySet([
  "repo.overview",
  "repo.status",
  "tree.overview",
  "tree.branch",
  "tree.scope",
  "tree.expand",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "context.summary",
]);
