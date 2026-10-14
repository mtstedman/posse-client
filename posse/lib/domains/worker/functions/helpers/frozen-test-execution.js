import { runCommand, MAX_STREAM_CHARS } from "./test-command-process.js";
import path from "path";
import { resolveVerificationPolicy, verificationPolicyFingerprint } from "../../../settings/functions/verification-policy.js";
import { TEST_FILE_INVOKED_COVERAGE_STATUS, SINGLE_FILE_TEST_RUNNERS } from "../../../../catalog/verification.js";
import { checkRunFailureFingerprint, testFailureInventory } from "./test-failure-evidence.js";
import { discoverUnitTestCapability, runUnitTestFiles } from "../../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { testExecutionCounts } from "../../../../shared/tools/functions/toolkit/test-output-counts.js";
import { exactDeclaredTestInvocation } from "./frozen-test-plan.js";
import { classifyPackageManagerTestPlanFailure, classifyNestedRunnerInfrastructureFailure } from "../../../verification/functions/test-runner-failure.js";
import { isUnrunnableTestResult } from "./verification-outcome.js";
import { testCommandCapability, testFileRemovedSinceBaseline } from "../../../verification/functions/test-capability.js";
import { TEST_RUNNER_REMOVED_REASON } from "../../../../catalog/verification.js";

// Project file-runner output into the command-result shape shared by receipts
// and final review. Final review exposes the detailed outcome label and the
// runner's aggregate reason; stored checks retain their historical status text.
export function unitTestCommandResult(aggregate, { finalReview = false, cwd = null, baselineCommit = "HEAD" } = {}) {
  const results = cwd ? aggregate.results.map((result) => {
    if (!cwd || !testFileRemovedSinceBaseline(result.path, cwd, baselineCommit)) return result;
    return { ...result, status: "failed", ok: false, reason: TEST_RUNNER_REMOVED_REASON,
      stderr: "The candidate removed a test file present at its verification baseline." };
  }) : aggregate.results;
  if (results.some((result) => result.reason === TEST_RUNNER_REMOVED_REASON)) {
    aggregate = { ...aggregate, status: "failed", ok: false, reason: TEST_RUNNER_REMOVED_REASON };
  }
  return {
    status: aggregate.status,
    ok: aggregate.ok,
    code: aggregate.ok === true ? 0 : aggregate.ok === false ? 1 : null,
    ...(finalReview ? {} : { signal: null }),
    timed_out: aggregate.status === "timed_out",
    duration_ms: results.reduce((sum, result) => sum + Number(result.duration_ms || 0), 0),
    stdout: results.map((result) => {
      const label = (finalReview && result.outcome) || result.status || "unknown";
      return `[${result.path}] ${String(label)}\n${String(result.stdout || "")}`.trim();
    }).join("\n\n"),
    stderr: results.map((result) => String(result.stderr || "")).filter(Boolean).join("\n\n"),
    reason: aggregate.reason === TEST_RUNNER_REMOVED_REASON ? aggregate.reason : finalReview ? aggregate.reason || null
      : aggregate.ok == null ? results.find((result) => result.ok == null)?.reason || "unit_test_unavailable" : null,
    stdout_truncated: results.some((result) => result.stdout_truncated === true),
    stderr_truncated: results.some((result) => result.stderr_truncated === true),
    file_results: results,
  };
}

// Effective policy for one execution: the resolved repository policy, with any
// caller-supplied override folded in so the fingerprint always describes the
// limits that actually applied.
// `timeoutMs` > 0 overrides the wall limit. `idleTimeoutMs` undefined inherits
// the repository idle limit; null or 0 disables it; > 0 overrides it.
export function effectiveVerificationPolicy({ cwd, policy = null, timeoutMs = null, idleTimeoutMs = undefined } = {}) {
  const base = policy || resolveVerificationPolicy({ projectDir: cwd, checkClass: "frozen_test" });
  const callerWall = Number(timeoutMs) > 0;
  const wall = callerWall ? Math.max(1000, Number(timeoutMs)) : base.wall_timeout_ms;
  let idle = base.idle_timeout_ms ?? null;
  if (idleTimeoutMs !== undefined) {
    idle = Number(idleTimeoutMs) > 0 ? Math.max(1000, Number(idleTimeoutMs)) : null;
  }
  if (idle != null) idle = Math.min(idle, wall);
  const effective = {
    ...base,
    wall_timeout_ms: wall,
    wall_source: callerWall ? "caller" : base.wall_source,
    idle_timeout_ms: idle,
  };
  return { ...effective, fingerprint: verificationPolicyFingerprint(effective) };
}

