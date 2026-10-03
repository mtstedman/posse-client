// `posse session merge|deploy|auto`: the team's work leaves a pairing session
// while it keeps running. merge squashes the shared trunk into the host's
// local target branch; deploy pushes that branch to origin, merging first.
// Each is `ask` (the host approves with a typed yes) or `auto` (an unattended
// run started by the session owner when team work lands).
//
// The session console runs these as a child process (like `add` and `go`):
// the child owns the terminal and Ctrl+C while the host decides, and its git
// can never stall the console's heartbeat. Nothing here writes the close
// promotion journal, so crash recovery never mistakes a merge for a close.

import { SESSION_AUTO_PUBLISH_POLICY, SESSION_PUBLISH_MODES } from "../../../catalog/session-sync.js";
import { SHARED_TRUNK_MERGE_LOCK_OWNERS } from "../../../catalog/shared-trunk.js";
import { adminGitExecAsync } from "../../git/functions/admin-git.js";
import { syncSharedTrunkFromOrigin } from "../../git/functions/shared-trunk.js";
import { withMergeLock } from "../../queue/functions/locks.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS, writeRuntimeStatus } from "../../queue/functions/runtime-status.js";
import { askToPublishPromotion, printPromotionForApproval } from "./approval-prompt.js";
import { repositoryRoot, validateRemoteName } from "./git.js";
import { readPairingPromotionJournal } from "./promotion.js";
import { activeSessionCloseClaim } from "./session-close-claim.js";
import {
  buildSessionSquash,
  describeSessionPublish,
  fetchSessionOrigin,
  findSessionSquash,
  gitSupportsSessionPublish,
  isSessionAncestor,
  localBranchSha,
  moveLocalTarget,
  planSessionOnto,
  pushSessionCandidate,
  resolveSessionSquashBase,
  sessionCommitsBetween,
  validateSessionPushCandidate,
} from "./session-publish.js";
import { getLivePairingState, getPairingState, updateSessionPublishSettings } from "./state.js";
import { sessionProvenanceIdentities } from "./work-items.js";

const LOCK_RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 3_000, 5_000]);
// Failures that can clear up by themselves; they back off and retry, up to
// SESSION_AUTO_PUBLISH_POLICY.MAX_CONSECUTIVE_FAILURES in a row. Anything else
// pauses auto mode at once.
const TRANSIENT_CODES = new Set([
  "session_publish_busy",
  "session_publish_trunk_unavailable",
  "session_publish_origin_unavailable",
  "session_publish_push_failed",
  "session_publish_target_moved",
  "session_publish_run_lost",
]);
// What origin says when it refuses a push for good (a protected branch, a
// pre-receive hook, missing permission or signature): retrying cannot help.
const PUSH_REFUSED_PATTERNS = Object.freeze([
  /\[remote rejected\]/iu,
  /pre-receive hook declined/iu,
  /protected branch/iu,
  /permission (?:to .+ )?denied/iu,
  /\bGH0\d\d\b/u,
  /must be signed|signature/iu,
  /authentication failed/iu,
]);
// How long a typed close waits for an auto run already in flight.
const CLOSE_WAITS_FOR_AUTO_RUN_MS = 60_000;

function publishError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortSha(value) {
  return String(value || "").slice(0, 8);
}

/** The live host session this command acts on, or a refusal saying why not. */
function sessionForPublish(stateId = null) {
  const state = stateId ? getPairingState(stateId) : getLivePairingState();
  if (!state || state.phase !== "active") {
    throw publishError("pairing_host_session_required", "This clone is not hosting a live session");
  }
  if (state.role !== "host") {
    throw publishError("session_publish_host_only", "Only the session host can merge or deploy the session's work");
  }
  if (activeSessionCloseClaim({ stateId: state.id })) {
    throw publishError("session_close_in_progress", "The session is closing; its close integrates the remaining work");
  }
  if (readPairingPromotionJournal()) {
    throw publishError("session_publish_close_pending",
      "A close integration is pending; finish it with `posse session integrate` first");
  }
  if (state.close_action === "integrate-fast-forward") {
    throw publishError("session_publish_history_preserving",
      "This session is set to close history-preserving, which squash merges would break; close it to publish its history");
  }
  return state;
}

