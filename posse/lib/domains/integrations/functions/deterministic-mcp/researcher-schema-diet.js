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
  "atlas.traverse_ref": "Fetch content for issued traversal_ref values and batch independent refs. Evidence refs are citation-only.",
  "atlas.create_ref": "Create a bounded stored ref from visible text or source slices.",
  "atlas.symbol.search": "Find ranked symbol addresses by exact or semantic query; use returned IDs or locations for focused reads.",
  "atlas.symbol.card": "Inspect one known symbol's compact signature and relationships.",
  "atlas.symbol.overview": "Inspect a known symbol's bounded relationship overview.",
  "atlas.code.skeleton": "Inspect a body-free outline for one known file or symbol.",
  "atlas.code.lens": "Locate all named identifiers within one known file or symbol before an exact source read.",
  "atlas.code.window": "Read exact source for one known symbol or anchored file region. Reuse visible evidence and include all known same-file identifiers.",
  "atlas.code.structure": "Inspect body-free files, symbols, imports, and selected relationship edges for known paths.",
  "atlas.code.survey": "Survey ranked symbols and call relationships across known paths when the exact target is still unclear.",
  "atlas.memory.surface": "Surface bounded repository memories for known symbols, files, or domains.",
  "atlas.memory.get": "Retrieve bounded repository memories for known symbols, files, or domains.",
  "atlas.memory.feedback": "Record whether one surfaced repository memory was useful.",
});

export function applyResearcherSchemaDiet(tool) {
  const normalizedName = String(tool?.name || "");
  const compactDescription = RESEARCHER_SCHEMA_DIET_DESCRIPTIONS[normalizedName];
  const { annotations: _annotations, ...withoutAnnotations } = tool;
  return {
    ...withoutAnnotations,
    ...(compactDescription ? { description: compactDescription } : {}),
    inputSchema: stripAgentSchemaDescriptions(tool.inputSchema),
  };
}