async function runVerificationCheck(check, { cwd, policy, phase = null, signal = null, baselineCommit = "HEAD" } = {}) {
  const executionCommand = check.execution_command || check.command;
  const raw = Array.isArray(check.unit_test_paths)
    ? await runUnitTestFiles({
        projectDir: cwd,
        paths: check.unit_test_paths,
        capability: discoverUnitTestCapability({ projectDir: cwd }),
        timeoutMs: policy.wall_timeout_ms,
        signal,
      }).then((aggregate) => unitTestCommandResult(aggregate, { cwd, baselineCommit }))
    : await runCommand(executionCommand, {
        cwd: check.cwd_relative ? path.resolve(cwd, check.cwd_relative) : cwd,
        timeoutMs: policy.wall_timeout_ms,
        signal,
        idleTimeoutMs: policy.idle_timeout_ms,
        trustedShell: check.source === "task_ab_acceptance",
        baselineCommit,
      });
  const classified = check.source !== "task_ab_acceptance" && check.source !== "operator_approved_operation" && phase === "baseline"
    ? classifyPackageManagerTestPlanFailure(executionCommand, raw) : raw;
  const result = classifyNestedRunnerInfrastructureFailure(executionCommand, classified, { projectRoot: cwd });
  const counts = check.intent === "test" ? testExecutionCounts(`${result.stdout || ""}\n${result.stderr || ""}`) : null;
  const fileInvoked = (check.intent || "test") === "test"
    && didInvokeTestFile(result, executionCommand, cwd, check.cwd_relative, counts);
  const empty = result.status === "passed" && counts && (counts.total === 0 || counts.skipped === counts.total);
  return { ...result, status: empty ? "skipped" : result.status,
    ok: empty ? null : result.ok,
    reason: empty ? "no_tests_executed" : result.reason || null,
    check_id: check.id || check.check_id || null,
    command: check.command,
    intent: check.intent || "test",
    test_counts: counts,
    coverage_status: testCoverageStatus(result, check.intent || "test", counts, { fileInvoked }) };
}

// Without a case count, only a runner that executes exactly the named file
// shows the file ran: a package or target runner can pass without it.
export function didInvokeTestFile(result, command, cwd, cwdRelative, counts) {
  if (result.status !== "passed" || counts) return false;
  if (Array.isArray(result.file_results) && result.file_results.length > 0
    && result.file_results.every((file) => file.status === "passed"
      && SINGLE_FILE_TEST_RUNNERS.includes(file.runner)
      && `${file.stdout || ""}${file.stderr || ""}`.trim())) return true;
  return !!`${result.stdout || ""}${result.stderr || ""}`.trim()
    && SINGLE_FILE_TEST_RUNNERS.includes(exactDeclaredTestInvocation(command, cwd, cwdRelative || null)?.runner);
}

export function testCoverageStatus(result, intent, counts, { fileInvoked = false } = {}) {
  if (intent !== "test") return "not_applicable";
  if (counts && (counts.total === 0 || counts.skipped === counts.total)) return "none_executed";
  if (result.status !== "passed") return "aborted_or_unknown";
  if (counts?.total > 0) return "reported_executed";
  // A recognized test file was invoked successfully, but its case count is
  // unavailable. Keep this distinct from both reported cases and opaque output.
  return fileInvoked ? TEST_FILE_INVOKED_COVERAGE_STATUS : "unknown";
}

