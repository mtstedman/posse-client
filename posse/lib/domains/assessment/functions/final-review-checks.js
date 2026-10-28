// Deterministic evidence final_review gathers beyond the planner's declared
// tests: the changed-file lint/typecheck the assessment harness runs after
// handoff, and the unit test files the change itself adds or edits. Both run
// on the uncommitted workspace before the reviewer starts, so a failure the
// assessor would find reaches the developer while it can still fix it in the
// same attempt. Live 2026-10-09: final_review passed a change whose typecheck
// failed in the changed file, and twice passed a change whose own new test
// failed; both surfaced only at assessment and cost a fix job each. Only a
// failure attributable to the change in process (an added line, an added
// test file) is returned without the reviewer: debt in an untouched line or a
// pre-existing test is the reviewer's evidence, never a finding by itself.

import fs from "node:fs";
import path from "node:path";
import { runScopedChecks } from "../../../shared/tools/functions/toolkit/scoped-runners.js";
import { discoverUnitTestCapability } from "../../../shared/tools/functions/toolkit/unit-test-runner.js";
import {
  changedUnitTestPlan,
  lineageBaseCommit,
  lineageChangedTestPaths,
} from "../../worker/functions/helpers/test-execution-receipt.js";
import {
  FINAL_REVIEW_CHECKS,
  FINAL_REVIEW_CHECK_ATTRIBUTION_LABELS,
  FINAL_REVIEW_CHECK_MAX_FILES,
  FINAL_REVIEW_MAX_FINDINGS,
  FINAL_REVIEW_OUTCOMES,
  FINAL_REVIEW_PROVEN_TEST_STATUSES,
  FINAL_REVIEW_SHARED_TEST_RUNNERS,
  FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS,
} from "../../../catalog/final-review.js";

// A located diagnostic line: `path(line,col): ...` (tsc) or `path:line:col ...`.
const LOCATED_LINE = /^\s*([^\s():]+\.[A-Za-z0-9]+)(?:\((\d+)|:(\d+))/u;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/** Changed files that still exist; a deletion has nothing to lint or run. */
function existingChangedFiles(cwd, change) {
  return (Array.isArray(change?.files) ? change.files : [])
    .map((file) => String(file?.path || ""))
    .filter((file) => file && fs.existsSync(path.join(cwd, file)));
}

/**
 * Unit test plan for test files the change adds or edits that the declared
 * plan does not already run, or null when there are none. Only files the
 * repository's unit-test runner recognizes resolve. `lineagePaths` are the
 * test files changed since the lineage base (lineageTestFiles): a fix runs
 * the tests its root committed, as its post-change receipt does, even when
 * the fix leaves them untouched.
 */
export function changedTestPlan(job, payload, change, declaredPlan, {
  cwd,
  lineagePaths = [],
} = {}) {
  if (!cwd || !["dev", "fix"].includes(String(job?.job_type || ""))
    || String(payload?.task_mode || "code") !== "code") return null;
  const declared = new Set([
    ...(Array.isArray(declaredPlan?.unit_test_paths) ? declaredPlan.unit_test_paths : []),
    ...(Array.isArray(declaredPlan?.covered_unit_test_paths) ? declaredPlan.covered_unit_test_paths : []),
  ]);
  const lineage = (Array.isArray(lineagePaths) ? lineagePaths : [])
    .filter((file) => file && fs.existsSync(path.join(cwd, file)));
  const capability = discoverUnitTestCapability({ projectDir: cwd });
  if (!capability.available) return null;
  const discovered = new Set(capability.files);
  const candidates = [...new Set([...existingChangedFiles(cwd, change), ...lineage])]
    .filter((file) => discovered.has(file) && !declared.has(file));
  if (candidates.length === 0) return null;
  // The changed files run alone: the declared plan already carries the
  // repository's registered checks. The lineage base stays on the plan so a
  // failing file can be told apart from one the base tree did not have.
  let base = null;
  try { base = lineageBaseCommit(job, payload) || null; } catch { base = null; }
  return changedUnitTestPlan(candidates, { cwd, capability, base });
}

/**
 * Test files changed since the job's lineage base, diffed against the working
 * tree, committed or not: the files the post-change receipt will run, and
 * those of them absent at the base when the lineage diff reports it. Empty
 * when the lineage cannot be read; the review never waits on it.
 *
 * @returns {Promise<{ paths: string[], addedPaths: string[] }>}
 */
export async function lineageTestFiles(job, payload, cwd) {
  try {
    const lineage = await lineageChangedTestPaths({ job, payload, cwd });
    return {
      paths: Array.isArray(lineage?.paths) ? lineage.paths : [],
      addedPaths: Array.isArray(lineage?.addedPaths) ? lineage.addedPaths : [],
    };
  } catch {
    return { paths: [], addedPaths: [] };
  }
}

/**
 * The lines the scoped change added, per file, read from its diff in
 * process. A file the diff creates counts every line, including an untracked
 * file whose diff is synthesized without hunks.
 *
 * @returns {Map<string, Set<number> | true>} true: the whole file is added
 */
export function addedLinesByFile(diff) {
  const added = new Map();
  let file = null;
  let header = false;
  let created = false;
  let next = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      header = true;
      created = false;
      continue;
    }
    if (header && line.startsWith("--- ")) {
      created = line === "--- /dev/null";
      continue;
    }
    if (header && line.startsWith("+++ ")) {
      header = false;
      file = line === "+++ /dev/null" ? null : line.slice(4).replace(/^b\//u, "");
      if (file) added.set(file, created ? true : added.get(file) || new Set());
      continue;
    }
    const lines = file ? added.get(file) : null;
    if (!(lines instanceof Set)) continue;
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) next = Number(hunk[1]);
    else if (line.startsWith("+")) lines.add(next++);
    else if (line.startsWith(" ")) next += 1;
  }
  return added;
}

