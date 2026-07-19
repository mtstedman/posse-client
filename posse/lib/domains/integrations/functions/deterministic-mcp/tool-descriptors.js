import { TOOL_INSPECT_FILE } from "../../../worker/functions/helpers/file-inspector.js";
import { TOOL_GIT_HISTORY } from "../../../git/functions/history.js";
import { resolveAtlasToolGateEnabled, resolveAtlasProseDedup } from "./gate-settings.js";
import { ATLAS_INDEXABLE_SOURCE_EXTENSIONS } from "./source-file-gate.js";
import { formatAtlasBackendText, atlasBackendLabel } from "../atlas-label.js";
import { atlasDescriptorSchemaForAction } from "../../../atlas/functions/v2/contracts/tool-schemas.js";
import { POSSE_MCP_GATEWAY_TRANSPORT } from "../mcp-gateway.js";

// Static data table mirroring each provider's capabilities.toolAttachment.
// Defined here rather than imported via getProvider() so this module stays
// out of the provider-registry import cycle (tool-descriptors is loaded
// during provider module initialization). A contract test asserts this
// table stays in sync with the per-provider capability declarations.
const TOOL_ATTACHMENT_BY_PROVIDER = Object.freeze({
  claude: "mcp",
  openai: "function",
  grok: "function",
  codex: "deterministic-bridge",
  copilot: "mcp",
});

function _toolAttachmentModeFor(providerName) {
  return TOOL_ATTACHMENT_BY_PROVIDER[providerName] || null;
}

function _providerLabelFor(providerName) {
  if (providerName === "openai") return "OpenAI";
  if (providerName === "grok") return "Grok";
  if (providerName === "codex") return "Codex";
  if (providerName === "claude") return "Claude";
  return providerName ? providerName.charAt(0).toUpperCase() + providerName.slice(1) : "This provider";
}

export { TOOL_ATTACHMENT_BY_PROVIDER };

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
} from "../../../../catalog/native-tools.js";

import { ATLAS_TOOL_DEFS_RAW } from "../../../../catalog/atlas-tools.js";
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
  "tree.scope",
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

export const ATLAS_TOOL_DEFS = Object.freeze(withNativeAtlasSchemas(ATLAS_TOOL_DEFS_RAW));
export const SURFACED_ATLAS_TOOL_DEFS = Object.freeze(
  Object.fromEntries(Object.entries(ATLAS_TOOL_DEFS).filter(([action]) => isAtlasActionSurfaced(action))),
);

