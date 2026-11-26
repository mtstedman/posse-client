import { TEST_FILE_INVOKED_COVERAGE_STATUS } from "./verification.js";
// Public, additive outcome vocabulary. Execution success is not verification.
export const WORK_ITEM_OUTCOME_VERSION = 1;
export const OUTCOME_EXECUTION = Object.freeze({ COMPLETE: "complete", ACTIVE: "active", BLOCKED: "blocked", FAILED: "failed", CANCELED: "canceled", UNKNOWN: "unknown" });
export const OUTCOME_VERIFICATION = Object.freeze({ CHECKS_PASSED: "checks_passed", INCOMPLETE: "incomplete", FAILED: "failed", REVIEW_ONLY: "review_only", UNKNOWN: "unknown" });
export const OUTCOME_VERIFIED_COVERAGE = Object.freeze(["reported_executed", TEST_FILE_INVOKED_COVERAGE_STATUS, "not_applicable"]);
export const OUTCOME_DEPLOYMENT = Object.freeze({ VERIFIED: "verified", INCLUDED: "included_in_deployment", UNVERIFIED: "unverified" });

// Read-side guidance only; these are destinations, never mutation authority.
export const OUTCOME_DESTINATIONS = Object.freeze({ REVIEW: "review", BUDGET: "budget", ACCEPTANCE: "acceptance", STATUS: "status" });
