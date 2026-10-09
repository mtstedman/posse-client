// Deterministic evidence final_review gathers beyond the planner's declared
// tests: the changed-file lint/typecheck the assessment harness runs after
// handoff, and the unit test files the change itself adds or edits. Both run
// on the uncommitted workspace before the reviewer starts, so a failure the
// assessor would find reaches the developer while it can still fix it in the
// same attempt. Live 2026-10-09: final_review passed a change whose typecheck
// failed in the changed file, and twice passed a change whose own new test
// failed; both surfaced only at assessment and cost a fix job each.

import fs from "node:fs";
import path from "node:path";
import { runScopedChecks } from "../../../shared/tools/functions/toolkit/scoped-runners.js";
import {
  lineageChangedTestPaths,
  resolveFrozenTestPlan,
} from "../../worker/functions/helpers/test-execution-receipt.js";
import {
  FINAL_REVIEW_CHECKS,
  FINAL_REVIEW_CHECK_MAX_FILES,
  FINAL_REVIEW_MAX_FINDINGS,
  FINAL_REVIEW_OUTCOMES,
  FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS,
} from "../../../catalog/final-review.js";

// A located diagnostic line: `path(line,col): ...` (tsc) or `path:line:col ...`.
const LOCATED_LINE = /^\s*([^\s():]+\.[A-Za-z0-9]+)[(:]\d/u;

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
  resolvePlan = resolveFrozenTestPlan,
  lineagePaths = [],
} = {}) {
  if (!cwd) return null;
  const declared = new Set(Array.isArray(declaredPlan?.unit_test_paths) ? declaredPlan.unit_test_paths : []);
  const lineage = (Array.isArray(lineagePaths) ? lineagePaths : [])
    .filter((file) => file && fs.existsSync(path.join(cwd, file)));
  const candidates = [...new Set([...existingChangedFiles(cwd, change), ...lineage])]
    .filter((file) => !declared.has(file));
  if (candidates.length === 0) return null;
  const plan = resolvePlan(job, { task_mode: payload?.task_mode || "code", tests_to_run: candidates }, { cwd });
  return Array.isArray(plan?.unit_test_paths) && plan.unit_test_paths.length > 0 ? plan : null;
}

/**
 * Test files changed since the job's lineage base, diffed against the working
 * tree, committed or not: the files the post-change receipt will run. Empty
 * when the lineage cannot be read; the review never waits on it.
 */
export async function lineageTestFiles(job, payload, cwd) {
  try {
    return (await lineageChangedTestPaths({ job, payload, cwd })).paths;
  } catch {
    return [];
  }
}

