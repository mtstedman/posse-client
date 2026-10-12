import { readonlySet } from "./readonly-collections.js";
// Canonical terminal-handoff vocabulary shared by schemas and runtime policy.
import { DEV_MODE_ORDER } from "./dev-mode.js";
import { JOB_MODEL_TIERS, JOB_REASONING_EFFORTS } from "./job.js";
import { RESEARCH_BUDGETS } from "./research-budget.js";
import { WORK_ITEM_PRIORITIES } from "./work-item.js";

export const AGENT_HANDOFF_RECEIPT_NOTIFICATION = "notifications/posse/agent_handoff_receipt";
export const AGENT_HANDOFF_PROTOCOL = "posse.agent_handoff.v1";
export const AGENT_HANDOFF_PROFILES = Object.freeze({
  RESEARCHER_PIPELINE: "researcher.pipeline.v1",
  RESEARCHER_REPORT: "researcher.report.v1",
  PLANNER_PLAN: "planner.plan.v1",
  DEV_RESULT: "dev.result.v1",
  ARTIFICER_RESULT: "artificer.result.v1",
  ASSESSOR_VERDICT: "assessor.verdict.v1",
  RESEARCH_INVESTIGATION: "research_investigation.v1",
  CITATION_SYNTHESIS: "citation_synthesis.v1",
});

export const AGENT_HANDOFF_PLANNER_REPORT_METADATA_KEYS = Object.freeze([
  "dev_mode",
  "risk",
  "risk_tags",
  "scope_confidence",
  "skills",
  "deepthink_budget",
  "model_tier",
  "reasoning_effort",
  "priority",
  "skip_assessment",
  "executed_by_planner",
  "test_command",
  "tests_to_run",
  "write_tests",
]);

export const AGENT_HANDOFF_PLANNER_REPORT_KEYS = Object.freeze([
  "summary",
  "claims",
  "scope",
  "constraints",
  "success_criteria",
  "questions",
  "research",
  ...AGENT_HANDOFF_PLANNER_REPORT_METADATA_KEYS,
  "payload",
]);

export const AGENT_HANDOFF_SCOPE_CONFIDENCE_VALUES = Object.freeze(["high", "medium", "low"]);
export const AGENT_HANDOFF_PLANNER_METADATA_ENUMS = Object.freeze({
  dev_mode: DEV_MODE_ORDER,
  scope_confidence: AGENT_HANDOFF_SCOPE_CONFIDENCE_VALUES,
  deepthink_budget: RESEARCH_BUDGETS,
  model_tier: JOB_MODEL_TIERS,
  reasoning_effort: JOB_REASONING_EFFORTS,
  priority: WORK_ITEM_PRIORITIES,
});

export const AGENT_HANDOFF_RESEARCH_USEFULNESS_VALUES = Object.freeze(["primary", "supporting", "context", "low"]);
export const AGENT_HANDOFF_RESEARCH_EVIDENCE_VALUES = Object.freeze(["audited_file_read", "atlas", "search", "prior_research", "web"]);
export const AGENT_HANDOFF_RESEARCH_QUESTION_CATEGORIES = Object.freeze(["data-handling", "security", "convention", "config", "unclear-pattern"]);

export const AGENT_HANDOFF_EVIDENCE_CLEANUP_ACTIONS = Object.freeze({
  DEMOTE_UNVERIFIED_CLAIM_TO_SUMMARY: "demote_unverified_claim_to_summary",
  DROP_ADVISORY_RESEARCH_SELECTOR: "drop_advisory_research_selector",
  DROP_UNVERIFIABLE_STRICT_CLAIM_SELECTOR: "drop_unverifiable_strict_claim_selector",
  DROP_UNVERIFIABLE_DECOY_SELECTOR: "drop_unverifiable_decoy_selector",
  DROP_RESEARCHER_OVERFLOW: "drop_researcher_overflow",
  REDACT_SENSITIVE_PROSE: "redact_sensitive_prose",
  REDACT_URL_USERINFO: "redact_url_userinfo",
  CLAMP_PATH_END: "clamp_path_end",
  CLAMP_SOURCE_END: "clamp_source_end",
  CLAMP_REF_RELATIVE_END: "clamp_ref_relative_end",
  CLAMP_MATERIALIZED_END: "clamp_materialized_end",
  NORMALIZE_COMPACT_SOURCE_RELATIVE_RANGE: "normalize_compact_source_relative_range",
  NORMALIZE_REF_SOURCE_COORDINATES_TO_SURFACED_PATH: "normalize_ref_source_coordinates_to_surfaced_path",
  NORMALIZE_MATERIALIZED_ENVELOPE_TO_SOURCE_WINDOW: "normalize_materialized_envelope_to_source_window",
  TRIM_SELECTOR_TO_DELIVERED_RANGES: "trim_selector_to_delivered_ranges",
  NARROW_WHOLE_REF: "narrow_whole_ref",
});