async function withPublishLock(callback, { delays = LOCK_RETRY_DELAYS_MS, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const locked = await withMergeLock(callback, {
      ownerId: `merge-${process.pid}-${SHARED_TRUNK_MERGE_LOCK_OWNERS.SESSION_PUBLISH}`,
    });
    if (locked.acquired) return locked.result;
    if (attempt >= delays.length) {
      throw publishError("session_publish_busy", "The shared trunk is busy (a merge or sync is running); try again shortly");
    }
    await wait(delays[attempt]);
  }
}

/**
 * The trunk tip to merge: fetched and provenance-checked exactly as close's
 * final sync checks it, without moving the host's checkout (which is usually
 * mid-edit) and without raising a gate for it.
 */
async function takeVerifiedTrunk(root, state, { sync, delays = LOCK_RETRY_DELAYS_MS, wait = sleep }) {
  const gitIdentities = sessionProvenanceIdentities(state.remote_session_id);
  for (let attempt = 0; ; attempt += 1) {
    const synced = await sync(root, {
      holdFastForward: true,
      raiseBlockedGate: false,
      provenance: state.baseline_oid ? { baselineOid: state.baseline_oid, gitIdentities } : null,
    });
    if (synced?.ok && /^[0-9a-f]{40,64}$/u.test(String(synced.remoteSha || ""))) return synced.remoteSha;
    if (synced?.reason === "merge_in_progress" && attempt < delays.length) {
      await wait(delays[attempt]);
      continue;
    }
    if (synced?.reason === "shared_trunk_provenance_blocked") {
      throw publishError("session_publish_trunk_unavailable",
        "The shared trunk has commits Posse cannot attribute to a session member yet; nothing was merged");
    }
    throw publishError("session_publish_trunk_unavailable",
      `Could not take the shared trunk (${synced?.reason || "unknown"}); nothing was merged`);
  }
}

function checkStillOpen(state) {
  if (activeSessionCloseClaim({ stateId: state.id })) {
    throw publishError("session_close_in_progress", "The session started closing; its close integrates this work instead");
  }
  if (readPairingPromotionJournal()) {
    throw publishError("session_publish_close_pending", "A close integration started; its close integrates this work instead");
  }
}

/** What a deploy sends to origin, for the host to approve. */
async function describeDeploy(root, { state, remote, targetBranch, originSha, tip, trunk, built, exec }) {
  const sessionId = state.remote_session_id;
  const deployed = await findSessionSquash(root, originSha, sessionId, { exec });
  const from = deployed?.trunk || state.original_head;
  const to = trunk || (await findSessionSquash(root, tip, sessionId, { exec }))?.trunk;
  let commits = [];
  if (from && to) {
    try {
      commits = await sessionCommitsBetween(root, from, to, { exec });
    } catch { /* the list is advisory; the diffstat below is exact */ }
  }
  const squashes = String(await exec(["rev-list", "--count", `${originSha}..${tip}`], root)).trim();
  const summary = await describeSessionPublish(root, {
    target: `${remote}/${targetBranch}`, commits, from: originSha, to: tip, exec,
  });
  return {
    ...summary,
    ridingMerges: Math.max(0, (Number(squashes) || 0) - (built && !built.empty ? 1 : 0)),
  };
}

function autoRecord(sessionId) {
  const record = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_AUTO_PUBLISH);
  return record?.session_id === sessionId ? record : { session_id: sessionId };
}

function writeAutoRecord(sessionId, values) {
  writeRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_AUTO_PUBLISH, { ...autoRecord(sessionId), ...values, session_id: sessionId });
}

/**
 * Merge or deploy the session's work. Returns a result object; throws a coded
 * error when it refuses. `unattended` is the owner's auto run: it acts only
 * in auto mode, never prompts, and never merges for a deploy unless merge is
 * auto too.
 */
