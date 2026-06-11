// Bridge-side executor for the `git.push` command: answers a push-offer
// gate by actually pushing the repo (or declining). Runs in the serve
// process — no scheduler needed. Push state is re-collected at execution
// time so a stale offer (someone pushed manually) closes cleanly instead of
// double-pushing, and the configured pre_push_verify_cmd hook plus the
// conflict-marker check run exactly as they do for a terminal-initiated push.

import { execFileSync } from "node:child_process";

import { createGitWorkflowHelpers } from "../../cli/functions/git-workflows.js";
import { resolveTargetBranch } from "../../git/functions/target-branch.js";
import {
  acquireMergeLock,
  forceUpdateJobStatus,
  getJob,
  releaseMergeLock,
  setJobResult,
} from "../../queue/functions/index.js";
import { isPushOfferJob } from "../../queue/functions/common.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { redactBridgeValue } from "./redaction.js";

const OPEN_GATE_STATUSES = new Set(["queued", "waiting_on_human"]);
const MAX_OUTPUT_CHARS = 2000;

function truncatedRedactedOutput(output) {
  const text = String(output || "").slice(0, MAX_OUTPUT_CHARS);
  const redacted = redactBridgeValue(text);
  return typeof redacted === "string" ? redacted : text;
}

/**
 * Target branch with graceful degradation: the native resolver is
 * authoritative, but a push gate must still be answerable when the git
 * daemon is unavailable — fall back to the gate's recorded branch, then
 * the currently checked-out branch.
 */
function resolveTargetBranchSafe(projectDir, gatePayload = {}) {
  try {
    const resolved = resolveTargetBranch(projectDir);
    if (resolved) return resolved;
  } catch {
    // native git daemon unavailable — degrade below
  }
  const fromGate = String(gatePayload?.target_branch || gatePayload?.push_branch || "").trim();
  if (fromGate) return fromGate;
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "main";
  }
}

export async function executeGitPushGate(jobId, args = {}, context = {}, deps = {}) {
  const job = getJob(jobId);
  if (!job || !isPushOfferJob(job)) return { ok: false, reason: "no_such_gate" };
  if (!OPEN_GATE_STATUSES.has(job.status)) return { ok: false, reason: "gate_closed" };

  if (args.decline === true) {
    setJobResult(jobId, { declined: true });
    forceUpdateJobStatus(jobId, "canceled");
    return { ok: true, declined: true, job_id: jobId };
  }

  const projectDir = context.projectDir || process.cwd();
  const gatePayload = parseJobPayload(job) || {};
  const helpers = deps.collectState && deps.push
    ? null
    : createGitWorkflowHelpers({
        projectDir,
        getTargetBranch: () => resolveTargetBranchSafe(projectDir, gatePayload),
      });
  const collectState = deps.collectState || (() => helpers._collectPushOfferState(0));
  const runPush = deps.push || ((pushArgs) => helpers._executePush(pushArgs));

  // The offer payload is advisory; the push acts on CURRENT repo state.
  let state;
  try {
    state = collectState();
  } catch (err) {
    return { ok: false, reason: "push_state_failed", message: err?.message || String(err) };
  }
  if (!state?.hasRemote) return { ok: false, reason: "no_remote" };
  if (!state.pushBranch) return { ok: false, reason: "no_push_branch" };

  const aheadCount = Number.isFinite(state.aheadCount) ? state.aheadCount : null;
  if (aheadCount === 0) {
    // Someone already pushed (terminal, another device). Close the gate as
    // satisfied rather than failing the phone.
    setJobResult(jobId, { pushed: false, already_up_to_date: true });
    forceUpdateJobStatus(jobId, "succeeded");
    return { ok: true, pushed: false, already_up_to_date: true, job_id: jobId };
  }

  // Don't push while a merge is rewriting the branch underneath us.
  const lockOwner = `bridge-git-push:${process.pid}:${jobId}`;
  if (!acquireMergeLock(lockOwner, 120)) {
    return { ok: false, reason: "merge_in_progress" };
  }
  let pushed;
  try {
    pushed = runPush({
      effectiveRemote: state.effectiveRemote,
      pushBranch: state.pushBranch,
      mergedCount: Number(gatePayload?.merged_count) || 0,
    });
  } catch (err) {
    pushed = { ok: false, reason: "push_failed", output: err?.message || String(err) };
  } finally {
    try { releaseMergeLock(lockOwner); } catch { /* lock expiry covers us */ }
  }

  if (pushed?.ok) {
    const result = {
      pushed: true,
      remote: state.effectiveRemote,
      branch: state.pushBranch,
      ahead_count: aheadCount,
    };
    setJobResult(jobId, result);
    forceUpdateJobStatus(jobId, "succeeded");
    return { ok: true, ...result, job_id: jobId };
  }

  // Failure keeps the gate open so the phone can fix-and-retry.
  return {
    ok: false,
    reason: pushed?.reason || "push_failed",
    message: truncatedRedactedOutput(
      pushed?.output
        || (Array.isArray(pushed?.files) ? `conflict markers in: ${pushed.files.join(", ")}` : ""),
    ) || undefined,
  };
}
