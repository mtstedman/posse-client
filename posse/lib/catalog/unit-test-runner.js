// @ts-check
import { WORKSPACE_TRAVERSAL_PROFILES } from "./workspace-traversal.js";
import { readonlySet } from "./readonly-collections.js";

import { TEST_HELPER_DIRECTORIES } from "./verification.js";

export const SKIP_DIRS = WORKSPACE_TRAVERSAL_PROFILES.unit_tests;

export const TEST_HELPER_DIRS = readonlySet(TEST_HELPER_DIRECTORIES);

export const MAX_OUTPUT_CHARS = 128 * 1024;

export const MAX_SOURCE_SNIFF_BYTES = 256 * 1024;

export const DEFAULT_TIMEOUT_MS = 120_000;

export const PHPUNIT_CONFIG_NAMES = Object.freeze(["phpunit.xml", "phpunit.xml.dist", "phpunit.dist.xml"]);

// Outcome -> legacy wire status. `ok` stays true only for a real pass, false
// for a real product failure or timeout, and null when nothing was verified.
export const OUTCOME_STATUS = Object.freeze({
  passed: "passed",
  product_failed: "failed",
  timed_out: "timed_out",
  infrastructure_error: "infrastructure_error",
  unavailable: "unavailable",
});

export const UNIT_TEST_OUTCOMES = readonlySet(Object.keys(OUTCOME_STATUS));

// Observation outcomes describe execution; the wire status above retains the
// verifier's specific result. An unavailable test did not execute.
export const OUTCOME_TOOL_OBSERVATION = Object.freeze({
  passed: "succeeded",
  product_failed: "failed",
  timed_out: "failed",
  infrastructure_error: "failed",
  unavailable: "rejected",
});

// Framework imports are authoritative for mixed JS/TS repositories. Unsupported
// frameworks stay discoverable and require an explicit repository runner.
export const JAVASCRIPT_TEST_FRAMEWORK_IMPORTS = Object.freeze({
  "node:test": "node:test", vitest: "vitest", "@jest/globals": "jest",
  mocha: "mocha", ava: "ava", "@playwright/test": "playwright", "bun:test": "bun",
});
export const VITEST_SELECTION_OPTIONS = Object.freeze({
  "--config": true, "-c": true, "--environment": true, "--pool": true,
  "--globals": false, "--no-globals": false, "--isolate": false, "--no-isolate": false,
});