export async function runSessionPublish({
  action,
  projectDir = process.cwd(),
  unattended = false,
  C,
  json = false,
  log = console.log,
  input = process.stdin,
  output = process.stdout,
  ask = askToPublishPromotion,
  sync = syncSharedTrunkFromOrigin,
  push = pushSessionCandidate,
  gate = validateSessionPushCandidate,
  exec = adminGitExecAsync,
} = {}) {
  if (!["merge", "deploy"].includes(action)) throw publishError("session_publish_action_invalid", `Unknown action ${action}`);
  const deploy = action === "deploy";
  let state = sessionForPublish();
  const mode = deploy ? state.deploy_mode : state.merge_mode;
  if (unattended && mode !== SESSION_PUBLISH_MODES.AUTO) return { ok: true, skipped: "not_auto", action };
  const mayMerge = !unattended || !deploy || state.merge_mode === SESSION_PUBLISH_MODES.AUTO;
  const say = (message) => { if (!json) log(`  ${C.cyan}[session ${action}]${C.reset} ${message}`); };
  const root = repositoryRoot(projectDir);
  if (!(await gitSupportsSessionPublish(root, { exec }))) {
    throw publishError("session_publish_git_too_old", "In-session merge and deploy need git 2.40 or newer; update git and try again");
  }
  const remote = validateRemoteName(state.origin_remote_name || "origin");
  const targetBranch = state.original_branch;
  const sessionId = state.remote_session_id;
  const sshCommand = state.original_ssh_command;
  const attempts = unattended ? 2 : 3;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const trunk = mayMerge ? await takeVerifiedTrunk(root, state, { sync }) : null;
    let originSha;
    try {
      originSha = await fetchSessionOrigin(root, { remote, targetBranch, sshCommand, exec });
    } catch (error) {
      if (error?.code === "session_publish_origin_missing") throw error;
      throw publishError("session_publish_origin_unavailable", `Could not fetch ${remote}/${targetBranch}: ${String(error?.message || error).split("\n")[0]}`);
    }
    const localSha = await localBranchSha(root, targetBranch, { exec });
    // Once this session deployed, origin must still hold its squash: without
    // it the base falls back to the session's start and the merge would bring
    // back what the team undid since. Someone rewrote origin; refuse.
    if (state.last_deploy_oid && !(await findSessionSquash(root, originSha, sessionId, { exec }))) {
      throw publishError("session_publish_deploy_vanished",
        `${remote}/${targetBranch} no longer holds this session's deploy ${shortSha(state.last_deploy_oid)} (history was rewritten); merge it by hand`);
    }
    const plan = await planSessionOnto(root, { localSha, originSha, sessionId, targetBranch, exec });
    let tip = plan.onto;
    let built = null;
    if (mayMerge) {
      const { base } = await resolveSessionSquashBase(root, {
        onto: plan.onto, trunk, sessionId, originalHead: state.original_head, exec,
      });
      built = await buildSessionSquash(root, { onto: plan.onto, trunk, base, sessionId, exec });
      if (!built.empty) tip = built.commit;
    } else if (plan.relation === "diverged") {
      throw publishError("session_publish_needs_merge",
        `${remote}/${targetBranch} moved under the session's undeployed merge, which must be merged again with your approval: run deploy`);
    }

    if (!deploy) {
      if (built.empty) {
        if (plan.relation === "diverged") {
          // The undeployed merge's content reached origin another way; local
          // follows origin (the replaced tip is kept) so a later close or
          // `session host` does not trip over it.
          await withPublishLock(async () => {
            checkStillOpen(state);
            await moveLocalTarget(root, { targetBranch, next: originSha, expected: localSha, sessionId, exec });
          });
        }
        if (unattended) writeAutoRecord(sessionId, { evaluated_trunk: trunk, failures: 0, retry_after: null });
        say(`Nothing new: local ${targetBranch} already has the session's work (trunk ${shortSha(trunk)}).`);
        return { ok: true, action, nothing: true, trunk };
      }
      const summary = {
        ...(await describeSessionPublish(root, {
          target: `local ${targetBranch}`, commits: built.commits, from: plan.onto, to: tip, exec,
        })),
        heading: `Ready to merge into local ${targetBranch}`,
      };
      if (mode === SESSION_PUBLISH_MODES.ASK) {
        if (!json) printPromotionForApproval(C, summary, log);
        // --json output is for scripts: a prompt there would corrupt it.
        const approved = json ? null : await ask(C, summary, {
          input, output,
          question: `\n  Type ${C.bold}yes${C.reset} to merge into local ${C.cyan}${targetBranch}${C.reset} (anything else cancels): `,
        });
        if (approved !== true) {
          say(approved === null ? "Needs your approval in a terminal (or turn on auto merge); nothing was merged." : "Cancelled; nothing was merged.");
          return { ok: false, action, cancelled: true, reason: approved === null ? "approval_unavailable" : "declined" };
        }
      }
      try {
        await withPublishLock(async () => {
          checkStillOpen(state);
          await moveLocalTarget(root, { targetBranch, next: tip, expected: localSha, sessionId, exec });
        });
      } catch (error) {
        if (error?.code === "session_publish_target_moved" && attempt + 1 < attempts) continue;
        throw error;
      }
      state = updateSessionPublishSettings(state.id, { lastMergeOid: tip });
      if (unattended) writeAutoRecord(sessionId, { evaluated_trunk: trunk, failures: 0, retry_after: null });
      say(`Merged ${built.commits.length} session commit(s) into local ${targetBranch} (${shortSha(tip)}). Run deploy to push it to ${remote}.`);
      return { ok: true, action, merged: true, mergeOid: tip, trunk };
    }

    // Deploy.
    if (tip === originSha) {
      if (localSha && localSha !== originSha && plan.relation === "diverged") {
        // The undeployed merge's content reached origin another way.
        await withPublishLock(async () => {
          checkStillOpen(state);
          await moveLocalTarget(root, { targetBranch, next: originSha, expected: localSha, sessionId, exec });
        });
      }
      // A deploy whose push was reported lost but landed is recorded now, so
      // the deploy tripwire knows origin holds this session's work.
      const onOrigin = await findSessionSquash(root, originSha, sessionId, { exec, since: state.original_head });
      if (onOrigin && state.last_deploy_oid !== onOrigin.commit) {
        state = updateSessionPublishSettings(state.id, { lastDeployOid: onOrigin.commit });
      }
      if (unattended && trunk) writeAutoRecord(sessionId, { evaluated_trunk: trunk, failures: 0, retry_after: null });
      say(`Nothing to deploy: ${remote}/${targetBranch} already has the session's work.`);
      return { ok: true, action, nothing: true, trunk };
    }
    checkStillOpen(state);
    const validation = await gate(root, { candidate: tip, originSha, exec, onProgress: say });
    if (!validation?.ok) {
      const detail = validation?.files?.length ? `: ${validation.files.slice(0, 5).join(", ")}` : validation?.output ? `\n${validation.output}` : "";
      throw publishError("session_publish_gate_failed", `The push gate refused the candidate (${validation?.reason || "unknown"})${detail}`, { validation });
    }
    const needsApproval = mode === SESSION_PUBLISH_MODES.ASK
      || (built && !built.empty && state.merge_mode === SESSION_PUBLISH_MODES.ASK);
    if (needsApproval) {
      const summary = await describeDeploy(root, { state, remote, targetBranch, originSha, tip, trunk, built, exec });
      if (!json) printPromotionForApproval(C, summary, log);
      const approved = json ? null : await ask(C, summary, {
        input, output,
        question: `\n  Type ${C.bold}yes${C.reset} to deploy to ${C.cyan}${remote}/${targetBranch}${C.reset} (anything else cancels): `,
      });
      if (approved !== true) {
        say(approved === null ? "Needs your approval in a terminal (or turn on auto deploy); nothing was deployed." : "Cancelled; nothing was deployed.");
        return { ok: false, action, cancelled: true, reason: approved === null ? "approval_unavailable" : "declined" };
      }
    }
    if (tip !== localSha) {
      try {
        await withPublishLock(async () => {
          checkStillOpen(state);
          await moveLocalTarget(root, { targetBranch, next: tip, expected: localSha, sessionId, exec });
        });
      } catch (error) {
        if (error?.code === "session_publish_target_moved" && attempt + 1 < attempts) continue;
        throw error;
      }
      if (built && !built.empty) state = updateSessionPublishSettings(state.id, { lastMergeOid: tip });
    }
    checkStillOpen(state);
    if (!(await isSessionAncestor(root, originSha, tip, { exec }))) {
      throw publishError("session_publish_not_fast_forward", `${shortSha(tip)} does not extend ${remote}/${targetBranch}; refusing to push`);
    }
    say(`Pushing ${shortSha(tip)} to ${remote}/${targetBranch}`);
    try {
      push(root, { remote, targetBranch, candidate: tip, sshCommand });
    } catch (error) {
      let observed = null;
      try { observed = await fetchSessionOrigin(root, { remote, targetBranch, sshCommand, exec }); } catch { /* reported below */ }
      const landed = observed === tip
        || (observed && observed !== originSha && await isSessionAncestor(root, tip, observed, { exec }));
      if (landed) {
        // The push landed (someone may already have built on it); only its
        // report was lost.
      } else if (observed && observed !== originSha && attempt + 1 < attempts) {
        say(`${remote}/${targetBranch} moved during the push; rebuilding on it`);
        continue;
      } else {
        throw pushFailure(error, { remote, targetBranch });
      }
    }
    state = updateSessionPublishSettings(state.id, { lastDeployOid: tip });
    if (unattended) writeAutoRecord(sessionId, { ...(trunk ? { evaluated_trunk: trunk } : {}), failures: 0, retry_after: null });
    say(`Deployed ${shortSha(tip)} to ${remote}/${targetBranch}; the session keeps running.`);
    return { ok: true, action, deployed: true, deployOid: tip, merged: Boolean(built && !built.empty), trunk };
  }
  throw publishError("session_publish_target_moved", `${remote}/${targetBranch} or local ${targetBranch} kept moving; try again`);
}

