import {
  getSetting,
  getWorkItem,
  logEvent,
} from "../../../queue/functions/index.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { snapshotAndResetDirtyWorktreeAsync } from "../../../git/functions/worktree.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { runShellCommandAsync } from "./assessment-runner.js";
import {
  describeToolchain,
  resolveVerificationPolicy,
  toolchainFingerprint,
} from "../../../settings/functions/verification-policy.js";
import { verificationOutcome } from "./verification-outcome.js";

function readSettingText(key, projectDir = null) {
  try {
    const value = getSetting(key, projectDir ? { projectDir } : {});
    return value == null ? "" : String(value).trim();
  } catch {
    return "";
  }
}

function readSettingBool(key, fallback = false) {
  const value = readSettingText(key).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export function configuredVerificationPlan(projectDir, {
  preAssessAlreadyVerified = false,
} = {}) {
  const canonicalVerifyCmd = readSettingText("canonical_verify_cmd", projectDir);
  const command = canonicalVerifyCmd || readSettingText("pre_assess_cmd") || "";
  const settingKey = canonicalVerifyCmd ? "canonical_verify_cmd" : "pre_assess_cmd";
  const hooksSkipped = readSettingBool("skip_hooks", false)
    || readSettingBool("skip_hook_post_dev_verify", false);
  const policy = resolveVerificationPolicy({ projectDir, checkClass: "canonical_verify" });
  const toolchain = describeToolchain({ projectDir });
  return {
    command,
    setting_key: settingKey,
    timeout_ms: policy.wall_timeout_ms,
    idle_timeout_ms: policy.idle_timeout_ms,
    timeout_source: policy.wall_source,
    policy_fingerprint: policy.fingerprint,
    toolchain_fingerprint: toolchainFingerprint(toolchain),
    enabled: !!command && !preAssessAlreadyVerified && !hooksSkipped,
    skip_reason: !command
      ? "not_configured"
      : preAssessAlreadyVerified
        ? "already_verified"
        : hooksSkipped
          ? "hooks_skipped"
          : null,
  };
}

async function gitPorcelainZ(cwd) {
  return String(await gitExecAsync(
    ["status", "--porcelain=v1", "-z"],
    cwd,
    { trim: false },
  ) || "");
}

function parsePorcelainZ(raw = "") {
  const parts = String(raw || "").split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    const status = item.slice(0, 2);
    const filePath = item.slice(3);
    let oldPath = null;
    if ((status.includes("R") || status.includes("C")) && index + 1 < parts.length) {
      oldPath = parts[++index];
    }
    entries.push({ status, path: filePath, old_path: oldPath });
  }
  return entries;
}

function porcelainEntryKey(entry) {
  return `${entry.status}\0${entry.path || ""}\0${entry.old_path || ""}`;
}

function diffPorcelainEntries(beforeRaw, afterRaw) {
  const beforeKeys = new Set(parsePorcelainZ(beforeRaw).map(porcelainEntryKey));
  return parsePorcelainZ(afterRaw).filter((entry) => !beforeKeys.has(porcelainEntryKey(entry)));
}

async function commitBinding(cwd, assessedCommitHash) {
  const assessed = String(assessedCommitHash || "").trim().toLowerCase();
  if (!cwd || !/^[0-9a-f]{40,64}$/i.test(assessed)) {
    return {
      assessed_commit_hash: assessed || null,
      executed_commit_hash: null,
      tested_integrated_descendant: false,
      verification_eligible: false,
    };
  }
  let executed = null;
  try {
    executed = String(await gitExecAsync(["rev-parse", "HEAD"], cwd) || "").trim().toLowerCase() || null;
  } catch {
    return {
      assessed_commit_hash: assessed,
      executed_commit_hash: null,
      tested_integrated_descendant: false,
      verification_eligible: false,
    };
  }
  if (executed === assessed) {
    return {
      assessed_commit_hash: assessed,
      executed_commit_hash: executed,
      tested_integrated_descendant: false,
      verification_eligible: true,
    };
  }
  let testedIntegratedDescendant = false;
  try {
    await gitExecAsync(["merge-base", "--is-ancestor", assessed, executed], cwd);
    testedIntegratedDescendant = true;
  } catch {
    testedIntegratedDescendant = false;
  }
  return {
    assessed_commit_hash: assessed,
    executed_commit_hash: executed,
    tested_integrated_descendant: testedIntegratedDescendant,
    verification_eligible: testedIntegratedDescendant,
  };
}

