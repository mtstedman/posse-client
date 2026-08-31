import { TOOL_INSPECT_FILE } from "../../../worker/functions/helpers/file-inspector.js";
import { TOOL_GIT_HISTORY } from "../../../git/functions/history.js";
import { resolveAtlasToolGateEnabled } from "./gate-settings.js";
import { atlasBackendLabel } from "../atlas-label.js";
import { atlasDescriptorSchemaForAction } from "../../../atlas/functions/v2/contracts/tool-schemas.js";
import { REGISTERED_TEST_AGENT_SURFACE_ENABLED } from "../../../../catalog/registered-tests.js";
import { TOOL_ATTACHMENT_BY_PROVIDER } from "../../../../catalog/tool-surface/provider-attachments.js";
import {
  getToolBatchingClass,
  TOOL_BATCHING_CLASSES,
} from "../../../../catalog/tool-surface/batching.js";
import {
  projectAgentToolDefinition,
  projectAgentToolSchema,
} from "../../../../shared/tools/functions/agent-schema.js";

export { TOOL_ATTACHMENT_BY_PROVIDER };
export { getToolBatchingClass, TOOL_BATCHING_CLASSES };

export { TOOL_INSPECT_FILE } from "../../../worker/functions/helpers/file-inspector.js";
export { TOOL_GIT_HISTORY } from "../../../git/functions/history.js";


// Tool schema definitions are pure data and live in the catalog layer.
import {
  TOOL_READ_FILE,
  TOOL_WRITE_FILE,
  TOOL_EDIT_FILE,
  TOOL_REQUEST_SCOPE,
  TOOL_LIST_FILES,
  TOOL_SEARCH_FILES,
  TOOL_HASH_FILE,
  TOOL_RESIZE_IMAGE,
  TOOL_READ_IMAGE_METADATA,
  TOOL_VALIDATE_ARTIFACT_OUTPUT,
  TOOL_PRUNE_ARTIFACT_OUTPUT,
  TOOL_OPTIMIZE_IMAGE,
  TOOL_REENCODE_IMAGE,
  TOOL_CLEAN_IMAGE,
  TOOL_EXTRACT_IMAGE_TEXT,
  TOOL_BASH,
  TOOL_AGENT_FEEDBACK,
  TOOL_GET_OPERATOR_FEEDBACK,
  TOOL_ACK_OPERATOR_FEEDBACK,
  TOOL_RUN_SCOPED_CHECKS,
  TOOL_CREATE_TEST_SUITE,
  TOOL_CREATE_TEST,
  TOOL_RUN_TEST,
  TOOL_RUN_TEST_SUITE,
  TOOL_MOVE_FILE,
  TOOL_COPY_FILE,
  TOOL_MAKE_DIR,
  TOOL_CHAIN_READ,
  TOOL_CHAIN_VERDICT,
  TOOL_PULL_BRIEF,
  TOOL_GET_BRIEF,
  TOOL_GENERATE_IMAGE,
  TOOL_PROJECT_DB_QUERY,
  TOOL_AGENT_HANDOFF,
  TOOL_AGENT_HANDOFF_DEV,
  TOOL_AGENT_HANDOFF_ARTIFICER,
  TOOL_AGENT_HANDOFF_ASSESSOR,
  TOOL_AGENT_HANDOFF_CITATION,
  TOOL_AGENT_HANDOFF_PLANNER,
  TOOL_AGENT_HANDOFF_RESEARCHER,
  TOOL_AGENT_HANDOFF_REPORT,
  getAgentHandoffToolSchemaForRole,
  TOOL_SUB_AGENT,
  TOOL_SUB_AGENT_NEXT_INPUT,
  TOOL_DISPATCH_AGENT,
  TOOL_WEB_RESEARCH_HANDOFF,
} from "../../../../catalog/native-tools.js";

export {
  TOOL_READ_FILE,
  TOOL_WRITE_FILE,
  TOOL_EDIT_FILE,
  TOOL_REQUEST_SCOPE,
  TOOL_LIST_FILES,
  TOOL_SEARCH_FILES,
  TOOL_HASH_FILE,
  TOOL_RESIZE_IMAGE,
  TOOL_READ_IMAGE_METADATA,
  TOOL_VALIDATE_ARTIFACT_OUTPUT,
  TOOL_PRUNE_ARTIFACT_OUTPUT,
  TOOL_OPTIMIZE_IMAGE,
  TOOL_REENCODE_IMAGE,
  TOOL_CLEAN_IMAGE,
  TOOL_EXTRACT_IMAGE_TEXT,
  TOOL_BASH,
  TOOL_AGENT_FEEDBACK,
  TOOL_GET_OPERATOR_FEEDBACK,
  TOOL_ACK_OPERATOR_FEEDBACK,
  TOOL_RUN_SCOPED_CHECKS,
  TOOL_CREATE_TEST_SUITE,
  TOOL_CREATE_TEST,
  TOOL_RUN_TEST,
  TOOL_RUN_TEST_SUITE,
  TOOL_MOVE_FILE,
  TOOL_COPY_FILE,
  TOOL_MAKE_DIR,
  TOOL_CHAIN_READ,
  TOOL_CHAIN_VERDICT,
  TOOL_PULL_BRIEF,
  TOOL_GET_BRIEF,
  TOOL_GENERATE_IMAGE,
  TOOL_PROJECT_DB_QUERY,
  TOOL_AGENT_HANDOFF,
  TOOL_AGENT_HANDOFF_DEV,
  TOOL_AGENT_HANDOFF_ARTIFICER,
  TOOL_AGENT_HANDOFF_ASSESSOR,
  TOOL_AGENT_HANDOFF_CITATION,
  TOOL_AGENT_HANDOFF_PLANNER,
  TOOL_AGENT_HANDOFF_RESEARCHER,
  TOOL_AGENT_HANDOFF_REPORT,
  TOOL_SUB_AGENT_NEXT_INPUT,
  TOOL_SUB_AGENT,
  TOOL_DISPATCH_AGENT,
  TOOL_WEB_RESEARCH_HANDOFF,
} from "../../../../catalog/native-tools.js";

