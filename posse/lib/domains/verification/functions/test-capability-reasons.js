import { UNRUNNABLE_TEST_REASONS } from "../../../catalog/verification.js";

export function isUnrunnableTestReason(reason) {
  const value = String(reason || "");
  return UNRUNNABLE_TEST_REASONS.includes(value)
    || value.endsWith("dependency_unavailable")
    || value.startsWith("test_script_missing:")
    || value.startsWith("test_script_missing_in_workspace:")
    || value.startsWith("planner_test_selection_unresolved:");
}

