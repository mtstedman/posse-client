// Canonical verification result vocabulary. Existing runners retain their
// wire-level `status` fields for compatibility; this adapter gives every path
// one typed decision model so infrastructure cannot masquerade as a product
// regression.

export const VERIFICATION_OUTCOME_SCHEMA_VERSION = 1;

const INFRASTRUCTURE_OUTCOMES = new Set([
  "dependency_unavailable",
  "runner_unavailable",
  "side_effect_detected",
  "timed_out",
]);

function outcomeType(value = {}) {
  const status = String(value?.status || "").trim().toLowerCase();
  const reason = String(value?.reason || "").trim().toLowerCase();
  const phase = String(value?.phase || "").trim().toLowerCase();
  if (status === "passed") return "passed";
  if (status === "skipped") return "no_applicable_suite";
  if (status === "timed_out") return "timed_out";
  if (status === "cancelled") return "cancelled";
  if (status === "side_effect_detected") return "side_effect_detected";
  if (["rejected", "invalid_test_plan", "unsafe_command"].includes(status)) {
    return status === "unsafe_command" ? "unsafe_command" : "invalid_plan";
  }
  if (reason.includes("dependency_unavailable") || status === "dependency_unavailable") {
    return "dependency_unavailable";
  }
  if (["infrastructure_error", "unavailable", "runner_unavailable"].includes(status)) {
    return "runner_unavailable";
  }
  if (status === "failed") return phase === "baseline" ? "baseline_debt" : "product_failed";
  return "runner_unavailable";
}

export function verificationOutcome(value = {}, {
  comparison = "not_comparable",
  evidence = null,
} = {}) {
  const type = outcomeType(value);
  const infrastructure = INFRASTRUCTURE_OUTCOMES.has(type);
  const actionability = type === "side_effect_detected"
    ? "repository_cleanup"
    : infrastructure
      ? "infrastructure"
      : type === "product_failed"
      ? "implementation"
      : ["invalid_plan", "unsafe_command"].includes(type)
        ? "configuration"
        : "none";
  return Object.freeze({
    schema_version: VERIFICATION_OUTCOME_SCHEMA_VERSION,
    type,
    actionability,
    retry_class: infrastructure ? "verification_infrastructure" : "none",
    comparison,
    evidence: evidence || {
      status: value?.status || null,
      reason: value?.reason || null,
      exit_code: value?.exit_code ?? value?.code ?? null,
      failure_fingerprint: value?.failure_fingerprint || null,
    },
  });
}

export function isVerificationInfrastructureOutcome(value) {
  const type = typeof value === "string"
    ? value
    : value?.verification_outcome?.type || verificationOutcome(value).type;
  return INFRASTRUCTURE_OUTCOMES.has(String(type || ""));
}

export function verificationInfrastructureError(value, prefix = "Verification infrastructure unavailable") {
  const outcome = value?.verification_outcome || verificationOutcome(value);
  const error = new Error(`${prefix}: ${value?.reason || outcome.type}`);
  error.code = "POSSE_VERIFICATION_INFRASTRUCTURE";
  error.verification_outcome = outcome;
  error.rerun_command = String(value?.command || "").trim() || null;
  return error;
}