import {
  ATLAS_TOOL_DEFS_RAW,
  normalizeAtlasCodeWindowPolicy,
} from "../../../../catalog/atlas-tools.js";
import {
  INTERNAL_ATLAS_SURFACE_ACTIONS,
  INTERNAL_ATLAS_SURFACE_ACTION_SET,
} from "../../../../catalog/internal-tools.js";

export const HIDDEN_ATLAS_SURFACE_ACTIONS = Object.freeze(new Set([
  ...INTERNAL_ATLAS_SURFACE_ACTIONS,
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

export function isAtlasActionSurfaced(action) {
  return !HIDDEN_ATLAS_SURFACE_ACTIONS.has(String(action || "").trim());
}

const CATALOG_SCHEMA_OVERRIDE_KEYS = Object.freeze([
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

export const ATLAS_TOOL_DEFS = Object.freeze(withNativeAtlasSchemas(ATLAS_TOOL_DEFS_RAW));
export const SURFACED_ATLAS_TOOL_DEFS = Object.freeze(
  Object.fromEntries(Object.entries(ATLAS_TOOL_DEFS).filter(([action]) => isAtlasActionSurfaced(action))),
);

export const SYSTEM_PREFETCH_CAPABLE_ATLAS_ACTIONS = Object.freeze(new Set([
  "code.survey",
]));

function withNativeAtlasSchemas(defs) {
  const out = {};
  for (const [action, def] of Object.entries(defs)) {
    const generated = atlasDescriptorSchemaForAction(action);
    const parameters = generated
      ? mergeCatalogSchemaMetadata(generated, def.parameters)
      : cloneJson(def.parameters);
    out[action] = {
      ...def,
      parameters: filterFallbackOnlyAtlasSchema(action, parameters),
    };
  }
  return out;
}

function filterFallbackOnlyAtlasSchema(action, parameters) {
  if (["query", "code", "repo", "agent"].includes(action) && Array.isArray(parameters?.properties?.action?.enum)) {
    parameters.properties.action.enum = parameters.properties.action.enum
      .filter((toolName) => {
        const normalized = String(toolName || "").replace(/^atlas[._]/, "").replace(/_/g, ".");
        return normalized !== "file.read" && isAtlasActionSurfaced(normalized);
      });
  }
  return parameters;
}

function mergeCatalogSchemaMetadata(generated, existing) {
  const out = cloneJson(generated);
  mergeCatalogSchemaMetadataInPlace(out, existing || {});
  return out;
}

function mergeCatalogSchemaMetadataInPlace(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return;
  if (typeof source.description === "string") target.description = source.description;
  if (Object.prototype.hasOwnProperty.call(source, "default")) target.default = cloneJson(source.default);
  for (const key of CATALOG_SCHEMA_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = cloneJson(source[key]);
  }
  if (source.internalOnly === true) target.internalOnly = true;
  const targetProps = target.properties && typeof target.properties === "object" ? target.properties : {};
  const sourceProps = source.properties && typeof source.properties === "object" ? source.properties : {};
  for (const [key, child] of Object.entries(targetProps)) {
    mergeCatalogSchemaMetadataInPlace(child, sourceProps[key]);
  }
  if (target.items && source.items) mergeCatalogSchemaMetadataInPlace(target.items, source.items);
  if (
    target.additionalProperties
    && typeof target.additionalProperties === "object"
    && source.additionalProperties
    && typeof source.additionalProperties === "object"
  ) {
    mergeCatalogSchemaMetadataInPlace(target.additionalProperties, source.additionalProperties);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// One authored entry per callable tool. Provider schemas, execution metadata,
// observations, lazy Atlas discovery, and inventories all project from this
// catalog; do not add parallel schema or summary dictionaries.
export const TOOL_CATALOG = {
  agent_handoff: {
    schema: TOOL_AGENT_HANDOFF,
    access: "coordination",
    summary: "Submit the terminal structured handoff report; any selected evidence is materialized backend-side.",
    observation: { type: "tool.agent_handoff", label: "AgentHandoff", format: "generic", targetKeys: ["profile", "outcome"] },
  },
  sub_agent: {
    schema: TOOL_SUB_AGENT,
    access: "coordination",
    summary: "Dispatch or control a bounded batch of isolated citation-synthesis agents.",
    budgetExempt: true,
    observation: { type: "tool.sub_agent", label: "SubAgent", format: "generic", targetKeys: ["op", "batch_id"] },
  },
  sub_agent_next_input: {
    schema: TOOL_SUB_AGENT_NEXT_INPUT,
    access: "coordination",
    summary: "Advance a citation child's backend-owned ordered input cursor.",
    budgetExempt: true,
    observation: { type: "tool.sub_agent_next_input", label: "SubAgentInput", format: "generic", targetKeys: ["position"] },
  },
  dispatch_agent: {
    schema: TOOL_DISPATCH_AGENT,
    access: "coordination",
    summary: "Dispatch one isolated specialty agent; the web route returns parent-visible cited findings.",
    budgetExempt: true,
    observation: { type: "tool.dispatch_agent", label: "DispatchAgent", format: "generic", targetKeys: ["route"] },
  },
  web_research_handoff: {
    schema: TOOL_WEB_RESEARCH_HANDOFF,
    access: "coordination",
    summary: "Submit a web specialty agent's bounded source-backed findings.",
    budgetExempt: true,
    observation: { type: "tool.web_research_handoff", label: "WebResearchHandoff", format: "generic", targetKeys: ["protocol"] },
  },
  read_file: {
    schema: TOOL_READ_FILE,
    access: "read",
    summary: "Read file contents with line-aware slices.",
    observation: { type: "tool.read", label: "Read", format: "file", pathKeys: ["file_path", "path"], requireTarget: true, includeRange: true },
  },
  chain_read: {
    schema: TOOL_CHAIN_READ,
    access: "read",
    summary: "Read exact missing context; the first page is paired with chain_verdict and relevant continuations inherit it.",
    observation: { type: "tool.chain_read", label: "ChainRead", format: "file", pathKeys: ["path"], requireTarget: true, pair: "chain_read+chain_verdict" },
  },
  chain_verdict: {
    schema: TOOL_CHAIN_VERDICT,
    access: "read",
    summary: "Record whether a newly read file was relevant; later pages inherit a relevant verdict.",
    observation: { type: "tool.chain_verdict", label: "ChainReview", format: "chain_verdict", pathKeys: ["path"], pair: "chain_read+chain_verdict" },
  },
  pull_brief: {
    schema: TOOL_PULL_BRIEF,
    access: "read",
    summary: "Build a bounded deterministic file brief for targeted context retrieval.",
    observation: { type: "tool.pull_brief", label: "PullBrief", format: "generic", targetKeys: ["query", "mode"] },
  },
  get_brief: {
    schema: TOOL_GET_BRIEF,
    access: "read",
    summary: "Load the pre-staged research brief bundle (analysis, structured data, file priorities, function index, source manifest) for this work item in one call.",
    observation: { type: "tool.get_brief", label: "GetBrief", format: "generic", targetKeys: [] },
  },
  project_db_query: {
    schema: TOOL_PROJECT_DB_QUERY,
    access: "read",
    summary: "Run a single SQL statement against the project's configured application database; allowed statement types follow the operator-granted permissions.",
    observation: { type: "tool.project_db_query", label: "ProjectDbQuery", format: "generic", targetKeys: ["query"] },
  },
  list_files: {
    schema: TOOL_LIST_FILES,
    access: "read",
    summary: "List directories and files within the allowed workspace scope.",
    observation: { type: "tool.list", label: "List", format: "list", targetKeys: ["path", "directory", "pattern"] },
  },
  search_files: {
    schema: TOOL_SEARCH_FILES,
    access: "read",
    summary: "Search file contents deterministically through self-bounded ripgrep output (one context line and matchesTotal, without continuation paging).",
    observation: { type: "tool.search", label: "Search", format: "search", targetKeys: ["path", "directory", "file_path"] },
  },
  git_history: {
    schema: TOOL_GIT_HISTORY,
    access: "read",
    summary: "Inspect git log/show/blame/diff history without shell access.",
    observation: { type: "tool.git_history", label: "GitHistory", format: "generic", targetKeys: ["path", "op", "ref"] },
  },
  inspect_file: {
    schema: TOOL_INSPECT_FILE,
    access: "read",
    summary: "Inspect metadata and image dimensions for one file path or an ordered batch.",
    observation: { type: "tool.inspect", label: "Inspect", format: "file", pathKeys: ["file_path", "path"], arrayPathKeys: ["path", "paths"], requireTarget: true },
  },
  hash_file: {
    schema: TOOL_HASH_FILE,
    access: "read",
    summary: "Hash files deterministically for verification and audit.",
    observation: { type: "tool.hash", label: "Hash", format: "file", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  write_file: {
    schema: TOOL_WRITE_FILE,
    access: "write",
    deprecated: true,
    deprecationReason: "Code handoff materializes exact files_to_create paths before provider execution; code dev/fix must populate them with edit_file.",
    summary: "Deprecated for code dev/fix: handoff materializes exact create paths before provider execution. Retained for dynamic artifact compatibility.",
    observation: { type: "tool.write", label: "Write", format: "file", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  edit_file: {
    schema: TOOL_EDIT_FILE,
    access: "write",
    summary: "Patch existing allowed files or update their executable permission without shell editing.",
    observation: { type: "tool.edit", label: "Edit", format: "edit", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  request_scope: {
    schema: TOOL_REQUEST_SCOPE,
    access: "write",
    summary: "Pause the current job for human approval of one exact writable file path.",
    observation: { type: "tool.scope_request", label: "ScopeRequest", format: "file", pathKeys: ["path"], requireTarget: true },
  },
  move_file: {
    schema: TOOL_MOVE_FILE,
    access: "write",
    summary: "Move or rename files inside the allowed scope.",
    observation: { type: "tool.move", label: "Move", format: "move_copy", sourceKey: "source", destinationKey: "destination" },
  },
  copy_file: {
    schema: TOOL_COPY_FILE,
    access: "write",
    summary: "Copy files inside the allowed scope.",
    observation: { type: "tool.copy", label: "Copy", format: "move_copy", sourceKey: "source", destinationKey: "destination" },
    surfaced: false,
  },
  make_dir: {
    schema: TOOL_MAKE_DIR,
    access: "write",
    summary: "Create directories inside the allowed scope.",
    observation: { type: "tool.mkdir", label: "MkDir", format: "file", pathKeys: ["path"], requireTarget: true },
  },
  resize_image: {
    schema: TOOL_RESIZE_IMAGE,
    access: "write",
    summary: "Resize PNG images deterministically.",
    observation: { type: "tool.resize_image", label: "Resize image", format: "resize_image", pathKeys: ["path", "file_path"] },
  },
  read_image_metadata: {
    schema: TOOL_READ_IMAGE_METADATA,
    access: "read",
    summary: "Inspect image metadata such as format and dimensions.",
    observation: { type: "tool.read_image_metadata", label: "ImageMeta", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  validate_artifact_output: {
    schema: TOOL_VALIDATE_ARTIFACT_OUTPUT,
    access: "read",
    summary: "Validate artifact output contents and image dimensions.",
    observation: { type: "tool.validate_artifact_output", label: "Validate artifact output", format: "artifact_output", rootKey: "output_root" },
  },
  prune_artifact_output: {
    schema: TOOL_PRUNE_ARTIFACT_OUTPUT,
    access: "write",
    summary: "Remove non-deliverable sidecar files from artifact output roots.",
    observation: { type: "tool.prune_artifact_output", label: "Prune artifact output", format: "artifact_output", rootKey: "output_root", includeDryRun: true },
  },
  optimize_image: {
    schema: TOOL_OPTIMIZE_IMAGE,
    access: "write",
    summary: "Optimize PNG images by stripping non-essential metadata.",
    observation: { type: "tool.optimize_image", label: "OptimizeImg", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  reencode_image: {
    schema: TOOL_REENCODE_IMAGE,
    access: "write",
    summary: "Re-encode image files to clean PNGs, including JPEG bytes saved with .png names.",
    observation: { type: "tool.reencode_image", label: "ReencodeImg", format: "reencode_image", pathKeys: ["path", "file_path"] },
  },
  clean_image: {
    schema: TOOL_CLEAN_IMAGE,
    access: "write",
    summary: "Inspect, re-encode, resize, or optimize images through one scoped cleanup tool.",
    observation: { type: "tool.clean_image", label: "CleanImage", format: "reencode_image", pathKeys: ["path", "file_path", "output_path"] },
  },
  generate_image: {
    schema: TOOL_GENERATE_IMAGE,
    access: "write",
    summary: "Generate new image artifacts inside allowed output scope.",
    observation: { type: "tool.generate_image", label: "Generate image", format: "generate_image", pathKeys: ["filename"] },
  },
  extract_image_text: {
    schema: TOOL_EXTRACT_IMAGE_TEXT,
    access: "read",
    summary: "Run local tesseract OCR to extract text from an image.",
    observation: { type: "tool.extract_image_text", label: "ExtractText", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  run_scoped_checks: {
    schema: TOOL_RUN_SCOPED_CHECKS,
    access: "shell",
    summary: "Canonical lint/typecheck route for the declared job scope, including scoped PHP syntax lint when applicable.",
    observation: { type: "tool.run_scoped_checks", label: "ScopedChecks", format: "generic", targetKeys: ["checks", "scope"] },
  },
  create_test_suite: {
    schema: TOOL_CREATE_TEST_SUITE,
    access: "shell",
    summary: "Create or update one DB-backed registered test suite without exposing the suite catalog.",
    observation: { type: "tool.create_test_suite", label: "CreateSuite", format: "generic", targetKeys: ["name", "suite"] },
  },
  create_test: {
    schema: TOOL_CREATE_TEST,
    access: "shell",
    summary: "Register or update one or many tests in a suite; every candidate runs first and a failing candidate is never persisted.",
    observation: { type: "tool.create_test", label: "CreateTest", format: "generic", targetKeys: ["suite_id", "suite", "name", "target_files", "target_symbols"] },
  },
  run_test: {
    schema: TOOL_RUN_TEST,
    access: "shell",
    summary: "Run one or many DB-backed registered tests and return per-test suite/name and pass/fail feedback.",
    observation: { type: "tool.run_test", label: "RunTest", format: "generic", targetKeys: ["test_id", "suite_id", "suite", "test"] },
  },
  run_test_suite: {
    schema: TOOL_RUN_TEST_SUITE,
    access: "shell",
    summary: "Run all active tests in one named/id suite without listing the full catalog.",
    observation: { type: "tool.run_test_suite", label: "RunSuite", format: "generic", targetKeys: ["suite_id", "suite"] },
  },
  bash: {
    schema: TOOL_BASH,
    access: "shell",
    summary: "Run guarded shell commands only when deterministic tools cannot satisfy the task; do not bypass run_scoped_checks for lint/typecheck.",
    observation: { type: "tool.bash", label: "Bash", format: "command", commandKey: "command", kind: "system_call" },
  },
  agent_feedback: {
    schema: TOOL_AGENT_FEEDBACK,
    // "read" = no workspace/file writes, so it stays available to read-only
    // roles (planner/researcher/assessor). It does record to the Monitor Agents
    // interaction channel; that is intentional and not a workspace mutation.
    access: "read",
    summary: "Send a short visible operational update to Monitor Agents.",
    observation: { type: "tool.agent_feedback", label: "AgentFeedback", format: "generic", targetKeys: ["phase", "status", "summary"] },
    budgetExempt: true,
  },
  get_operator_feedback: {
    schema: TOOL_GET_OPERATOR_FEEDBACK,
    access: "read",
    summary: "Internal recovery endpoint for interrupted direct operator-feedback delivery.",
    observation: { type: "tool.get_operator_feedback", label: "GetFeedback", format: "generic", targetKeys: ["limit"] },
    budgetExempt: true,
  },
  ack_operator_feedback: {
    schema: TOOL_ACK_OPERATOR_FEEDBACK,
    access: "read",
    summary: "Acknowledge retrieved operator feedback as accepted, rejected, or deferred.",
    observation: { type: "tool.ack_operator_feedback", label: "AckFeedback", format: "generic", targetKeys: ["interaction_id", "decision"] },
    budgetExempt: true,
  },
  ...Object.fromEntries(Object.entries(ATLAS_TOOL_DEFS).map(([name, schema]) => [name, {
    schema,
    access: "atlas",
    systemPrefetchCapable: SYSTEM_PREFETCH_CAPABLE_ATLAS_ACTIONS.has(name),
  }])),
};

const REMOTE_ATLAS_INTERNAL_TOOLS = Object.freeze([
  "traverse_ref",
  "fetch_ref",
  "create_ref",
  "repo.overview",
  "tree.overview",
  "tree.scope",
  "tree.branch",
  "tree.expand",
  "symbol.search",
  "symbol.card",
  "symbol.overview",
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
      read: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
      // Exact files_to_create are materialized as empty files before a code
      // dev/fix provider starts, then moved into files_to_modify. write_file
      // remains registered for compatibility/artificer output but must not be
      // issued on this surface; edit_file can populate the empty file.
      write: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "edit_file", "move_file", "make_dir", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "extract_image_text", "project_db_query"],
    }),
    artificer: Object.freeze({
      read: ["ack_operator_feedback"],
      write: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "move_file", "make_dir", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "clean_image", "extract_image_text", "bash", "project_db_query"],
      imageGeneration: ["generate_image"],
    }),
    // Assessor carries project_db_query on the READ lane so it can verify the
    // claimed end state of db-mode dev work with SELECT/inspection; the
    // execution capability cap keeps it read-only regardless of the operator
    // grant, and the contract gate drops the tool when no read grant exists.
    assessor: Object.freeze({
      read: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "read_image_metadata", "validate_artifact_output", "extract_image_text", "run_scoped_checks", ...(REGISTERED_TEST_AGENT_SURFACE_ENABLED ? ["run_test", "run_test_suite"] : []), "bash", "project_db_query"],
      write: ["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "read_image_metadata", "validate_artifact_output", "extract_image_text", "run_scoped_checks", ...(REGISTERED_TEST_AGENT_SURFACE_ENABLED ? ["run_test", "run_test_suite"] : []), "bash", "project_db_query"],
    }),
    // researcher/planner carry project_db_query as a READ-lane tool: the
    // execution capability cap limits them to SELECT/inspection regardless of
    // the operator grant, and the contract gate drops the tool entirely when
    // the repo grants no read permission.
    researcher: Object.freeze({
      read: ["ack_operator_feedback", "chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
      write: ["ack_operator_feedback", "chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
    }),
    planner: Object.freeze({
      read: ["ack_operator_feedback", "get_brief", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
      write: ["ack_operator_feedback", "get_brief", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
    }),
    // Internal one-turn JSON model passes are not Jobs and therefore cannot
    // possess an Agent-bound MCP gate. Their prompts explicitly prohibit tool
    // use, and this empty contract keeps that boundary true at the CLI layer.
    model_pass: Object.freeze({ read: [], write: [] }),
    preflight: Object.freeze({ read: [], write: [] }),
    delegator: Object.freeze({ read: [], write: [] }),
    default: Object.freeze({
      read: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
      write: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "bash", "project_db_query"],
    }),
  }),
  deterministicMcp: Object.freeze({
    read: Object.freeze(["ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"]),
    write: Object.freeze(["write_file", "edit_file", "move_file", "make_dir", "prune_artifact_output"]),
    // Read-only image inspection (dev/artificer/assessor). clean_image is a
    // mutation and is gated to artificer separately — keep it out of this set.
    imageHelpers: Object.freeze(["read_image_metadata", "validate_artifact_output"]),
    imageMutation: Object.freeze(["clean_image"]),
    imageGeneration: Object.freeze(["generate_image"]),
    ocr: Object.freeze(["extract_image_text"]),
    shellRoles: Object.freeze(["artificer", "assessor"]),
    writeRoles: Object.freeze(["dev", "artificer"]),
    imageHelperRoles: Object.freeze(["dev", "artificer", "assessor"]),
    imageGenerationRoles: Object.freeze(["artificer"]),
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
    delegator: Object.freeze({
      phase: null,
      tools: Object.freeze([]),
      rationale: "Delegator emits routing JSON only; no tool surface required.",
    }),
  }),
});

const ROLE_TOOL_ALLOWLISTS = TOOL_ROLE_LIBRARY.baseToolAllowlists;

export const DETERMINISTIC_READ_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.read;
export const DETERMINISTIC_WRITE_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.write;
export const DETERMINISTIC_IMAGE_HELPER_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageHelpers;
export const DETERMINISTIC_IMAGE_MUTATION_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageMutation;
export const DETERMINISTIC_IMAGE_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageGeneration;
export const DETERMINISTIC_OCR_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.ocr;

// Native benchmark teams own the whole workflow in one provider session, so
// they need the same opt-in web lane that Posse splits across researcher and
// assessor roles. The account toggle and provider policy still fail closed.
export const WEB_TOOL_ROLES = new Set(["researcher", "assessor", "native"]);
export const GATED_ROLES = new Set(["researcher", "planner", "dev", "assessor"]);

export const MEANINGFUL_ATLAS_ACTIONS = new Set([
  "symbol.search",
  "symbol.card",
  "symbol.overview",
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

// The ATLAS-first gate covers ONLY non-ATLAS read/discovery tools: it forces a
// role to attempt ATLAS retrieval before falling back to raw reads/listings for
// context discovery. It deliberately does NOT gate:
//   - write tools (write_file, edit_file, move/copy/make_dir, bash) — mutation
//     is governed by scope/policy, never by ATLAS-first ordering, and
//   - git_history — Git state/history is not mirrored in ATLAS, so ATLAS
//     retrieval cannot substitute for it, and
//   - ack_operator_feedback — direct feedback delivery must remain
//     acknowledgeable regardless of ATLAS readiness. The recovery getter is
//     internal and never issued. Outbound status uses native commentary.
// Only the read/discovery tools below are gated.
export const GATED_NATIVE_TOOLS = new Set([
  "chain_read",
  "chain_verdict",
  "list_files",
  "search_files",
  "inspect_file",
  "hash_file",
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

function roleAllowlistForTool(toolName) {
  if (toolName === "sub_agent_next_input") return new Set(["subagent"]);
  if (toolName === "web_research_handoff") return new Set(["researcher"]);
  if (toolName === "dispatch_agent") return new Set(["researcher", "planner"]);
  if (toolName === "agent_handoff") {
    return new Set(["researcher", "planner", "dev", "artificer", "assessor", "subagent"]);
  }
  if (toolName === "sub_agent") {
    return new Set(["researcher", "dev", "artificer"]);
  }
  const roles = [];
  for (const [role, config] of Object.entries(ROLE_TOOL_ALLOWLISTS)) {
    if (role === "default") continue;
    const names = new Set([
      ...(config.read || []),
      ...(config.write || []),
      ...(config.imageGeneration || []),
    ]);
    if (names.has(toolName)) roles.push(role);
  }
  // Researcher switches between read_file (when Atlas is available) and the
  // audited chain protocol (when it is not). The static catalog records the
  // union; runtime availability performs the mode-specific narrowing.
  if (toolName === "read_file" && !roles.includes("researcher")) roles.push("researcher");
  return new Set(roles);
}

function atlasRoleAllowlistForTool(toolName) {
  const roles = [];
  for (const [role, route] of Object.entries(TOOL_ROLE_LIBRARY.atlasRoutes)) {
    if ((route.tools || []).includes(toolName)) roles.push(role);
  }
  return new Set(roles);
}

function capabilityFlagsFor(access) {
  return Object.freeze({
    read: access === "read",
    write: access === "write",
    shell: access === "shell",
    atlas: access === "atlas",
    coordination: access === "coordination",
  });
}

for (const [name, authored] of Object.entries(TOOL_CATALOG)) {
  const access = String(authored.access || "unknown");
  if (!authored.schema) throw new Error(`Missing schema in canonical tool catalog entry ${name}`);
  if (access !== "atlas" && !authored.observation) {
    throw new Error(`Missing observation metadata in canonical tool catalog entry ${name}`);
  }
  const roleAllowlist = access === "atlas"
    ? atlasRoleAllowlistForTool(name)
    : roleAllowlistForTool(name);
  const surfaced = typeof authored.surfaced === "boolean"
    ? authored.surfaced
    : (access === "atlas" ? isAtlasActionSurfaced(name) : roleAllowlist.size > 0);
  TOOL_CATALOG[name] = Object.freeze({
    ...authored,
    name,
    summary: String(authored.summary || authored.schema.description || ""),
    batching: getToolBatchingClass(name),
    observation: authored.observation ? Object.freeze({ ...authored.observation }) : null,
    roleAllowlist,
    gateTier: access === "atlas"
      ? "atlas"
      : (GATED_NATIVE_TOOLS.has(name) ? "native-atlas-gated" : "native"),
    capabilityFlags: capabilityFlagsFor(access),
    surfaced,
    budgetExempt: authored.budgetExempt === true,
    deprecated: authored.deprecated === true,
    deprecationReason: authored.deprecationReason || null,
  });
}
Object.freeze(TOOL_CATALOG);

export function getToolCatalogEntry(name) {
  const entry = TOOL_CATALOG[name] || null;
  return entry?.surfaced === false ? null : entry;
}

export function getCanonicalToolCatalogEntry(name) {
  return TOOL_CATALOG[name] || null;
}

export function getToolSchema(name) {
  return getToolCatalogEntry(name)?.schema || null;
}

export function getCanonicalToolSchema(name) {
  return getCanonicalToolCatalogEntry(name)?.schema || null;
}

export function getToolSchemaForRole(name, role, {
  compactCompletion = false,
  compactV3 = false,
  compactV4 = false,
} = {}) {
  if (name !== "agent_handoff") return getToolSchema(name);
  return getAgentHandoffToolSchemaForRole(role, { compactCompletion, compactV3, compactV4 });
}

export function getToolExecutionSpec(name) {
  const entry = getToolCatalogEntry(name);
  if (!entry) return null;
  return executionSpecForEntry(entry);
}

export function getCanonicalToolExecutionSpec(name) {
  const entry = getCanonicalToolCatalogEntry(name);
  if (!entry) return null;
  return executionSpecForEntry(entry);
}

function executionSpecForEntry(entry) {
  return {
    access: entry.access,
    summary: entry.summary,
    batching: entry.batching,
    observation: entry.observation,
    budgetExempt: entry.budgetExempt,
    deprecated: entry.deprecated,
    deprecationReason: entry.deprecationReason,
  };
}

export function getBaseToolNamesForRole(role, allowWrite, { needsImageGeneration = false, agentHandoff = false, subAgent = false, dispatchAgent = false, webResearchHandoff = false } = {}) {
  if (role === "subagent") return ["sub_agent_next_input", "agent_handoff"];
  const config = ROLE_TOOL_ALLOWLISTS[role] || ROLE_TOOL_ALLOWLISTS.default;
  const key = allowWrite ? "write" : "read";
  const names = [...(config[key] || [])];
  if (role === "artificer" && allowWrite && needsImageGeneration) {
    names.push(...(config.imageGeneration || []));
  }
  if (agentHandoff && ["researcher", "planner", "dev", "artificer", "assessor"].includes(role)) {
    names.unshift("agent_handoff");
  }
  if (subAgent && ["researcher", "dev", "artificer"].includes(role)) {
    names.unshift("sub_agent");
  }
  if (dispatchAgent && ["researcher", "planner"].includes(role)) names.unshift("dispatch_agent");
  if (webResearchHandoff && role === "researcher") names.unshift("web_research_handoff");
  return names;
}

export function roleUsesDeterministicReadMcp(role) {
  return role === "dev"
    || role === "planner"
    || role === "artificer"
    || role === "assessor"
    || role === "researcher"
    // Coordination-only agents still receive an MCP gate dependency. Their
    // role contract is intentionally empty; attachment is not authorization.
    || role === "preflight"
    || role === "delegator";
}

export function roleUsesDeterministicWriteMcp(role) {
  return TOOL_ROLE_LIBRARY.deterministicMcp.writeRoles.includes(role);
}

export function roleUsesDeterministicImageMcp(role) {
  return TOOL_ROLE_LIBRARY.deterministicMcp.imageGenerationRoles.includes(role);
}

export function roleUsesDeterministicImageHelpers(role) {
  return TOOL_ROLE_LIBRARY.deterministicMcp.imageHelperRoles.includes(role);
}

export function getDeterministicMcpToolNames(role, {
  needsImageGeneration = false,
  agentHandoff = false,
  subAgent = false,
  dispatchAgent = false,
  webResearchHandoff = false,
  atlasAvailable = false,
} = {}) {
  if (role === "subagent") return ["sub_agent_next_input", "agent_handoff"];
  if (!roleUsesDeterministicReadMcp(role)) return [];
  if (role === "preflight" || role === "delegator") return [];
  const tools = [...DETERMINISTIC_READ_TOOLS];
  if (roleUsesDeterministicWriteMcp(role)) {
    tools.push(...DETERMINISTIC_WRITE_TOOLS.filter((name) => (
      role !== "dev" || name !== "write_file"
    )));
  }
  if (roleUsesDeterministicImageHelpers(role)) tools.push(...DETERMINISTIC_IMAGE_HELPER_TOOLS);
  // clean_image mutates an image within scope; keep it artificer-only.
  if (roleUsesDeterministicImageMcp(role)) tools.push(...DETERMINISTIC_IMAGE_MUTATION_TOOLS);
  if (roleUsesDeterministicImageMcp(role) && needsImageGeneration) tools.push(...DETERMINISTIC_IMAGE_TOOLS);
  if (role === "dev" || role === "artificer" || role === "assessor") tools.push(...DETERMINISTIC_OCR_TOOLS);
  // Scoped lint/typecheck belongs to the assessor. The separate DB-backed
  // registered-test experiment remains deferred and is not issued.
  if (role === "assessor") {
    tools.push("run_scoped_checks");
    if (REGISTERED_TEST_AGENT_SURFACE_ENABLED) tools.push("run_test", "run_test_suite");
  }
  if (TOOL_ROLE_LIBRARY.deterministicMcp.shellRoles.includes(role)) tools.push("bash");
  if (role === "planner") tools.push("get_brief");
  // Opt-in project DB access: write-lane roles (dev/artificer) use the full
  // operator grant, read-lane roles (researcher/planner) are capped to SELECT
  // at execution. The MCP gateway's runtimeToolAvailable() hides the tool
  // unless this repo's admin config enables it with a usable grant.
  if (["dev", "artificer", "assessor", "researcher", "planner"].includes(role)) tools.push("project_db_query");
  if (role === "researcher" && !atlasAvailable) {
    const readIdx = tools.indexOf("read_file");
    if (readIdx !== -1) tools.splice(readIdx, 1);
    tools.push("chain_read", "chain_verdict");
  }
  if (agentHandoff && ["researcher", "planner", "dev", "artificer", "assessor"].includes(role)) {
    tools.unshift("agent_handoff");
  }
  if (subAgent && ["researcher", "dev", "artificer"].includes(role)) {
    tools.unshift("sub_agent");
  }
  if (dispatchAgent && ["researcher", "planner"].includes(role)) tools.unshift("dispatch_agent");
  if (webResearchHandoff && role === "researcher") tools.unshift("web_research_handoff");
  return tools;
}

export function getAtlasToolNames() {
  return Object.keys(SURFACED_ATLAS_TOOL_DEFS);
}

export function getSyntheticAtlasToolSchemas(availableToolNames = []) {
  const available = new Set([...availableToolNames].map((name) => String(name || "")));
  const hasDelta = available.has("atlas.review.delta") || available.has("review.delta");
  const hasRisk = available.has("atlas.review.analyze") || available.has("review.analyze");
  const schemas = [];
  if (hasDelta && hasRisk) {
    const def = ATLAS_TOOL_DEFS["review.risk"];
    schemas.push({
      name: "atlas.review.risk",
      description: def.description,
      inputSchema: projectAgentToolSchema(def.parameters),
      annotations: { title: "ATLAS PR Risk" },
    });
  }
  return schemas.map((schema) => ({ ...schema }));
}

export function getAtlasRouteDefinitionForRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const route = TOOL_ROLE_LIBRARY.atlasRoutes[normalizedRole] || Object.freeze({
    phase: null,
    tools: Object.freeze([]),
    internalTools: Object.freeze([]),
    rationale: "No ATLAS route is defined for this role.",
  });
  const externalTools = Array.isArray(route.tools) ? route.tools : [];
  const internalTools = Array.isArray(route.internalTools) ? route.internalTools : externalTools;
  return {
    phase: route.phase,
    // Advertised to (and gate-callable by) the agent: prefetch-only actions
    // are excluded here on purpose.
    tools: [...externalTools].filter(isExternallyRoutedAtlasTool),
    // Routed for the role at all — what the handoff prefetch may execute on
    // the agent's behalf. Prefetch-only tree actions stay in THIS list; only
    // mutating and fallback-only actions are stripped.
    internalTools: [...internalTools].filter((tool) => !isBlockedFoldedAtlasTool(tool) && !isFallbackOnlyAtlasTool(tool)),
    rationale: route.rationale,
  };
}

function normalizeAtlasActionName(tool) {
  const raw = String(tool || "").trim();
  if (!raw) return "";
  if (ATLAS_TOOL_DEFS[raw]) return raw;
  const stripped = stripAtlasPrefix(raw);
  if (ATLAS_TOOL_DEFS[stripped]) return stripped;
  for (const [action, def] of Object.entries(ATLAS_TOOL_DEFS)) {
    if (def?.name === raw) return action;
  }
  return stripped;
}

function normalizedAtlasActionSet(tools = []) {
  return new Set((Array.isArray(tools) ? tools : [])
    .map((tool) => normalizeAtlasActionName(tool))
    .filter(Boolean));
}

function atlasContractToolsForRoute(route, opts = {}) {
  const routeTools = (Array.isArray(route?.tools) ? [...route.tools] : [])
    .filter(isExternallyRoutedAtlasTool);
  const attached = normalizedAtlasActionSet(opts?.atlasAttachment?.tools);
  if (attached.size > 0) {
    return [...attached].filter(isExternallyRoutedAtlasTool);
  }
  return routeTools;
}


export function renderAtlasRoleContract(role, opts = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const route = getAtlasRouteDefinitionForRole(normalizedRole);
  const routeTools = atlasContractToolsForRoute(route, opts);
  const label = atlasBackendLabel(opts?.atlasAttachment);
  if (!routeTools.length) {
    return `No ${label} repository tools are issued to this role.`;
  }
  return [
    `${label} repository inspection is active for the ${normalizedRole || "current"} role.`,
    "The provider-exposed tool schemas are exhaustive and own exact names, arguments, and action semantics.",
  ].join("\n");
}

const ATLAS_MUTATING_ACTIONS = new Set([
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

const ATLAS_FALLBACK_ONLY_ACTIONS = new Set([
  "file.read",
]);

// Actions the handoff prefetch runs on the agent's behalf with better input
// than the agent could reconstruct. Keep their schemas and internal role
// routes intact while the whole tree suite is reversibly disabled on the
// agent-facing surface.
const ATLAS_PREFETCH_ONLY_ACTIONS = new Set([
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

export function isPrefetchOnlyAtlasTool(name) {
  return ATLAS_PREFETCH_ONLY_ACTIONS.has(stripAtlasPrefix(name));
}

function stripAtlasPrefix(name) {
  const raw = String(name || "");
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length);
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".");
  return raw;
}

export function isBlockedFoldedAtlasTool(name) {
  return ATLAS_MUTATING_ACTIONS.has(stripAtlasPrefix(name));
}

export function isFallbackOnlyAtlasTool(name) {
  return ATLAS_FALLBACK_ONLY_ACTIONS.has(stripAtlasPrefix(name));
}

export function isExternallyRoutedAtlasTool(name) {
  const action = stripAtlasPrefix(name);
  // Route allowlist membership keeps hidden-surface read actions (info,
  // policy.get, usage.stats, etc.). Those actions are routed/allowed for the
  // role even though they are not advertised as standalone enum values; only
  // mutating, fallback-only, and internal-only actions are stripped from the
  // agent route.
  return !isBlockedFoldedAtlasTool(action)
    && !isFallbackOnlyAtlasTool(action)
    && !INTERNAL_ATLAS_SURFACE_ACTION_SET.has(action)
    && !ATLAS_PREFETCH_ONLY_ACTIONS.has(action);
}

export function projectAtlasToolDefinitionForRuntime(schema = {}, {
  action = null,
  codeWindowPolicy = null,
} = {}) {
  const normalizedAction = normalizeAtlasActionName(action || schema?.name);
  if (normalizedAction !== "code.window" || !codeWindowPolicy) return schema;
  const projected = cloneJson(schema);
  const policy = normalizeAtlasCodeWindowPolicy(codeWindowPolicy);
  for (const schemaKey of ["parameters", "inputSchema"]) {
    const maxTokens = projected?.[schemaKey]?.properties?.maxTokens;
    if (!maxTokens || typeof maxTokens !== "object") continue;
    maxTokens.maximum = policy.maxWindowTokens;
    maxTokens.description = `Optional inline token cap for this selection. The configured maximum for this run is ${policy.maxWindowTokens} tokens; larger values are clamped.`;
  }
  return projected;
}

export function buildNativeToolDescriptor(schema, opts = {}) {
  const projected = projectAtlasToolDefinitionForRuntime(schema, opts);
  return projectAgentToolDefinition({
    name: projected.name,
    description: projected.description,
    inputSchema: projected.parameters || { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      title: projected.name,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  });
}

export function buildFoldedAtlasToolDescriptor(schema = {}, {
  role = null,
  codeWindowPolicy = null,
} = {}) {
  const projected = projectAtlasToolDefinitionForRuntime(schema, { codeWindowPolicy });
  const annotations = projected.annotations && typeof projected.annotations === "object"
    ? projected.annotations
    : {};
  const name = String(projected.name || "");
  const mutating = isBlockedFoldedAtlasTool(name);
  const canonicalDescription = ATLAS_TOOL_DEFS[stripAtlasPrefix(name)]?.description;
  let inputSchema = projected.inputSchema;
  // Keep every provider-facing window selection scalar so independent exact
  // reads can be scheduled concurrently. Upstream catalogs may temporarily
  // retain the retired items mode during a staggered rollout, so narrow it at
  // this local enforcement boundary too.
  if (
    stripAtlasPrefix(name) === "code.window"
    && inputSchema?.properties?.items
    && Array.isArray(inputSchema.anyOf)
  ) {
    const properties = { ...inputSchema.properties };
    delete properties.items;
    inputSchema = {
      ...inputSchema,
      properties,
      required: [],
      anyOf: inputSchema.anyOf.filter((mode) => !mode?.required?.includes("items")),
    };
  }
  void role;
  return projectAgentToolDefinition({
    ...projected,
    description: canonicalDescription || projected.description,
    ...(inputSchema ? { inputSchema } : {}),
    annotations: {
      ...annotations,
      title: annotations.title || name,
      readOnlyHint: !mutating,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  });
}
