// Planner-only presentation. Validation and execution remain in the tool catalog.
export const PLANNER_TOOL_DESCRIPTIONS = Object.freeze({
  "tools.agent_handoff": "Submit the complete plan using the issued task schema.",
  "tools.list_files": "List up to 200 paths under a directory, optionally by name pattern; marks truncated results.",
  "tools.git_history": "Inspect bounded commits, file changes, or blame context.",
  "tools.get_brief": "Load an available upstream research brief, structured findings, and source manifest.",
  "tools.ack_operator_feedback": "Acknowledge delivered operator feedback after incorporating it into the current work.",
});

export const PLANNER_CLAIMS_DESCRIPTION = "Optional supported claims; do not gather extra evidence to fill them. Select already-visible evidence with #ref:start-end, path:start-end, or {ref/path,lines:{start,count}}. Paths must already be surfaced and uniquely resolve. Use bare range numbers. For source-backed refs, lines use source-file coordinates and must fit one recorded window; other refs use stored payload lines. Omit lines to cite an entire ref. Cite evidence_ref directly; read an issued traversal_ref before citing hidden content. Omit unsupported claims; an unavailable selector becomes a marked task-summary note and repair is optional.";
export const PLANNER_SCOPE_DESCRIPTION = "Exact writable scope: dev tasks use file paths, never create_roots; artificer may use bounded output roots. Paths belong to one category unless replacement was requested. DB tasks use role dev, mode db and empty file/root arrays. Human_input uses {}; promote names exact destination files. Other tasks require non-empty writable scope.";
