import path from "node:path";
import fs from "node:fs";
import { gitExec } from "../../git/functions/utils.js";
import { TEST_RUNNER_REMOVED_REASON } from "../../../catalog/verification.js";
import { findCommandOnPath } from "../../../shared/platform/functions/command-launch.js";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";
import { discoverUnitTestCapability, resolveUnitTestInvocation } from "../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { isUnrunnableTestReason } from "./test-capability-reasons.js";
import { validatePlannerTestCommandForRepository } from "./planner-test-command.js";

export function testFileRemovedSinceBaseline(file, cwd, baselineCommit) {
  if (!file || !/^(?:HEAD|[a-f0-9]{40,64})$/i.test(baselineCommit || "")) return false;
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || fs.existsSync(absolute)) return false;
  try {
    const prefix = String(gitExec(["rev-parse", "--show-prefix"], cwd) || "").trim();
    gitExec(["cat-file", "-e", `${baselineCommit}:${prefix}${relative}`], cwd);
    return true;
  }
  catch { return false; }
}

export function testCommandCapability(command, cwd, { filesToCreate = [], findCommand = findCommandOnPath, baselineCommit = "HEAD" } = {}) {
  if (!cwd || !command) return null;
  const validation = validatePlannerTestCommandForRepository(command, cwd, { filesToCreate });
  if (!validation.ok) {
    if (testFileRemovedSinceBaseline(validation.missing_script, cwd, baselineCommit)) return TEST_RUNNER_REMOVED_REASON;
    return isUnrunnableTestReason(validation.reason) ? validation.reason : null;
  }
  if (Array.isArray(validation.unit_test_paths)) {
    const capability = discoverUnitTestCapability({ projectDir: cwd });
    for (const file of validation.unit_test_paths) {
      if (filesToCreate.includes(file) && !fs.existsSync(path.resolve(cwd, file))) continue;
      const reason = testFileCapability(file, cwd, capability, { findCommand, baselineCommit });
      if (reason) return reason;
    }
    return null;
  }
  const [executable] = parseCommandArguments(validation.execution_command || command);
  const root = path.resolve(cwd, validation.cwd_relative || ".");
  const candidate = /[/\\]/.test(executable) ? path.resolve(root, executable) : executable;
  return findCommand(candidate) ? null : "test_executable_unavailable";
}

export function testFileCapability(file, cwd, capability, { findCommand = findCommandOnPath, baselineCommit = "HEAD", posseRoot = undefined } = {}) {
  if (testFileRemovedSinceBaseline(file, cwd, baselineCommit)) return TEST_RUNNER_REMOVED_REASON;
  const invocation = resolveUnitTestInvocation(cwd, file, capability, { posseRoot });
  if (!invocation?.runner) return invocation?.reason || capability?.reason || "unit_test_path_unavailable";
  const executable = /[/\\]/.test(invocation.executable)
    ? path.resolve(cwd, invocation.executable) : invocation.executable;
  return findCommand(executable) ? null : "test_executable_unavailable";
}

// Recomputed at each handoff, including old queued/fix jobs. Telemetry retains
// the discarded selections; the agent receives only runnable obligations.
export function pruneTestHandoff(payload, cwd, { jobId = null, findCommand = findCommandOnPath, posseRoot = undefined } = {}) {
  if (!cwd) return payload;
  const next = { ...payload };
  const pruned = [];
  const baselineCommit = payload._test_capability_base_commit || payload.root_base_commit || payload.commit_base_hash || "HEAD";
  const rejected = payload._verification_plan_invalid;
  if (rejected?.command && isUnrunnableTestReason(rejected.reason)
    && !(payload._pruned_tests || []).some((entry) => entry.command === rejected.command && entry.reason === rejected.reason)) {
    pruned.push({ command: rejected.command, reason: rejected.reason });
    if (!Array.isArray(next.tests_to_run)) next.tests_to_run = [];
  }
  if (payload.test_command) {
    const reason = testCommandCapability(payload.test_command, cwd, {
      filesToCreate: Array.isArray(payload.files_to_create) ? payload.files_to_create : [], findCommand, baselineCommit,
    });
    if (reason && reason !== TEST_RUNNER_REMOVED_REASON) {
      pruned.push({ command: payload.test_command, reason });
      next.test_command = null;
      // An explicit empty selection prevents fallback to an inherited plan.
      if (!Array.isArray(next.tests_to_run)) next.tests_to_run = [];
    }
  }
  if (Array.isArray(payload.tests_to_run) && payload.tests_to_run.length) {
    const capability = discoverUnitTestCapability({ projectDir: cwd });
    next.tests_to_run = payload.tests_to_run.filter((file) => {
      const reason = testFileCapability(file, cwd, capability, { findCommand, baselineCommit, posseRoot });
      if (!reason || reason === TEST_RUNNER_REMOVED_REASON) return true;
      pruned.push({ path: file, reason });
      return false;
    });
  }
  if (!pruned.length) return payload;
  log.warn("verification", "Pruned unavailable tests from handoff", { job_id: jobId, cwd, pruned });
  next._pruned_tests = [...(payload._pruned_tests || []), ...pruned].slice(-48);
  return next;
}
