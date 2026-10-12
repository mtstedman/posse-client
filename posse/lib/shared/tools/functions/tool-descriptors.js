import { stripAtlasPrefixUntrimmed as stripAtlasPrefix } from "./atlas-tool-name.js";
// @ts-check
import { TOOL_ROLE_LIBRARY, ROLE_TOOL_ALLOWLISTS, DETERMINISTIC_READ_TOOLS, DETERMINISTIC_WRITE_TOOLS, DETERMINISTIC_IMAGE_HELPER_TOOLS, DETERMINISTIC_IMAGE_MUTATION_TOOLS, DETERMINISTIC_IMAGE_TOOLS, DETERMINISTIC_OCR_TOOLS, DETERMINISTIC_IMAGE_VIEW_TOOLS, DETERMINISTIC_ASSET_DOWNLOAD_TOOLS, HIDDEN_ATLAS_SURFACE_ACTIONS, CATALOG_SCHEMA_OVERRIDE_KEYS, SYSTEM_PREFETCH_CAPABLE_ATLAS_ACTIONS, ATLAS_MUTATING_ACTIONS, ATLAS_FALLBACK_ONLY_ACTIONS, ATLAS_PREFETCH_ONLY_ACTIONS } from "../../../catalog/tool-surface/roles.js";
export { HIDDEN_ATLAS_SURFACE_ACTIONS, SYSTEM_PREFETCH_CAPABLE_ATLAS_ACTIONS, TOOL_ROLE_LIBRARY, DETERMINISTIC_READ_TOOLS, DETERMINISTIC_WRITE_TOOLS, DETERMINISTIC_IMAGE_HELPER_TOOLS, DETERMINISTIC_IMAGE_MUTATION_TOOLS, DETERMINISTIC_IMAGE_TOOLS, DETERMINISTIC_OCR_TOOLS, DETERMINISTIC_IMAGE_VIEW_TOOLS, DETERMINISTIC_ASSET_DOWNLOAD_TOOLS, WEB_TOOL_ROLES, GATED_ROLES, MEANINGFUL_ATLAS_ACTIONS, GATED_NATIVE_TOOLS, TOOL_OBSERVATION_ALIASES } from "../../../catalog/tool-surface/roles.js";
import { TOOL_INSPECT_FILE } from "../../../catalog/tools/inspect-file.js";
import { ATLAS_REPLACED_NATIVE_TOOLS, atlasReplacesNativeTool } from "../../../catalog/tools/source-navigation.js";
import { TOOL_GIT_HISTORY } from "../../../catalog/tools/git-history.js";
import { atlasBackendLabel } from "../../../domains/integrations/functions/atlas-label.js";
import { atlasDescriptorSchemaForAction } from "../../../domains/atlas/functions/v2/contracts/tool-schemas.js";
import { TOOL_CUSTOM_TOOLS } from "../../../catalog/custom-tools.js";
import { TOOL_ATTACHMENT_BY_PROVIDER } from "../../../catalog/tool-surface/provider-attachments.js";
import { getToolBatchingClass, TOOL_BATCHING_CLASSES } from "../../../catalog/tool-surface/batching.js";
import { projectAgentToolDefinition, projectAgentToolSchema } from "./agent-schema.js";

export { TOOL_ATTACHMENT_BY_PROVIDER };
export { getToolBatchingClass, TOOL_BATCHING_CLASSES };

export { TOOL_INSPECT_FILE } from "../../../catalog/tools/inspect-file.js";
export { TOOL_GIT_HISTORY } from "../../../catalog/tools/git-history.js";