/**
 * Test files absent at the lineage base, as far as the review can tell in
 * process: those the lineage diff reports added, and those the scoped change
 * creates outright, every line of which is the change's own.
 */
export function addedTestFiles(change, lineage = null) {
  const created = [...addedLinesByFile(change?.diff)].filter(([, lines]) => lines === true).map(([file]) => file);
  return [...new Set([...(Array.isArray(lineage?.addedPaths) ? lineage.addedPaths : []), ...created])];
}

function locatedLine(line) {
  const match = LOCATED_LINE.exec(line);
  return match ? {
    file: match[1].replace(/\\/gu, "/").replace(/^\.\//u, ""),
    line: Number(match[2] || match[3]),
  } : null;
}

// A package-root check prints paths relative to that root (`src/a.ts` for
// the changed `apps/web/src/a.ts`), so a suffix on a path boundary matches.
function namesChangedFile(file, changed) {
  return changed.some((candidate) => candidate === file || candidate.endsWith(`/${file}`));
}

/**
 * Split check failures by attribution. `introduced`: located on a line the
 * change added, a defect of this change. `inChanged`: in a changed file but
 * not on an added line, which may be debt the change never touched.
 * `elsewhere`: outside the changed files, which may predate the change or be
 * a caller it broke. Only `introduced` becomes a finding by itself; the rest
 * is shown to the reviewer.
 */
function splitFailures(failures, changed, added = new Map()) {
  const introduced = [];
  const inChanged = [];
  const elsewhere = [];
  const changedFilesNamed = (names) => changed.filter((file) => names.some((name) => namesChangedFile(name, [file])));
  // An ambiguous package-relative path is attributed only when the line is
  // added in every changed file it may name.
  const onAddedLine = (name, line) => {
    const files = changedFilesNamed([name]);
    return files.length > 0 && files.every((file) => {
      const lines = added.get(file);
      return lines === true || (lines instanceof Set && Number.isSafeInteger(line) && lines.has(line));
    });
  };
  for (const failure of Array.isArray(failures) ? failures : []) {
    const check = failure?.check || "check";
    const message = String(failure?.message || "").trim();
    if (failure?.file) {
      const file = String(failure.file);
      const text = `${file}: ${message}`;
      if (!namesChangedFile(file, changed)) {
        elsewhere.push({ check, text, files: [] });
        continue;
      }
      const line = Number(failure.line) || message.split("\n").map(locatedLine).find(Boolean)?.line || null;
      (onAddedLine(file, line) ? introduced : inChanged).push({ check, text, files: changedFilesNamed([file]) });
      continue;
    }
    const lines = message.split("\n").filter((line) => line.trim());
    const located = lines.map((text) => ({ text, at: locatedLine(text) })).filter((entry) => entry.at);
    const hits = located.filter((entry) => namesChangedFile(entry.at.file, changed));
    const proven = hits.filter((entry) => onAddedLine(entry.at.file, entry.at.line));
    const unattributed = hits.filter((entry) => !proven.includes(entry));
    for (const [bucket, entries] of [[introduced, proven], [inChanged, unattributed]]) {
      if (entries.length > 0) {
        bucket.push({ check, text: entries.map((entry) => entry.text).join("\n"),
          files: changedFilesNamed(entries.map((entry) => entry.at.file)) });
      }
    }
    const rest = located.filter((entry) => !hits.includes(entry));
    if (rest.length > 0) elsewhere.push({ check, text: rest.map((entry) => entry.text).join("\n"), files: [] });
    else if (located.length === 0) elsewhere.push({ check, text: lines.join("\n"), files: [] });
  }
  return { introduced, inChanged, elsewhere };
}

/**
 * The assessment harness's changed-file lint/typecheck, run on the current
 * workspace. Null when no changed file exists to check.
 */
export function runChangedFileChecks(cwd, change, { runChecks = runScopedChecks, checkKinds = FINAL_REVIEW_CHECKS } = {}) {
  if (!cwd) return null;
  const files = existingChangedFiles(cwd, change).slice(0, FINAL_REVIEW_CHECK_MAX_FILES);
  if (files.length === 0) return null;
  let result;
  try {
    result = runChecks({ cwd, args: { checks: [...checkKinds], scope: { files } } });
  } catch (error) {
    return {
      status: "unavailable",
      summary: `changed-file checks could not run (${String(error?.message || error).slice(0, 200)})`,
      files,
      introduced: [],
      inChanged: [],
      elsewhere: [],
    };
  }
  const { introduced, inChanged, elsewhere } = result?.status === "failed"
    ? splitFailures(result.failures, files, addedLinesByFile(change?.diff))
    : { introduced: [], inChanged: [], elsewhere: [] };
  return {
    status: String(result?.status || "unavailable"),
    summary: String(result?.summary || ""),
    files,
    introduced,
    inChanged,
    elsewhere,
  };
}

function tail(text, max) {
  const value = String(text || "");
  return value.length <= max ? value : `…${value.slice(value.length - max)}`;
}

/** The reviewer's view of the changed-file checks; null when none ran. */
export function renderChangedFileChecks(checks) {
  if (!checks) return null;
  const implicit = (checks.implicit_typechecks || []).map(check => `Required typecheck: ${check.command}: ${check.status}\n${check.output}`).join("\n");
  const head = implicit + `\nCHANGED-FILE CHECKS (${FINAL_REVIEW_CHECKS.join(", ")} on ${checks.files.length} changed file(s)): ${checks.status.toUpperCase()}${checks.summary ? `, ${checks.summary}` : ""}.`;
  if (checks.status !== "failed") return head;
  const block = (entries) => `\`\`\`text\n${tail(entries.map((entry) => `[${entry.check}] ${entry.text}`).join("\n"), FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS)}\n\`\`\``;
  return [
    head,
    ...["introduced", "inChanged", "elsewhere"].flatMap((attribution) => {
      const entries = Array.isArray(checks[attribution]) ? checks[attribution] : [];
      return entries.length > 0 ? [FINAL_REVIEW_CHECK_ATTRIBUTION_LABELS[attribution], block(entries)] : [];
    }),
  ].join("\n");
}

/**
 * Findings the deterministic evidence proves on its own, attributed in
 * process: a check failure on a line the change added, and a failing
 * test file the change added (`addedTestPaths`, addedTestFiles)
 * that its runner ran on its own. They stand even when the reviewer passes
 * the change. A timeout alone does not prove a product defect. A failure in
 * an edited, pre-existing test or elsewhere in a
 * changed file may predate the change, so the reviewer judges it instead.
 */
export function finalReviewCheckFindings({ checks = null, changedTestRun = null, addedTestPaths = [] } = {}) {
  const findings = (checks?.implicit_typechecks || []).filter(check => check.status === "failed").map(check => ({
    severity: "high", criterion: `Required typecheck fails (${check.command}):\n${check.output}`.slice(0, 1000),
  }));
  const byCheck = new Map();
  for (const entry of checks?.introduced || []) {
    const prior = byCheck.get(entry.check) || { texts: [], files: [] };
    byCheck.set(entry.check, { texts: [...prior.texts, entry.text], files: [...prior.files, ...entry.files] });
  }
  for (const [check, { texts, files }] of byCheck) {
    const paths = [...new Set(files)].slice(0, 8);
    findings.push({
      severity: "high",
      criterion: `${check} fails on lines this change added:\n${texts.join("\n")}`.slice(0, 1000),
      ...(paths.length > 0 ? { paths } : {}),
    });
  }
  const added = new Set(Array.isArray(addedTestPaths) ? addedTestPaths : []);
  const proven = (Array.isArray(changedTestRun?.file_results) ? changedTestRun.file_results : [])
    .filter((result) => added.has(result?.path)
      && FINAL_REVIEW_PROVEN_TEST_STATUSES.includes(result.status)
      && result.reused !== true
      && !FINAL_REVIEW_SHARED_TEST_RUNNERS.includes(result.runner));
  if (proven.length > 0) {
    const paths = [...new Set(proven.map((result) => result.path))];
    findings.push({
      severity: "high",
      criterion: `Test files this change added fail: ${proven.map((result) => `${result.path} (${result.status})`).join(", ")}\n${failureExcerpt({
        stderr: proven.map((result) => result.stderr).filter(Boolean).join("\n"),
        stdout: proven.map((result) => `[${result.path}] ${result.status}\n${String(result.stdout || "")}`.trim()).join("\n\n"),
      })}`.slice(0, 1000),
      paths: paths.slice(0, 8),
    });
  }
  return findings;
}

function failureExcerpt(run) {
  const output = [run.failure_summary, run.stderr, run.stdout].filter(Boolean).join("\n");
  // Exceptions precede child-process Buffer dumps and runner summaries. Keep
  // the beginning as well as the end so the repair instruction retains them.
  return output.length <= 800 ? output : `${output.slice(0, 550)}\n…\n${output.slice(-240)}`;
}

/**
 * Add the deterministic findings to the reviewer's result. A pass or a
 * blocked review with a proven failure becomes findings: the developer fixes
 * it now instead of handing off a change the assessment will fail.
 */
export function mergeCheckFindings(result, checkFindings = []) {
  if (!result || checkFindings.length === 0) return result;
  if (result.outcome === FINAL_REVIEW_OUTCOMES.FINDINGS) {
    return { ...result, findings: [...(result.findings || []), ...checkFindings].slice(0, FINAL_REVIEW_MAX_FINDINGS) };
  }
  return {
    outcome: FINAL_REVIEW_OUTCOMES.FINDINGS,
    findings: checkFindings.slice(0, FINAL_REVIEW_MAX_FINDINGS),
  };
}
