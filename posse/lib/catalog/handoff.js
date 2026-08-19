// Canonical terminal-handoff vocabulary shared by schemas and runtime policy.

export const AGENT_HANDOFF_RECEIPT_NOTIFICATION = "notifications/posse/agent_handoff_receipt";
export const AGENT_HANDOFF_PROTOCOL = "posse.agent_handoff.v1";
export const AGENT_HANDOFF_LIMITS = Object.freeze({
  maxCallBytes: 256 * 1024,
  maxEntryBytes: 32 * 1024,
  maxClaims: 12,
  maxClaimChars: 1000,
  maxSelectorsPerClaim: 24,
  recommendedIdChars: 40,
  maxIdChars: 80,
  recommendedSummaryChars: 2000,
  maxSummaryChars: 4000,
  recommendedPlannerTaskSpecChars: 2000,
  targetSelectorLines: 40,
  recommendedSelectorLines: 300,
  maxSelectorLines: 2000,
  targetSelectorChars: 4000,
  recommendedSelectorChars: 24000,
  maxSelectorChars: 128 * 1024,
  targetEvidenceChars: 12000,
  recommendedEvidenceChars: 32000,
  maxEvidenceChars: 192 * 1024,
  maxCitationChildEvidenceChars: 4000,
  recommendedNarrativeChars: 4000,
  maxNarrativeChars: 12000,
  maxCitationChildNarrativeChars: 2000,
  maxStructuredMetadataChars: 12000,
});

export const AGENT_HANDOFF_PLANNER_CONTRACT_VERSION = 1;
export const AGENT_HANDOFF_PLANNER_CONTRACT_KEYS = Object.freeze([
  "version",
  "exact_executable_handoffs",
  "dependency_edges",
]);
export const AGENT_HANDOFF_PLANNER_DEPENDENCY_EDGE_POLICIES = Object.freeze([
  "unconstrained",
  "at_least_one",
  "none",
]);
export const AGENT_HANDOFF_WORK_ITEM_CONTRACT_ERROR = "AGENT_HANDOFF_WORK_ITEM_CONTRACT_INVALID";
