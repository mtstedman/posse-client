// Bridge-side executor for the `git.push` command: answers a push-offer
// gate by actually pushing the repo (or declining). Runs in the serve
// process — no scheduler needed. Push state is re-collected at execution
// time so a stale offer (someone pushed manually) closes cleanly instead of
// double-pushing, and the configured pre_push_verify_cmd hook plus the
// conflict-marker check run exactly as they do for a terminal-initiated push.

import { createGitWorkflowHelpers } from "../../git/functions/workflows.js";
import { BRIDGE_OPEN_GATE_STATUSES } from "../../../catalog/bridge.js";
import { humanGateStateAllowsAnswer } from "../../../catalog/human-input.js";
import { gitExec } from "../../git/functions/utils.js";
import { resolveTargetBranchAsync } from "../../git/functions/target-branch.js";
import {
  getHumanGate,
  getJob,
  withMergeLock,
} from "../../queue/functions/index.js";
import { isPushOfferJob } from "../../queue/functions/common.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { closePushOfferGate } from "../../queue/functions/push-offer.js";
import { redactBridgeValue } from "./redaction.js";

const OPEN_GATE_STATUSES = new Set(BRIDGE_OPEN_GATE_STATUSES);
const MAX_OUTPUT_CHARS = 2000;

function isOpenPushGate(job) {
  if (!job || !OPEN_GATE_STATUSES.has(job.status)) return false;
  const gate = getHumanGate(job.id);
  return humanGateStateAllowsAnswer(gate?.gate_state);
}

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
async function resolveTargetBranchSafe(projectDir, gatePayload = {}) {
  try {
    const resolved = await resolveTargetBranchAsync(projectDir);
    if (resolved) return resolved;
  } catch {
    // native git daemon unavailable — degrade below
  }
  const fromGate = String(gatePayload?.target_branch || gatePayload?.push_branch || "").trim();
  if (fromGate) return fromGate;
  try {
    return gitExec(["rev-parse", "--abbrev-ref", "HEAD"], projectDir, { timeoutMs: 5000 }).trim();
  } catch {
    return "main";
  }
}

