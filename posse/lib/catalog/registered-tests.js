// The DB-backed registered-test experiment is retained for later completion,
// but is not an agent-facing capability while its discovery/custody contract
// is unfinished. Repository-declared frozen test commands and scoped checks
// are separate production features and remain enabled.
export const REGISTERED_TEST_FEATURE_STATE = "deferred_unfinished";
export const REGISTERED_TEST_AGENT_SURFACE_ENABLED = false;
export const REGISTERED_TEST_TOOL_NAMES = Object.freeze([
  "create_test_suite",
  "create_test",
  "run_test",
  "run_test_suite",
]);