function pushFailure(error, { remote, targetBranch }) {
  const stderr = String(error?.stderr || "").trim();
  const detail = (stderr.split(/\r?\n/u).filter((line) => line.trim()).slice(-3).join(" / ")
    || String(error?.message || error).split("\n")[0]).slice(0, 400);
  const refused = PUSH_REFUSED_PATTERNS.some((pattern) => pattern.test(stderr || String(error?.message || "")));
  return publishError(refused ? "session_publish_push_refused" : "session_publish_push_failed",
    `${remote} ${refused ? "refused" : "did not take"} the push to ${targetBranch}: ${detail}. Local ${targetBranch} keeps the merge; `
      + (refused ? "fix the cause on origin, then run deploy again" : "run deploy again"));
}

/**
 * What an unattended run does with its failure: a transient one is retried
 * later with backoff, until too many in a row; any other pauses that action
 * back to `ask` and says why.
 */
export function recordUnattendedFailure(action, error, { nowMs = Date.now(), policy = SESSION_AUTO_PUBLISH_POLICY } = {}) {
  const state = getLivePairingState();
  if (!state?.remote_session_id) return { paused: false };
  const record = autoRecord(state.remote_session_id);
  const failures = (Number(record.failures) || 0) + 1;
  if (TRANSIENT_CODES.has(error?.code) && failures < policy.MAX_CONSECUTIVE_FAILURES) {
    const delay = Math.min(policy.RETRY_MAX_MS, policy.RETRY_BASE_MS * 2 ** (failures - 1));
    writeAutoRecord(state.remote_session_id, { failures, retry_after: new Date(nowMs + delay).toISOString() });
    return { paused: false, retryInMs: delay };
  }
  writeAutoRecord(state.remote_session_id, { failures: 0, retry_after: null });
  const repeated = TRANSIENT_CODES.has(error?.code) ? ` (failed ${failures} times in a row)` : "";
  const reason = `${action}: ${String(error?.message || error).split("\n")[0]}${repeated}`.slice(0, 500);
  updateSessionPublishSettings(state.id, {
    ...(action === "deploy" ? { deployMode: SESSION_PUBLISH_MODES.ASK } : { mergeMode: SESSION_PUBLISH_MODES.ASK }),
    autoPausedReason: reason,
  });
  return { paused: true, reason };
}

