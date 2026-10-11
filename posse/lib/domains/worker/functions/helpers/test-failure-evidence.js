import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import {
  VOLATILE_CHECKOUT_DIR_PREFIXES,
  VOLATILE_CHECKOUT_SUBDIRS,
  VOLATILE_TEST_OUTPUT_PATTERNS,
} from "../../../../catalog/verification.js";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A disposable checkout under the system temporary directory, by its literal
// and its resolved path (macOS /var is /private/var), with either separator.
const TEMP_CHECKOUT_PATH = (() => {
  const roots = new Set([os.tmpdir()]);
  try { roots.add(fs.realpathSync(os.tmpdir())); } catch { /* the literal path still matches */ }
  const pattern = [...roots]
    .map((root) => root.replace(/[\\/]+$/u, "").split(/[\\/]/u).map(escapeRegExp).join("[\\\\/]"))
    .join("|");
  const prefixes = VOLATILE_CHECKOUT_DIR_PREFIXES.map(escapeRegExp).join("|");
  const subdirs = VOLATILE_CHECKOUT_SUBDIRS.map(escapeRegExp).join("|");
  return new RegExp(
    `(?:${pattern})[\\\\/](?:${prefixes})[A-Za-z0-9._-]+[\\\\/](?:(?:${subdirs})[\\\\/])?`,
    process.platform === "win32" ? "gi" : "g",
  );
})();

export function normalizeFailureFingerprintText(value) {
  let text = String(value || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\[REDACTED:[^\]]+\][\\/]/gi, "")
    .replace(/(?:[A-Za-z]:)?[^\s"'`()\[\]{}]*\.?posse-worktrees[\\/]wi-\d+[\\/]/gi, "")
    .replace(TEMP_CHECKOUT_PATH, "")
    .replace(/(\.(?:[cm]?[jt]sx?|php|py|rb|go|rs|java|cs|cpp|c|h)):\d+(?::\d+)?/gi, "$1:<line>")
    .replace(/(\.(?:[cm]?[jt]sx?|php|py|rb|go|rs|java|cs|cpp|c|h))\(\d+(?::\d+)?\)/gi, "$1(<line>)")
    .replace(/\bon line \d+\b/gi, "on line <line>");
  for (const [pattern, replacement] of VOLATILE_TEST_OUTPUT_PATTERNS) text = text.replace(pattern, replacement);
  return text.replace(/[ \t]+$/gm, "").trim();
}

// Parse only a complete, single Node spec report. Nested/suite failures and
// unfamiliar reporters fall back to full diagnostics, never a partial list.
export function nodeSpecFailureReport(output) {
  const text = String(output || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n");
  const counts = {};
  for (const key of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...text.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, "gm"))];
    if (matches.length !== 1) return null;
    counts[key] = Number(matches[0][1]);
  }
  if (counts.fail < 1 || counts.suites !== 0 || counts.cancelled !== 0
    || counts.tests !== counts.pass + counts.fail + counts.skipped + counts.todo) return null;
  const marker = "\n✖ failing tests:\n";
  if (text.split(marker).length !== 2) return null;
  const details = text.slice(text.indexOf(marker) + marker.length).trim();
  const headers = [...details.matchAll(/^test at ([^\n]+)\n✖ ([^\n]+) \(\d+(?:\.\d+)?ms\)\n/gm)];
  if (headers.length !== counts.fail || headers[0]?.index !== 0) return null;
  const failures = headers.map((header, index) => {
    const diagnostic = details.slice(header.index + header[0].length, headers[index + 1]?.index).trim();
    // A regex mismatch is identified by the assertion's expected pattern, not
    // by the entire input source that assert.match redundantly prints twice.
    // Scalar/deep equality and custom assertion messages retain their values.
    const message = /^(AssertionError \[ERR_ASSERTION\]: The input (?:did not match|was expected to not match) the regular expression .+\. Input:)\n/.exec(diagnostic);
    const regexAssertion = message
      && /^    generatedMessage: true,$/m.test(diagnostic)
      && /^    code: 'ERR_ASSERTION',$/m.test(diagnostic)
      && /^    expected: \/.*\/[a-z]*,$/m.test(diagnostic)
      && /^    operator: '(?:match|doesNotMatch)',$/m.test(diagnostic)
      && /\n  \}$/.test(diagnostic);
    return {
      location: normalizeFailureFingerprintText(header[1]),
      name: header[2],
      diagnostic: normalizeFailureFingerprintText(regexAssertion ? message[1] : diagnostic),
    };
  });
  if (headers.some((header, index) => {
    const diagnostic = details.slice(header.index + header[0].length, headers[index + 1]?.index).trim();
    return !/^AssertionError \[ERR_ASSERTION\]:/.test(diagnostic) || !/\n  \}$/.test(diagnostic);
  })) return null;
  return { counts, failures };
}