export async function executeGitPushGate(jobId, args = {}, context = {}, deps = {}) {
  const job = getJob(jobId);
  if (!job || !isPushOfferJob(job)) return { ok: false, reason: "no_such_gate" };
  if (!isOpenPushGate(job)) return { ok: false, reason: "gate_closed" };

  if (args.decline === true) {
    const declineOutcome = await withMergeLock(
      () => {
        const liveGate = getJob(jobId);
        if (!isOpenPushGate(liveGate)) return false;
        return closePushOfferGate(jobId, "canceled", { declined: true });
      },
      { ownerId: `merge-${process.pid}-bridge-git-decline-${jobId}` },
    );
    if (!declineOutcome.acquired) {
      return { ok: false, reason: "merge_in_progress" };
    }
    if (!declineOutcome.result) {
      return { ok: false, reason: "gate_closed" };
    }
    return { ok: true, declined: true, job_id: jobId };
  }

  const projectDir = context.projectDir || process.cwd();
  const gatePayload = parseJobPayload(job) || {};
  // Resolved once per gate execution: workflow helpers require a synchronous
  // getTargetBranch, and the branch cannot change mid-push.
  const helpers = deps.collectState && deps.push
    ? null
    : createGitWorkflowHelpers({
        projectDir,
        targetBranch: await resolveTargetBranchSafe(projectDir, gatePayload),
      });
  const collectState = deps.collectState || (() => helpers._collectPushOfferStateAsync(0));
  const runPush = deps.push || ((pushArgs) => helpers._executePushAsync(pushArgs));

  // Collect and validate CURRENT repository state only after taking the same
  // lock used by merges and pushes. Checking before the lock leaves a TOCTOU
  // window where a merge can change HEAD after authorization validation.
  const lockOwner = `merge-${process.pid}-bridge-git-push-${jobId}`;
  let pushed;
  try {
    const pushOutcome = await withMergeLock(async () => {
      const liveGate = getJob(jobId);
      if (!isOpenPushGate(liveGate)) {
        return { ok: false, gateClosed: true };
      }

      let state;
      try {
        state = await collectState();
      } catch (err) {
        return { ok: false, reason: "push_state_failed", message: err?.message || String(err) };
      }
      if (!state?.hasRemote) return { ok: false, reason: "no_remote" };
      if (!state.pushBranch) return { ok: false, reason: "no_push_branch" };
      if (state.pushBranchWorkItem) {
        return {
          ok: false,
          reason: "work_item_push_target",
          message: `Refusing to push work-item branch ${state.pushBranch}; merge it into the repository target branch first`,
        };
      }

      const offeredRemote = String(gatePayload.remote || "").trim();
      const offeredBranch = String(gatePayload.push_branch || "").trim();
      const offeredHead = String(gatePayload.push_head_hash || "").trim().toLowerCase();
      const currentRemote = String(state.effectiveRemote || "").trim();
      const currentBranch = String(state.pushBranch || "").trim();
      const currentHead = String(state.pushHeadHash || "").trim().toLowerCase();
      if (!currentHead) {
        return {
          ok: false,
          reason: "push_state_unverifiable",
          message: "Current push HEAD could not be verified; the existing offer remains open",
        };
      }
      if (
        !offeredHead
        || offeredRemote !== currentRemote
        || offeredBranch !== currentBranch
        || offeredHead !== currentHead
      ) {
        closePushOfferGate(jobId, "canceled", {
          declined: false,
          superseded: true,
          reason: "publication_state_changed",
          offered: { remote: offeredRemote, branch: offeredBranch, head: offeredHead || null },
          current: { remote: currentRemote, branch: currentBranch, head: currentHead },
        });
        return {
          ok: false,
          reason: "stale_offer",
          message: "The push target changed after this offer was created; refresh to authorize the current HEAD",
        };
      }

      const aheadCount = Number.isFinite(state.aheadCount) ? state.aheadCount : null;
      if (aheadCount === 0) {
        const gateResult = { pushed: false, already_up_to_date: true };
        return {
          ok: true,
          gateResult,
          gateSettled: closePushOfferGate(jobId, "succeeded", gateResult),
        };
      }

      const pushResult = await runPush({
        effectiveRemote: state.effectiveRemote,
        pushBranch: state.pushBranch,
        mergedCount: Number(gatePayload?.merged_count) || 0,
      });
      if (!pushResult?.ok) return pushResult;
      const gateResult = {
        pushed: true,
        remote: state.effectiveRemote,
        branch: state.pushBranch,
        ahead_count: aheadCount,
      };
      return {
        ...pushResult,
        gateResult,
        gateSettled: closePushOfferGate(jobId, "succeeded", gateResult),
      };
    }, {
      ownerId: lockOwner,
    });
    if (!pushOutcome.acquired) {
      return { ok: false, reason: "merge_in_progress" };
    }
    pushed = pushOutcome.result;
    if (pushed?.gateClosed) {
      return { ok: false, reason: "gate_closed" };
    }
  } catch (err) {
    pushed = { ok: false, reason: "push_failed", output: err?.message || String(err) };
  }

  if (pushed?.ok) {
    if (!pushed.gateSettled) {
      return { ok: false, reason: "gate_closed" };
    }
    const result = pushed.gateResult;
    return { ok: true, ...result, job_id: jobId };
  }

  // Failure keeps the gate open so the phone can fix-and-retry.
  return {
    ok: false,
    reason: pushed?.reason || "push_failed",
    message: truncatedRedactedOutput(pushed?.message
      || pushed?.output
      || (Array.isArray(pushed?.files) ? `conflict markers in: ${pushed.files.join(", ")}` : "")) || undefined,
  };
}