function withNativeAtlasSchemas(defs) {
  const out = {};
  for (const [action, def] of Object.entries(defs)) {
    const generated = atlasDescriptorSchemaForAction(action);
    const parameters = generated
      ? mergeSchemaDescriptions(generated, def.parameters)
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

function mergeSchemaDescriptions(generated, existing) {
  const out = cloneJson(generated);
  mergeDescriptionsInPlace(out, existing || {});
  return out;
}

function mergeDescriptionsInPlace(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return;
  if (!target.description && typeof source.description === "string") target.description = source.description;
  if (!Object.prototype.hasOwnProperty.call(target, "default") && Object.prototype.hasOwnProperty.call(source, "default")) {
    target.default = source.default;
  }
  const targetProps = target.properties && typeof target.properties === "object" ? target.properties : {};
  const sourceProps = source.properties && typeof source.properties === "object" ? source.properties : {};
  for (const [key, child] of Object.entries(targetProps)) {
    mergeDescriptionsInPlace(child, sourceProps[key]);
  }
  if (target.items && source.items) mergeDescriptionsInPlace(target.items, source.items);
  if (
    target.additionalProperties
    && typeof target.additionalProperties === "object"
    && source.additionalProperties
    && typeof source.additionalProperties === "object"
  ) {
    mergeDescriptionsInPlace(target.additionalProperties, source.additionalProperties);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export const TOOL_EXECUTION_SPECS = Object.freeze({
  read_file: {
    access: "read",
    summary: "Read file contents with line-aware slices.",
    observation: { type: "tool.read", label: "Read", format: "file", pathKeys: ["file_path", "path"], requireTarget: true, includeRange: true },
  },
  chain_read: {
    access: "read",
    summary: "Read one file for researcher review; must be paired with chain_verdict.",
    observation: { type: "tool.chain_read", label: "ChainRead", format: "file", pathKeys: ["path"], requireTarget: true, pair: "chain_read+chain_verdict" },
  },
  chain_verdict: {
    access: "read",
    summary: "Record whether the preceding chain_read was relevant before reading another file.",
    observation: { type: "tool.chain_verdict", label: "ChainReview", format: "chain_verdict", pathKeys: ["path"], pair: "chain_read+chain_verdict" },
  },
  pull_brief: {
    access: "read",
    summary: "Build a bounded deterministic file brief for targeted context retrieval.",
    observation: { type: "tool.pull_brief", label: "PullBrief", format: "generic", targetKeys: ["query", "mode"] },
  },
  get_brief: {
    access: "read",
    summary: "Load the pre-staged research brief bundle (analysis, structured data, file priorities, function index, source manifest) for this work item in one call.",
    observation: { type: "tool.get_brief", label: "GetBrief", format: "generic", targetKeys: [] },
  },
  project_db_query: {
    access: "read",
    summary: "Run a single SQL statement against the project's configured application database; allowed statement types follow the operator-granted permissions.",
    observation: { type: "tool.project_db_query", label: "ProjectDbQuery", format: "generic", targetKeys: ["query"] },
  },
  list_files: {
    access: "read",
    summary: "List directories and files within the allowed workspace scope.",
    observation: { type: "tool.list", label: "List", format: "list", targetKeys: ["path", "directory", "pattern"] },
  },
  search_files: {
    access: "read",
    summary: "Search file contents deterministically through the required ripgrep-backed search_files tool.",
    observation: { type: "tool.search", label: "Search", format: "search", targetKeys: ["path", "directory", "file_path"] },
  },
  git_history: {
    access: "read",
    summary: "Inspect git log/show/blame/diff history without shell access.",
    observation: { type: "tool.git_history", label: "GitHistory", format: "generic", targetKeys: ["path", "op", "ref"] },
  },
  inspect_file: {
    access: "read",
    summary: "Inspect file metadata and image dimensions; pass `paths: [...]` to batch many files in one call instead of looping.",
    observation: { type: "tool.inspect", label: "Inspect", format: "file", pathKeys: ["file_path", "path"], arrayPathKeys: ["paths"], requireTarget: true },
  },
  hash_file: {
    access: "read",
    summary: "Hash files deterministically for verification and audit.",
    observation: { type: "tool.hash", label: "Hash", format: "file", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  write_file: {
    access: "write",
    summary: "Create or overwrite allowed files.",
    observation: { type: "tool.write", label: "Write", format: "file", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  edit_file: {
    access: "write",
    summary: "Patch existing allowed files without shell editing.",
    observation: { type: "tool.edit", label: "Edit", format: "edit", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  request_scope: {
    access: "write",
    summary: "Pause the current job for human approval of one exact writable file path.",
    observation: { type: "tool.scope_request", label: "ScopeRequest", format: "file", pathKeys: ["path"], requireTarget: true },
  },
  move_file: {
    access: "write",
    summary: "Move or rename files inside the allowed scope.",
    observation: { type: "tool.move", label: "Move", format: "move_copy", sourceKey: "source", destinationKey: "destination" },
  },
  copy_file: {
    access: "write",
    summary: "Copy files inside the allowed scope.",
    observation: { type: "tool.copy", label: "Copy", format: "move_copy", sourceKey: "source", destinationKey: "destination" },
  },
  make_dir: {
    access: "write",
    summary: "Create directories inside the allowed scope.",
    observation: { type: "tool.mkdir", label: "MkDir", format: "file", pathKeys: ["path"], requireTarget: true },
  },
  resize_image: {
    access: "write",
    summary: "Resize PNG images deterministically.",
    observation: { type: "tool.resize_image", label: "Resize image", format: "resize_image", pathKeys: ["path", "file_path"] },
  },
  read_image_metadata: {
    access: "read",
    summary: "Inspect image metadata such as format and dimensions.",
    observation: { type: "tool.read_image_metadata", label: "ImageMeta", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  validate_artifact_output: {
    access: "read",
    summary: "Validate artifact output contents and image dimensions.",
    observation: { type: "tool.validate_artifact_output", label: "Validate artifact output", format: "artifact_output", rootKey: "output_root" },
  },
  prune_artifact_output: {
    access: "write",
    summary: "Remove non-deliverable sidecar files from artifact output roots.",
    observation: { type: "tool.prune_artifact_output", label: "Prune artifact output", format: "artifact_output", rootKey: "output_root", includeDryRun: true },
  },
  optimize_image: {
    access: "write",
    summary: "Optimize PNG images by stripping non-essential metadata.",
    observation: { type: "tool.optimize_image", label: "OptimizeImg", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  reencode_image: {
    access: "write",
    summary: "Re-encode image files to clean PNGs, including JPEG bytes saved with .png names.",
    observation: { type: "tool.reencode_image", label: "ReencodeImg", format: "reencode_image", pathKeys: ["path", "file_path"] },
  },
  clean_image: {
    access: "write",
    summary: "Inspect, re-encode, resize, or optimize images through one scoped cleanup tool.",
    observation: { type: "tool.clean_image", label: "CleanImage", format: "reencode_image", pathKeys: ["path", "file_path", "output_path"] },
  },
  generate_image: {
    access: "write",
    summary: "Generate new image artifacts inside allowed output scope.",
    observation: { type: "tool.generate_image", label: "Generate image", format: "generate_image", pathKeys: ["path", "file_path", "output_path"] },
  },
  extract_image_text: {
    access: "read",
    summary: "Run local tesseract OCR to extract text from an image.",
    observation: { type: "tool.extract_image_text", label: "ExtractText", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  run_scoped_checks: {
    access: "shell",
    summary: "Canonical lint/typecheck route for the declared job scope, including scoped PHP syntax lint when applicable.",
    observation: { type: "tool.run_scoped_checks", label: "ScopedChecks", format: "generic", targetKeys: ["checks", "scope"] },
  },
  create_test_suite: {
    access: "shell",
    summary: "Create or update one DB-backed registered test suite without exposing the suite catalog.",
    observation: { type: "tool.create_test_suite", label: "CreateSuite", format: "generic", targetKeys: ["name", "suite"] },
  },
  create_test: {
    access: "shell",
    summary: "Register or update one test in a suite, rejecting it unless it passes immediately.",
    observation: { type: "tool.create_test", label: "CreateTest", format: "generic", targetKeys: ["suite_id", "suite", "name", "target_files", "target_symbols"] },
  },
  run_test: {
    access: "shell",
    summary: "Run one DB-backed registered test and return compact pass/fail feedback.",
    observation: { type: "tool.run_test", label: "RunTest", format: "generic", targetKeys: ["test_id", "suite_id", "suite", "test"] },
  },
  run_test_suite: {
    access: "shell",
    summary: "Run all active tests in one named/id suite without listing the full catalog.",
    observation: { type: "tool.run_test_suite", label: "RunSuite", format: "generic", targetKeys: ["suite_id", "suite"] },
  },
  bash: {
    access: "shell",
    summary: "Run guarded shell commands only when deterministic tools cannot satisfy the task; do not bypass run_scoped_checks for lint/typecheck.",
    observation: { type: "tool.bash", label: "Bash", format: "command", commandKey: "command", kind: "system_call" },
  },
  agent_feedback: {
    // "read" = no workspace/file writes, so it stays available to read-only
    // roles (planner/researcher/assessor). It does record to the Monitor Agents
    // interaction channel; that is intentional and not a workspace mutation.
    access: "read",
    summary: "Send a short visible operational update to Monitor Agents.",
    observation: { type: "tool.agent_feedback", label: "AgentFeedback", format: "generic", targetKeys: ["phase", "status", "summary"] },
    budgetExempt: true,
  },
  get_operator_feedback: {
    access: "read",
    summary: "Retrieve pending live operator feedback after a tool result signals availability.",
    observation: { type: "tool.get_operator_feedback", label: "GetFeedback", format: "generic", targetKeys: ["limit"] },
    budgetExempt: true,
  },
  ack_operator_feedback: {
    access: "read",
    summary: "Acknowledge retrieved operator feedback as accepted, rejected, or deferred.",
    observation: { type: "tool.ack_operator_feedback", label: "AckFeedback", format: "generic", targetKeys: ["interaction_id", "decision"] },
    budgetExempt: true,
  },
  "query": { access: "atlas", summary: "Compact gateway for native ATLAS v2 retrieval actions." },
  "code": { access: "atlas", summary: "Compact gateway for native ATLAS v2 code-inspection actions." },
  "repo": { access: "atlas", summary: "Compact gateway for native ATLAS v2 action-catalog discovery: action search and compact manuals." },
  "agent": { access: "atlas", summary: "Compact gateway for native ATLAS v2 memory curation actions: memory store and memory feedback." },
  "action.search": { access: "atlas", summary: "Search the native ATLAS v2 action catalog for the right tool/action." },
  "manual": { access: "atlas", summary: "Return compact native ATLAS v2 API reference entries." },
  "workflow": { access: "atlas", summary: "Execute multi-step native ATLAS workflows with data transforms and references." },
  "info": { access: "atlas", summary: "Report native ATLAS v2 runtime, storage, view freshness, ledger, and policy diagnostics." },
  "fetch_ref": { access: "atlas", summary: "Fetch one or more opaque refs from the current agent scope. Returned structured data may contain an immediate next-page ref; follow it only when deeper results are needed and never route it through the producer tool." },
  "create_ref": { access: "atlas", summary: "Store an evidence chunk (inline text or a server-side slice of an existing ref) and get back a citable #ref stub for handoffs. Batchable via chunks[]; optional note travels with the stub. Synthesis stays prose; evidence moves as refs." },
  "repo.register": { access: "atlas", summary: "Register a repository with ATLAS v2 and initialize ledger/view storage." },
  "repo.status": { access: "atlas", summary: "Get ATLAS repository status, health, and latest version identifiers." },
  "repo.overview": { access: "atlas", summary: "Fetch ATLAS repository summaries, indexed coverage, directory summaries, and hotspots." },
  "index.refresh": { access: "atlas", summary: "Refresh the ATLAS v2 index and materialized view for full or incremental updates." },
  "repo.quality": { access: "atlas", summary: "Inspect ATLAS v2 index quality, parser health, edge resolution, and feedback gaps." },
  "buffer.push": { access: "atlas", summary: "Push an unsaved editor buffer overlay into ATLAS v2 retrieval." },
  "buffer.checkpoint": { access: "atlas", summary: "Clear or persist an ATLAS v2 editor buffer overlay." },
  "buffer.status": { access: "atlas", summary: "Inspect active ATLAS v2 editor buffer overlays." },
  "symbol.search": { access: "atlas", summary: "Search indexed symbols through ATLAS for targeted semantic discovery." },
  "symbol.card": { access: "atlas", summary: "Fetch compact symbol cards without loading whole files: one card by symbolId/symbolRef, or a batch with per-item errors via symbolIds/symbolRefs." },
  "symbol.overview": { access: "atlas", summary: "List compact call/reference sites for a symbol without full caller cards." },
  "tree.overview": { access: "atlas", summary: "Top-level code-tree orientation: root containment page plus the compressed-tree labeled area map." },
  "tree.branch": { access: "atlas", summary: "Walk a code-tree branch: page a focused path/node/symbol subtree with aggregate counts and area labels. Structure only — for exact file/import/fan-in inventory, follow with code.structure; for content intake, follow with code.survey." },
  "tree.scope": { access: "atlas", summary: "Returns the ten highest-ranked candidate files inline. When more exist, nextCandidateFiles is an opaque fetch_ref value for the next ranked page; fetch pages sequentially only when needed." },
  "tree.expand": { access: "atlas", summary: "Grow scope from validated seed files/areas: surrounding branches, siblings, tests, entrypoints, risk metrics." },
  "slice.build": { access: "atlas", summary: "Build a task-scoped ATLAS slice for bounded dependency context." },
  "slice.refresh": { access: "atlas", summary: "Refresh an ATLAS slice incrementally instead of rebuilding from scratch." },
  "edit.plan": { access: "atlas", summary: "Preview symbol/file-scoped edit candidates with preconditions before using write tools." },
  "code.skeleton": { access: "atlas", summary: "Structural outline for one uncovered file or symbol. Do not call for a file already covered by a successful code.survey unless required structure was omitted." },
  "code.lens": { access: "atlas", summary: "Identifier-focused excerpts for one named unresolved usage or branch. Do not use as a generic follow-up to code.survey or code.skeleton." },
  "code.window": { access: "atlas", summary: "Raw code for an exact unresolved guard, ordering rule, or surrounding-text requirement. Identify what prior evidence could not establish." },
  "code.survey": { access: "atlas", summary: "Best first content call for a multi-file area. Returns per-file skeleton evidence plus a call map and satisfies card-and-skeleton evidence for every covered file; use per-file tools only for named gaps." },
  "code.structure": { access: "atlas", summary: "Exact indexed inventory for files, symbols, imports, and fan-in/fan-out. Use instead of content tools when bodies are not needed." },
  "code.db": { access: "atlas", summary: "Internal WI/setup DB query inventory. Not routed through agent gateways." },
  "context": { access: "atlas", summary: "Request generated ATLAS context (taskType + contextMode) for precise/broad retrieval." },
  "context.summary": { access: "atlas", summary: "Request compact ATLAS context with an answer, evidence list, and next action guidance." },
  "agent.feedback": { access: "atlas", summary: "Record useful/missing symbols to improve future ATLAS context quality." },
  "agent.feedback.query": { access: "atlas", summary: "Query useful/missing symbol feedback aggregates for retrieval tuning." },
  "review.delta": { access: "atlas", summary: "Fetch ATLAS semantic diff and blast-radius context between versions." },
  "review.analyze": { access: "atlas", summary: "Run ATLAS PR risk analysis with blast-radius evidence." },
  "review.risk": { access: "atlas", summary: "Fetch ATLAS semantic diff and risk analysis in one assessor call." },
  "slice.spillover.get": { access: "atlas", summary: "Fetch deferred-edge spillover for an existing slice without rebuilding." },
  "file.read": { access: "atlas", summary: "Bounded file read via ATLAS: offset/limit, search+context, or jsonPath. Honors ETag (ifNoneMatch)." },
  "memory.store": { access: "atlas", summary: "Store one rare, verified durable memory linked to exact symbols/files. Title <=120 chars; content <=1200 chars." },
  "memory.surface": { access: "atlas", summary: "Probe exact symbols/files and return only which anchors have attached memory; no bodies or fuzzy search." },
  "memory.get": { access: "atlas", summary: "Fetch memories attached to exact symbols or files, normally after memory.surface/prefetch shows those anchors have memory." },
  "memory.feedback": { access: "atlas", summary: "Issue a simple enum verdict for an existing memory you actually used or checked: used, stale, wrong, or duplicate." },
  "policy.get": { access: "atlas", summary: "Fetch native ATLAS v2 policy for the current repository." },
  "policy.set": { access: "atlas", summary: "Patch native ATLAS v2 policy settings." },
  "usage.stats": { access: "atlas", summary: "Report native ATLAS v2 action usage and estimated token savings." },
  "runtime.execute": { access: "atlas", summary: "Execute policy-gated runtime commands inside the repository with output artifacts." },
  "runtime.queryOutput": { access: "atlas", summary: "Query persisted runtime output artifacts by keyword." },
  "scip.ingest": { access: "atlas", summary: "Ingest a prebuilt SCIP index into the native ATLAS v2 ledger." },
  "file.write": { access: "atlas", summary: "Intentionally not exposed in native ATLAS v2. Use scoped write_file/edit_file; those tools push ATLAS live buffers and trigger normal refresh paths." },
});

const REMOTE_ATLAS_INTERNAL_TOOLS = Object.freeze([
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
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "bash", "project_db_query"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "move_file", "copy_file", "make_dir", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "extract_image_text", "run_scoped_checks", "create_test_suite", "create_test", "run_test", "run_test_suite", "bash", "project_db_query"],
    }),
    artificer: Object.freeze({
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "move_file", "copy_file", "make_dir", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "clean_image", "extract_image_text", "bash", "project_db_query"],
      imageGeneration: ["generate_image"],
    }),
    // Assessor carries project_db_query on the READ lane so it can verify the
    // claimed end state of db-mode dev work with SELECT/inspection; the
    // execution capability cap keeps it read-only regardless of the operator
    // grant, and the contract gate drops the tool when no read grant exists.
    assessor: Object.freeze({
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "read_image_metadata", "validate_artifact_output", "extract_image_text", "run_scoped_checks", "run_test", "run_test_suite", "bash", "project_db_query"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "read_image_metadata", "validate_artifact_output", "extract_image_text", "run_scoped_checks", "run_test", "run_test_suite", "bash", "project_db_query"],
    }),
    // researcher/planner carry project_db_query as a READ-lane tool: the
    // execution capability cap limits them to SELECT/inspection regardless of
    // the operator grant, and the contract gate drops the tool entirely when
    // the repo grants no read permission.
    researcher: Object.freeze({
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
    }),
    planner: Object.freeze({
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "get_brief", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "get_brief", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "project_db_query"],
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
    read: Object.freeze(["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"]),
    write: Object.freeze(["write_file", "edit_file", "move_file", "copy_file", "make_dir", "prune_artifact_output"]),
    // Read-only image inspection (dev/artificer/assessor). clean_image is a
    // mutation and is gated to artificer separately — keep it out of this set.
    imageHelpers: Object.freeze(["read_image_metadata", "validate_artifact_output"]),
    imageMutation: Object.freeze(["clean_image"]),
    imageGeneration: Object.freeze(["generate_image"]),
    ocr: Object.freeze(["extract_image_text"]),
    shellRoles: Object.freeze(["dev", "artificer", "assessor"]),
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
      internalTools: Object.freeze(["fetch_ref"]),
      rationale: "Artificer produces non-code deliverables; ATLAS retrieval is not in scope, but remote policy may issue citation ref fetches.",
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

export const WEB_TOOL_ROLES = new Set(["researcher", "assessor"]);
export const GATED_ROLES = new Set(["researcher", "planner", "dev", "assessor"]);

export const MEANINGFUL_ATLAS_ACTIONS = new Set([
  "tree.branch",
  "tree.expand",
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
//   - agent/coordination tools (agent_feedback, get_operator_feedback,
//     ack_operator_feedback) — the live operator channel must stay reachable
//     regardless of ATLAS readiness, so an agent can always report status even
//     while ATLAS is warming or unavailable.
// Only the read/discovery tools below are gated.
export const GATED_NATIVE_TOOLS = new Set([
  "chain_read",
  "chain_verdict",
  "list_files",
  "search_files",
  "git_history",
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

const NATIVE_SCHEMAS = Object.freeze({
  read_file: TOOL_READ_FILE,
  write_file: TOOL_WRITE_FILE,
  edit_file: TOOL_EDIT_FILE,
  request_scope: TOOL_REQUEST_SCOPE,
  list_files: TOOL_LIST_FILES,
  search_files: TOOL_SEARCH_FILES,
  git_history: TOOL_GIT_HISTORY,
  inspect_file: TOOL_INSPECT_FILE,
  hash_file: TOOL_HASH_FILE,
  agent_feedback: TOOL_AGENT_FEEDBACK,
  get_operator_feedback: TOOL_GET_OPERATOR_FEEDBACK,
  ack_operator_feedback: TOOL_ACK_OPERATOR_FEEDBACK,
  resize_image: TOOL_RESIZE_IMAGE,
  read_image_metadata: TOOL_READ_IMAGE_METADATA,
  validate_artifact_output: TOOL_VALIDATE_ARTIFACT_OUTPUT,
  prune_artifact_output: TOOL_PRUNE_ARTIFACT_OUTPUT,
  optimize_image: TOOL_OPTIMIZE_IMAGE,
  reencode_image: TOOL_REENCODE_IMAGE,
  clean_image: TOOL_CLEAN_IMAGE,
  extract_image_text: TOOL_EXTRACT_IMAGE_TEXT,
  run_scoped_checks: TOOL_RUN_SCOPED_CHECKS,
  create_test_suite: TOOL_CREATE_TEST_SUITE,
  create_test: TOOL_CREATE_TEST,
  run_test: TOOL_RUN_TEST,
  run_test_suite: TOOL_RUN_TEST_SUITE,
  bash: TOOL_BASH,
  move_file: TOOL_MOVE_FILE,
  copy_file: TOOL_COPY_FILE,
  make_dir: TOOL_MAKE_DIR,
  chain_read: TOOL_CHAIN_READ,
  chain_verdict: TOOL_CHAIN_VERDICT,
  pull_brief: TOOL_PULL_BRIEF,
  get_brief: TOOL_GET_BRIEF,
  generate_image: TOOL_GENERATE_IMAGE,
  project_db_query: TOOL_PROJECT_DB_QUERY,
});

function roleAllowlistForTool(toolName) {
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
  });
}

export const TOOL_CATALOG = Object.freeze({
  ...Object.fromEntries(Object.entries(NATIVE_SCHEMAS).map(([name, schema]) => {
    const spec = TOOL_EXECUTION_SPECS[name];
    if (!spec) throw new Error(`Missing TOOL_EXECUTION_SPECS entry for native tool ${name}`);
    if (!spec.observation) throw new Error(`Missing observation spec for native tool ${name}`);
    return [name, Object.freeze({
      name,
      schema,
      access: spec.access,
      summary: spec.summary,
      observation: Object.freeze({ ...spec.observation }),
      roleAllowlist: roleAllowlistForTool(name),
      gateTier: GATED_NATIVE_TOOLS.has(name) ? "native-atlas-gated" : "native",
      capabilityFlags: capabilityFlagsFor(spec.access),
      budgetExempt: !!spec.budgetExempt,
    })];
  })),
  ...Object.fromEntries(Object.entries(SURFACED_ATLAS_TOOL_DEFS).map(([name, schema]) => {
    const spec = TOOL_EXECUTION_SPECS[name];
    if (!spec) throw new Error(`Missing TOOL_EXECUTION_SPECS entry for ATLAS tool ${name}`);
    return [name, Object.freeze({
      name,
      schema,
      access: spec.access,
      summary: spec.summary,
      observation: null,
      roleAllowlist: atlasRoleAllowlistForTool(name),
      gateTier: "atlas",
      capabilityFlags: capabilityFlagsFor("atlas"),
    })];
  })),
});

export function getToolCatalogEntry(name) {
  return TOOL_CATALOG[name] || null;
}

export function getToolSchema(name) {
  return TOOL_CATALOG[name]?.schema || null;
}

export function getToolExecutionSpec(name) {
  return TOOL_EXECUTION_SPECS[name] || null;
}

export function getBaseToolNamesForRole(role, allowWrite, { needsImageGeneration = false } = {}) {
  const config = ROLE_TOOL_ALLOWLISTS[role] || ROLE_TOOL_ALLOWLISTS.default;
  const key = allowWrite ? "write" : "read";
  const names = [...(config[key] || [])];
  if (role === "artificer" && allowWrite && needsImageGeneration) {
    names.push(...(config.imageGeneration || []));
  }
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
} = {}) {
  if (!roleUsesDeterministicReadMcp(role)) return [];
  if (role === "preflight" || role === "delegator") return [];
  const tools = [...DETERMINISTIC_READ_TOOLS];
  if (roleUsesDeterministicWriteMcp(role)) tools.push(...DETERMINISTIC_WRITE_TOOLS);
  if (roleUsesDeterministicImageHelpers(role)) tools.push(...DETERMINISTIC_IMAGE_HELPER_TOOLS);
  // clean_image mutates an image within scope; keep it artificer-only.
  if (roleUsesDeterministicImageMcp(role)) tools.push(...DETERMINISTIC_IMAGE_MUTATION_TOOLS);
  if (roleUsesDeterministicImageMcp(role) && needsImageGeneration) tools.push(...DETERMINISTIC_IMAGE_TOOLS);
  if (role === "dev" || role === "artificer" || role === "assessor") tools.push(...DETERMINISTIC_OCR_TOOLS);
  // Dev authors and runs tests; the assessor may run tests to verify but must
  // not author them (test creation is a dev-only mutation).
  if (role === "dev") tools.push(
    "run_scoped_checks",
    "create_test_suite",
    "create_test",
    "run_test",
    "run_test_suite",
  );
  if (role === "assessor") tools.push("run_scoped_checks", "run_test", "run_test_suite");
  if (role === "dev" || role === "artificer" || role === "assessor") tools.push("bash");
  if (role === "planner") tools.push("get_brief");
  // Opt-in project DB access: write-lane roles (dev/artificer) use the full
  // operator grant, read-lane roles (researcher/planner) are capped to SELECT
  // at execution. The MCP gateway's runtimeToolAvailable() hides the tool
  // unless this repo's admin config enables it with a usable grant.
  if (["dev", "artificer", "assessor", "researcher", "planner"].includes(role)) tools.push("project_db_query");
  if (role === "researcher") {
    const readIdx = tools.indexOf("read_file");
    if (readIdx !== -1) tools.splice(readIdx, 1);
    tools.push("chain_read", "chain_verdict");
  }
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
      inputSchema: def.parameters,
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
    // the agent's behalf. Prefetch-only actions (tree.scope) stay in THIS
    // list; only mutating and fallback-only actions are stripped.
    internalTools: [...internalTools].filter((tool) => !isBlockedFoldedAtlasTool(tool) && !isFallbackOnlyAtlasTool(tool)),
    rationale: route.rationale,
  };
}

function atlasProviderForContract(opts = {}) {
  return String(opts?.atlasAttachment?.provider || opts?.providerName || "").trim().toLowerCase();
}

function atlasTransportForContract(opts = {}) {
  return String(opts?.atlasAttachment?.transport || "").trim().toLowerCase();
}

function hasRuntimeAtlasNaming(opts = {}) {
  return !!(atlasProviderForContract(opts) || atlasTransportForContract(opts));
}

function atlasGateEnabledForContract(opts = {}) {
  if (opts?.atlasGateEnabled != null) return !!opts.atlasGateEnabled;
  if (opts?.atlasAttachment?.gateEnabled != null) return !!opts.atlasAttachment.gateEnabled;
  return resolveAtlasToolGateEnabled();
}

function renderIndexableExtensionList() {
  return [...ATLAS_INDEXABLE_SOURCE_EXTENSIONS].sort().join(", ");
}

function snakeAtlasToolName(tool) {
  return `atlas_${String(tool || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function renderAtlasToolNameForContract(tool, opts = {}) {
  const raw = String(tool || "").trim();
  if (!raw) return raw;
  const surfaceToolNames = opts?.atlasAttachment?.surfaceToolNames;
  if (surfaceToolNames && typeof surfaceToolNames === "object") {
    const mapped = surfaceToolNames[raw] || surfaceToolNames[stripAtlasPrefix(raw)];
    if (mapped) return mapped;
  }
  if (raw.startsWith("atlas.") || raw.startsWith("atlas_")) return raw;
  if (!hasRuntimeAtlasNaming(opts)) return `atlas.${raw}`;

  const provider = atlasProviderForContract(opts);
  const transport = atlasTransportForContract(opts);
  if (transport === "embedded" || ["openai", "grok"].includes(provider)) {
    return ATLAS_TOOL_DEFS[raw]?.name || snakeAtlasToolName(raw);
  }
  return `atlas.${raw}`;
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

function renderProviderNamingLine(opts = {}) {
  if (!hasRuntimeAtlasNaming(opts)) return null;
  const label = atlasBackendLabel(opts?.atlasAttachment);
  const provider = atlasProviderForContract(opts);
  const mode = _toolAttachmentModeFor(provider);
  const providerLabel = _providerLabelFor(provider);
  const transport = String(opts?.atlasAttachment?.transport || "").trim().toLowerCase();
  if (mode === "function") {
    return `${providerLabel} exposes ${label} as function tools; call the exact function names listed in this contract.`;
  }
  if (transport === POSSE_MCP_GATEWAY_TRANSPORT || transport === "posse-gateway" || transport === "deterministic-mcp") {
    return `${providerLabel} exposes ${label} through the Posse MCP gateway as a separate atlas.* tool suite; call the exact tool names listed in this contract.`;
  }
  if (mode === "deterministic-bridge") {
    return `${providerLabel} exposes ${label} through the Posse MCP gateway; call the exact tool names listed in this contract.`;
  }
  if (mode === "mcp") {
    return `${providerLabel} exposes ${label} through MCP; call the exact MCP tool names listed in this contract.`;
  }
  return `Call the exact ${label} tool names listed in this contract for this provider.`;
}

function renderActiveAtlasFallbackLines(opts = {}) {
  // The ATLAS contract is only rendered when ATLAS is attached and advertised
  // for the active tool surface. The contract's presence already asserts
  // ATLAS-is-primary, so we don't restate it here.
  // The "Use standard tools only when:" list below implicitly establishes
  // ATLAS as the default by enumerating the conditions for falling back.
  const label = atlasBackendLabel(opts?.atlasAttachment);
  if (atlasGateEnabledForContract(opts)) {
    const extensions = renderIndexableExtensionList();
    return [
      `${label} is the inspection path; native reads are the exception for a named evidence gap, never the reward for making enough ${label} calls.`,
      `For indexable source files (${extensions}), discovery is file-scoped: before reading a given source file natively, attempt task-relevant ${label} discovery against that same file or a symbol, tree, or code result that returns that file — often that answers the question and no native read is needed.`,
      `For a named residual file gap, use ${renderAtlasToolNameForContract("code.skeleton", opts)} only for an uncovered structural outline, ${renderAtlasToolNameForContract("code.lens", opts)} for one unresolved identifier or branch, and ${renderAtlasToolNameForContract("code.window", opts)} only for exact raw guards, ordering, or surrounding text.`,
      `Each indexable source file needs its own focused ${label} attempt before a native read of it.`,
      `Never make ${label} calls merely to make native tools available; aim every retrieval at your actual evidence gap and stop when the evidence is sufficient.`,
      `For broad audits, sweeps, enumerations, or unfamiliar areas: pick the area with ${renderAtlasToolNameForContract("tree.branch", opts)} or ${renderAtlasToolNameForContract("tree.expand", opts)} (structure only — no code content). If the deliverable is exact file/import/fan-in inventory, use ONE ${renderAtlasToolNameForContract("code.structure", opts)} call; if content understanding is needed, use ONE ${renderAtlasToolNameForContract("code.survey", opts)} call over that directory or file list. These area calls can surface pathAmbiguity or negativeEvidence when duplicate/stub decoys are detected.`,
      `${label} prefetch and internal bookkeeping calls do not count as active retrieval.`,
      "Use standard tools only for a named evidence gap:",
      `- ${label} is unavailable,`,
      `- ${label} returned stale, empty, or conflicting evidence after a focused attempt,`,
      "- the target is non-indexed config/data/docs where the raw text is the object,",
      "- you have mutated files and need exact current worktree state,",
      `- you need exact surrounding text ${label} code tools could not provide,`,
      `- you need git state/history/diff operations not exposed through ${label},`,
      "- you need to run tests, build commands, or other shell commands.",
      `If you use a standard tool, state the precise gap and the ${label} result that was insufficient.`,
    ];
  }
  const extensions = renderIndexableExtensionList();
  return [
    `For indexable source files (${extensions}), attempt task-relevant ${label} discovery against the file before native read_file/chain_read fallback whenever possible.`,
    `For broad audits, sweeps, enumerations, or unfamiliar areas: pick the area with ${renderAtlasToolNameForContract("tree.branch", opts)} or ${renderAtlasToolNameForContract("tree.expand", opts)} (structure only), then make ONE ${renderAtlasToolNameForContract("code.structure", opts)} call for exact inventory or ONE ${renderAtlasToolNameForContract("code.survey", opts)} call for content intake before any per-file loop.`,
    "Use standard tools only when:",
    `- ${label} is unavailable,`,
    `- ${label} fails to answer the question after a relevant attempt,`,
    "- you have mutated files and need exact current worktree state,",
    `- you need git state/history/diff operations not exposed through ${label},`,
    "- you need to run tests, build commands, or other shell commands.",
    `If you fall back to standard tools, state what ${label} could not provide.`,
  ];
}

function renderPrefetchGuidance(opts = {}) {
  const status = String(opts?.atlasPrefetchStatus || opts?.atlasAttachment?.prefetchStatus || "").trim().toLowerCase();
  const label = atlasBackendLabel(opts?.atlasAttachment);
  if (status === "ok" || status === "ok_relevant" || status === "prefetch_ok_relevant") {
    return [
      `${label} prefetch supplied task-relevant context for this handoff.`,
      atlasGateEnabledForContract(opts)
        ? `Use prefetch as a comprehension scaffold for the first codebase map; it does not count as active ${label} retrieval. Make additional ${label} calls only for real evidence gaps, never to make native tools available.`
        : `Use prefetch as a comprehension scaffold for the first codebase map; make additional task-relevant ${label} retrieval only when a specific context gap remains.`,
      ...renderActiveAtlasFallbackLines(opts),
    ];
  }
  if (status === "ok_unhelpful" || status === "prefetch_ok_unhelpful") {
    return [
      `${label} prefetch completed but did not match the requested scope.`,
      ...renderActiveAtlasFallbackLines(opts),
    ];
  }
  if (status && status !== "skipped") {
    return [
      `${label} prefetch status is ${status}. Follow the ${label} CONTEXT fallback notice if one is present.`,
      `If ${label} tools are still advertised, prefer ${label} retrieval before broad native reads.`,
    ];
  }
  return [
    ...renderActiveAtlasFallbackLines(opts),
  ];
}

function pushAvailableToolLine(lines, tools, tool, label, opts = {}) {
  if (!tools.includes(tool)) return;
  lines.push(`- ${renderAtlasToolNameForContract(tool, opts)}: ${label}`);
}

function renderRouteUsageLines(role, tools, opts = {}) {
  const label = atlasBackendLabel(opts?.atlasAttachment);
  const lines = [
    `How to use this ${label} route:`,
  ];

  const providerLine = renderProviderNamingLine(opts);
  if (providerLine) lines.push(providerLine);
  lines.push(...renderPrefetchGuidance(opts));
  lines.push(`${label} should build code-content understanding, not just file discovery: use results to explain what the code does, how data flows, and which exact files need verification; before another retrieval call, name the unresolved material claim and choose the cheapest tool that can answer it.`);
  if (tools.some((tool) => ["query", "code", "repo", "agent", "workflow"].includes(tool))) {
    lines.push(`${label} gateway/workflow tools may take nested action names; nested actions must also appear in this role route. Do not use a wrapper to bypass routing.`);
  }
  lines.push(`${label} symbolId values are opaque. Never invent them from file paths, names, or file:symbol pairs; use IDs returned by ATLAS results, or symbolRef/file inputs where the tool explicitly supports them.`);
  lines.push(`Search ${label} for repo-defined symbols, not language/runtime/library functions such as date, gmdate, password_verify, json_decode, Math.floor, or console.log. If you need repo code that uses those runtime identifiers, treat them as identifier filters: use code.lens on known files, symbol.search with scope=\"body\", or deterministic content search after the ${label} policy allows it.`);

  const discovery = [];
  pushAvailableToolLine(discovery, tools, "symbol.search", "best first call when you know a repo-defined concept or symbol name but not the exact symbol ID.", opts);
  pushAvailableToolLine(discovery, tools, "tree.branch", "best first call when you know a path, symbol, or branch and need the structure around it (paths, counts, areas — no code content).", opts);
  pushAvailableToolLine(discovery, tools, "tree.expand", "best first call when you have seed files, symbols, or areas and need nearby structure, siblings, tests, or entrypoints.", opts);
  pushAvailableToolLine(discovery, tools, "code.structure", "exact indexed inventory for files, symbols, imports, and fan-in/fan-out; use instead of content tools when bodies are not needed.", opts);
  pushAvailableToolLine(discovery, tools, "code.survey", "best first content call for a multi-file area: one call returns per-file skeleton evidence plus a call map and satisfies card-and-skeleton evidence for every covered file.", opts);
  if (discovery.length) {
    lines.push("", "Discovery starters:");
    lines.push(...discovery);
  }

  // These tools are alternatives selected by the remaining evidence gap.
  // Define the shared anti-repetition policy once, then list only the
  // selection rules for tools actually issued to this role.
  const LADDER_TOOLS = ["symbol.card", "code.skeleton", "code.lens", "code.window"];
  const hasLadder = LADDER_TOOLS.some((tool) => tools.includes(tool));
  if (hasLadder) {
    const surveyName = renderAtlasToolNameForContract("code.survey", opts);
    const cardName = renderAtlasToolNameForContract("symbol.card", opts);
    const skeletonName = renderAtlasToolNameForContract("code.skeleton", opts);
    const lensName = renderAtlasToolNameForContract("code.lens", opts);
    lines.push(
      "",
      `Iris evidence tools are alternatives selected by the remaining evidence gap, not mandatory sequential steps. ${surveyName} already satisfies card-and-skeleton evidence for every file it covers. Do not call ${cardName}, ${skeletonName}, or ${lensName} merely to repeat survey output. Before another retrieval call, name the unresolved material claim and choose the cheapest tool that can answer it. If no specific claim remains, stop retrieving and synthesize.`,
    );
    lines.push("Evidence-gap selection rules:");
    if (tools.includes("code.skeleton")) {
      lines.push(`- Use ${skeletonName} only for an uncovered single file that needs a structural outline.`);
    }
    if (tools.includes("code.lens")) {
      lines.push(`- Use ${lensName} only when a named identifier, usage, or branch remains unresolved and a focused excerpt can answer it.`);
    }
    if (tools.includes("code.window")) {
      lines.push(`- Use ${renderAtlasToolNameForContract("code.window", opts)} only when exact guards, ordering, surrounding text, or raw implementation details are required; the request reason must identify what prior evidence could not establish.`);
    }
    lines.push("- Do not call a narrower tool merely to confirm facts already present in a successful area call.");
    lines.push("- Stop when every material claim has sufficient evidence. Do not retrieve only to increase ATLAS call count or unlock native tools.");
    if (role === "planner" && !tools.includes("code.window")) {
      lines.push("Planner routes do not include code.window. If exact raw details are still required, name the unresolved claim and the exact missing symbols or files for downstream verification.");
    }
  }

  if (tools.includes("review.risk")) {
    const riskName = renderAtlasToolNameForContract("review.risk", opts);
    lines.push(
      "",
      "Assessor review path:",
      `- Use ${riskName} when version IDs are available for semantic delta, blast radius, risks, and tests.`,
      "- Use cards, skeletons, hot paths, or raw windows only to verify specific findings from the risk output.",
    );
  }

  return lines;
}

export function renderAtlasRoleContract(role, opts = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const route = getAtlasRouteDefinitionForRole(normalizedRole);
  const routeTools = atlasContractToolsForRoute(route, opts);
  const title = normalizedRole ? normalizedRole.toUpperCase() : "ROLE";
  const gateEnabled = atlasGateEnabledForContract(opts);
  const label = atlasBackendLabel(opts?.atlasAttachment);
  const lines = [
    "===========================================================",
    `${label} TOOLS CONTRACT - ${title}`,
    "===========================================================",
    "",
  ];

  if (!routeTools.length) {
    lines.push(
      `No ${label} tools are routed to this role. Use the deterministic tools granted by the execution contract.`,
      "",
      formatAtlasBackendText(route.rationale, label),
    );
    return lines.join("\n");
  }

  lines.push(
    "This contract is generated from TOOL_ROLE_LIBRARY.atlasRoutes in the shared tool catalog.",
    hasRuntimeAtlasNaming(opts)
      ? "Tool names in this runtime contract are rendered for the active provider/transport; call them exactly as listed."
      : "Checked-in generated contracts use canonical MCP tool names; embedded function-tool providers render exact function names at runtime.",
    "",
    `Route phase: ${route.phase || "none"}`,
    `Route rationale: ${formatAtlasBackendText(route.rationale, label)}`,
    "",
    `Generated ${label} route:`,
  );
  for (const tool of routeTools) {
    const summary = ATLAS_TOOL_DEFS[tool]?.description || TOOL_EXECUTION_SPECS[tool]?.summary || "ATLAS tool.";
    lines.push(`- ${renderAtlasToolNameForContract(tool, opts)}: ${formatAtlasBackendText(summary, label)}`);
  }

  // The contract's presence already asserts "ATLAS is the primary path"
  // (it's only loaded when the role's ATLAS attachment is active). The
  // evidence-gap selection rules are emitted by renderRouteUsageLines. The
  // closing block only needs fallback policy and the anti-fabrication rule.
  // L5b (TOKEN-LEVERS): the handoff atlas-context prose already delivers the
  // full retrieval/fallback policy at runtime; when atlas_prose_dedup is on we
  // emit a compact single-statement variant here instead of the full block.
  // Gated on runtime naming so checked-in generated contracts are unaffected.
  const proseDedup = hasRuntimeAtlasNaming(opts) && resolveAtlasProseDedup();
  lines.push(
    "",
    ...renderRouteUsageLines(normalizedRole, routeTools, opts),
    "",
  );
  if (proseDedup) {
    lines.push(
      `Use deterministic file/search/read/git/test/build/shell tools only for a named evidence gap or for operations ${label} does not expose; do not invent missing repo content.`,
    );
  } else {
    lines.push(
      gateEnabled
        ? `Use deterministic file/search/read tools only for a named evidence gap after targeted ${label} retrieval, when ${label} is unavailable or insufficient, or when you have mutated files and need exact current worktree state.`
        : `Use deterministic file/search/read tools for a named evidence gap when ${label} is unavailable or insufficient, or when you have mutated files and need exact current worktree state.`,
      `Use deterministic git/test/build/shell tools when those operations are not exposed through ${label}.`,
      "Do not invent missing repo content.",
    );
  }

  return `${lines.join("\n")}\n`;
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
// (full task text) than the agent could reconstruct — kept in role routes so
// the prefetch can use them, but never advertised to the agent. Agents get
// tree.expand (seed expansion) instead.
const ATLAS_PREFETCH_ONLY_ACTIONS = new Set([
  "repo.overview",
  "repo.status",
  "tree.overview",
  "tree.scope",
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

export function buildNativeToolDescriptor(schema) {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.parameters || { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      title: schema.name,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

export function buildFoldedAtlasToolDescriptor(schema = {}) {
  const annotations = schema.annotations && typeof schema.annotations === "object"
    ? schema.annotations
    : {};
  const name = String(schema.name || "");
  const mutating = isBlockedFoldedAtlasTool(name);
  const canonicalDescription = ATLAS_TOOL_DEFS[stripAtlasPrefix(name)]?.description;
  return {
    ...schema,
    description: canonicalDescription || schema.description,
    annotations: {
      ...annotations,
      title: annotations.title || name,
      readOnlyHint: !mutating,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}
