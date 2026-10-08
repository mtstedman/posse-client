import { stripAgentSchemaDescriptions } from "../../../../shared/tools/functions/agent-schema.js";

const RESEARCHER_SCHEMA_DIET_DESCRIPTIONS = Object.freeze({
  "tools.agent_handoff": "Submit the terminal researcher report. Put each finding in claims with visible evidence; the receipt ends generation.",
  "tools.read_file": "Read a bounded text-file range. With Atlas active, use this only for non-source artifacts, changed source, or the documented Atlas fallback.",
  "tools.ack_operator_feedback": "Acknowledge newly delivered operator feedback after incorporating it into the current work.",
  "tools.list_files": "List up to 200 paths under a directory, optionally by name pattern.",
  "tools.search_files": "Search repository text with bounded ripgrep regex or literal results.",
  "tools.git_history": "Inspect bounded repository history for commits, file changes, or blame context.",
  "tools.inspect_file": "Inspect one file's bounded metadata or content without mutation.",
  "tools.hash_file": "Calculate a deterministic file hash for verification.",

});

export function applyResearcherSchemaDiet(tool, { preserveDescription = false } = {}) {
  const normalizedName = String(tool?.name || "");
  const compactDescription = RESEARCHER_SCHEMA_DIET_DESCRIPTIONS[normalizedName];
  const { annotations: _annotations, ...withoutAnnotations } = tool;
  const inputSchema = stripAgentSchemaDescriptions(tool.inputSchema);
  // Keep semantic help that JSON types and limits cannot express. The facade
  // uses snake_case; ordinary surfaces use camelCase. Preserve nested batch
  // selectors too, without retaining descriptions on every obvious field.
  const semanticFields = new Set([
    "identifiers_to_find", "identifiersToFind",
    "limit", "offset", "max_tokens", "maxTokens", "granularity", "expected_lines", "expectedLines",
    "auto_fill", "autoFill", "edge_kinds", "edgeKinds", "mode", "kind", "context_lines", "contextLines",
    "search_mode", "searchMode", "traversal_ref", "reaccess_authorization", "reaccessAuthorization",
  ]);
  const restore = (source, target) => {
    if (!source || !target || typeof source !== "object" || typeof target !== "object") return;
    for (const [key, value] of Object.entries(source)) {
      if (key === "properties") {
        for (const [field, schema] of Object.entries(value || {})) {
          const projected = target.properties?.[field];
          if (projected && semanticFields.has(field) && schema?.description) projected.description = schema.description;
          restore(schema, projected);
        }
      } else if (key !== "description") restore(value, target[key]);
    }
  };
  restore(tool.inputSchema, inputSchema);
  return {
    ...withoutAnnotations,
    ...(!preserveDescription && compactDescription ? { description: compactDescription } : {}),
    inputSchema,
  };
}
