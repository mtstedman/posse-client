import { createHash } from "node:crypto";

export function normalizeFailureFingerprintText(value) {
  return String(value || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\.(?:[cm]?[jt]sx?|php|py|rb|go|rs|java|cs|cpp|c|h)):\d+(?::\d+)?/gi, "$1:<line>")
    .replace(/(\.(?:[cm]?[jt]sx?|php|py|rb|go|rs|java|cs|cpp|c|h))\(\d+(?::\d+)?\)/gi, "$1(<line>)")
    .replace(/\bon line \d+\b/gi, "on line <line>")
    .replace(/^([✔✖▶].*) \(\d+(?:\.\d+)?ms\)$/gm, "$1 (<duration>)")
    .replace(/^((?:ℹ|#) duration_ms) \d+(?:\.\d+)?$/gm, "$1 <duration>")
    .replace(/[ \t]+$/gm, "")
    .trim();
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

export function comparableTestFailureFingerprint(receipt) {
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