function phpUnitSummaryCounts(text) {
  const summaries = [...text.matchAll(/^Tests:\s*\d+(?:,\s*[A-Za-z][A-Za-z ]*:\s*\d+)*\.?\s*$/gm)];
  if (summaries.length !== 1) return null;
  const counts = {};
  for (const pair of summaries[0][0].replace(/\.\s*$/, "").split(/,\s*/)) {
    const match = /^([A-Za-z][A-Za-z ]*):\s*(\d+)$/.exec(pair);
    if (!match) return null;
    counts[match[1].trim().toLowerCase().replace(/\s+/g, "_")] = Number(match[2]);
  }
  if (!Number.isInteger(counts.tests)) return null;
  counts.errors ??= 0;
  counts.failures ??= 0;
  return { counts, index: summaries[0].index };
}

// Parse complete PHPUnit text reports into stable failure evidence. Timing,
// memory, progress glyphs, and stack locations are intentionally outside the
// report; the failing test identity and first diagnostic line remain material.
// If section counts disagree with the footer, callers fail closed to the full
// raw output rather than comparing a partial inventory.
export function phpUnitFailureReport(output) {
  const text = String(output || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n");
  if (!/^PHPUnit\s+\d+/m.test(text)) return null;
  const summary = phpUnitSummaryCounts(text);
  if (!summary || summary.counts.errors + summary.counts.failures < 1) return null;

  const sectionHeaders = [...text.matchAll(/^There (?:was|were) (\d+) (error|errors|failure|failures):\s*$/gm)];
  if (sectionHeaders.length < 1) return null;
  const failures = [];
  const sectionCounts = { error: 0, failure: 0 };
  for (let sectionIndex = 0; sectionIndex < sectionHeaders.length; sectionIndex += 1) {
    const section = sectionHeaders[sectionIndex];
    const kind = section[2].startsWith("error") ? "error" : "failure";
    const expected = Number(section[1]);
    const end = sectionHeaders[sectionIndex + 1]?.index ?? summary.index;
    if (end <= section.index) return null;
    const body = text.slice(section.index + section[0].length, end).trim();
    const cases = [...body.matchAll(/^(\d+)\) ([^\n]+)\s*$/gm)];
    if (cases.length !== expected || cases[0]?.index !== 0) return null;
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const header = cases[caseIndex];
      if (Number(header[1]) !== caseIndex + 1) return null;
      const diagnosticBody = body.slice(
        header.index + header[0].length,
        cases[caseIndex + 1]?.index,
      ).trim();
      const diagnostic = diagnosticBody.split("\n").find((line) => line.trim())?.trim();
      if (!diagnostic) return null;
      failures.push({
        kind,
        name: header[2].trim(),
        diagnostic: normalizeFailureFingerprintText(diagnostic),
      });
    }
    sectionCounts[kind] += cases.length;
  }
  if (sectionCounts.error !== summary.counts.errors
    || sectionCounts.failure !== summary.counts.failures) return null;
  return { framework: "phpunit", counts: summary.counts, failures };
}

function structuredFailureReport(output) {
  return nodeSpecFailureReport(output) || phpUnitFailureReport(output);
}

function looksLikeStructuredTestReport(output) {
  const text = String(output || "");
  return /ℹ (?:tests|fail) \d+|✖ failing tests:/.test(text)
    || (/^PHPUnit\s+\d+/m.test(text) && /^(?:There (?:was|were) \d+ (?:errors?|failures?):|Tests:\s*\d+)/m.test(text));
}

export function testFailureFingerprint(result = {}) {
  if (result.status === "passed") return null;
  const report = result.stdout_truncated || result.stderr_truncated
    ? null : structuredFailureReport(result.stdout);
  return createHash("sha256").update(JSON.stringify([
    result.status,
    result.code ?? result.exit_code ?? "unknown",
    result.signal ?? null,
    report || normalizeFailureFingerprintText(result.stdout),
    normalizeFailureFingerprintText(result.stderr),
  ])).digest("hex");
}

/**
 * One check's failure identity, or null when the check passed or its output
 * cannot be compared (truncated, or a structured report that did not parse).
 */
export function checkRunFailureFingerprint(run = {}) {
  if (!run || run.status === "passed" || run.stdout_truncated || run.stderr_truncated) return null;
  if (looksLikeStructuredTestReport(run.stdout) && !structuredFailureReport(run.stdout)) return null;
  return testFailureFingerprint(run);
}

/**
 * A multi-check receipt's failure identity: its non-passed checks' own
 * identities, by check. Output from a passing check (a linter's timing, a
 * package manager's "Done in") never decides whether a failure persisted.
 * Undefined for a receipt that predates per-check identities; null when a
 * non-passed check cannot be compared.
 */
export function checkRunsFailureFingerprint(checkRuns) {
  if (!Array.isArray(checkRuns) || !checkRuns.some((run) => run && Object.hasOwn(run, "failure_fingerprint"))) return undefined;
  const pairs = [];
  for (const run of checkRuns) {
    if (run?.status === "passed") continue;
    if (!run?.failure_fingerprint) return null;
    pairs.push([String(run.check_id || run.command || ""), run.failure_fingerprint]);
  }
  if (pairs.length === 0) return null;
  pairs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(["check_runs_v1", pairs])).digest("hex");
}

