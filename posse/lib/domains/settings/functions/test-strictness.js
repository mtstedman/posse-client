import { DEFAULT_TEST_STRICTNESS, TEST_STRICTNESS } from "../../../catalog/verification.js";
import { getSetting } from "./repository-settings.js";

export function getTestStrictness({ projectDir = null, readSetting = getSetting } = {}) {
  const value = readSetting("test_strictness", { projectDir });
  return value === TEST_STRICTNESS.STRICT ? TEST_STRICTNESS.STRICT : DEFAULT_TEST_STRICTNESS;
}

export function requiresTestVerification(options = {}) {
  return getTestStrictness(options) === TEST_STRICTNESS.STRICT;
}

export function renderTestStrictness(options = {}) {
  return requiresTestVerification(options)
    ? "Repository test strictness: strict. Missing test execution requires verification recovery. Unknown case counts alone do not invalidate a successful run."
    : "Repository test strictness: permissive. Missing, unavailable, unconfigured, or zero tests and unknown coverage are advisory, not reasons to fail, replan, lower confidence, or request human review. Judge the implementation using the available evidence. Actual test failures and demonstrated product defects remain actionable.";
}
