// Canonical local policy for deterministic tools that a citation child may
// consume through its private evidence cursor. Remote issuance surfaces carry
// canonical tool names but do not trust remote-provided access labels, so both
// native and Atlas evidence safety must be explicit closed sets.

export const SUB_AGENT_PROTOCOL = "posse.sub_agent.v1";
export const SUB_AGENT_EVIDENCE_OUTCOMES = Object.freeze({
  DELIVERED: "evidence_delivered",
  COVERED: "covered",
  CONTROL: "control",
  ERROR: "error",
});
export const SUB_AGENT_LIMITS = Object.freeze({
  maxBatch: 3,
  maxInputs: 3,
  maxActiveChildren: 3,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 60_000,
  maxStatusWaitMs: 5_000,
  maxCursorAttempts: 5,
  maxInputArgumentBytes: 8 * 1024,
  maxInputDepth: 6,
  maxInputArrayItems: 32,
  maxInputStringChars: 4000,
  maxIntentChars: 2000,
  maxEvidenceLines: 80,
  maxEvidenceChars: 4000,
  targetTerminalEvidenceLines: 30,
  maxAtlasWindowTokens: 900,
  maxRequestBytes: 32 * 1024,
});

export const SUB_AGENT_EVIDENCE_SAFE_NATIVE_TOOLS = Object.freeze([
  "tools.read_file",
  "tools.pull_brief",
  "tools.get_brief",
  "tools.list_files",
  "tools.search_files",
  "tools.git_history",
  "tools.inspect_file",
  "tools.hash_file",
  "tools.read_image_metadata",
  "tools.validate_artifact_output",
  "tools.extract_image_text",
]);

const SUB_AGENT_EVIDENCE_SAFE_NATIVE_TOOL_SET = new Set(SUB_AGENT_EVIDENCE_SAFE_NATIVE_TOOLS);

export function isSubAgentEvidenceSafeNativeTool(name) {
  return SUB_AGENT_EVIDENCE_SAFE_NATIVE_TOOL_SET.has(String(name || ""));
}

export const SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOLS = Object.freeze([
  "atlas.query",
  "atlas.code",
  "atlas.repo",
  "atlas.action.search",
  "atlas.manual",
  "atlas.info",
  "atlas.traverse_ref",
  "atlas.fetch_ref",
  "atlas.repo.status",
  "atlas.repo.overview",
  "atlas.repo.quality",
  "atlas.buffer.status",
  "atlas.symbol.search",
  "atlas.symbol.card",
  "atlas.symbol.overview",
  "atlas.tree.overview",
  "atlas.tree.branch",
  "atlas.tree.scope",
  "atlas.tree.expand",
  "atlas.slice.spillover.get",
  "atlas.edit.plan",
  "atlas.code.skeleton",
  "atlas.code.lens",
  "atlas.code.window",
  "atlas.code.survey",
  "atlas.code.structure",
  "atlas.code.db",
  "atlas.context",
  "atlas.context.summary",
  "atlas.agent.feedback.query",
  "atlas.review.delta",
  "atlas.review.analyze",
  "atlas.review.risk",
  "atlas.file.read",
  "atlas.memory.get",
  "atlas.memory.surface",
  "atlas.policy.get",
  "atlas.usage.stats",
  "atlas.runtime.queryOutput",
]);

const SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOL_SET = new Set(SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOLS);

export function isSubAgentEvidenceSafeAtlasTool(name) {
  return SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOL_SET.has(String(name || ""));
}
