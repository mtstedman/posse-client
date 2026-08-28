// lib/domains/git/functions/workflow-push.js
// Push-offer gate and push execution workflow helpers.

import { listWorkItems, logEvent, withMergeLock } from "../../queue/functions/index.js";
import {
  cancelOpenPushOfferGateForTarget,
  cancelOpenPushOfferGates,
  markOpenPushOfferGatePushed,
  upsertPushOfferGate,
} from "../../queue/functions/push-offer.js";
import { C } from "../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { runHook } from "./hooks.js";
import { gitExec, resolvePushBranch } from "./utils.js";
import { GIT_MERGE_TIMEOUT_MS } from "./workflow-git-utils.js";
import { resolveSharedTrunkConfigRuntime } from "./shared-trunk-config.js";

export function createPushWorkflowHelpers(context, { auditWorktreeState, askSingleKeyYesNo }) {
  const { projectDir, currentTargetBranch, runGitWorkflowTaskOffMainThread, nonInteractive, askFn, nativeParity } = context;

  function workItemForBranch(branchName) {
    const branch = String(branchName || "").trim();
    if (!branch) return null;
    return listWorkItems().find((wi) => String(wi?.branch_name || "").trim() === branch) || null;
  }

  function collectPushOfferState(mergedCount) {
    const targetBranch = currentTargetBranch();
    const branch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], projectDir, { nativeParity }).trim();
    const remotes = (() => {
      try {
        // Enumerate remotes via a statically read-only config query: bare
        // `git remote` fails closed to the git:mutate route under the
        // encoder's argv policy, which read-route workflow workers (e.g.
        // the off-main-thread collectPushOfferState task) cannot use.
        return [...new Set(
          gitExec(["config", "--get-regexp", "^remote\\..*\\.url$"], projectDir, { nativeParity })
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.split(/\s/, 1)[0].replace(/^remote\./, "").replace(/\.url$/, ""))
            .filter(Boolean),
        )];
      } catch {
        // `git config --get-regexp` exits 1 when no remotes are configured.
        return [];
      }
    })();
    const branchRemote = (() => {
      try {
        return gitExec(["config", "--get", `branch.${branch}.remote`], projectDir, { nativeParity }).trim();
      } catch {
        return "";
      }
    })();
    const pushRemote = remotes.includes(branchRemote)
      ? branchRemote
      : (remotes[0] || "");
    const hasRemote = pushRemote.length > 0;
    if (!hasRemote) return { hasRemote: false, branch, remotes, targetBranch, mergedCount };

    const pushBranchInfo = resolvePushBranch(projectDir, targetBranch, { currentBranch: branch, remote: pushRemote });
    if (!pushBranchInfo.branch) {
      return { hasRemote: true, branch, remotes, targetBranch, mergedCount, pushBranchInfo };
    }

    const pushBranch = pushBranchInfo.branch;
    const pushBranchWorkItem = workItemForBranch(pushBranch);
    const pushBranchRemote = (() => {
      try {
        return gitExec(["config", "--get", `branch.${pushBranch}.remote`], projectDir, { nativeParity }).trim();
      } catch {
        return "";
      }
    })();
    const effectiveRemote = remotes.includes(pushBranchRemote) ? pushBranchRemote : pushRemote;

    let workingTreeStatus = "";
    try {
      workingTreeStatus = gitExec(["status", "--porcelain"], projectDir, { timeoutMs: 5000, nativeParity }).trim();
    } catch {
      workingTreeStatus = "";
    }

    // Commits on the push branch that the remote tracking ref doesn't have.
    // This — not "did this wrap-up pass merge anything" — is what warrants a
    // push offer: mid-run auto-merges land before the wrap-up counts them, so
    // gating on the pass-local merge count strands merged work unpushed.
    // null = no upstream ref yet (never pushed) or git error; callers fall
    // back to the merge-count gate in that case.
    let aheadCount = null;
    try {
      const upstreamRef = `${effectiveRemote}/${pushBranch}`;
      gitExec(["rev-parse", "--verify", "--quiet", upstreamRef], projectDir, { nativeParity });
      const counted = gitExec(["rev-list", "--count", `${upstreamRef}..${pushBranch}`], projectDir, { timeoutMs: 5000, nativeParity }).trim();
      const parsed = Number.parseInt(counted, 10);
      aheadCount = Number.isFinite(parsed) ? parsed : null;
    } catch {
      aheadCount = null;
    }

    const dirtyItems = auditWorktreeState();
    const unmergedWIs = dirtyItems
      .filter(d => d.issues.some(i => i.type === "unmerged"))
      .map((item) => ({
        wiId: item.wiId,
        title: item.title,
        branchName: item.branchName,
        message: item.issues.find(i => i.type === "unmerged")?.message || "",
      }));
    return {
      hasRemote: true,
      branch,
      remotes,
      targetBranch,
      mergedCount,
      pushBranchInfo,
      pushBranch,
      pushBranchWorkItem: pushBranchWorkItem ? {
        wiId: pushBranchWorkItem.id,
        title: pushBranchWorkItem.title,
        mergeState: pushBranchWorkItem.merge_state,
      } : null,
      effectiveRemote,
      workingTreeStatus,
      unmergedWIs,
      aheadCount,
    };
  }

  function collectPushOfferStateAsync(mergedCount, workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("collectPushOfferState", { mergedCount }, workerOptions);
  }

  let sharedTrunkRoutingProblemLogged = false;
  async function isEnrolledSharedTrunkPair(remote, branch) {
    // Automatic-publication routing must degrade to the legacy manual
    // push-offer path — never crash wrap-up, and never cancel the operator's
    // manual escape hatch — when the enrollment is invalid or the native
    // contract is unavailable. The merge coordinator independently fails
    // closed before any trunk write in both situations.
    let config;
    try {
      config = await resolveSharedTrunkConfigRuntime(projectDir, {
        nativeCapabilityPreflight: async ({ projectDir: root }) => {
          const { getSharedTrunkNativeCapabilities } = await import("./shared-trunk-native.js");
          return getSharedTrunkNativeCapabilities(root);
        },
      });
    } catch (err) {
      if (!sharedTrunkRoutingProblemLogged) {
        sharedTrunkRoutingProblemLogged = true;
        try {
          logEvent({
            event_type: EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Shared-trunk push routing degraded to manual offers: ${err?.message || err}`,
            event_json: JSON.stringify({ error: err?.message || String(err), error_code: err?.code || null, push_routing: true }),
          });
        } catch { /* routing must not depend on telemetry */ }
      }
      return false;
    }
    return config.enabled
      && String(remote || "") === config.remote
      && String(branch || "") === config.branch;
  }

  async function refreshPushOfferGate(mergedCount = 0, { createdBy = "post_merge_closeout" } = {}) {
    const state = await collectPushOfferStateAsync(mergedCount);
    if (state?.effectiveRemote && state?.pushBranch
      && await isEnrolledSharedTrunkPair(state.effectiveRemote, state.pushBranch)) {
      cancelOpenPushOfferGateForTarget(
        state.effectiveRemote,
        state.pushBranch,
        "shared_trunk_publishes_automatically",
      );
      return { ok: false, reason: "shared_trunk_automatic_publication", state };
    }
    const aheadCount = Number.isFinite(state?.aheadCount) ? state.aheadCount : 0;
    if (!state?.hasRemote || !state?.pushBranch || state.pushBranchWorkItem
      || (Number(mergedCount) <= 0 && aheadCount <= 0)) {
      cancelOpenPushOfferGates("post_merge_state_has_no_push_offer");
      return { ok: false, reason: "nothing_to_push", state };
    }
    return { ...upsertPushOfferGate(state, { createdBy }), state };
  }

  // This is also the shared-trunk publication gate. Keep marker validation and
  // the repository hook in one implementation so automatic CAS publication
  // cannot be weaker than an operator-initiated push.
  function validatePushCandidate({ pushBranch }) {
    try {
      const markerCheck = gitExec([
        "grep",
        "-l",
        "-e",
        "^<<<<<<<",
        "-e",
        "^=======$",
        "-e",
        "^>>>>>>>",
        "HEAD",
        "--",
        ".",
        ":(exclude).posse/**",
      ], projectDir, { timeoutMs: 10000, nativeParity }).trim();
      if (markerCheck) {
        return {
          ok: false,
          reason: "conflict_markers",
          files: markerCheck.split("\n").filter(Boolean).map((file) => file.replace(/^HEAD:/, "")),
        };
      }
    } catch (err) {
      // git grep exits 1 when no matches are found. Every other error fails
      // closed, including native route/capability failures.
      if (err?.status !== 1) {
        return {
          ok: false,
          reason: "marker_check_failed",
          output: String(err?.message || err).split("\n")[0],
        };
      }
    }

    const gate = runHook("pre_push_gate", { cwd: projectDir, targetBranch: pushBranch, nativeParity });
    if (!gate.ok) return { ok: false, reason: "gate_failed", output: gate.output || "" };
    return { ok: true };
  }

  function executePush({ effectiveRemote, pushBranch, mergedCount = 0 }) {
    const pushBranchWorkItem = workItemForBranch(pushBranch);
    if (pushBranchWorkItem) {
      return {
        ok: false,
        reason: "work_item_push_target",
        wiId: pushBranchWorkItem.id,
        pushBranch,
      };
    }

    const validation = validatePushCandidate({ pushBranch });
    if (!validation.ok) return validation;

    try {
      gitExec(["push", effectiveRemote, pushBranch], projectDir, { timeoutMs: GIT_MERGE_TIMEOUT_MS, nativeParity });
      logEvent({
        event_type: EVENT_TYPES.GIT_PUSHED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: `Pushed ${pushBranch} to ${effectiveRemote} after merging ${mergedCount} WI(s)`,
      });
      return { ok: true, effectiveRemote, pushBranch };
    } catch (pushErr) {
      const stderr = pushErr.stderr ? pushErr.stderr.toString().trim() : pushErr.message;
      return { ok: false, reason: "push_failed", output: stderr || String(pushErr?.message || pushErr) };
    }
  }

  async function executePushAsync(args = {}, workerOptions = {}) {
    if (args?.effectiveRemote && args?.pushBranch
      && await isEnrolledSharedTrunkPair(args.effectiveRemote, args.pushBranch)) {
      cancelOpenPushOfferGateForTarget(
        args.effectiveRemote,
        args.pushBranch,
        "shared_trunk_publishes_automatically",
      );
      return { ok: false, reason: "shared_trunk_automatic_publication" };
    }
    return runGitWorkflowTaskOffMainThread("executePush", args, workerOptions);
  }

  async function offerPush(mergedCount) {
    let state;
    try {
      state = await collectPushOfferStateAsync(mergedCount);
    } catch (err) {
      console.log(`  ${C.yellow}Push check skipped: ${err?.message || String(err)}${C.reset}`);
      console.log("");
      return;
    }

    if (!state?.hasRemote) {
      console.log("");
      return;
    }

    if (state.effectiveRemote && state.pushBranch
      && await isEnrolledSharedTrunkPair(state.effectiveRemote, state.pushBranch)) {
      cancelOpenPushOfferGateForTarget(
        state.effectiveRemote,
        state.pushBranch,
        "shared_trunk_publishes_automatically",
      );
      console.log("");
      return;
    }

    const targetBranch = state.targetBranch || currentTargetBranch();
    const pushBranchInfo = state.pushBranchInfo || {};
    if (!pushBranchInfo.branch) {
      if (mergedCount > 0) {
        console.log(`\n  ${C.bold}${mergedCount} work item(s) merged, but no local branch is available to push.${C.reset}`);
        console.log(`  ${C.yellow}Configured target branch ${C.cyan}${targetBranch}${C.yellow} is not a local branch.${C.reset}`);
        console.log(`  ${C.dim}Create/check out the target branch or update Posse admin setting target_branch before pushing.${C.reset}`);
      }
      console.log("");
      return;
    }

    // The offer is warranted by unpushed commits on the push branch, not just
    // by merges performed in this wrap-up pass: WIs auto-merged mid-run land
    // before the wrap-up counts them and would otherwise strand unpushed.
    const aheadCount = Number.isFinite(state.aheadCount) ? state.aheadCount : 0;
    if (mergedCount <= 0 && aheadCount <= 0) {
      console.log("");
      return;
    }

    const pushBranch = state.pushBranch;
    const effectiveRemote = state.effectiveRemote;
    if (state.pushBranchWorkItem) {
      const wiId = state.pushBranchWorkItem.wiId ?? state.pushBranchWorkItem.wi_id ?? "?";
      console.log(`\n  ${C.red}${C.bold}\u2717 Refusing to push work-item branch ${C.cyan}${pushBranch}${C.reset}${C.red}.${C.reset}`);
      console.log(`  ${C.yellow}WI#${wiId} must be merged into ${targetBranch} before any remote push.${C.reset}`);
      console.log(`  ${C.dim}Set Repo -> git & merge -> target_branch if trunk was detected incorrectly, then run posse merge/review.${C.reset}`);
      console.log("");
      return;
    }
    if (mergedCount > 0) {
      console.log(`\n  ${C.bold}${mergedCount} work item(s) merged into ${C.cyan}${pushBranch}${C.reset}`);
    } else {
      console.log(`\n  ${C.bold}${aheadCount} unpushed commit(s) on ${C.cyan}${pushBranch}${C.reset}${C.bold} from earlier merges${C.reset}`);
    }
    if (mergedCount > 0 && aheadCount > 0) {
      console.log(`  ${C.dim}${aheadCount} commit(s) ahead of ${effectiveRemote}/${pushBranch}${C.reset}`);
    }
    if (pushBranchInfo.fallback) {
      console.log(`  ${C.yellow}Configured target branch ${C.cyan}${pushBranchInfo.missingBranch}${C.yellow} is not a local branch; using ${C.cyan}${pushBranch}${C.yellow} for push.${C.reset}`);
    }

    const workingTreeStatus = String(state.workingTreeStatus || "").trim();
    if (workingTreeStatus) {
      const statusLines = workingTreeStatus.split("\n");
      console.log(`\n  ${C.red}${C.bold}\u26a0 Working tree has ${statusLines.length} uncommitted change(s):${C.reset}`);
      for (const line of statusLines.slice(0, 8)) {
        console.log(`    ${C.dim}${line}${C.reset}`);
      }
      if (statusLines.length > 8) {
        console.log(`    ${C.dim}... and ${statusLines.length - 8} more${C.reset}`);
      }
      console.log(`\n  ${C.yellow}These changes are NOT included in the merge commits.${C.reset}`);
      console.log(`  ${C.yellow}Pushing now will only push the merged work, not these uncommitted files.${C.reset}`);
    }

    const unmergedWIs = Array.isArray(state.unmergedWIs) ? state.unmergedWIs : [];
    if (unmergedWIs.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${unmergedWIs.length} branch(es) with commits NOT in this push:${C.reset}`);
      for (const item of unmergedWIs) {
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${(item.title || "").slice(0, 50)} \u2014 ${item.message}`);
      }
      console.log(`  ${C.dim}Use 'posse review' or 'posse merge' to include them.${C.reset}`);
    }

    // Persist the offer as a bridge gate FIRST, regardless of TTY: the
    // phone (or a later CLI session) can deploy even when nobody answers
    // here. Pushing below closes the gate; declining leaves it open.
    let pushGate = { ok: false };
    try {
      pushGate = upsertPushOfferGate(state, { createdBy: "run_wrapup" });
    } catch (err) {
      console.log(`  ${C.dim}Push gate not created: ${err?.message || err}${C.reset}`);
    }

    // Headless/explicit batch mode: never prompt. The gate above carries the
    // offer for the app or a later terminal session.
    if (!process.stdin.isTTY || nonInteractive) {
      console.log(`  ${C.dim}Push offer available \u2014 answer from the Posse app, or run: git push${C.reset}`);
      console.log("");
      return;
    }

    const answer = await askSingleKeyYesNo(`  Push to remote? [y/N] `, { fallbackAsk: askFn });
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log(`  ${C.dim}Skipped push. You can push manually, or from the Posse app.${C.reset}`);
      console.log("");
      return;
    }

    console.log(`  ${C.dim}Pushing ${pushBranch} to ${effectiveRemote}...${C.reset}`);
    const pushOutcome = await withMergeLock(async () => {
      const result = await executePushAsync({ effectiveRemote, pushBranch, mergedCount }).catch((err) => ({
        ok: false,
        reason: "push_failed",
        output: err?.message || String(err),
      }));
      if (result.ok) {
        try {
          markOpenPushOfferGatePushed({ remote: effectiveRemote, branch: pushBranch, via: "terminal" });
        } catch { /* gate close is best-effort; supersede covers stragglers */ }
      }
      return result;
    }, {
      ownerId: `merge-${process.pid}-terminal-git-push`,
    });
    const pushed = pushOutcome.acquired
      ? pushOutcome.result
      : { ok: false, reason: "merge_in_progress", output: "A merge or push is already in progress" };
    if (pushed.ok) {
      console.log(`  ${C.green}\u2713 Pushed to ${effectiveRemote}${C.reset}`);
    } else if (pushed.reason === "work_item_push_target") {
      console.log(`  ${C.red}\u2717 Refusing to push work-item branch ${pushBranch}; merge WI#${pushed.wiId ?? "?"} into ${targetBranch} first.${C.reset}`);
    } else if (pushed.reason === "conflict_markers") {
      const files = Array.isArray(pushed.files) ? pushed.files : [];
      console.log(`  ${C.red}\u2717 Conflict markers found in ${files.length} file(s) — refusing to push:${C.reset}`);
      for (const f of files.slice(0, 5)) {
        console.log(`    ${C.dim}${f}${C.reset}`);
      }
      if (files.length > 5) console.log(`    ${C.dim}... and ${files.length - 5} more${C.reset}`);
      console.log(`  ${C.dim}Resolve conflicts first, then push manually: git push${C.reset}`);
    } else if (pushed.reason === "gate_failed") {
      const output = String(pushed.output || "");
      console.log(`  ${C.red}\u2717 ${output.split("\n")[0] || "Pre-push gate failed"}${C.reset}`);
      const extra = output.split("\n").slice(1, 8);
      for (const line of extra) {
        console.log(`  ${C.dim}${line}${C.reset}`);
      }
      console.log(`  ${C.dim}Push skipped until the gate passes.${C.reset}`);
    } else {
      const output = String(pushed.output || "unknown error");
      console.log(`  ${C.red}\u2717 Push failed: ${output.split("\n")[0]}${C.reset}`);
    }

    console.log("");
  }

  /**
   * Startup cleanup: enforce target-branch cleanliness, then run shared worktree GC.
   * The worker-owned GC path is the source of truth for preserving dirty state
   * before cleaning startup worktrees.
   */

  return {
    collectPushOfferState,
    collectPushOfferStateAsync,
    refreshPushOfferGate,
    executePush,
    executePushAsync,
    validatePushCandidate,
    offerPush,
  };
}