// Remote serves researcher_report_direct with the same researcher.report.v1
// handoff and claim staging, so it is a report-only handoff profile too.
const RESEARCHER_REPORT_PROMPT_PROFILES = readonlySet([
  "researcher_report",
  "researcher_report_tight",
  "researcher_report_direct",
]);

export function usesResearcherReportOnlyHandoff(promptProfile) {
  return RESEARCHER_REPORT_PROMPT_PROFILES.has(String(promptProfile || "").trim().toLowerCase());
}

// Only narrative fields may be rewritten when they repeat selected evidence.
// Commands, paths, symbols, queries and other structured values stay exact.
export const AGENT_HANDOFF_RESEARCH_PROSE_FIELDS = Object.freeze({
  memories: ["title", "content"],
  planner_file_priorities: ["reason"],
  patterns: ["description"],
  scope_estimate: ["unknowns", "scope_reasons"],
  absence_checks: ["claim"],
  question_details: ["question", "context", "impact"],
  verification_targets: ["reason"],
});

// Terminal prose may name an auth scheme or use a placeholder noun. This
// vocabulary never changes credential detection for bridge payloads or logs.
export const AGENT_HANDOFF_BEARER_PROSE_TERMS = Object.freeze([
  "access token", "access-token", "auth token", "auth-token",
  "token", "tokens", "credential", "credentials", "header",
  "authorization", "authentication",
]);

// Explicit telemetry classification, independent of cleanup action names.
export const AGENT_HANDOFF_EVIDENCE_CLEANUP_OUTCOMES = Object.freeze({
  DROPPED: "dropped",
  NORMALIZED: "normalized",
});