export function aggregateCheckCoverageStatus(checkRuns = []) {
  const tests = checkRuns.filter((run) => run.intent === "test");
  if (tests.length === 0) return "not_applicable";
  if (tests.every((run) => run.coverage_status === "reported_executed")) return "reported_executed";
  if (tests.some((run) => run.coverage_status === "none_executed")) return "none_executed";
  if (tests.every((run) => ["reported_executed", TEST_FILE_INVOKED_COVERAGE_STATUS].includes(run.coverage_status))) {
    return TEST_FILE_INVOKED_COVERAGE_STATUS;
  }
  return "unknown";
}

export async function runVerificationChecks(plan, { cwd, policy, phase = null, signal = null, baselineCommit = plan.capability_base_commit || "HEAD" } = {}) {
  const checks = Array.isArray(plan.execution_checks) && plan.execution_checks.length > 0
    ? plan.execution_checks : [{ ...plan, id: plan.check_id }];
  // Each check gets the policy's full wall. The plan as a whole is bounded by
  // that wall per runnable check, up to the administrator ceiling. A check
  // the plan budget cut short has not shown that it would time out, so it is
  // recorded unavailable, never as a timeout the change could be charged with.
  const wall = policy.wall_timeout_ms;
  const runnable = checks.filter((check) => !check.unavailable_reason).length;
  const ceiling = Number(policy.wall_timeout_max_ms) > 0 ? Number(policy.wall_timeout_max_ms) : Infinity;
  const deadline = Date.now() + Math.max(wall, Math.min(wall * Math.max(1, runnable), ceiling));
  const budgetExhausted = (check, extra = {}) => ({ check_id: check.id || null, command: check.command,
    intent: check.intent || "test", status: "unavailable", ok: null, reason: "verification_plan_wall_budget_exhausted",
    coverage_status: check.intent && check.intent !== "test" ? "not_applicable" : "unknown",
    stdout: "", stderr: "", duration_ms: 0, code: null, ...extra });
  const runs = [];
  for (const check of checks) {
    signal?.throwIfAborted();
    if (check.unavailable_reason && testCommandCapability(check.command, cwd, { baselineCommit }) !== TEST_RUNNER_REMOVED_REASON) {
      runs.push({ check_id: check.id || null, command: check.command, intent: check.intent || "test",
        status: "unavailable", ok: null, reason: check.unavailable_reason,
        coverage_status: check.intent && check.intent !== "test" ? "not_applicable" : "unknown",
        stdout: "", stderr: "", duration_ms: 0, code: null });
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining < 1000) {
      runs.push(budgetExhausted(check));
      continue;
    }
    const checkWall = Math.min(wall, remaining);
    const run = await runVerificationCheck(check, { cwd,
      baselineCommit, policy: { ...policy, wall_timeout_ms: checkWall, idle_timeout_ms: policy.idle_timeout_ms == null
        ? null : Math.min(policy.idle_timeout_ms, checkWall) }, phase, signal });
    runs.push(run.status === "timed_out" && run.timeout_kind !== "idle" && checkWall < wall
      ? budgetExhausted(check, { timeout_kind: "plan_budget", duration_ms: run.duration_ms || 0,
        stdout: run.stdout || "", stderr: run.stderr || "", test_counts: run.test_counts || null })
      : run);
  }
  const stdout = runs.map((run) => `[${run.check_id || run.command}] ${run.status}\n${run.stdout || ""}`.trim()).join("\n\n");
  const stderr = runs.map((run) => `[${run.check_id || run.command}] ${run.status}\n${run.stderr || ""}`.trim()).join("\n\n");
  const status = runs.some((run) => run.status === "failed") ? "failed"
    : runs.some((run) => run.status === "timed_out") ? "timed_out"
      : runs.some((run) => run.status === "infrastructure_error") ? "infrastructure_error"
        : runs.some((run) => run.status !== "passed") ? "unavailable" : "passed";
  return {
    status,
    ok: status === "passed" ? true : status === "failed" || status === "timed_out" ? false : null,
    code: status === "passed" ? 0 : status === "failed" ? 1 : null,
    signal: runs.find((run) => run.signal)?.signal || null,
    timed_out: status === "timed_out",
    timeout_kind: runs.find((run) => run.timed_out)?.timeout_kind || null,
    duration_ms: runs.reduce((sum, run) => sum + Number(run.duration_ms || 0), 0),
    stdout: stdout.slice(-MAX_STREAM_CHARS),
    stderr: stderr.slice(-MAX_STREAM_CHARS),
    // A check's own cut output, or the joined output cut here, is partial.
    stdout_truncated: runs.some((run) => run.stdout_truncated === true) || stdout.length > MAX_STREAM_CHARS,
    stderr_truncated: runs.some((run) => run.stderr_truncated === true) || stderr.length > MAX_STREAM_CHARS,
    reason: (runs.find((run) => run.status === status) || runs.find((run) => run.status !== "passed"))?.reason || null,
    check_runs: runs.map((run) => ({ check_id: run.check_id, command: run.command, intent: run.intent,
      ...(isUnrunnableTestResult(run) ? { required: false } : {}),
      status: run.status, ok: run.ok, reason: run.reason, exit_code: run.code,
      duration_ms: run.duration_ms, test_counts: run.test_counts || null,
      coverage_status: run.coverage_status || "unknown", failure_fingerprint: checkRunFailureFingerprint(run, { executionRoot: cwd }),
      failure_inventory: testFailureInventory(run, { executionRoot: cwd }),
      ...(run.timeout_kind ? { timeout_kind: run.timeout_kind } : {}) })),
    coverage_status: aggregateCheckCoverageStatus(runs),
    file_results: runs.flatMap((run) => run.file_results || []),
  };
}

