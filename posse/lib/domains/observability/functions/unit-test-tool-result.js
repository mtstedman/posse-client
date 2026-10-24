import { parseResult } from "./tool-result-object.js";
import { UNIT_TEST_OUTCOMES } from "../../../catalog/unit-test-runner.js";
import "../../../shared/tools/functions/ref-surface.js";
// Project a run_unit_test result into its tool observation: what ran, what it
// proved, at which commit, and enough of the failure output to act on. The
// generic tool error field is cut at 200 characters and the serialized result
// puts stdout last, so without this the failure message never reached the log.

const MAX_OUTPUT_EXCERPT_CHARS = 4000;

// Runners print the failing case and its assertion where the failure happens
// and a summary at the end; a verbose passing-test listing in between can push
// the failure out of a plain tail. The excerpt starts at the first failure
// marker when one exists and still ends with the tail, so the observation
// carries what failed and how the run finished.
const FAILURE_MARKER_RE = /^.*(?:\bFAIL(?:ED|URES?)?\b|\bERRORS?\b|✗|✕|×|●|\bnot ok\b|\bAssertion(?:Error|FailedError)\b|\bError:|\bexpected\b|\bFatal error\b).*$/im;
const FAILURE_LEAD_MIN_CHARS = 1200;

function failureFocusedExcerpt(output) {
  if (output.length <= MAX_OUTPUT_EXCERPT_CHARS) return output;
  const match = FAILURE_MARKER_RE.exec(output);
  const tailStart = output.length - MAX_OUTPUT_EXCERPT_CHARS;
  if (!match || match.index >= tailStart) return output.slice(-MAX_OUTPUT_EXCERPT_CHARS);
  const lead = output.slice(match.index, match.index + Math.max(FAILURE_LEAD_MIN_CHARS, Math.floor(MAX_OUTPUT_EXCERPT_CHARS / 2)));
  const tail = output.slice(-(MAX_OUTPUT_EXCERPT_CHARS - lead.length - 1));
  // The tail may begin inside the lead when the two windows overlap; then the
  // lead already runs to the end and the tail adds nothing.
  if (match.index + lead.length >= output.length - tail.length) {
    return output.slice(match.index, match.index + MAX_OUTPUT_EXCERPT_CHARS);
  }
  return `${lead}\n…\n${tail}`.slice(0, MAX_OUTPUT_EXCERPT_CHARS + 3);
}

function nonNegativeIntegerOrNull(value) {
  const number = Number(value);
  return value != null && Number.isInteger(number) && number >= 0 ? number : null;
}

export function unitTestToolResultObservation({ tool, resultText = "" } = {}) {
  const name = String(tool || "").trim().toLowerCase().replace(/^tools[._-]/, "");
  if (name !== "run_unit_test") return null;
  const payload = parseResult(resultText);
  if (!payload || !UNIT_TEST_OUTCOMES.has(payload.outcome)) return null;
  const testPath = String(payload.path || "").slice(0, 500);
  const output = [payload.stderr, payload.stdout]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
  const excerpt = payload.outcome === "passed" ? null : failureFocusedExcerpt(output) || null;
  const exitCode = Number.isInteger(payload.exit_code) ? payload.exit_code : null;
  const executedCommitHash = /^[0-9a-f]{40,64}$/i.test(String(payload.executed_commit_hash || ""))
    ? String(payload.executed_commit_hash).toLowerCase()
    : null;
  const label = `${payload.outcome}${payload.reason ? ` (${payload.reason})` : ""}${exitCode != null ? `, exit ${exitCode}` : ""}`;
  return {
    summary: `UnitTest: ${testPath} — ${label}`,
    error: payload.outcome === "passed" ? null : label,
    detail: {
      path: testPath,
      language: payload.language ? String(payload.language).slice(0, 40) : null,
      runner: payload.runner ? String(payload.runner).slice(0, 40) : null,
      outcome: payload.outcome,
      reason: payload.reason ? String(payload.reason).slice(0, 120) : null,
      exit_code: exitCode,
      test_counts: payload.test_counts && typeof payload.test_counts === "object" ? {
        total: nonNegativeIntegerOrNull(payload.test_counts.total),
        skipped: nonNegativeIntegerOrNull(payload.test_counts.skipped),
      } : null,
      executed_commit_hash: executedCommitHash,
      output_excerpt: excerpt,
      output_truncated: payload.stdout_truncated === true || payload.stderr_truncated === true
        || output.length > MAX_OUTPUT_EXCERPT_CHARS,
    },
  };
}
