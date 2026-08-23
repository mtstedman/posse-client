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

// Researcher report mode intentionally accepts complete long-form prose up to
// the aggregate call cutoff. Pipeline mode stays compact and uses the normal
// per-field runtime ceilings. Keep this distinction explicit so schemas,
// runtime validation, and prompt policy do not accidentally apply the compact
// pipeline limits to terminal reports.
export const AGENT_HANDOFF_RESEARCHER_LIMIT_POLICY = Object.freeze({
  "researcher.pipeline.v1": Object.freeze({
    maxSummaryChars: AGENT_HANDOFF_LIMITS.maxSummaryChars,
    maxClaims: AGENT_HANDOFF_LIMITS.maxClaims,
    maxClaimChars: AGENT_HANDOFF_LIMITS.maxClaimChars,
    maxClaimSummaryChars: AGENT_HANDOFF_LIMITS.maxSummaryChars,
  }),
  "researcher.report.v1": Object.freeze({
    maxCallBytes: AGENT_HANDOFF_LIMITS.maxCallBytes,
    unboundedWithinCall: Object.freeze([
      "summary",
      "claim_count",
      "claim_chars",
      "claim_summary_chars",
    ]),
  }),
});

export const AGENT_HANDOFF_PROFILE_POLICY = Object.freeze({
  "researcher.pipeline.v1": Object.freeze({
    roles: Object.freeze(["researcher"]),
    outcomes: Object.freeze(["success", "gap", "input_required"]),
    targetKinds: Object.freeze(["pipeline"]),
    maxHandoffs: 1,
  }),
  "researcher.report.v1": Object.freeze({
    roles: Object.freeze(["researcher"]),
    outcomes: Object.freeze(["complete"]),
    targetKinds: Object.freeze(["result"]),
    maxHandoffs: 1,
  }),
  "planner.plan.v1": Object.freeze({
    roles: Object.freeze(["planner"]),
    outcomes: Object.freeze(["success"]),
    targetKinds: Object.freeze(["agent", "system"]),
    maxHandoffs: 50,
  }),
  "dev.result.v1": Object.freeze({
    roles: Object.freeze(["dev", "fix"]),
    outcomes: Object.freeze(["complete", "failed", "blocked"]),
    targetKinds: Object.freeze(["pipeline"]),
    maxHandoffs: 1,
  }),
  "artificer.result.v1": Object.freeze({
    roles: Object.freeze(["artificer"]),
    outcomes: Object.freeze(["complete", "failed", "blocked"]),
    targetKinds: Object.freeze(["pipeline"]),
    maxHandoffs: 1,
  }),
  "assessor.verdict.v1": Object.freeze({
    roles: Object.freeze(["assessor"]),
    outcomes: Object.freeze(["pass", "fail", "needs_replan", "needs_review", "blocked"]),
    targetKinds: Object.freeze(["pipeline"]),
    maxHandoffs: 1,
  }),
  "citation_synthesis.v1": Object.freeze({
    roles: Object.freeze(["subagent"]),
    outcomes: Object.freeze(["complete", "partial", "failed"]),
    targetKinds: Object.freeze(["parent"]),
    maxHandoffs: 1,
  }),
});

// Prompt-facing disclosure for the runtime's researcher evidence rule. Every
// structured claim must be independently checkable through the canonical
// evidence lane; uncited narrative belongs in the report summary.
export const AGENT_HANDOFF_RESEARCH_EVIDENCE_POLICY = Object.freeze({
  profiles: Object.freeze(["researcher.pipeline.v1", "researcher.report.v1"]),
  requiredLanes: Object.freeze(["evidence"]),
  rule: "every_claim",
});

// Agent-facing schemas advertise canonical handoff fields only. Runtime keeps
// these explicitly cataloged compatibility forms for older trusted callers and
// malformed-response repair; accepting an alias never makes it model-facing.
export const AGENT_HANDOFF_ALIAS_POLICY = Object.freeze({
  advertised: Object.freeze({
    fieldAliases: Object.freeze([]),
    shapeAliases: Object.freeze([]),
  }),
  accepted: Object.freeze({
    fieldAliases: Object.freeze({
      assessorCompactOutcome: Object.freeze({
        canonical: "verdict",
        alias: "outcome",
        contexts: Object.freeze(["assessor.compact.v3"]),
      }),
      plannerTaskRole: Object.freeze({
        canonical: "role",
        alias: "job_type",
        contexts: Object.freeze(["planner.compact.v2", "planner.compact.v3"]),
      }),
      claimName: Object.freeze({
        canonical: "claim",
        alias: "name",
        contexts: Object.freeze(["handoff.claim"]),
      }),
      claimSummary: Object.freeze({
        canonical: "summary",
        alias: "prose",
        contexts: Object.freeze(["handoff.claim"]),
      }),
      researcherClaimProof: Object.freeze({
        canonical: "evidence",
        alias: "proof",
        contexts: Object.freeze(["handoff.claim", "trusted_legacy"]),
      }),
      researcherClaimSupport: Object.freeze({
        canonical: "evidence",
        alias: "support",
        contexts: Object.freeze(["handoff.claim", "trusted_legacy"]),
      }),
      decoyReason: Object.freeze({
        canonical: "reason",
        alias: "summary",
        contexts: Object.freeze(["handoff.claim.decoy"]),
      }),
    }),
    shapeAliases: Object.freeze([
      Object.freeze({
        id: "claim_tuple",
        canonical: "claims[].{claim,summary,evidence,decoy}",
        accepted: "claims[].[claim,detail]",
        contexts: Object.freeze(["trusted_legacy", "compatibility_repair"]),
      }),
      Object.freeze({
        id: "decoy_ref_lines",
        canonical: "claims[].decoy[].selector",
        accepted: "claims[].decoy[].{ref,lines}",
        contexts: Object.freeze(["trusted_legacy", "compatibility_repair"]),
      }),
      Object.freeze({
        id: "flat_report_fields",
        canonical: "handoffs[].report.*",
        accepted: "handoffs[].{summary,claims,scope,constraints,success_criteria,questions,research,payload,metadata}",
        contexts: Object.freeze(["trusted_legacy", "non_schema_transport"]),
      }),
      Object.freeze({
        id: "researcher_compatibility_envelope",
        canonical: "researcher compact or canonical handoff envelope",
        accepted: "legacy researcher status/report/claim prose envelope",
        contexts: Object.freeze(["malformed_response_repair"]),
      }),
      Object.freeze({
        id: "assessor_compatibility_envelope",
        canonical: "assessor compact or canonical handoff envelope",
        accepted: "legacy assessor status/verdict/report envelope",
        contexts: Object.freeze(["malformed_response_repair"]),
      }),
    ]),
  }),
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