/**
 * Run a resolved frozen test plan once on the workspace as it is now, for a
 * developer's final review before its change is committed. Nothing is stored:
 * a receipt is keyed to a commit, and this workspace is not one yet. Returns
 * the classified run, or a not-run result when the plan cannot execute.
 */
export async function runFrozenTestPlanOnce(plan, { cwd, timeoutMs = null, signal = null } = {}) {
  signal?.throwIfAborted();
  if (!plan) return { status: "skipped", ok: null, reason: "no_declared_tests" };
  if (plan.validation_error || plan.verification_eligible === false) {
    return { status: "invalid_test_plan", ok: null, reason: plan.validation_error || "not_a_verification_command", command: plan.command };
  }
  const policy = effectiveVerificationPolicy({ cwd, timeoutMs });
  const hasExecutionChecks = Array.isArray(plan.execution_checks) && plan.execution_checks.length > 0;
  const raw = hasExecutionChecks
    ? await runVerificationChecks(plan, { cwd, policy, signal })
    : Array.isArray(plan.unit_test_paths)
    ? await runUnitTestFiles({
        projectDir: cwd,
        paths: plan.unit_test_paths,
        capability: discoverUnitTestCapability({ projectDir: cwd }),
        timeoutMs: policy.wall_timeout_ms,
        signal,
      }).then((aggregate) => unitTestCommandResult(aggregate, { finalReview: true, cwd, baselineCommit: plan.capability_base_commit || "HEAD" }))
    : await runCommand(plan.execution_command || plan.command, {
        cwd: plan.cwd_relative ? path.resolve(cwd, plan.cwd_relative) : cwd,
        timeoutMs: policy.wall_timeout_ms,
        signal,
        idleTimeoutMs: policy.idle_timeout_ms,
        baselineCommit: plan.capability_base_commit || "HEAD",
      });
  const result = hasExecutionChecks ? raw
    : classifyNestedRunnerInfrastructureFailure(plan.execution_command || plan.command, raw, { projectRoot: cwd });
  const counts = testExecutionCounts(`${result.stdout || ""}\n${result.stderr || ""}`);
  const fileInvoked = (plan.intent || "test") === "test"
    && didInvokeTestFile(result, plan.execution_command || plan.command, cwd, plan.cwd_relative, counts);
  return {
    ...result,
    command: plan.command,
    test_counts: counts,
    execution_root: cwd,
    coverage_status: hasExecutionChecks ? aggregateCheckCoverageStatus(result.check_runs)
      : testCoverageStatus(result, plan.intent || "test", counts, { fileInvoked }),
  };
}
