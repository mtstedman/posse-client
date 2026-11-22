// @ts-check
// Atlas tool parameter vocabularies.
//
// One declaration per closed set. The agent-facing tool table
// (atlas-tools.js), the dispatcher's runtime schemas
// (domains/atlas/functions/v2/contracts/tool-schemas.js), the researcher's
// direct tools, the deterministic toolkit and the action handlers all read
// these lists. Order is agent-visible: the pinned agent tool contract records
// each enum in this order.

import { HASH_REF_OWNER_SCOPES } from "./hash-store.js";

// workflow
export const ATLAS_WORKFLOW_ON_ERROR_MODES = Object.freeze(["continue", "stop"]);
export const ATLAS_WORKFLOW_TRACE_LEVELS = Object.freeze(["summary", "verbose"]);

// manual
export const ATLAS_MANUAL_FORMATS = Object.freeze(["text", "json"]);

// fetch_ref / create_ref. Agents own refs on their work item or job; agent_run
// scope is runtime-internal.
export const ATLAS_FETCH_REF_SEARCH_MODES = Object.freeze(["auto", "literal", "regex"]);
export const ATLAS_AGENT_HASH_REF_OWNER_SCOPES = Object.freeze(
  HASH_REF_OWNER_SCOPES.filter((scope) => scope !== "agent_run"),
);

// repo.status / index.refresh / repo.overview
export const ATLAS_REPO_STATUS_DETAILS = Object.freeze(["minimal", "standard", "full"]);
export const ATLAS_INDEX_REFRESH_MODES = Object.freeze(["smart", "full", "incremental"]);
export const ATLAS_OVERVIEW_LEVELS = Object.freeze(["stats", "directories", "hotspots", "graph", "full"]);

// buffer.push
export const ATLAS_BUFFER_EVENT_TYPES = Object.freeze(["open", "change", "save", "close", "checkpoint"]);

// symbol.search
export const ATLAS_SEARCH_ENTITIES = Object.freeze(["symbols", "feedback"]);
export const ATLAS_SEARCH_SCOPES = Object.freeze(["name", "body", "either"]);

// Shared retrieval vocabulary (context, slice.build, tree.*, agent.feedback).
export const ATLAS_TASK_TYPES = Object.freeze(["debug", "review", "implement", "explain"]);
export const ATLAS_CARD_DETAILS = Object.freeze(["minimal", "signature", "deps", "compact", "full"]);
export const ATLAS_WIRE_FORMATS = Object.freeze(["standard", "compact", "agent", "packed"]);
export const ATLAS_CONTEXT_MODES = Object.freeze(["precise", "broad"]);
export const ATLAS_TREE_REF_TYPES = Object.freeze(["cluster", "process"]);

// symbol.callers / symbol.overview / code.structure
export const ATLAS_CALLER_MODES = Object.freeze(["caller", "reference", "all"]);
export const ATLAS_RELATIONSHIP_KINDS = Object.freeze([
  "calls", "references", "reads", "writes", "uses_type", "imports", "extends", "implements",
]);
export const ATLAS_STRUCTURE_EDGE_KINDS = Object.freeze([
  "imports", "calls", "references", "extends", "implements", "uses_type",
]);

// edit.plan / code.window
export const ATLAS_EDIT_OPERATIONS = Object.freeze(["replace", "insert", "delete", "inspect"]);
export const ATLAS_CODE_GRANULARITIES = Object.freeze(["symbol", "block", "fileWindow"]);

// memory.*. `general` is the default domain and cannot be requested as a
// specific one. Agents report one of the feedback verdicts; the runtime also
// accepts `suppress`, which only an operator issues.
export const ATLAS_MEMORY_DOMAINS = Object.freeze(["general", "ux", "schema", "security", "performance"]);
export const ATLAS_MEMORY_SPECIFIC_DOMAINS = Object.freeze(
  ATLAS_MEMORY_DOMAINS.filter((domain) => domain !== "general"),
);
export const ATLAS_MEMORY_AGENT_FEEDBACK_VERDICTS = Object.freeze(["used", "stale", "wrong", "duplicate"]);
export const ATLAS_MEMORY_FEEDBACK_VERDICTS = Object.freeze([...ATLAS_MEMORY_AGENT_FEEDBACK_VERDICTS, "suppress"]);

// usage.stats / runtime.queryoutput
export const ATLAS_USAGE_SCOPES = Object.freeze(["session", "history", "both"]);
export const ATLAS_RUNTIME_OUTPUT_MODES = Object.freeze(["minimal", "summary", "intent"]);
export const ATLAS_RUNTIME_STREAMS = Object.freeze(["stdout", "stderr", "both"]);
