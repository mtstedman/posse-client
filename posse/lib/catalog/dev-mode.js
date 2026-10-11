// Canonical dev/fix execution modes and their planner/developer policy.

export const DEFAULT_DEV_MODE = "feature_impl";
export const DEFAULT_FIX_DEV_MODE = "bug_fix";

export const DEV_MODE_ORDER = [
  "feature_impl",
  "bug_fix",
  "defensive_change",
  "refactor",
  "cleanup",
  "hotfix",
];

export const DEV_MODE_DEFINITIONS = {
  feature_impl: {
    label: "Feature Implementation",
    plannerUse: "New scoped behavior or capability where normal implementation and verification are expected.",
    developerRules: [
      "Implement the planned behavior within the declared writable scope.",
      "Follow existing project patterns before adding new abstractions.",
      "Add focused tests or verification when the change affects behavior.",
    ],
  },
  bug_fix: {
    label: "Bug Fix",
    plannerUse: "Incorrect, failing, or regressed behavior where the task should isolate and fix the defect.",
    developerRules: [
      "Identify the broken behavior before editing when practical.",
      "Make the smallest behavior-preserving fix that addresses the defect.",
      "Add or update a regression test when the repo has an applicable test path.",
    ],
  },
  defensive_change: {
    label: "Defensive Change",
    plannerUse: "Safety-sensitive work such as data loss, git state, concurrency, destructive operations, auth, or persistence boundaries.",
    developerRules: [
      "Bias toward preserving existing behavior and preventing data loss.",
      "Handle edge cases and failure paths explicitly instead of assuming happy-path state.",
      "Prefer narrow, auditable changes with verification around the risk boundary.",
    ],
  },
  refactor: {
    label: "Refactor",
    plannerUse: "Behavior-preserving structure change, simplification, or deduplication.",
    developerRules: [
      "Preserve observable behavior; do not add product behavior unless explicitly requested.",
      "Keep the refactor scoped to the named files and established local patterns.",
      "Verify with tests or focused checks that behavior still matches before and after.",
    ],
  },
  cleanup: {
    label: "Cleanup",
    plannerUse: "Mechanical cleanup, dead code removal, formatting, small naming, or low-risk maintenance.",
    developerRules: [
      "Keep the diff mechanical and low-churn.",
      "Avoid opportunistic rewrites or behavior changes.",
      "Run the smallest useful verification for the touched surface.",
    ],
  },
  hotfix: {
    label: "Hotfix",
    plannerUse: "Urgent minimal patch where reducing blast radius is more important than completeness.",
    developerRules: [
      "Make the smallest safe patch that resolves the immediate problem.",
      "Avoid broad refactors, opportunistic cleanup, or nonessential polish.",
      "Run targeted verification that the immediate failure is addressed.",
    ],
  },
};

export const DEV_MODE_ALIASES = {
  feature: "feature_impl",
  feature_implementation: "feature_impl",
  implementation: "feature_impl",
  implement: "feature_impl",
  bug: "bug_fix",
  bugfix: "bug_fix",
  fix: "bug_fix",
  defensive: "defensive_change",
  safety: "defensive_change",
  safe: "defensive_change",
  merge_safety: "defensive_change",
  refactoring: "refactor",
  cleanup: "cleanup",
  clean_up: "cleanup",
  mechanical: "cleanup",
  urgent: "hotfix",
  hot_fix: "hotfix",
};