export const AGENT_HANDOFF_LIMITS = Object.freeze({
  maxCallBytes: 256 * 1024,
  maxEntryBytes: 32 * 1024,
  maxClaims: 12,
  // Coverage requirements may share a report claim. Keep this independent
  // from maxClaims so an explicit multi-part task is not collapsed merely to
  // fit the report's narrative claim limit.
  maxCompletionRequirements: 24,
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

// Rendering of a researcher report brief, not part of the model-facing
// handoff contract. The brief quotes each claim's cited code under the claim.
// HARD-40 answers cite a median ~1,400 lines (~63k chars); the budget covers
// that median. Every claim keeps its first excerpt, later selectors fill in
// claim order, and the rest are listed by location.
export const RESEARCHER_REPORT_BRIEF_POLICY = Object.freeze({
  inlineCodeChars: 64000,
  inlineExcerptLines: 120,
});

// Researcher report mode intentionally accepts complete long-form prose up to
// the aggregate call cutoff. Pipeline mode stays compact and uses the normal
// per-field runtime ceilings. Keep this distinction explicit so schemas,
// runtime validation, and prompt policy do not accidentally apply the compact
// pipeline limits to terminal reports.
export const AGENT_HANDOFF_RESEARCHER_LIMIT_POLICY = Object.freeze({
  [AGENT_HANDOFF_PROFILES.RESEARCHER_PIPELINE]: Object.freeze({
    maxSelectorsPerClaim: null,
    maxEvidenceChars: null,
    maxSummaryChars: AGENT_HANDOFF_LIMITS.maxSummaryChars,
    maxClaims: AGENT_HANDOFF_LIMITS.maxClaims,
    maxClaimChars: AGENT_HANDOFF_LIMITS.maxClaimChars,
    maxClaimSummaryChars: AGENT_HANDOFF_LIMITS.maxSummaryChars,
  }),
  [AGENT_HANDOFF_PROFILES.RESEARCHER_REPORT]: Object.freeze({
    maxSelectorsPerClaim: null,
    maxEvidenceChars: null,
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
  [AGENT_HANDOFF_PROFILES.RESEARCHER_PIPELINE]: Object.freeze({
    roles: Object.freeze(["researcher"]),
    outcomes: Object.freeze(["success", "gap", "input_required"]),
    targetKinds: Object.freeze(["pipeline"]),
    maxHandoffs: 1,
  }),
  [AGENT_HANDOFF_PROFILES.RESEARCHER_REPORT]: Object.freeze({
    roles: Object.freeze(["researcher"]),
    outcomes: Object.freeze(["complete"]),
    targetKinds: Object.freeze(["result"]),
    maxHandoffs: 1,
  }),
  [AGENT_HANDOFF_PROFILES.PLANNER_PLAN]: Object.freeze({
    roles: Object.freeze(["planner"]),
    outcomes: Object.freeze(["success"]),
    targetKinds: Object.freeze(["agent", "system"]),
    maxHandoffs: 50,
  }),
  [AGENT_HANDOFF_PROFILES.DEV_RESULT]: Object.freeze({
    roles: Object.freeze(["dev", "fix"]),
    outcomes: Object.freeze(["complete", "failed", "blocked"]),
    targetKinds: Object.freeze(["pipeline"]),
    maxHandoffs: 1,
  }),
  [AGENT_HANDOFF_PROFILES.ARTIFICER_RESULT]: Object.freeze({
    roles: Object.freeze(["artificer"]),
    outcomes: Object.freeze(["complete", "failed", "blocked"]),
    targetKinds: Object.freeze(["pipeline"]),
    maxHandoffs: 1,
  }),
  [AGENT_HANDOFF_PROFILES.ASSESSOR_VERDICT]: Object.freeze({
    roles: Object.freeze(["assessor"]),
    outcomes: Object.freeze(["pass", "fail", "needs_replan", "needs_review", "blocked"]),
    targetKinds: Object.freeze(["pipeline"]),
    maxHandoffs: 1,
  }),
  [AGENT_HANDOFF_PROFILES.RESEARCH_INVESTIGATION]: Object.freeze({
    roles: Object.freeze(["researcher"]),
    outcomes: Object.freeze(["complete", "partial", "failed"]),
    targetKinds: Object.freeze(["parent"]),
    maxHandoffs: 1,
  }),
  [AGENT_HANDOFF_PROFILES.CITATION_SYNTHESIS]: Object.freeze({
    roles: Object.freeze(["subagent"]),
    outcomes: Object.freeze(["complete", "partial", "failed"]),
    targetKinds: Object.freeze(["parent"]),
    maxHandoffs: 1,
  }),
});

// Prompt-facing disclosure for the runtime's researcher evidence rule.
// Human-facing report claims remain assessment-grade, but an unsupported
// candidate is demoted to a marked summary note rather than spending another
// provider turn on handoff repair. Pipeline research is an advisory discovery
// brief: the planner can re-surface a cited location or inspect an uncited
// claim, so evidence mistakes are recorded and dropped.
export const AGENT_HANDOFF_RESEARCH_EVIDENCE_POLICY = Object.freeze({
  profiles: Object.freeze([AGENT_HANDOFF_PROFILES.RESEARCHER_REPORT]),
  advisoryProfiles: Object.freeze([AGENT_HANDOFF_PROFILES.RESEARCHER_PIPELINE]),
  requiredLanes: Object.freeze(["evidence"]),
  rule: "every_report_claim",
  unsupportedClaimFallback: "demote_to_summary_note",
});

// Automatic repair is a material mutation, so an assessor failure needs one
// grounded defect claim before it can cross that boundary. Other assessor
// outcomes keep claims optional to avoid adding verification work to passes.
export const AGENT_HANDOFF_ASSESSOR_FAIL_EVIDENCE_POLICY = Object.freeze({
  profiles: Object.freeze([AGENT_HANDOFF_PROFILES.ASSESSOR_VERDICT]),
  outcomes: Object.freeze(["fail"]),
  requiredLanes: Object.freeze(["evidence"]),
  rule: "at_least_one_claim",
});

// A planner may coin names only for cross-task symbols that repository lookup
// cannot supply. Posse then copies the declarations into every referenced dev
// task, avoiding independently invented interfaces while preserving the
// canonical packet and downstream job format. Contracts are advertised for dev
// tasks; an artificer or promote task that references or owns one is accepted
// as a recorded repair and counts like a dev task. A contract that still
// breaks the role, reference-count or owner rules degrades to plain
// constraints on the tasks that referenced it instead of failing the plan.
export const AGENT_HANDOFF_SHARED_PLAN_CONTRACT_POLICY = Object.freeze({
  profiles: Object.freeze([AGENT_HANDOFF_PROFILES.PLANNER_PLAN]),
  taskRoles: Object.freeze(["dev"]),
  acceptedTaskRoles: Object.freeze(["dev", "artificer", "promote"]),
  scope: "new_repository_symbols",
  minTaskRefs: 2,
  ownerMustReference: true,
  maxContracts: 20,
  maxDeclarations: 12,
  maxRefsPerTask: 20,
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
