import path from "node:path";
import { normPath } from "../../../shared/scope/functions/path.js";
import fs from "node:fs";
import { gitExec } from "../../git/functions/utils.js";
import { TEST_RUNNER_REMOVED_REASON } from "../../../catalog/verification.js";
import { findCommandOnPath } from "../../../shared/platform/functions/command-launch.js";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";
import { discoverUnitTestCapability, resolveUnitTestInvocation } from "../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { isUnrunnableTestReason } from "./test-capability-reasons.js";
import { validatePlannerTestCommandForRepository } from "./planner-test-command.js";
import {
  installedNodeRoots,
  installedComposerRoots,
  linkComposerVendorFromPrimaryCheckout,
  linkNodeDependenciesFromPrimaryCheckout,
  primaryCheckoutFor,
} from "./prerequisite-adapters.js";

// Reasons a worktree's absent install explains: its runner or package lives
// under the ignored vendor/ or node_modules/ that it never checks out.
const PRIMARY_INSTALL_REASONS = new Set(["test_executable_unavailable", "test_dependency_unavailable", "phpunit_unavailable"]);

/**
 * Link the primary checkout's lock-matched install into a worktree (no
 * network, no installer) so a declared runner is not pruned before
 * dependency repair could supply it. Like development start, it links only
 * into directories the repository ignores. True when a link succeeded.
 */
export function linkPrimaryTestDependencies(cwd, { git = gitExec } = {}) {
  const primary = cwd ? primaryCheckoutFor(cwd) : null;
  if (!primary) return false;
  const ignored = (directory) => {
    try { git(["check-ignore", "-q", "--", `${directory}/.posse-setup-probe`], cwd); return true; } catch { return false; }
  };
  let linked = false;
  for (const root of installedComposerRoots(primary)) {
    const directory = root === "." ? "vendor" : `${root}/vendor`;
    if (ignored(directory)) linked = linkComposerVendorFromPrimaryCheckout(path.resolve(cwd, root)).ok || linked;
  }
  for (const root of installedNodeRoots(primary)) {
    const directory = root === "." ? "node_modules" : `${root}/node_modules`;
    if (ignored(directory)) linked = linkNodeDependenciesFromPrimaryCheckout(path.resolve(cwd, root), {
      allowDirectory: (target) => ignored(path.relative(cwd, target).replace(/\\/g, "/")),
    }).ok || linked;
  }
  return linked;
}

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

export function testCommandCapability(command, cwd, { filesToCreate = [], findCommand = findCommandOnPath, baselineCommit = "HEAD", posseRoot } = {}) {
  if (!cwd || !command) return null;
  const validation = validatePlannerTestCommandForRepository(command, cwd, { filesToCreate, posseRoot });
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
export function pruneTestHandoff(payload, cwd, { jobId = null, findCommand = findCommandOnPath, posseRoot = undefined, linkDependencies = null } = {}) {
  if (!cwd) return payload;
  const next = { ...payload };
  const pruned = [];
  const baselineCommit = payload._test_capability_base_commit || payload.root_base_commit || payload.commit_base_hash || "HEAD";
  // One link attempt per handoff, then the selection is evaluated again.
  let linkAttempted = false;
  const linkedInstall = (reason) => {
    if (linkAttempted || typeof linkDependencies !== "function" || !PRIMARY_INSTALL_REASONS.has(reason)) return false;
    linkAttempted = true;
    try { return linkDependencies(cwd) === true; } catch { return false; }
  };
  const rejected = payload._verification_plan_invalid;
  if (rejected?.command && isUnrunnableTestReason(rejected.reason)
    && !(payload._pruned_tests || []).some((entry) => entry.command === rejected.command && entry.reason === rejected.reason)) {
    pruned.push({ command: rejected.command, reason: rejected.reason });
    if (!Array.isArray(next.tests_to_run)) next.tests_to_run = [];
  }
  if (payload.test_command) {
    const evaluate = () => testCommandCapability(payload.test_command, cwd, {
      filesToCreate: Array.isArray(payload.files_to_create) ? payload.files_to_create : [], findCommand, baselineCommit, posseRoot,
    });
    let reason = evaluate();
    if (linkedInstall(reason)) reason = evaluate();
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
      if ((payload.files_to_create || []).some((created) => normPath(created) === normPath(file))) return true;
      let reason = testFileCapability(file, cwd, capability, { findCommand, baselineCommit, posseRoot });
      if (linkedInstall(reason)) reason = testFileCapability(file, cwd, capability, { findCommand, baselineCommit, posseRoot });
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
