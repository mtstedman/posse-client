// Canonical verification result vocabulary. Existing runners retain their
// wire-level `status` fields for compatibility; this adapter gives every path
// one typed decision model so infrastructure cannot masquerade as a product
// regression.
import { requiresTestVerification } from "../../../settings/functions/test-strictness.js";
import { PERMISSIVE_TEST_OUTCOMES } from "../../../../catalog/verification.js";
import { isUnrunnableTestReason } from "../../../verification/functions/test-capability-reasons.js";

export function isUnrunnableTestResult(value) {
  if (!value || value.required === true) return false;
  const children = value.check_runs || value.file_results || value.results;
  if (Array.isArray(children) && children.length) {
    return children.some(isUnrunnableTestResult)
      && children.every((child) => child.status === "passed" || isUnrunnableTestResult(child));
  }
  return value.status !== "passed" && isUnrunnableTestReason(value.reason || value.validation_error);
}

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
  // Scoped checks that already fail at the pre-change commit are the same
  // debt a failing frozen baseline is: not attributable to the change.
  if (status === "baseline_debt") return "baseline_debt";
  if (status === "failed") return phase === "baseline" || value?.baseline_attribution?.debt_only === true ? "baseline_debt" : "product_failed";
  return "runner_unavailable";
}

export function verificationOutcome(value = {}, {
  comparison = "not_comparable",
  evidence = null,
} = {}) {
  const type = comparison === "regressed" && value?.status === "timed_out"
    ? "product_failed"
    : comparison === "persistent" && value?.status === "failed"
      ? "baseline_debt" : outcomeType(value);
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

export function isAdvisoryTestResult(value, options = {}) {
  // A repository-declared required check remains an obligation even when its
  // environment is unavailable. Optional absence remains visible/advisory.
  if (value?.required === false && !["failed", "timed_out"].includes(value.status)) return true;
  if (value?.required === true && value.status !== "passed") return false;
  if ((value?.check_runs || []).some((child) => child.required === true && child.status !== "passed")) return false;
  // Undeclared unavailable harnesses retain the existing permissive policy.
  if (isUnrunnableTestResult(value)) return true;
  const children = value?.check_runs || value?.file_results || value?.results;
  if (Array.isArray(children) && children.some((child) => child.status === "failed" && !isUnrunnableTestResult(child))) return false;
  if (requiresTestVerification(options)) return false;
  const type = value?.verification_outcome?.type || verificationOutcome(value).type;
  return PERMISSIVE_TEST_OUTCOMES.includes(type);
}

export function isBlockingVerificationInfrastructureOutcome(value, options = {}) {
  return isVerificationInfrastructureOutcome(value) && !isAdvisoryTestResult(value, options);
}

export function verificationInfrastructureError(value, prefix = "Verification infrastructure unavailable") {
  const outcome = value?.verification_outcome || verificationOutcome(value);
  const error = new Error(`${prefix}: ${value?.reason || outcome.type}`);
  error.code = "POSSE_VERIFICATION_INFRASTRUCTURE";
  error.verification_outcome = outcome;
  error.rerun_command = String(value?.command || "").trim() || null;
  return error;
}
