// Canonical local policy for deterministic tools that a citation child may
// consume through its private evidence cursor. Atlas uses one broad access
// class for both reads and durable side effects, so evidence safety must be an
// explicit closed set rather than inferred from the `atlas.` prefix.

export const SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOLS = Object.freeze([
  "atlas.query",
  "atlas.code",
  "atlas.repo",
  "atlas.action.search",
  "atlas.manual",
  "atlas.info",
  "atlas.fetch_ref",
  "atlas.fetch.ref",
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
  "atlas.runtime.query.output",
]);

const SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOL_SET = new Set(SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOLS);

export function isSubAgentEvidenceSafeAtlasTool(name) {
  return SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOL_SET.has(String(name || ""));
}
