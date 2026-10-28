import { implicitTypechecks } from "../../verification/functions/implicit-typechecks.js";
import { resolveUnitTestInvocation } from "../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { testExecutionCounts } from "../../../shared/tools/functions/toolkit/test-output-counts.js";
import { MERGE_CANDIDATE_CHECKOUT_PREFIX, MERGE_CHECK_FAILURE_KINDS } from "../../../catalog/verification.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { installedComposerRoots, installedDependenciesMatchLockfile, installedNodeRoots, linkComposerVendorFromCheckout } from "../../verification/functions/prerequisite-adapters.js";
import { classifyNestedRunnerInfrastructureFailure } from "../../verification/functions/test-runner-failure.js";
import { validatePlannerTestCommandForRepository } from "../../verification/functions/planner-test-command.js";
import { runCloseoutTestCommandSync } from "./merge-closeout.js";

/** Create one disposable checkout of the staged candidate for merge checks. */
export function withTemporaryMergeCandidateCheckout({ cwd, git, dependencySources = [] }, use) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), MERGE_CANDIDATE_CHECKOUT_PREFIX));
  const checkout = path.join(root, "candidate");
  let added = false;
  try {
    const tree = git(["write-tree"], cwd);
    const head = git(["rev-parse", "HEAD"], cwd);
    const commit = git(["commit-tree", tree, "-p", head, "-m", "Temporary merge verification candidate"], cwd);
    git(["worktree", "add", "--detach", checkout, commit], cwd);
    added = true;
    // The target checkout's install predates a candidate that changed its
    // lockfile; the work item's worktree may hold the install that matches.
    const dependencyOwner = (relative) => {
      const sources = [cwd, ...dependencySources].filter((source) => source && fs.existsSync(path.join(source, relative)));
      let lockfile = null;
      try { lockfile = fs.readFileSync(path.join(checkout, path.dirname(relative), path.basename(relative) === "vendor" ? "composer.lock" : "package-lock.json"), "utf8"); } catch { /* no lockfile */ }
      return (lockfile && sources.find((source) => installedDependenciesMatchLockfile(path.join(source, relative), lockfile) === true)) || sources[0] || null;
    };
    const reset = (revision = commit) => {
      git(["reset", "--hard", revision], checkout);
      git(["clean", "-fdx"], checkout);
      const sources = [cwd, ...dependencySources.filter(Boolean)];
      const dependencyDirs = new Set(["node_modules", "vendor",
        ...sources.flatMap((source) => installedNodeRoots(source).map((nodeRoot) => path.relative(source, path.join(source, nodeRoot, "node_modules")))),
        ...sources.flatMap((source) => installedComposerRoots(source).map((root) => path.join(root, "vendor"))),
      ]);
      for (const relative of dependencyDirs) {
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
        if (path.basename(relative) === "vendor") {
          for (const source of sources) {
            if (linkComposerVendorFromCheckout(path.dirname(path.join(checkout, relative)), path.dirname(path.join(source, relative))).ok) break;
          }
          continue;
        }
        const owner = dependencyOwner(relative);
        const destination = path.join(checkout, relative);
        if (!owner || fs.existsSync(destination) || !fs.existsSync(path.dirname(destination))) continue;
        const source = path.join(owner, relative);
        fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
      }
    };
    return use({ checkout, candidateCommit: commit, targetHead: head, reset });
  } finally {
    try {
      if (added) git(["worktree", "remove", "--force", checkout], cwd);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

/** The distinct test commands succeeded dev/fix jobs declared for the merge gate. */
export function declaredMergeCandidateCommands(jobs = []) {
  return [...new Set((jobs || []).filter((job) => job.status === "succeeded" && ["dev", "fix"].includes(job.job_type))
    .map((job) => String(parseJobPayload(job).test_command || "").trim()).filter(Boolean))];
}

function runSelectedTests(paths, checkout, run, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const results = [];
  const quote = (arg) => `"${String(arg).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  for (const file of paths) {
    const invocation = resolveUnitTestInvocation(checkout, file);
    if (!invocation?.runner) return { ok: false, status: null, error_code: "ENOENT", output: `Selected test unavailable: ${file}` };
    const remaining = deadline - Date.now();
    if (remaining < 1) return { ok: false, status: null, timed_out: true, error_code: "ETIMEDOUT", output: "Selected tests exceeded merge budget" };
    const result = run([invocation.executable, ...invocation.args].map(quote).join(" "), {
      cwd: invocation.cwd || checkout, timeoutMs: remaining,
    });
    const counts = testExecutionCounts(result.output);
    results.push({ ...result, no_tests: result.ok && counts && (counts.total === 0 || counts.total === counts.skipped) });
  }
  const failure = results.find((result) => !result.ok);
  return { ...(failure || results[0]), ok: !failure,
    no_tests: results.some((result) => result.no_tests),
    stdout: results.map((result) => result.stdout || result.output || "").join("\n"),
    stderr: results.map((result) => result.stderr || "").join("\n"),
    output: results.map((result) => result.output || "").join("\n") };
}

/** Verify the staged tree without letting test side effects alter the merge. */
export function runDeclaredMergeCandidateChecks({ cwd, jobs = [], git, run = runCloseoutTestCommandSync, candidate = null, deadlineMs = null, includeDeclared = true, scopeFiles = null }) {
  const commands = includeDeclared ? declaredMergeCandidateCommands(jobs) : [];
  const files = scopeFiles || jobs.filter(job => job.status === "succeeded" && ["dev", "fix"].includes(job.job_type))
    .flatMap(job => { const payload = parseJobPayload(job); return [...(payload.files_to_modify || []), ...(payload.files_to_create || [])]; });
  const runInCheckout = ({ checkout, reset }) => {
    reset();
    const implicit = new Set(implicitTypechecks(checkout, files).map(check => check.declared_command));
    const required = [...new Set([...commands, ...implicit])];
    if (!required.length) return null;
    const results = required.map((command) => {
      const remainingMs = deadlineMs == null ? 10 * 60_000 : deadlineMs - Date.now();
      if (remainingMs < 1000) return { ok: false, status: "failed", failure_kind: MERGE_CHECK_FAILURE_KINDS.TIMEOUT,
        test: { name: command }, failure: { message: "merge gate wall budget expired before this declared check" } };
      reset();
      const validation = validatePlannerTestCommandForRepository(command, checkout);
      if (!validation.ok) return { ok: false, status: "unavailable", failure_kind: MERGE_CHECK_FAILURE_KINDS.MISSING_RUNNER,
        test: { name: command }, note: validation.reason };
      const cwdRelative = validation.cwd_relative || null;
      const timeoutMs = Math.min(10 * 60_000, remainingMs);
      const result = Array.isArray(validation.unit_test_paths)
        ? runSelectedTests(validation.unit_test_paths, checkout, run, timeoutMs)
        : run(validation.execution_command || command, {
        cwd: validation.cwd_relative ? path.resolve(checkout, validation.cwd_relative) : checkout,
        dependencySourceDir: validation.cwd_relative ? path.resolve(cwd, validation.cwd_relative) : cwd,
        timeoutMs,
      });
      // An absent runner leaves required verification unresolved. A process
      // that timed out, was killed, or overflowed cannot be called unavailable.
      const classified = classifyNestedRunnerInfrastructureFailure(validation.execution_command || command, {
        status: result.error_code === "ENOENT" ? "infrastructure_error" : result.ok ? "passed" : "failed",
        code: result.error_code || result.status, stdout: result.stdout ?? result.output, stderr: result.stderr ?? "",
      }, { projectRoot: cwdRelative ? path.resolve(checkout, cwdRelative) : checkout });
      const missingRunner = [127, 9009].includes(result.status)
        && /not found|not recognized as an internal or external command/i.test(result.output);
      const counts = testExecutionCounts(result.output);
      const noTests = !implicit.has(command) && result.ok && (result.no_tests || counts && (counts.total === 0 || counts.total === counts.skipped));
      const abnormal = result.timed_out || result.error_code === "ETIMEDOUT" || result.signal
        || result.error_code === "ENOBUFS" || (result.error_code && result.error_code !== "ENOENT")
        || result.status == null && result.error_code !== "ENOENT";
      const unavailable = !abnormal && (noTests || missingRunner || result.error_code === "ENOENT"
        || classified.status === "infrastructure_error");
      const failureKind = unavailable
        ? noTests ? MERGE_CHECK_FAILURE_KINDS.NO_TESTS : MERGE_CHECK_FAILURE_KINDS.MISSING_RUNNER
        : result.timed_out || result.error_code === "ETIMEDOUT" ? MERGE_CHECK_FAILURE_KINDS.TIMEOUT
          : result.error_code === "ENOBUFS" ? MERGE_CHECK_FAILURE_KINDS.OUTPUT_OVERFLOW
            : result.signal ? MERGE_CHECK_FAILURE_KINDS.SIGNAL
              : result.error_code || result.status == null ? MERGE_CHECK_FAILURE_KINDS.SPAWN_ERROR
                : !result.ok ? MERGE_CHECK_FAILURE_KINDS.TEST_FAILURE : null;
      return { ok: !unavailable && result.ok && !abnormal, status: unavailable ? "unavailable" : result.ok && !abnormal ? "passed" : "failed",
        ...(failureKind ? { failure_kind: failureKind } : {}),
        ...(classified.missing_runtime_capabilities ? { missing_runtime_capabilities: classified.missing_runtime_capabilities } : {}),
        source: "job_test_command", implicit_typecheck: implicit.has(command),
        test: { name: command }, cwd_relative: cwdRelative, timeout_ms: timeoutMs, ...(unavailable ? { note: result.output } : {}),
        stdout: result.stdout ?? result.output ?? "", stderr: result.stderr ?? "",
        exit_code: result.status, signal: result.signal ?? null,
        ...(!unavailable && (!result.ok || abnormal) ? { failure: { message: result.output || `merge check ended without a result (${failureKind})` } } : {}),
      };
    });
    for (const result of results) {
      result.source = "job_test_command";
      result.implicit_typecheck = implicit.has(result.test.name);
    }
    const passed = results.filter((result) => result.status === "passed").length;
    const failed = results.filter((result) => result.status === "failed").length;
    const unavailable = results.filter((result) => result.status === "unavailable").length;
    return { ok: failed === 0 && unavailable === 0, source: "job_test_command", matched: results.length, passed, failed, unavailable, results,
      summary: `declared merge candidate checks: ${passed} passed, ${failed} failed, ${unavailable} unavailable`,
    };
  };
  return candidate ? runInCheckout(candidate) : withTemporaryMergeCandidateCheckout({ cwd, git }, runInCheckout);
}

// Registered tests and implicit scripts are independent merge obligations.
export function appendRequiredMergeTypechecks(primary, options) {
  const required = runDeclaredMergeCandidateChecks({ ...options, includeDeclared: false });
  if (!required) return primary;
  return { ...primary, ok: primary.ok && required.ok,
    matched: (primary.matched || 0) + required.matched,
    passed: (primary.passed || 0) + required.passed,
    failed: (primary.failed || 0) + required.failed,
    unavailable: (primary.unavailable || 0) + required.unavailable,
    results: [...primary.results, ...required.results], summary: `${primary.summary}; ${required.summary}` };
}
