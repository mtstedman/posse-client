import { TOOL_INSPECT_FILE } from "../../../worker/functions/helpers/file-inspector.js";
import { TOOL_GIT_HISTORY } from "../../../git/functions/history.js";
import { resolveAtlasToolGateEnabled } from "./gate-settings.js";
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

export const HIDDEN_ATLAS_SURFACE_ACTIONS = Object.freeze(new Set([
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
  "repo": { access: "atlas", summary: "Compact gateway for native ATLAS v2 repository, policy, usage, and diagnostics actions." },
  "agent": { access: "atlas", summary: "Compact gateway for native ATLAS v2 context, feedback, buffer, and memory actions." },
  "action.search": { access: "atlas", summary: "Search the native ATLAS v2 action catalog for the right tool/action." },
  "manual": { access: "atlas", summary: "Return compact native ATLAS v2 API reference entries." },
  "workflow": { access: "atlas", summary: "Execute multi-step native ATLAS workflows with data transforms and references." },
  "info": { access: "atlas", summary: "Report native ATLAS v2 runtime, storage, view freshness, ledger, and policy diagnostics." },
  "repo.register": { access: "atlas", summary: "Register a repository with ATLAS v2 and initialize ledger/view storage." },
  "repo.status": { access: "atlas", summary: "Get ATLAS repository status, health, and latest version identifiers." },
  "repo.overview": { access: "atlas", summary: "Fetch ATLAS repository summaries, indexed coverage, directory summaries, and hotspots." },
  "index.refresh": { access: "atlas", summary: "Refresh the ATLAS v2 index and materialized view for full or incremental updates." },
  "repo.quality": { access: "atlas", summary: "Inspect ATLAS v2 index quality, parser health, edge resolution, and feedback gaps." },
  "buffer.push": { access: "atlas", summary: "Push an unsaved editor buffer overlay into ATLAS v2 retrieval." },
  "buffer.checkpoint": { access: "atlas", summary: "Clear or persist an ATLAS v2 editor buffer overlay." },
  "buffer.status": { access: "atlas", summary: "Inspect active ATLAS v2 editor buffer overlays." },
  "symbol.search": { access: "atlas", summary: "Search indexed symbols through ATLAS for targeted semantic discovery." },
  "symbol.card": { access: "atlas", summary: "Fetch one symbol card by symbolId or symbolRef without loading whole files." },
  "symbol.cards": { access: "atlas", summary: "Fetch multiple symbol cards by symbolIds or symbolRefs with per-item errors." },
  "symbol.overview": { access: "atlas", summary: "List compact call/reference sites for a symbol without full caller cards." },
  "tree.overview": { access: "atlas", summary: "Top-level code-tree orientation: root containment page plus the compressed-tree labeled area map." },
  "tree.branch": { access: "atlas", summary: "Walk a code-tree branch: page a focused path/node/symbol subtree with aggregate counts and area labels." },
  "tree.scope": { access: "atlas", summary: "Prefetch-only task scoping; agents use tree.expand for seed expansion instead." },
  "tree.expand": { access: "atlas", summary: "Grow scope from validated seed files/areas: surrounding branches, siblings, tests, entrypoints, risk metrics." },
  "slice.build": { access: "atlas", summary: "Build a task-scoped ATLAS slice for bounded dependency context." },
  "slice.refresh": { access: "atlas", summary: "Refresh an ATLAS slice incrementally instead of rebuilding from scratch." },
  "edit.plan": { access: "atlas", summary: "Preview symbol/file-scoped edit candidates with preconditions before using write tools." },
  "code.skeleton": { access: "atlas", summary: "Inspect signatures/control flow skeleton before escalating to raw code." },
  "code.lens": { access: "atlas", summary: "Inspect identifier-focused code excerpts with tight context windows." },
  "code.window": { access: "atlas", summary: "Request policy-gated raw code windows only when prior rungs are insufficient." },
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
  "repo.overview",
  "tree.overview",
  "tree.scope",
  "tree.branch",
  "tree.expand",
  "symbol.search",
  "symbol.card",
  "symbol.cards",
  "symbol.overview",
  "slice.build",
  "slice.refresh",
  "context",
  "context.summary",
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
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "clean_image", "extract_image_text", "run_scoped_checks", "create_test_suite", "create_test", "run_test", "run_test_suite", "bash", "project_db_query"],
    }),
    artificer: Object.freeze({
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "inspect_file", "write_file", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "clean_image", "extract_image_text", "bash"],
      imageGeneration: ["generate_image"],
    }),
    assessor: Object.freeze({
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "run_scoped_checks", "create_test_suite", "create_test", "run_test", "run_test_suite", "bash"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "run_scoped_checks", "create_test_suite", "create_test", "run_test", "run_test_suite", "bash"],
    }),
    researcher: Object.freeze({
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
    }),
    planner: Object.freeze({
      read: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "get_brief", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
      write: ["agent_feedback", "get_operator_feedback", "ack_operator_feedback", "get_brief", "read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
    }),
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
    imageHelpers: Object.freeze(["read_image_metadata", "validate_artifact_output", "clean_image"]),
    imageGeneration: Object.freeze(["generate_image"]),
    ocr: Object.freeze(["extract_image_text"]),
    shellRoles: Object.freeze(["dev", "artificer", "assessor"]),
    writeRoles: Object.freeze(["dev", "artificer"]),
    imageHelperRoles: Object.freeze(["dev", "artificer"]),
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
      rationale: "Artificer produces non-code deliverables; ATLAS retrieval is not in scope, deterministic write tools handle artifact output.",
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
export const DETERMINISTIC_IMAGE_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageGeneration;
export const DETERMINISTIC_OCR_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.ocr;

export const WEB_TOOL_ROLES = new Set(["researcher", "artificer"]);
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
    || role === "researcher";
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
  const tools = [...DETERMINISTIC_READ_TOOLS];
  if (roleUsesDeterministicWriteMcp(role)) tools.push(...DETERMINISTIC_WRITE_TOOLS);
  if (roleUsesDeterministicImageHelpers(role)) tools.push(...DETERMINISTIC_IMAGE_HELPER_TOOLS);
  if (roleUsesDeterministicImageMcp(role) && needsImageGeneration) tools.push(...DETERMINISTIC_IMAGE_TOOLS);
  if (role === "dev" || role === "artificer") tools.push(...DETERMINISTIC_OCR_TOOLS);
  if (role === "dev" || role === "assessor") tools.push(
    "run_scoped_checks",
    "create_test_suite",
    "create_test",
    "run_test",
    "run_test_suite",
  );
  if (role === "dev" || role === "artificer" || role === "assessor") tools.push("bash");
  if (role === "planner") tools.push("get_brief");
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
      `For indexable source files (${extensions}), native read_file/chain_read fallback unlocks file by file: before reading a given source file, attempt task-relevant ${label} discovery against that same file or a symbol, tree, or code result that returns that file.`,
      `Good file-specific discovery calls include ${renderAtlasToolNameForContract("code.skeleton", opts)}, ${renderAtlasToolNameForContract("code.lens", opts)}, ${renderAtlasToolNameForContract("code.window", opts)}, ${renderAtlasToolNameForContract("symbol.search", opts)}, ${renderAtlasToolNameForContract("tree.branch", opts)}, and ${renderAtlasToolNameForContract("tree.expand", opts)}.`,
      `Other indexable source files stay locked until separately discovered through ${label}.`,
      `For broad standard list/search/read fallback not tied to one source file, make the required real ${label} retrieval attempts only when broad native fallback is still needed; keep them targeted to the task and stop when the needed context or fallback unlock is obtained.`,
      `For broad audits, sweeps, or unfamiliar repositories, start with ${renderAtlasToolNameForContract("tree.branch", opts)} or ${renderAtlasToolNameForContract("tree.expand", opts)}, then narrow with ${renderAtlasToolNameForContract("symbol.search", opts)} and ${renderAtlasToolNameForContract("code.skeleton", opts)}.`,
      `${label} prefetch and internal bookkeeping calls do not count toward file unlocks or broad fallback unlocks.`,
      "Use standard tools only when:",
      `- ${label} is unavailable,`,
      `- ${label} fails to answer the question after the required targeted discovery attempts,`,
      "- you have mutated files and need exact current worktree state,",
      `- you need git state/history/diff operations not exposed through ${label},`,
      "- you need to run tests, build commands, or other shell commands.",
      `If you fall back to standard tools, state what ${label} could not provide.`,
    ];
  }
  const extensions = renderIndexableExtensionList();
  return [
    `For indexable source files (${extensions}), attempt task-relevant ${label} discovery against the file before native read_file/chain_read fallback whenever possible.`,
    `For broad audits, sweeps, or unfamiliar repositories, start with ${renderAtlasToolNameForContract("tree.branch", opts)} or ${renderAtlasToolNameForContract("tree.expand", opts)}, then narrow with ${renderAtlasToolNameForContract("symbol.search", opts)} and ${renderAtlasToolNameForContract("code.skeleton", opts)}.`,
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
        ? `Use prefetch as a comprehension scaffold for the first codebase map; it does not count as active ${label} use or toward the 3-call native fallback gate.`
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
  lines.push(`${label} should build code-content understanding, not just file discovery: use results to explain what the code does, how data flows, and which exact files need verification; if a result only gives names or signatures, move to the next targeted rung or use the fallback policy.`);
  if (tools.some((tool) => ["query", "code", "repo", "agent", "workflow"].includes(tool))) {
    lines.push(`${label} gateway/workflow tools may take nested action names; nested actions must also appear in this role route. Do not use a wrapper to bypass routing.`);
  }
  lines.push(`${label} symbolId values are opaque. Never invent them from file paths, names, or file:symbol pairs; use IDs returned by ATLAS results, or symbolRef/file inputs where the tool explicitly supports them.`);
  lines.push(`Search ${label} for repo-defined symbols, not language/runtime/library functions such as date, gmdate, password_verify, json_decode, Math.floor, or console.log. If you need repo code that uses those runtime identifiers, treat them as identifier filters: use code.lens on known files, symbol.search with scope=\"body\", or deterministic content search after the ${label} policy allows it.`);

  const discovery = [];
  pushAvailableToolLine(discovery, tools, "symbol.search", "best first call when you know a repo-defined concept or symbol name but not the exact symbol ID.", opts);
  pushAvailableToolLine(discovery, tools, "tree.branch", "best first call when you know a path, symbol, or branch and need structure around it.", opts);
  pushAvailableToolLine(discovery, tools, "tree.expand", "best first call when you have seed files, symbols, or areas and need nearby structure, siblings, tests, or entrypoints.", opts);
  if (discovery.length) {
    lines.push("", "Discovery starters:");
    lines.push(...discovery);
  }

  // The route's tool list above already labels each ladder tool with its
  // rung and token cost. Define the ladder once here (the rung tools may
  // not all be in this role's route, but the definition stays canonical)
  // and follow with the role-specific escalation constraint. The Rung 3
  // stop line goes here — directly after the definition — so a planner
  // reading the contract learns the constraint before scanning for Rung 4.
  const LADDER_TOOLS = ["symbol.card", "code.skeleton", "code.lens", "code.window"];
  const hasLadder = LADDER_TOOLS.some((tool) => tools.includes(tool));
  if (hasLadder) {
    lines.push(
      "",
      `Iris rungs are the ${label} evidence ladder, ordered by cost: Rung 1 (~100 token cards) -> Rung 2 (~300 token skeletons) -> Rung 3 (~600 token hot paths) -> Rung 4 (~2000 token raw windows). Escalate only as far as needed — prefer the cheapest rung that answers the question.`,
    );
    if (role === "planner" && !tools.includes("code.window")) {
      lines.push("Planner routes stop at Rung 3 by design. If raw bodies are still required, name the exact missing symbols or files instead of making a raw-window call.");
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
  // cost ordering and escalation rule are already in the Iris rungs
  // definition emitted by renderRouteUsageLines. The closing block only
  // needs the cross-tool fallback policy and the anti-fabrication rule.
  lines.push(
    "",
    ...renderRouteUsageLines(normalizedRole, routeTools, opts),
    "",
    gateEnabled
      ? `Use deterministic file/search/read tools only after the required targeted ${label} discovery or 3-call native fallback gate unlock, when ${label} is unavailable or insufficient, or when you have mutated files and need exact current worktree state.`
      : `Use deterministic file/search/read tools when ${label} is unavailable or insufficient, or when you have mutated files and need exact current worktree state.`,
    `Use deterministic git/test/build/shell tools when those operations are not exposed through ${label}.`,
    "Do not invent missing repo content.",
  );

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
  // mutating and fallback-only actions are stripped from the role route.
  return !isBlockedFoldedAtlasTool(action)
    && !isFallbackOnlyAtlasTool(action)
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