/** `auto merge on`, `auto deploy off`: the host's trust setting for each step. */
export function setSessionAutoPublish({ which, value, stateId = null }) {
  if (!["merge", "deploy"].includes(which)) {
    throw publishError("session_publish_action_invalid", "Usage: auto <merge|deploy> <on|off>");
  }
  if (!["on", "off"].includes(value)) {
    throw publishError("session_publish_mode_invalid", "Usage: auto <merge|deploy> <on|off>");
  }
  const state = sessionForPublish(stateId);
  const mode = value === "on" ? SESSION_PUBLISH_MODES.AUTO : SESSION_PUBLISH_MODES.ASK;
  const updated = updateSessionPublishSettings(state.id, {
    ...(which === "merge" ? { mergeMode: mode } : { deployMode: mode }),
    // Turning a step on again, or settling it on ask, is the host's answer
    // to whatever paused it.
    ...(value === "on" || String(state.auto_paused_reason || "").startsWith(`${which}:`) ? { autoPausedReason: null } : {}),
  });
  if (value === "on") writeAutoRecord(state.remote_session_id, { failures: 0, retry_after: null });
  return { ok: true, which, mode, state: updated };
}

function liveAutoRun(state) {
  const run = autoRecord(state.remote_session_id).run;
  const pid = Number(run?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return run;
  } catch (error) {
    return error?.code === "EPERM" ? run : null;
  }
}