export function comparableTestFailureFingerprint(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const byCheck = checkRunsFailureFingerprint(receipt.check_runs);
  if (byCheck !== undefined) return byCheck;
  if (receipt.stdout_truncated || receipt.stderr_truncated) return null;
  // Recompute old receipts from immutable evidence; do not rewrite artifacts
  // or compare an old raw-output hash against a new structured hash.
  if (typeof receipt.stdout === "string" && typeof receipt.stderr === "string"
    && (receipt.stdout || receipt.stderr) && Number.isInteger(receipt.exit_code)) {
    if (looksLikeStructuredTestReport(receipt.stdout)
      && !structuredFailureReport(receipt.stdout)) return null;
    return testFailureFingerprint(receipt);
  }
  return receipt.failure_fingerprint || null;
}

function coversBaselineCases(postCounts, baselineCounts) {
  const post = Number(postCounts?.total);
  const baseline = Number(baselineCounts?.total);
  return Number.isFinite(post) && post > 0 && Number.isFinite(baseline) && post >= baseline;
}

/**
 * Whether a failure that predates the change still ran what it ran before:
 * both runs failed the same way, and the run after the change reported at
 * least as many cases as before, and more than none. A runner that stops at
 * its first failure, or output without a case count, establishes nothing.
 */
export function debtCoverageEstablished(post, baselineCheck) {
  if (post?.status !== "failed" || baselineCheck?.status !== "failed") return false;
  const identity = comparableTestFailureFingerprint(post);
  return !!identity
    && identity === comparableTestFailureFingerprint(baselineCheck)
    && coversBaselineCases(post.test_counts, baselineCheck.test_counts);
}

/**
 * The same, for a single-check receipt whose debt was attributed by rerunning
 * on the lineage base: with the change's scope removed (one declared run), or
 * file by file (changed test files as the plan).
 */
export function attributedDebtCoverageEstablished(post) {
  const attribution = post?.baseline_attribution;
  if (post?.status !== "failed" || attribution?.debt_only !== true) return false;
  if (Array.isArray(attribution.files)) {
    return attribution.files.length > 0 && attribution.files.every((file) => file.delta === "persistent_failure"
      && coversBaselineCases(file.test_counts, file.baseline_test_counts));
  }
  return debtCoverageEstablished(post, {
    status: attribution.baseline_status,
    test_counts: attribution.baseline_test_counts,
    failure_fingerprint: attribution.baseline_failure_fingerprint,
  });
}

export function renderTestFailureSummary(receipt) {
  if (!receipt || receipt.stdout_truncated || receipt.stderr_truncated) return "";
  const report = structuredFailureReport(receipt.stdout);
  if (!report) return "";
  const { counts, failures } = report;
  const phpUnit = report.framework === "phpunit";
  const failed = phpUnit ? counts.errors + counts.failures : counts.fail;
  const passed = phpUnit
    ? Math.max(0, counts.tests - failed - (counts.skipped || 0) - (counts.incomplete || 0) - (counts.risky || 0))
    : counts.pass;
  const lines = [phpUnit
    ? `tests: ${counts.tests}; passed: ${passed}; errors: ${counts.errors}; failures: ${counts.failures}; skipped: ${counts.skipped || 0}`
    : `tests: ${counts.tests}; passed: ${passed}; failed: ${failed}; skipped: ${counts.skipped}; todo: ${counts.todo}`];
  let omitted = 0;
  for (const failure of failures) {
    const diagnostic = failure.diagnostic.split("\n")[0];
    const line = phpUnit
      ? `- ${failure.name} [${failure.kind}]: ${diagnostic}`
      : `- ${failure.name} (${failure.location}): ${diagnostic}`;
    // Reserve space for an explicit omission notice, never silently lose a
    // failure behind the bounded source dump at the end of the runner output.
    if (lines.join("\n").length + line.length > 3000) { omitted += 1; continue; }
    lines.push(line);
  }
  if (omitted) lines.push(`[${omitted} failure detail(s) omitted; full output remains in the test artifact]`);
  return lines.join("\n");
}

// Keep the command and parsed failure names beside bounded diagnostic excerpts.
// The full output remains in the test receipt; truncation never rejects a run.
export function testRunDiagnostics(run) {
  if (!run) return null;
  const excerpt = (value) => {
    const text = String(value || "");
    return text.length > 8000 ? `${text.slice(0, 4000)}\n… output truncated …\n${text.slice(-4000)}` : text;
  };
  return {
    command: run.command || null,
    status: run.status || null,
    reason: run.reason || null,
    ...(Array.isArray(run.check_runs) ? { check_runs: run.check_runs } : {}),
    failure_summary: renderTestFailureSummary(run) || null,
    stdout: excerpt(run.stdout),
    stderr: excerpt(run.stderr),
  };
}

export function repairInstructions(verdict, instructions = null) {
  const evidence = verdict?._deterministic_evidence;
  return [...new Set([
    instructions,
    ...(verdict?.reasons || []),
    evidence?.failure_summary,
    evidence?.output_tail,
  ].filter(Boolean))].join("\n\n");
}