async function gitExecutionState(cwd) {
  let commit = null;
  let headRef = null;
  try {
    commit = String(await gitExecAsync(["rev-parse", "HEAD"], cwd) || "")
      .trim()
      .toLowerCase() || null;
  } catch {
    commit = null;
  }
  try {
    headRef = String(await gitExecAsync(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd) || "")
      .trim() || null;
  } catch {
    // A detached HEAD is a valid, stable execution state.
    headRef = null;
  }
  return { commit, head_ref: headRef };
}

function sameGitExecutionState(before, after) {
  return !!before?.commit
    && before.commit === after?.commit
    && before.head_ref === after?.head_ref;
}

function reusableVerification(jobId, plan, assessedCommitHash, currentBinding) {
  const assessed = String(assessedCommitHash || "").trim().toLowerCase();
  const executed = String(currentBinding?.executed_commit_hash || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/i.test(assessed)
    || currentBinding?.verification_eligible !== true
    || !/^[0-9a-f]{40,64}$/i.test(executed)) {
    return null;
  }
  try {
    const rows = getDb().prepare(`
      SELECT detail_json, created_at
      FROM job_observations
      WHERE job_id = ? AND observation_type = 'command.pre_assess'
      ORDER BY id DESC
      LIMIT 20
    `).all(jobId);
    for (const row of rows) {
      let detail;
      try { detail = JSON.parse(String(row.detail_json || "{}")); } catch { continue; }
      if (detail?.status !== "passed" || detail?.source !== "setting") continue;
      if (detail?.verification_eligible !== true) continue;
      if (String(detail?.policy_fingerprint || "") !== plan.policy_fingerprint) continue;
      if (String(detail?.toolchain_fingerprint || "") !== plan.toolchain_fingerprint) continue;
      if (String(detail?.command || "").trim() !== plan.command) continue;
      if (detail?.setting_key !== plan.setting_key) continue;
      if (String(detail?.assessed_commit_hash || "").trim().toLowerCase() !== assessed) continue;
      if (String(detail?.executed_commit_hash || "").trim().toLowerCase() !== executed) continue;
      return { ...detail, created_at: row.created_at };
    }
  } catch {
    return null;
  }
  return null;
}

function recordCommandObservation(job, attemptId, summary, detail) {
  recordObservation({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    observation_type: "command.pre_assess",
    summary,
    detail,
  });
}

export function renderConfiguredVerificationEvidence(result = {}) {
  if (!result?.command || result.status === "skipped") return "";
  const output = [result?.error?.stdout, result?.error?.stderr]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(-1600);
  return [
    "CONFIGURED REPOSITORY VERIFICATION:",
    `command: ${result.command}`,
    `status: ${String(result.status || "unknown").toUpperCase()}`,
    `outcome: ${result.verification_outcome?.type || verificationOutcome({ ...result, phase: "post_change" }).type}`,
    `timeout: wall=${result.timeout_ms ?? "unknown"}ms idle=${result.idle_timeout_ms ?? "disabled"}`,
    output ? `output_tail:\n${output}` : "",
  ].filter(Boolean).join("\n");
}

