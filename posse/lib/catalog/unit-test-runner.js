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