// Tool schema definitions are pure data and live in the catalog layer.
import { TOOL_READ_FILE, TOOL_WRITE_FILE, TOOL_EDIT_FILE, TOOL_REQUEST_SCOPE, TOOL_LIST_FILES, TOOL_SEARCH_FILES, TOOL_HASH_FILE, TOOL_RESIZE_IMAGE, TOOL_READ_IMAGE_METADATA, TOOL_VALIDATE_ARTIFACT_OUTPUT, TOOL_PRUNE_ARTIFACT_OUTPUT, TOOL_OPTIMIZE_IMAGE, TOOL_REENCODE_IMAGE, TOOL_CLEAN_IMAGE, TOOL_EXTRACT_IMAGE_TEXT, TOOL_VIEW_IMAGE, TOOL_BASH, TOOL_AGENT_FEEDBACK, TOOL_GET_OPERATOR_FEEDBACK, TOOL_ACK_OPERATOR_FEEDBACK, TOOL_RUN_SCOPED_CHECKS, TOOL_RUN_UNIT_TEST, TOOL_MOVE_FILE, TOOL_COPY_FILE, TOOL_MAKE_DIR, TOOL_CHAIN_READ, TOOL_CHAIN_VERDICT, TOOL_PULL_BRIEF, TOOL_GET_BRIEF, TOOL_FINAL_REVIEW, TOOL_GENERATE_IMAGE, TOOL_DOWNLOAD_FILE, TOOL_COMPOSE_SPRITE_SHEET, TOOL_PROJECT_DB_QUERY, TOOL_AGENT_HANDOFF, TOOL_AGENT_CLAIM, TOOL_REPORT_CLAIMS, getAgentHandoffToolSchemaForRole, TOOL_SUB_AGENT, TOOL_SUB_AGENT_NEXT_INPUT, TOOL_DISPATCH_AGENT, TOOL_DISPATCH_AGENT_PLANNER, TOOL_FINAL_REVIEW_DEV, TOOL_FINAL_REVIEW_ASSESSOR, TOOL_RUN_SCOPED_CHECKS_ASSESSOR, TOOL_REQUEST_SCOPE_DEV, TOOL_WEB_RESEARCH_HANDOFF } from "../../../catalog/native-tools.js";

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
  TOOL_VIEW_IMAGE,
  TOOL_BASH,
  TOOL_AGENT_FEEDBACK,
  TOOL_GET_OPERATOR_FEEDBACK,
  TOOL_ACK_OPERATOR_FEEDBACK,
  TOOL_RUN_SCOPED_CHECKS,
  TOOL_RUN_UNIT_TEST,
  TOOL_MOVE_FILE,
  TOOL_COPY_FILE,
  TOOL_MAKE_DIR,
  TOOL_CHAIN_READ,
  TOOL_CHAIN_VERDICT,
  TOOL_PULL_BRIEF,
  TOOL_GET_BRIEF,
  TOOL_FINAL_REVIEW,
  TOOL_GENERATE_IMAGE,
  TOOL_DOWNLOAD_FILE,
  TOOL_COMPOSE_SPRITE_SHEET,
  TOOL_PROJECT_DB_QUERY,
  TOOL_AGENT_HANDOFF,
  TOOL_AGENT_HANDOFF_DEV,
  TOOL_AGENT_HANDOFF_ARTIFICER,
  TOOL_AGENT_HANDOFF_ASSESSOR,
  TOOL_AGENT_HANDOFF_CITATION,
  TOOL_AGENT_HANDOFF_PLANNER,
  TOOL_AGENT_HANDOFF_RESEARCHER,
  TOOL_AGENT_HANDOFF_REPORT,
  TOOL_AGENT_CLAIM,
  TOOL_SUB_AGENT_NEXT_INPUT,
  TOOL_SUB_AGENT,
  TOOL_DISPATCH_AGENT,
  TOOL_WEB_RESEARCH_HANDOFF,
} from "../../../catalog/native-tools.js";