export async function ensureConfiguredVerification(worker, {
  job,
  attemptId = null,
  assessedCommitHash = null,
  wtPath = null,
  preAssessAlreadyVerified = false,
  allowReuse = true,
} = {}) {
  const plan = configuredVerificationPlan(worker?.projectDir, { preAssessAlreadyVerified });
  if (!plan.enabled || !wtPath) {
    const skipped = {
      status: "skipped",
      reason: !wtPath ? "worktree_unavailable" : plan.skip_reason,
      ...plan,
    };
    return { ...skipped, verification_outcome: verificationOutcome(skipped) };
  }
  const currentBinding = await commitBinding(wtPath, assessedCommitHash);
  const reused = allowReuse
    ? reusableVerification(job.id, plan, assessedCommitHash, currentBinding)
    : null;
  if (reused) {
    worker.emit(job.id, `${C.dim}[pre-assess] Reused passing ${plan.setting_key} receipt for the assessed commit${C.reset}`);
    return {
      status: "passed",
      reused: true,
      receipt: reused,
      verification_outcome: reused.verification_outcome || verificationOutcome({ ...reused, phase: "post_change" }),
      ...plan,
    };
  }

  worker.emit(job.id, `${C.dim}[pre-assess] Running: ${plan.command}${C.reset}`);
  recordCommandObservation(job, attemptId, "Running pre-assess command", {
    command: plan.command,
    cwd: wtPath,
    source: "setting",
    setting_key: plan.setting_key,
    timeout_ms: plan.timeout_ms,
    idle_timeout_ms: plan.idle_timeout_ms,
    timeout_source: plan.timeout_source,
    policy_fingerprint: plan.policy_fingerprint,
    toolchain_fingerprint: plan.toolchain_fingerprint,
  });

  try {
    const executionStateBefore = await gitExecutionState(wtPath);
    const before = await gitPorcelainZ(wtPath);
    await runShellCommandAsync(plan.command, {
      cwd: wtPath,
      timeoutMs: plan.timeout_ms,
      idleTimeoutMs: plan.idle_timeout_ms,
    });
    const after = await gitPorcelainZ(wtPath);
    const dirtyEntries = diffPorcelainEntries(before, after);
    if (dirtyEntries.length > 0 || after !== before) {
      const dirtyPaths = dirtyEntries.map((entry) => entry.path).filter(Boolean);
      const preview = dirtyPaths.slice(0, 10).join(", ");
      const more = dirtyPaths.length > 10 ? " ..." : "";
      const generatedOnly = before === ""
        && dirtyEntries.length > 0
        && dirtyEntries.every((entry) => entry.status === "??");
      const sideEffectMessage = generatedOnly
        ? `Pre-assessment hook generated disposable file(s)${preview ? `: ${preview}${more}` : ""}`
        : `Pre-assessment hook left worktree dirty${preview ? `: ${preview}${more}` : ""}`;
      let snapshotDir = null;
      let snapshotError = null;
      try {
        snapshotDir = await snapshotAndResetDirtyWorktreeAsync(wtPath, worker.projectDir, {
          reason: `pre-assess-dirty-wi-${job.work_item_id}-job-${job.id}`,
          branchName: getWorkItem(job.work_item_id)?.branch_name || null,
          wiId: job.work_item_id,
          onMsg: (message) => worker.emit(job.id, `${C.dim}[pre-assess] ${message}${C.reset}`),
        });
      } catch (error) {
        snapshotError = error?.message || String(error);
      }
      const sideEffectColor = generatedOnly ? C.dim : C.yellow;
      worker.emit(job.id, `${sideEffectColor}[pre-assess] ${sideEffectMessage}${snapshotDir ? ` (snapshot: ${snapshotDir})` : ""}${C.reset}`);
      let cleanupVerified = false;
      if (!snapshotError) {
        try {
          cleanupVerified = await gitPorcelainZ(wtPath) === before;
        } catch (error) {
          snapshotError = error?.message || String(error);
        }
      }
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attemptId,
        event_type: EVENT_TYPES.WORKTREE_PRE_ASSESS_DIRTY,
        actor_type: EVENT_ACTORS.WORKER,
        message: sideEffectMessage,
        event_json: JSON.stringify({
          command: plan.command,
          cwd: wtPath,
          setting_key: plan.setting_key,
          changed_paths: dirtyPaths.slice(0, 100),
          changed_entries: dirtyEntries.slice(0, 100),
          before_entries: parsePorcelainZ(before).slice(0, 100),
          after_entries: parsePorcelainZ(after).slice(0, 100),
          snapshot_dir: snapshotDir,
          snapshot_error: snapshotError,
          cleanup_verified: cleanupVerified,
          generated_only: generatedOnly,
        }),
      });
      recordCommandObservation(job, attemptId, sideEffectMessage, {
        command: plan.command,
        cwd: wtPath,
        source: "setting",
        setting_key: plan.setting_key,
        status: generatedOnly && cleanupVerified ? "passed_with_cleanup" : "dirty",
        changed_paths: dirtyPaths,
        snapshot_dir: snapshotDir,
        snapshot_error: snapshotError,
        cleanup_verified: cleanupVerified,
        generated_only: generatedOnly,
      });
      if (!generatedOnly || !cleanupVerified) {
        const message = snapshotError
          ? `${sideEffectMessage}; cleanup failed: ${snapshotError}`
          : `${sideEffectMessage}; cleanup could not restore the pre-verification tree`;
        return {
          status: "failed",
          error: new Error(message),
          message,
          verification_outcome: verificationOutcome({ status: "side_effect_detected", reason: message }),
          ...plan,
        };
      }
      worker.emit(
        job.id,
        `${C.dim}[pre-assess] Generated files were preserved and cleaned; retaining the successful verification result${C.reset}`,
      );
    }

    const executionStateAfter = await gitExecutionState(wtPath);
    if (!sameGitExecutionState(executionStateBefore, executionStateAfter)) {
      const error = new Error(
        "Pre-assessment hook changed Git HEAD; refusing to treat a mutated execution state as verification",
      );
      error.verification_git_state = {
        before: executionStateBefore,
        after: executionStateAfter,
      };
      throw error;
    }
    const binding = await commitBinding(wtPath, assessedCommitHash);
    const receipt = {
      command: plan.command,
      cwd: wtPath,
      status: "passed",
      source: "setting",
      setting_key: plan.setting_key,
      timeout_ms: plan.timeout_ms,
      idle_timeout_ms: plan.idle_timeout_ms,
      policy_fingerprint: plan.policy_fingerprint,
      toolchain_fingerprint: plan.toolchain_fingerprint,
      ...binding,
    };
    receipt.verification_outcome = verificationOutcome({ ...receipt, phase: "post_change" });
    worker.emit(job.id, `${C.green}[pre-assess] Passed${C.reset}`);
    recordCommandObservation(job, attemptId, "Pre-assess command passed", receipt);
    return {
      status: "passed",
      reused: false,
      receipt,
      verification_outcome: receipt.verification_outcome,
      ...plan,
    };
  } catch (error) {
    // A policy timeout is infrastructure evidence, not a product failure.
    // Preserve its kind so retry policy and operators can distinguish a hard
    // wall limit from an explicitly configured idle watchdog.
    const timedOut = ["ETIMEDOUT", "EIDLETIMEOUT"].includes(String(error?.code || ""));
    const timeoutKind = error?.timeout_kind || "wall";
    const timeoutLimit = timeoutKind === "idle" ? plan.idle_timeout_ms : plan.timeout_ms;
    const message = timedOut
      ? `Pre-assessment hook ${timeoutKind === "idle" ? "produced no output" : "timed out"} after ${timeoutLimit}ms (${timeoutKind} policy): ${plan.command}`
      : `Pre-assessment hook failed: ${String(error?.message || error).split("\n")[0]}`;
    worker.emit(job.id, `${C.red}[pre-assess] ${message}${C.reset}`);
    recordCommandObservation(job, attemptId, message, {
      command: plan.command,
      cwd: wtPath,
      status: timedOut ? "timed_out" : "failed",
      reason: timedOut ? `verification_${timeoutKind}_timeout` : null,
      timeout_ms: plan.timeout_ms,
      idle_timeout_ms: plan.idle_timeout_ms,
      timeout_kind: timedOut ? timeoutKind : null,
      timeout_source: plan.timeout_source,
      policy_fingerprint: plan.policy_fingerprint,
      toolchain_fingerprint: plan.toolchain_fingerprint,
      verification_outcome: verificationOutcome({
        status: timedOut ? "timed_out" : "failed",
        reason: timedOut ? `verification_${timeoutKind}_timeout` : null,
        phase: "post_change",
        code: error?.code ?? null,
      }),
      source: "setting",
      setting_key: plan.setting_key,
      ...(error?.verification_git_state
        ? { verification_git_state: error.verification_git_state }
        : {}),
    });
    const result = {
      status: timedOut ? "timed_out" : "failed",
      timed_out: timedOut,
      reason: timedOut ? "verification_wall_timeout" : null,
      error,
      message,
      ...plan,
    };
    result.reason = timedOut ? `verification_${timeoutKind}_timeout` : null;
    result.verification_outcome = verificationOutcome({ ...result, phase: "post_change", code: error?.code ?? null });
    return result;
  }
}
