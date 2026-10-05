// Project a run_unit_test result into its tool observation: what ran, what it
// proved, at which commit, and enough of the failure output to act on. The
// generic tool error field is cut at 200 characters and the serialized result
// puts stdout last, so without this the failure message never reached the log.

const MAX_OUTPUT_EXCERPT_CHARS = 4000;
const UNIT_TEST_OUTCOMES = new Set(["passed", "product_failed", "infrastructure_error", "unavailable", "timed_out"]);

function parseResult(resultText) {
  if (typeof resultText !== "string" || !resultText.trimStart().startsWith("{")) return null;
  try {
    const value = JSON.parse(resultText);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
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
  const excerpt = payload.outcome === "passed" ? null : output.slice(-MAX_OUTPUT_EXCERPT_CHARS) || null;
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