import { ATLAS_TOOL_DEFS_RAW, normalizeAtlasCodeWindowPolicy } from "../../../catalog/atlas-tools.js";
import { INTERNAL_ATLAS_SURFACE_ACTION_SET } from "../../../catalog/internal-tools.js";


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
  custom_tools: {
    schema: TOOL_CUSTOM_TOOLS,
    access: "read",
    summary: "Search, describe, invoke, inspect, or cancel an explicitly granted Custom Tools entry.",
    observation: { type: "tool.custom_tools", label: "CustomTools", format: "generic", targetKeys: ["operation", "tool", "run_id"] },
  },
  agent_handoff: {
    schema: TOOL_AGENT_HANDOFF,
    access: "coordination",
    summary: "Submit the terminal structured handoff report; any selected evidence is materialized backend-side.",
    observation: { type: "tool.agent_handoff", label: "AgentHandoff", format: "generic", targetKeys: ["profile", "outcome"] },
  },
  agent_claim: {
    schema: TOOL_AGENT_CLAIM,
    access: "coordination",
    summary: "Save, revise, retract, or list evidence-backed claims for the current nonterminal researcher report draft.",
    budgetExempt: true,
    observation: { type: "tool.agent_claim", label: "AgentClaim", format: "generic", targetKeys: ["op"] },
  },
  report_claims: {
    schema: TOOL_REPORT_CLAIMS,
    access: "coordination",
    surfaced: false,
    summary: "Compatibility name for saved researcher findings in existing sessions.",
    budgetExempt: true,
    observation: { type: "tool.report_claims", label: "ReportClaims", format: "generic", targetKeys: ["op"] },
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
  final_review: {
    schema: TOOL_FINAL_REVIEW,
    access: "coordination",
    summary: "Run declared tests and independent review; an accepted pass saves completion and ends both agent sessions.",
    budgetExempt: true,
    observation: { type: "tool.final_review", label: "FinalReview", format: "generic", targetKeys: [] },
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
    summary: "Run a single SQL statement against the project's configured application database.",
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
    summary: "Request one consolidated approval for exact writable file paths.",
    observation: { type: "tool.scope_request", label: "ScopeRequest", format: "file", pathKeys: ["path"], arrayPathKeys: ["requests"], requireTarget: true },
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
  compose_sprite_sheet: {
    schema: TOOL_COMPOSE_SPRITE_SHEET,
    access: "write",
    summary: "Pack scoped images into one PNG sprite sheet and a JSON frame map inside the artifact output scope.",
    observation: { type: "tool.compose_sprite_sheet", label: "SpriteSheet", format: "generic", targetKeys: ["output_path"] },
  },
  download_file: {
    schema: TOOL_DOWNLOAD_FILE,
    access: "write",
    summary: "Download public HTTPS files byte-exact into the artifact output scope, with per-hop address checks and size and type limits.",
    observation: { type: "tool.download_file", label: "Download", format: "generic", targetKeys: [] },
  },
  extract_image_text: {
    schema: TOOL_EXTRACT_IMAGE_TEXT,
    access: "read",
    summary: "Run local tesseract OCR to extract text from an image.",
    observation: { type: "tool.extract_image_text", label: "ExtractText", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  view_image: {
    schema: TOOL_VIEW_IMAGE,
    access: "read",
    summary: "Return one in-scope PNG, JPEG, WebP, or GIF image for visual inspection, downscaled when large.",
    observation: { type: "tool.view_image", label: "ViewImage", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  run_scoped_checks: {
    schema: TOOL_RUN_SCOPED_CHECKS,
    access: "shell",
    summary: "Canonical lint/typecheck route for the declared job scope, including scoped PHP syntax lint when applicable.",
    observation: { type: "tool.run_scoped_checks", label: "ScopedChecks", format: "generic", targetKeys: ["checks", "scope"] },
  },
  run_unit_test: {
    schema: TOOL_RUN_UNIT_TEST,
    access: "shell",
    summary: "Run one discovered unit-test file with a fixed language adapter and normalized pass/fail output.",
    observation: { type: "tool.run_unit_test", label: "UnitTest", format: "file", pathKeys: ["path"], requireTarget: true },
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

















function roleAllowlistForTool(toolName) {
  if (toolName === "custom_tools") return new Set(["researcher", "planner", "dev", "artificer", "assessor"]);
  if (toolName === "sub_agent_next_input") return new Set(["subagent"]);
  if (toolName === "web_research_handoff") return new Set(["researcher"]);
  if (toolName === "agent_claim" || toolName === "report_claims") return new Set(["researcher"]);
  if (toolName === "dispatch_agent") return new Set(["researcher", "planner"]);
  // The developer requests reviews; its reviewer child reports with it.
  if (toolName === "final_review") return new Set(["dev", "assessor"]);
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
      ...(("imageGeneration" in config ? config.imageGeneration : []) || []),
    ]);
    if (names.has(toolName)) roles.push(role);
  }
  // Protocol selection retains bounded native reads with Atlas and the audited
  // chain protocol without Atlas. This is the role ceiling, not an issued grant.
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
      : "native",
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
  requireResearcherCoverage = false,
  researchInvestigation = false,
  plannerMaxChildren = null,
} = {}) {
  if (role === "assessor") {
    if (name === "final_review") return TOOL_FINAL_REVIEW_ASSESSOR;
    if (name === "run_scoped_checks") return TOOL_RUN_SCOPED_CHECKS_ASSESSOR;
  }
  if (["dev", "fix"].includes(role)) {
    if (name === "final_review") return TOOL_FINAL_REVIEW_DEV;
    if (name === "request_scope") return TOOL_REQUEST_SCOPE_DEV;
  }
  if (name === "dispatch_agent" && role === "planner" && researchInvestigation) {
    const schema = structuredClone(TOOL_DISPATCH_AGENT_PLANNER);
    if (Number.isInteger(plannerMaxChildren) && plannerMaxChildren >= 1) {
      schema.parameters.properties.requests.maxItems = plannerMaxChildren;
    }
    return schema;
  }
  if (name !== "agent_handoff") return getToolSchema(name);
  return getAgentHandoffToolSchemaForRole(role, {
    compactCompletion,
    compactV3,
    compactV4,
    requireResearcherCoverage,
    researchInvestigation,
  });
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

export function getBaseToolNamesForRole(role, allowWrite, { needsImageGeneration = false, agentHandoff = false, subAgent = false, dispatchAgent = false, webResearchHandoff = false, finalReview = false } = {}) {
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
  if (agentHandoff && role === "researcher") names.unshift("agent_claim");
  if (subAgent && ["researcher", "dev", "artificer"].includes(role)) {
    names.unshift("sub_agent");
  }
  if (dispatchAgent && ["researcher", "planner"].includes(role)) names.unshift("dispatch_agent");
  if (webResearchHandoff && role === "researcher") names.unshift("web_research_handoff");
  if (finalReview && ((role === "dev" && allowWrite) || role === "assessor")) names.unshift("final_review");
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
    || role === "preflight";
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

export function roleUsesDeterministicAssetDownload(role) {
  return TOOL_ROLE_LIBRARY.deterministicMcp.assetDownloadRoles.includes(role);
}

export function getDeterministicMcpToolNames(role, {
  needsImageGeneration = false,
  agentHandoff = false,
  subAgent = false,
  dispatchAgent = false,
  webResearchHandoff = false,
  finalReview = false,
  atlasAvailable = false,
  disableSystemTools = false,
  researchInvestigation = false,
  customTools = false,
} = {}) {
  if (role === "subagent") return ["sub_agent_next_input", "agent_handoff"];
  if (!roleUsesDeterministicReadMcp(role)) return [];
  if (role === "preflight") return [];
  const tools = DETERMINISTIC_READ_TOOLS.filter((name) => !["planner", "dev", "fix"].includes(role) || name !== "hash_file");
  if (customTools) tools.unshift("custom_tools");
  if (roleUsesDeterministicWriteMcp(role)) {
    tools.push(...DETERMINISTIC_WRITE_TOOLS.filter((name) => (
      (role !== "dev" || name !== "write_file")
      && (role === "dev" || name !== "request_scope")
    )));
  }
  if (roleUsesDeterministicImageHelpers(role)) tools.push(...DETERMINISTIC_IMAGE_HELPER_TOOLS);
  // clean_image and compose_sprite_sheet write images within scope; keep them
  // artificer-only.
  if (roleUsesDeterministicImageMcp(role)) tools.push(...DETERMINISTIC_IMAGE_MUTATION_TOOLS);
  if (roleUsesDeterministicImageMcp(role) && needsImageGeneration) tools.push(...DETERMINISTIC_IMAGE_TOOLS);
  if (role === "dev" || role === "artificer" || role === "assessor") tools.push(...DETERMINISTIC_OCR_TOOLS);
  if (role === "assessor") tools.push(...DETERMINISTIC_IMAGE_VIEW_TOOLS);
  if (roleUsesDeterministicAssetDownload(role)) tools.push(...DETERMINISTIC_ASSET_DOWNLOAD_TOOLS);
  if (["planner", "dev", "assessor"].includes(role)) tools.push("run_unit_test");
  // Scoped lint/typecheck belongs to the assessor.
  if (role === "assessor") {
    tools.push("run_scoped_checks");
  }
  if (TOOL_ROLE_LIBRARY.deterministicMcp.shellRoles.includes(role)) tools.push("bash");
  if (role === "planner") tools.push("get_brief");
  // Opt-in project DB access for the roles that carry it. The job's issued
  // capability lane caps the operator grant at execution (the assessor is
  // always read-only). The MCP gateway's runtimeToolAvailable() hides the tool
  // unless this repo's admin config enables it with a usable grant.
  if (["planner", "dev", "assessor"].includes(role)) tools.push("project_db_query");
  if (role === "researcher" && !atlasAvailable) {
    const readIdx = tools.indexOf("read_file");
    if (readIdx !== -1) tools.splice(readIdx, 1);
    tools.push("chain_read", "chain_verdict");
  }
  if (atlasAvailable) {
    // Remove redundant source tools from every role's issued surface. Keep
    // directory browsing available without an ATLAS-first round trip.
    for (const toolName of ATLAS_REPLACED_NATIVE_TOOLS) {
      // Planners retain exact file access alongside Atlas retrieval.
      if (role === "planner" && toolName === "read_file") continue;
      if (!atlasReplacesNativeTool(toolName, role)) continue;
      const index = tools.indexOf(toolName);
      if (index !== -1) tools.splice(index, 1);
    }
  }
  if (role === "researcher" && atlasAvailable && disableSystemTools && researchInvestigation) {
    // Dispatched code researchers start from a focused assignment. Keep
    // directory discovery available to the normal researcher and planner.
    const index = tools.indexOf("list_files");
    if (index !== -1) tools.splice(index, 1);
  }
  if (agentHandoff && ["researcher", "planner", "dev", "artificer", "assessor"].includes(role)) {
    tools.unshift("agent_handoff");
  }
  if (agentHandoff && role === "researcher") tools.unshift("agent_claim");
  if (subAgent && ["researcher", "dev", "artificer"].includes(role)) {
    tools.unshift("sub_agent");
  }
  if (dispatchAgent && ["researcher", "planner"].includes(role)) tools.unshift("dispatch_agent");
  if (webResearchHandoff && role === "researcher") tools.unshift("web_research_handoff");
  if (finalReview && (role === "dev" || role === "assessor")) tools.unshift("final_review");
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




export function isPrefetchOnlyAtlasTool(name) {
  return ATLAS_PREFETCH_ONLY_ACTIONS.has(stripAtlasPrefix(name));
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
  if (normalizedAction === "symbol.get") {
    const projected = cloneJson(schema);
    for (const key of ["parameters", "inputSchema"]) {
      const budget = projected?.[key]?.properties?.maxTokens;
      if (budget) budget.maximum = ATLAS_TOOL_DEFS_RAW["symbol.get"].parameters.properties.maxTokens.maximum;
    }
    return projected;
  }
  if (normalizedAction === "code.skeleton") {
    const projected = cloneJson(schema);
    for (const schemaKey of ["parameters", "inputSchema"]) {
      const properties = projected?.[schemaKey]?.properties;
      if (!properties) continue;
      for (const [field, definition] of Object.entries(ATLAS_TOOL_DEFS_RAW["code.skeleton"].parameters.properties)) {
        if (definition.internalOnly === true && properties[field]) properties[field].internalOnly = true;
      }
    }
    return projected;
  }
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
