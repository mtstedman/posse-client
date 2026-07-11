export const INTERNAL_TOOL_FAMILY = "internal";

export const INTERNAL_ATLAS_ACTIONS = Object.freeze([
  "info",
  "repo.register",
  "repo.status",
  "index.refresh",
  "repo.overview",
  "repo.quality",
  "buffer.push",
  "buffer.checkpoint",
  "buffer.status",
  "tree.overview",
  "tree.scope",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "edit.plan",
  "context",
  "context.summary",
  "agent.feedback",
  "agent.feedback.query",
  "code.db",
  "policy.get",
  "policy.set",
  "usage.stats",
  "runtime.execute",
  "runtime.queryOutput",
  "scip.ingest",
  "workflow",
]);
export const INTERNAL_ATLAS_ACTION_SET = new Set(INTERNAL_ATLAS_ACTIONS);

export const INTERNAL_ATLAS_SURFACE_ACTIONS = Object.freeze([
  INTERNAL_TOOL_FAMILY,
  "file.write",
  ...INTERNAL_ATLAS_ACTIONS,
]);
export const INTERNAL_ATLAS_SURFACE_ACTION_SET = new Set(INTERNAL_ATLAS_SURFACE_ACTIONS);
