import fs from "node:fs";
import path from "node:path";
import { gitExec } from "../../git/functions/utils.js";
import { environmentFilesFingerprint } from "./receipt-fingerprint.js";
import { describeToolchain, toolchainFingerprint, resolveVerificationPolicy } from "../../settings/functions/verification-policy.js";
import { resolveUnitTestInvocation } from "../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { getRecentArtifactsByMimeType, storeArtifact } from "../../queue/functions/artifacts.js";
import { BASELINE_CHECK_EVIDENCE_MIME } from "../../../catalog/verification.js";
import { sha256 } from "../../../shared/format/functions/sha256.js";

// A selected file can invoke an entire repository section. Cache the actual
// invocation, retaining the selection separately as attribution, not coverage.
export function baselineCheckExecution(check, cwd) {
  if (!Array.isArray(check.unit_test_paths)) return {
    command: check.execution_command || check.command,
    cwd: check.cwd_relative || ".",
    trusted_shell: check.source === "task_ab_acceptance",
  };
  const invocations = check.unit_test_paths.map(file => resolveUnitTestInvocation(cwd, file));
  if (invocations.some(value => !value?.runner)) return null;
  return [...new Set(invocations.map(value => JSON.stringify({
    runner: value.runner,
    executable: path.isAbsolute(value.executable) && value.executable.startsWith(`${cwd}${path.sep}`)
      ? path.relative(cwd, value.executable) : value.executable,
    args: value.args,
    cwd: path.relative(cwd, value.cwd || cwd) || ".",
  })))].sort();
}

// Content addressing is the promotion protocol: a successful staged merge
// execution is reusable only when the next starting point has that exact tree.
// It needs no mutable "latest" pointer that an older merge could move backward.
export function baselineCheckIdentity(check, { cwd, policy = null, requireClean = true } = {}) {
  try {
    if (requireClean && gitExec(["status", "--porcelain", "--untracked-files=all"], cwd)) return null;
    const environment = environmentFilesFingerprint(cwd);
    const execution = baselineCheckExecution(check, cwd);
    if (!environment || !execution) return null;
    const resolved = policy || resolveVerificationPolicy({ projectDir: cwd, checkClass: "frozen_test" });
    const identity = {
      repository: fs.realpathSync(gitExec(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)),
      project: gitExec(["rev-parse", "--show-prefix"], cwd),
      tree: gitExec(["rev-parse", "HEAD^{tree}"], cwd),
      execution, intent: check.intent || "test", policy: resolved.fingerprint,
      wall_timeout_ms: resolved.wall_timeout_ms, idle_timeout_ms: resolved.idle_timeout_ms ?? null,
      toolchain: toolchainFingerprint(describeToolchain({ projectDir: cwd })), environment,
    };
    return { key: sha256(JSON.stringify(identity)), ...identity, executed_commit: gitExec(["rev-parse", "HEAD"], cwd) };
  } catch { return null; }
}

export function reusableBaselineCheck(result) {
  return ["passed", "failed"].includes(result?.status)
    && !result.timed_out && !result.signal && !result.stdout_truncated && !result.stderr_truncated
    && !result.failure_kind && !result.reason
    && !(result.test_counts?.skipped > 0);
}

export function readBaselineCheck(identity) {
  if (!identity) return null;
  for (const artifact of getRecentArtifactsByMimeType(BASELINE_CHECK_EVIDENCE_MIME)) {
    let stored;
    try { stored = typeof artifact.content_json === "string" ? JSON.parse(artifact.content_json) : artifact.content_json; } catch { continue; }
    if (stored?.identity?.key === identity.key) return reusableBaselineCheck(stored.result)
      && (stored.source === "baseline" || stored.result.status === "passed")
      ? { ...stored.result, baseline_source_artifact_id: artifact.id } : null;
  }
  return null;
}

export function storeBaselineCheck(identity, result, { job = null, source = "baseline" } = {}) {
  if (!identity || !result) return null;
  // Non-passing integration evidence invalidates any older pass for this key;
  // it never promotes a failed, waived, skipped, or interrupted run.
  if (source === "baseline" && !reusableBaselineCheck(result)) return null;
  return storeArtifact({ work_item_id: job?.work_item_id ?? null, job_id: job?.id ?? null,
    artifact_type: "log", mime_type: BASELINE_CHECK_EVIDENCE_MIME,
    content_json: { identity, source, result } });
}

export function baselineCheckStillMatches(identity, check, options) {
  const after = baselineCheckIdentity(check, options);
  return !!identity && after?.key === identity.key && after.executed_commit === identity.executed_commit;
}

// Whole-plan reuse predates the per-check cache. Do not let that shortcut
// resurrect an older success after a newer integration check invalidated it.
// Dirt is ignored only for this negative lookup against HEAD: it cannot grant
// execution authority or turn a dirty checkout into reusable evidence.
export function baselineChecksHaveNewEvidence(checks, options, afterArtifactId) {
  const wanted = new Set(checks.map(check => baselineCheckIdentity(check, { ...options, requireClean: false })?.key).filter(Boolean));
  if (!wanted.size) return false;
  for (const artifact of getRecentArtifactsByMimeType(BASELINE_CHECK_EVIDENCE_MIME)) {
    let stored;
    try { stored = typeof artifact.content_json === "string" ? JSON.parse(artifact.content_json) : artifact.content_json; } catch { continue; }
    if (!wanted.delete(stored?.identity?.key)) continue;
    if (Number(artifact.id) > Number(afterArtifactId)) return true;
    if (!wanted.size) break;
  }
  return false;
}