async function refShaOrEmpty(root, ref, exec) {
  try {
    const sha = String(await exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root)).trim();
    return /^[0-9a-f]{40,64}$/u.test(sha) ? sha : "";
  } catch {
    return "";
  }
}

/**
 * Why a close would fail after in-session merges, checked before the close
 * tells the Remote, drains members and revokes their keys (none of which can
 * be undone), or null. Reads local refs only. A forced close (Ctrl+C, a lost
 * terminal, crash recovery) skips this and leaves any failure to
 * `posse session integrate`, as today.
 */
export async function sessionClosePreflight(projectDir, state, {
  historyPreserving = false, exec = adminGitExecAsync, waitForAutoRunMs = CLOSE_WAITS_FOR_AUTO_RUN_MS,
  wait = sleep,
} = {}) {
  if (state?.role !== "host" || !state.remote_session_id) return null;
  // An auto merge/deploy in flight would land under the close's candidate and
  // make its approval stale only after members were drained: let it finish.
  const deadline = Date.now() + waitForAutoRunMs;
  for (let run = liveAutoRun(state); run; run = liveAutoRun(state)) {
    if (Date.now() >= deadline) {
      return `auto ${run.action || "publish"} is still running (pid ${run.pid}); close again when it finishes`;
    }
    await wait(1_000);
  }
  try {
    const root = repositoryRoot(projectDir);
    const sessionId = state.remote_session_id;
    const remote = state.origin_remote_name || "origin";
    const targetBranch = state.original_branch;
    const localSha = await localBranchSha(root, targetBranch, { exec });
    const originSha = await refShaOrEmpty(root, `refs/remotes/${remote}/${targetBranch}`, exec);
    const since = state.original_head;
    let merged = Boolean(state.last_deploy_oid);
    for (const ref of [localSha, originSha]) {
      if (!merged && ref && await findSessionSquash(root, ref, sessionId, { exec, since })) merged = true;
    }
    if (!merged) return null;
    if (state.last_deploy_oid && originSha && !(await findSessionSquash(root, originSha, sessionId, { exec, since }))) {
      return `${remote}/${targetBranch} no longer holds this session's deploy ${shortSha(state.last_deploy_oid)} (history was rewritten); `
        + "close with --keep-branch and integrate the session branch by hand";
    }
    if (historyPreserving || state.close_action === "integrate-fast-forward") {
      return "This session merged its work mid-session, so its history cannot be published as is; close without --history-preserving";
    }
    if (!(await gitSupportsSessionPublish(root, { exec }))) {
      return "This session merged mid-session, and closing it needs git 2.40 or newer; update git, then close";
    }
    if (originSha) {
      const plan = await planSessionOnto(root, { localSha, originSha, sessionId, targetBranch, exec });
      const trunk = await refShaOrEmpty(root, `refs/remotes/${state.remote_name}/${state.shared_branch}`, exec);
      if (trunk) {
        await resolveSessionSquashBase(root, {
          onto: plan.onto, trunk, sessionId, originalHead: state.original_head, exec,
        });
      }
    }
    return null;
  } catch (error) {
    if (["session_publish_target_foreign", "session_publish_base_invalid", "session_publish_base_ambiguous"].includes(error?.code)) {
      return error.message;
    }
    // Anything else is the close's to report with its full context.
    return null;
  }
}

/** One line for the session screen and `status`. */
export function describeSessionPublishModes(state) {
  if (!state || state.role !== "host") return null;
  const label = (mode) => (mode === SESSION_PUBLISH_MODES.AUTO ? "auto" : "you approve");
  const parts = [`merge: ${label(state.merge_mode)}`, `deploy: ${label(state.deploy_mode)}`];
  if (state.last_deploy_oid) parts.push(`last deploy ${shortSha(state.last_deploy_oid)}`);
  else if (state.last_merge_oid) parts.push(`last merge ${shortSha(state.last_merge_oid)}`);
  return parts.join(" · ");
}

export const __testSessionPublishCommandInternals = Object.freeze({
  pushFailure,
  SESSION_AUTO_PUBLISH_POLICY,
  TRANSIENT_CODES,
  takeVerifiedTrunk,
  withPublishLock,
});