function locatedFile(line) {
  const match = LOCATED_LINE.exec(line);
  return match ? match[1].replace(/\\/gu, "/").replace(/^\.\//u, "") : null;
}

// A package-root check prints paths relative to that root (`src/a.ts` for
// the changed `apps/web/src/a.ts`), so a suffix on a path boundary matches.
function namesChangedFile(file, changed) {
  return changed.some((candidate) => candidate === file || candidate.endsWith(`/${file}`));
}

/**
 * Split check failures into those located in a changed file and the rest. A
 * failure elsewhere may predate the change or be a caller it broke, so it is
 * shown to the reviewer but never becomes a finding by itself.
 */
function splitFailures(failures, changed) {
  const inChanged = [];
  const elsewhere = [];
  const changedFilesNamed = (names) => changed.filter((file) => names.some((name) => namesChangedFile(name, [file])));
  for (const failure of Array.isArray(failures) ? failures : []) {
    const check = failure?.check || "check";
    if (failure?.file) {
      const text = `${failure.file}: ${String(failure.message || "").trim()}`;
      if (namesChangedFile(String(failure.file), changed)) {
        inChanged.push({ check, text, files: changedFilesNamed([String(failure.file)]) });
      } else {
        elsewhere.push({ check, text, files: [] });
      }
      continue;
    }
    const lines = String(failure?.message || "").split("\n").filter((line) => line.trim());
    const located = lines.filter((line) => locatedFile(line));
    const hits = located.filter((line) => namesChangedFile(locatedFile(line), changed));
    if (hits.length > 0) inChanged.push({ check, text: hits.join("\n"), files: changedFilesNamed(hits.map(locatedFile)) });
    const rest = located.filter((line) => !hits.includes(line));
    if (rest.length > 0) elsewhere.push({ check, text: rest.join("\n"), files: [] });
    else if (located.length === 0) elsewhere.push({ check, text: lines.join("\n"), files: [] });
  }
  return { inChanged, elsewhere };
}

/**
 * The assessment harness's changed-file lint/typecheck, run on the current
 * workspace. Null when no changed file exists to check.
 */
export function runChangedFileChecks(cwd, change, { runChecks = runScopedChecks } = {}) {
  if (!cwd) return null;
  const files = existingChangedFiles(cwd, change).slice(0, FINAL_REVIEW_CHECK_MAX_FILES);
  if (files.length === 0) return null;
  let result;
  try {
    result = runChecks({ cwd, args: { checks: [...FINAL_REVIEW_CHECKS], scope: { files } } });
  } catch (error) {
    return {
      status: "unavailable",
      summary: `changed-file checks could not run (${String(error?.message || error).slice(0, 200)})`,
      files,
      inChanged: [],
      elsewhere: [],
    };
  }
  const { inChanged, elsewhere } = result?.status === "failed"
    ? splitFailures(result.failures, files)
    : { inChanged: [], elsewhere: [] };
  return {
    status: String(result?.status || "unavailable"),
    summary: String(result?.summary || ""),
    files,
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
  const head = `CHANGED-FILE CHECKS (${FINAL_REVIEW_CHECKS.join(", ")} on ${checks.files.length} changed file(s)): ${checks.status.toUpperCase()}${checks.summary ? `, ${checks.summary}` : ""}.`;
  if (checks.status !== "failed") return head;
  const block = (entries) => `\`\`\`text\n${tail(entries.map((entry) => `[${entry.check}] ${entry.text}`).join("\n"), FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS)}\n\`\`\``;
  return [
    head,
    checks.inChanged.length > 0 ? "In changed files (defects in this change):" : null,
    checks.inChanged.length > 0 ? block(checks.inChanged) : null,
    checks.elsewhere.length > 0
      ? "Elsewhere in the project (may predate this change; a caller this change broke is still its defect):"
      : null,
    checks.elsewhere.length > 0 ? block(checks.elsewhere) : null,
  ].filter((line) => line != null).join("\n");
}

/**
 * Findings the deterministic evidence proves on its own: a check failure
 * located in a changed file, and a failing test file the change added or
 * edited. They stand even when the reviewer passes the change.
 */
export function finalReviewCheckFindings({ checks = null, changedTestRun = null } = {}) {
  const findings = [];
  const byCheck = new Map();
  for (const entry of checks?.inChanged || []) {
    const prior = byCheck.get(entry.check) || { texts: [], files: [] };
    byCheck.set(entry.check, { texts: [...prior.texts, entry.text], files: [...prior.files, ...entry.files] });
  }
  for (const [check, { texts, files }] of byCheck) {
    const paths = [...new Set(files)].slice(0, 8);
    findings.push({
      severity: "high",
      criterion: `${check} fails in changed files:\n${texts.join("\n")}`.slice(0, 1000),
      ...(paths.length > 0 ? { paths } : {}),
    });
  }
  if (changedTestRun?.status === "failed" || changedTestRun?.status === "timed_out") {
    findings.push({
      severity: "high",
      criterion: `Test files this change added or edited ${changedTestRun.status === "timed_out" ? "time out" : "fail"}: ${changedTestRun.command}\n${tail([changedTestRun.stdout, changedTestRun.stderr].filter(Boolean).join("\n"), 800)}`.slice(0, 1000),
      paths: String(changedTestRun.command || "").split(", ").filter(Boolean).slice(0, 8),
    });
  }
  return findings;
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
