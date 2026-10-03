import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import {
  SESSION_LINK_OWNERS,
  SESSION_SYNC_GLYPHS,
  SESSION_SYNC_POLICY,
  SESSION_SYNC_STATES,
  sessionLeaseSec,
  TRUNK_HEAD_PATTERN,
} from "../../../catalog/session-sync.js";
import { ensureBridgeInstanceId } from "../../bridge/functions/auth.js";
import { runSharedTrunkAccessPreflight } from "../../integrations/functions/shared-trunk-preflight.js";
import {
  getLiveSchedulerBlockMessage,
  getSchedulerLockInfo,
} from "../../queue/functions/locks.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS } from "../../queue/functions/runtime-status.js";
import { listUnresolvedSharedTrunkMergeOperations } from "../../queue/functions/shared-trunk-merge-state.js";
import { getSetting, setSetting } from "../../settings/functions/repository-settings.js";
import { withWorktreeLockAsync } from "../../git/functions/worktree-locks.js";
import { cancelSharedTrunkGatesForBranch, syncSharedTrunkFromOrigin } from "../../git/functions/shared-trunk.js";
import { createSharedTrunkPoller } from "../../scheduler/functions/shared-trunk-poller.js";
import { cancelQueuedBranchWarmJobs } from "../../atlas/classes/v2/PipelineHooks.js";
import { pulseTokenManager } from "../../../shared/native/classes/PulseTokenManager.js";
import {
  createPairingRemoteClient,
  validatePairingRemoteResponse,
} from "./remote-client.js";
import {
  addPairingRemote,
  assertHostTrunkMatchesRemote,
  assertPairingRemoteTargets,
  assertCleanPairingCheckout,
  createAndPublishPairingBranch,
  checkoutSharedBranchForClose,
  currentCheckout,
  deletePublishedPairingBranch,
  discardFreshPairingCheckout,
  findPairingRemote,
  initializeFreshPairingCheckout,
  localBranchHead,
  pairingBranchHasOwnCommits,
  pairingTemporaryRemoteName,
  preflightAndCheckoutPairingBranch,
  removeTemporaryRemote,
  remoteDefaultBranch,
  repositoryFingerprint,
  repositoryRoot,
  restoreOriginalBranch,
  validateBranchName,
  validateRemoteName,
} from "./git.js";
import {
  createPairingState,
  getLivePairingState,
  getPairingState,
  listEndedPairingTargets,
  markPairingPhase,
  pairingOwnerProcessIsAlive,
  pairingProcessShouldStop,
  readoptPairingProcess,
  touchPairingState,
  updatePairingEnrollment,
} from "./state.js";
import {
  clearSessionHold,
  readSessionHoldStatus,
  requestSessionResume,
  setSessionHold,
  SESSION_HOLD_STATES,
} from "./session-hold.js";
import { readSessionLink, recordSessionLinkFailure, recordSessionLinkSuccess } from "./session-link.js";
import { readSessionSync, sessionFetchOwnerAlive } from "./session-sync.js";
import { formatSessionLanding, sessionPrompt } from "./session-landing.js";
import { formatPeerSyncRow, formatSyncAge, sessionSyncFeedLabel } from "./sync-state.js";
import {
  clearPairingPeerSnapshot,
  collectPairingJobs,
  collectPairingPresence,
  collectPairingWorkItems,
  diffPairingPeerActivity,
  pairingPeerTrunkHints,
  readPairingPeerSnapshot,
  writePairingPeerSnapshot,
} from "./work-items.js";
import {
  beginPairingPromotion,
  clearPairingPromotionJournal,
  describePairingPromotion,
  markPairingPromotion,
  promotePairingTrunk,
  readPairingPromotionJournal,
} from "./promotion.js";
import { waitForPairingSchedulerStop } from "./shutdown.js";
import {
  activeSessionCloseClaim,
  claimSessionCredentialMutation,
  claimSessionClose,
  releaseSessionCredentialMutation,
  releaseSessionClose,
  renewSessionCredentialMutation,
  renewSessionClose,
  SESSION_CLOSE_CLAIM_RENEW_MS,
} from "./session-close-claim.js";
import {
  teamPolicyRegression,
  teamPolicyRegressionMessage,
} from "./team-policy.js";
import {
  addGitHubMemberDeployKey,
  assertGitHubCliReady,
  assertSessionSshPathSupported,
  cleanupGitHubSessionRepository,
  configureRepositorySessionSsh,
  githubRepositoryName,
  prepareSessionSshIdentity,
  githubSessionRepositoryName,
  provisionGitHubSessionRepository,
  readLocalSshCommand,
  removeGitHubMemberDeployKeys,
  removeSessionCredentialDirectory,
  restoreRepositorySsh,
  revokeGitHubMemberDeployKeys,
  setGitHubDefaultBranch,
} from "./github-session.js";
import {
  createSessionConsole,
  describeSessionWriteScope,
  diffPairingMembers,
  parseSessionConsoleLine,
  sessionConsoleHelp,
  sessionMemberLabel,
  shortId,
} from "./session-console.js";

// This is both the lease heartbeat and the peer-work sync cadence. Five
// seconds keeps the terminal feed live without turning queue changes into one
// remote request apiece.
const HEARTBEAT_MS = 5_000;
const HEARTBEAT_RETRY_MS = 2_000;
const PAIRING_SETTING_KEYS = Object.freeze([
  SETTING_KEYS.TARGET_BRANCH,
  SETTING_KEYS.SHARED_TRUNK_BRANCH,
  SETTING_KEYS.SHARED_TRUNK_REMOTE,
  SETTING_KEYS.SHARED_TRUNK_ENABLED,
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error) {
  return String(error?.message || error || "unknown pairing error")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1***@")
    .replace(/\b(authorization|token|password)=([^\s&]+)/giu, "$1=***")
    .slice(0, 1600);
}

function reportRepositoryCleanupFailure(C, cleanup) {
  if (!cleanup || cleanup.ok) return;
  console.error(`  ${C.yellow}Temporary repository ${cleanup.repository} was not deleted:${C.reset} ${safeError(cleanup.message)}`);
  console.error(`  ${cleanup.remediation}\n`);
}

function sessionChanged(message) {
  return Object.assign(new Error(message), { code: "pairing_session_changed" });
}

function inviteToken(value) {
  const raw = String(value || "").trim();
  if (!raw.toLowerCase().startsWith("posse://")) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname !== "session") throw new Error("wrong invite host");
    const token = String(url.searchParams.get("token") || "").trim();
    if (!token) throw new Error("missing invite token");
    return token;
  } catch {
    throw Object.assign(new Error("The Posse session invite link is invalid"), {
      code: "pairing_invite_invalid",
    });
  }
}

async function waitForPairingAdmission(remoteClient, stateId, pendingToken, {
  C,
  json = false,
} = {}) {
  let interrupted = false;
  const stop = () => { interrupted = true; };
  // `on`, not `once`: a Ctrl+C that belonged to a foreground command must
  // leave the handler in place for the next one.
  process.on("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!interrupted) {
      const state = getPairingState(stateId);
      if (!state || state.phase !== "pending") {
        return { status: "left" };
      }
      const pending = validatePairingRemoteResponse(
        "pending",
        await remoteClient.pendingStatus(pendingToken),
      );
      if (pending.session_id !== state.remote_session_id) {
        throw sessionChanged("Pending credential resolved to a different session");
      }
      assertPairingRepositoryUnchanged({
        url: state.remote_url,
        branch: state.shared_branch,
      }, pending.repository);
      touchPairingState(stateId, undefined, ["pending"]);
      if (pending.status !== "pending") return pending;
      await sleep(2_000);
    }
    if (!json) console.log(`\n  ${C.yellow}Session join cancelled.${C.reset}\n`);
    return { status: "left" };
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function assertPairingRepositoryUnchanged(expected, received) {
  let expectedFingerprint;
  let receivedFingerprint;
  try {
    expectedFingerprint = repositoryFingerprint(expected?.url);
    receivedFingerprint = repositoryFingerprint(received?.url);
  } catch {
    throw sessionChanged("Pairing repository metadata changed during enrollment");
  }
  if (receivedFingerprint !== expectedFingerprint
    || String(received?.fingerprint || "").toLowerCase() !== expectedFingerprint
    || String(received?.branch || "") !== String(expected?.branch || "")) {
    throw sessionChanged("Pairing repository metadata changed during enrollment");
  }
}

function assertPairingStatusMatches(state, status) {
  if (status.session_id !== state.remote_session_id || status.role !== state.role) {
    throw sessionChanged("Pairing relay credential resolved to a different session");
  }
  assertPairingRepositoryUnchanged({
    url: state.remote_url,
    branch: state.shared_branch,
  }, status.repository);
}

export function parsePairArgs(argv = []) {
  const args = [...argv].map(String);
  let json = false;
  let remoteValue = null;
  let branch = null;
  let hasRemoteFlag = false;
  let hasBranchFlag = false;
  let keepBranch = false;
  let historyPreserving = false;
  let approvedSourceOid = null;
  let approvedOriginOid = null;
  // Join in this clone. The entry script reads it before any folder move
  // (join-folder.js); here it only has to be valid.
  let here = false;
  const positional = [];
  const assignFlag = (name, value) => {
    const normalized = String(value || "").trim();
    if (!normalized) {
      throw Object.assign(new Error(`${name} requires a ${name === "--remote" ? "Git remote name" : "branch name"}`), {
        code: name === "--remote" ? "pairing_remote_required" : "pairing_branch_required",
      });
    }
    if ((name === "--remote" && hasRemoteFlag) || (name === "--branch" && hasBranchFlag)) {
      throw Object.assign(new Error(`${name} may only be specified once`), {
        code: "pairing_option_duplicate",
      });
    }
    if (name === "--remote") {
      hasRemoteFlag = true;
      remoteValue = normalized;
    } else {
      hasBranchFlag = true;
      branch = normalized;
    }
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (json) {
        throw Object.assign(new Error("--json may only be specified once"), {
          code: "pairing_option_duplicate",
        });
      }
      json = true;
      continue;
    }
    if (arg === "--here") {
      here = true;
      continue;
    }
    if (arg === "--keep-branch") {
      if (keepBranch) {
        throw Object.assign(new Error("--keep-branch may only be specified once"), {
          code: "pairing_option_duplicate",
        });
      }
      keepBranch = true;
      continue;
    }
    if (arg === "--history-preserving") {
      if (historyPreserving) throw Object.assign(new Error("--history-preserving may only be specified once"), {
        code: "pairing_option_duplicate",
      });
      historyPreserving = true;
      continue;
    }
    if (["--approve-source-oid", "--approve-origin-oid"].some((name) => arg === name || arg.startsWith(`${name}=`))) {
      const source = arg.startsWith("--approve-source-oid");
      const name = source ? "--approve-source-oid" : "--approve-origin-oid";
      const value = arg === name ? args[++index] : arg.slice(name.length + 1);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value || "")) {
        throw Object.assign(new Error(`${name} requires a full Git object ID`), { code: "pairing_approval_oid_invalid" });
      }
      if (source ? approvedSourceOid : approvedOriginOid) {
        throw Object.assign(new Error(`${name} may only be specified once`), { code: "pairing_option_duplicate" });
      }
      if (source) approvedSourceOid = value;
      else approvedOriginOid = value;
      continue;
    }
    if (arg === "--remote" || arg === "--branch") {
      const value = args[index + 1];
      assignFlag(arg, value != null && !value.startsWith("-") ? value : null);
      index += 1;
      continue;
    }
    if (arg.startsWith("--remote=")) {
      assignFlag("--remote", arg.slice("--remote=".length));
      continue;
    }
    if (arg.startsWith("--branch=")) {
      assignFlag("--branch", arg.slice("--branch=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw Object.assign(new Error(`Unknown pairing option: ${arg}`), { code: "pairing_option_unknown" });
    }
    positional.push(arg);
  }
  const remote = validateRemoteName(remoteValue || "origin");
  const first = positional[0] || "host";
  let parsed;
  const actionLengths = new Map([
    ["host", [1, 1]], ["join", [2, 2]], ["leave", [1, 1]], ["close", [1, 1]],
    ["status", [1, 1]], ["admit", [2, 2]], ["members", [1, 1]], ["pending", [1, 1]],
    ["kick", [2, 2]], ["invite", [2, 2]], ["scope", [3, 3]], ["policy", [2, 2]],
    ["publication", [2, 2]],
    ["integrate", [1, 1]], ["abandon-integration", [1, 1]],
    // A hold reason is free text: every word after `hold` belongs to it.
    ["hold", [1, Number.MAX_SAFE_INTEGER]], ["resume", [1, 1]],
  ]);
  if (actionLengths.has(first)) {
    const [minimumLength, maximumLength] = actionLengths.get(first);
    const actionArgumentLength = positional.length || (first === "host" ? 1 : 0);
    if (actionArgumentLength < minimumLength) {
      throw Object.assign(new Error(`Missing argument for session ${first}`), {
        code: "pairing_argument_required",
      });
    }
    if (actionArgumentLength > maximumLength) {
      throw Object.assign(new Error(`Unexpected pairing argument: ${positional[maximumLength]}`), {
        code: "pairing_argument_unexpected",
      });
    }
    parsed = {
      action: first === "close" ? "leave" : first,
      code: positional[1] && first !== "hold" ? inviteToken(positional[1]) : null,
      json,
      remote,
      branch,
    };
    if (keepBranch) parsed.keepBranch = true;
    if (historyPreserving) parsed.historyPreserving = true;
    if (approvedSourceOid && approvedOriginOid) parsed.approval = {
      sourceOid: approvedSourceOid, originOid: approvedOriginOid,
    };
    if (first === "hold") {
      const reason = positional.slice(1).join(" ").trim();
      if (reason) parsed.reason = reason;
    } else if (positional[2]) parsed.value = positional[2];
  } else {
    if (positional.length > 1) {
      throw Object.assign(new Error(`Unexpected pairing argument: ${positional[1]}`), {
        code: "pairing_argument_unexpected",
      });
    }
    parsed = { action: "join", code: inviteToken(first), json, remote, branch };
  }
  if (parsed.action !== "host" && (hasRemoteFlag || hasBranchFlag)) {
    const option = hasRemoteFlag ? "--remote" : "--branch";
    throw Object.assign(new Error(`${option} is only valid when hosting a pairing`), {
      code: "pairing_option_not_allowed",
    });
  }
  if (here && parsed.action !== "join") {
    throw Object.assign(new Error("--here is only valid with session join"), {
      code: "pairing_option_not_allowed",
    });
  }
  if (keepBranch && first !== "close") {
    throw Object.assign(new Error("--keep-branch is only valid with session close"), {
      code: "pairing_option_not_allowed",
    });
  }
  if (historyPreserving && first !== "close") {
    throw Object.assign(new Error("--history-preserving is only valid with session close"), {
      code: "pairing_option_not_allowed",
    });
  }
  if (historyPreserving && keepBranch) {
    throw Object.assign(new Error("--history-preserving cannot be combined with --keep-branch"), {
      code: "pairing_option_conflict",
    });
  }
  if (approvedSourceOid || approvedOriginOid) {
    if (first !== "integrate") {
      throw Object.assign(new Error("Approval OIDs are only valid with session integrate"), {
        code: "pairing_option_not_allowed",
      });
    }
    if (!approvedSourceOid || !approvedOriginOid) {
      throw Object.assign(new Error("Both frozen source and origin base OIDs are required"), {
        code: "pairing_approval_oid_incomplete",
      });
    }
  }
  return parsed;
}

export function snapshotPairingSettings(projectDir) {
  return Object.fromEntries(PAIRING_SETTING_KEYS.map((key) => [
    key,
    getSetting(key, { projectDir }),
  ]));
}

function configurePairingSettings(projectDir, { remote, branch }) {
  setSetting(SETTING_KEYS.TARGET_BRANCH, branch, { projectDir });
  setSetting(SETTING_KEYS.SHARED_TRUNK_BRANCH, branch, { projectDir });
  setSetting(SETTING_KEYS.SHARED_TRUNK_REMOTE, remote, { projectDir });
  setSetting(SETTING_KEYS.SHARED_TRUNK_ENABLED, "true", { projectDir });
}

function restorePairingSettings(projectDir, settings) {
  for (const key of PAIRING_SETTING_KEYS) {
    setSetting(key, settings?.[key] ?? "", { projectDir });
  }
}

function assertPairingSchedulerStopped() {
  const message = getLiveSchedulerBlockMessage("main");
  if (!message) return;
  throw Object.assign(new Error(`Pairing checkout change refused: ${message}`), {
    code: "pairing_scheduler_live",
  });
}

// An ended session's branch is gone: its repair gates and refresh jobs would
// otherwise sit queued forever and be advertised to later sessions. Starting a
// session also sweeps branches of sessions that ended before this existed.
function retireEndedSessionQueueRows(targets = listEndedPairingTargets()) {
  for (const { branch, remote } of targets) {
    try {
      cancelSharedTrunkGatesForBranch(branch, "pairing session ended", { remote });
      cancelQueuedBranchWarmJobs(branch, "pairing_session_ended");
    } catch { /* stale queue rows are cosmetic; session changes must not fail on them */ }
  }
}

async function restoreLocalPairing(projectDir, state) {
  if (!state || state.phase === "left") return { ok: true, alreadyLeft: true };
  markPairingPhase(state.id, "leaving");
  try {
    assertPairingSchedulerStopped();
    await withWorktreeLockAsync(projectDir, projectDir, async () => {
      assertPairingSchedulerStopped();
      // Stop new shared-trunk publications before changing checkout state.
      setSetting(SETTING_KEYS.SHARED_TRUNK_ENABLED, "false", { projectDir });
      restoreRepositorySsh(projectDir, state.original_ssh_command);
      restoreOriginalBranch(projectDir, state.original_branch, { originalHead: state.original_head });
      restorePairingSettings(projectDir, state.originalSettings);
      if (state.added_remote_name) {
        removeTemporaryRemote(projectDir, {
          remote: state.added_remote_name,
          expectedUrl: state.added_remote_url,
        });
      }
    });
    if (state.credential_directory) removeSessionCredentialDirectory(state.credential_directory);
    markPairingPhase(state.id, "left");
    retireEndedSessionQueueRows([{ branch: state.shared_branch, remote: state.remote_name }]);
    pulseTokenManager.setSessionContext(null);
    return { ok: true };
  } catch (error) {
    const message = safeError(error);
    markPairingPhase(state.id, "restore_blocked", message);
    return { ok: false, code: error?.code || "pairing_restore_blocked", message };
  }
}

async function leaveRemoteBestEffort(remoteClient, state) {
  if (!remoteClient || !state?.relay_token) return null;
  try {
    return validatePairingRemoteResponse("leave", await remoteClient.leave(state.relay_token));
  } catch (error) {
    return { error: safeError(error), code: error?.code || "pairing_remote_leave_failed" };
  }
}

// The merge lock never waits: a routine fetch holding it for a moment makes a
// close-time sync or promotion report merge_in_progress. Those retry briefly.
const MERGE_LOCK_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 3_000, 5_000, 8_000]);

async function retryWhileMergeLockBusy(operation, { delays = MERGE_LOCK_RETRY_DELAYS_MS, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    const busy = result?.reason === "merge_in_progress";
    if (!busy || attempt >= delays.length) return result;
    await wait(delays[attempt]);
  }
}

// A member keeps the session's final state: before leaving, fast-forward the
// shared branch once more while the session repository and this member's
// session credentials still exist. Best effort; a blocked or failed sync
// leaves the last synced state in place.
async function takeFinalMemberSync(projectDir, state) {
  if (state?.role !== "member" || !["active", "leaving"].includes(state.phase)) return null;
  try {
    const synced = await retryWhileMergeLockBusy(
      () => syncSharedTrunkFromOrigin(projectDir, { raiseBlockedGate: false }),
    );
    if (!synced.ok) {
      return { ok: false, reason: synced.blockedReason || synced.reason || "sync_failed" };
    }
    return { ok: true, advanced: synced.advanced === true, head: localBranchHead(projectDir, state.shared_branch) };
  } catch (error) {
    return { ok: false, reason: safeError(error) };
  }
}

const MEMBER_EXIT_REASONS = Object.freeze({
  draining: "The host closed the session",
  closed: "The session was closed",
  expired: "The session expired",
});

function describeFinalMemberSync(finalSync) {
  if (!finalSync) return null;
  if (!finalSync.ok) return `Could not take the session's final state (${finalSync.reason}); this folder keeps what it last synced.`;
  const head = finalSync.head ? ` (${finalSync.head.slice(0, 7)})` : "";
  return finalSync.advanced ? `Took the session's final state${head}.` : `Already had the session's final state${head}.`;
}

async function unpair(projectDir, remoteClient, state = getLivePairingState()) {
  clearPairingPeerSnapshot();
  if (!state) return { ok: true, alreadyLeft: true };
  const finalSync = await takeFinalMemberSync(projectDir, state);
  pulseTokenManager.clearAuthentication();
  pulseTokenManager.setSessionContext(null);
  markPairingPhase(state.id, "leaving");
  const remote = await leaveRemoteBestEffort(remoteClient, state);
  const local = await restoreLocalPairing(projectDir, getPairingState(state.id));
  return { ok: local.ok, local, remote, role: state.role, finalSync };
}

function printPeerActivityChanges(C, status, seen, { json = false, log = console.log } = {}) {
  const changes = diffPairingPeerActivity(status?.peers, seen);
  for (const change of changes) {
    if (json) {
      console.log(JSON.stringify({
        event: "pairing_peer_activity",
        scope: "peer_read_only",
        local_queue: false,
        ...change,
      }));
      continue;
    }
    const verb = change.kind === "spawned" ? "started" : "updated";
    const entity = change.entity_type === "job" ? change.job : change.work_item;
    const entityLabel = change.entity_type === "job"
      ? `job #${entity.id}${entity.work_item_id ? ` (WI#${entity.work_item_id})` : ""} ${entity.job_type}`
      : `WI#${entity.id}`;
    log(
      `  ${C.dim}[pair peer · read-only]${C.reset} ${change.peer.label} ${verb} `
      + `${C.cyan}${entityLabel}${C.reset} `
      + `${entity.status}: ${entity.title}`,
    );
  }
}

function memberLabel(member) {
  return sessionMemberLabel(member);
}

function printMemberChanges(log, C, events, { json = false } = {}) {
  for (const event of events) {
    const member = event.member || {};
    if (json) {
      log(JSON.stringify({
        event: "pairing_member",
        kind: event.kind,
        member_id: member.id || null,
        state: member.state || null,
        instance_id: member.instance_id || null,
      }));
      continue;
    }
    if (event.kind === "pending") {
      log(`  ${C.yellow}[session]${C.reset} ${C.bold}Join request${C.reset} from ${memberLabel(member)}. `
        + "Ask them for the 4-character countersign on their screen, type it here and press Enter.");
    } else if (event.kind === "joined") {
      log(`  ${C.green}[session]${C.reset} ${memberLabel(member)} joined`);
    } else {
      log(`  ${C.dim}[session]${C.reset} ${memberLabel(member)} ${member.state === "kicked" ? "was removed" : "left"}`);
    }
  }
}

function describeSessionHold(hold) {
  const ttlSec = Math.max(0, Math.round((Date.parse(hold?.expires_at) - Date.parse(hold?.set_at)) / 1000));
  let owner = true;
  try {
    owner = sessionFetchOwnerAlive({ stateId: hold?.state_id });
  } catch { /* the hint is advisory */ }
  return `Held this checkout for ${formatSyncAge(ttlSec)}${hold?.reason ? ` (${hold.reason})` : ""}: `
    + "fetches continue, fast-forwards and publications wait. Type resume to lift it."
    + (owner ? "" : " Nothing is syncing this folder right now; the hold applies once the session console or posse go runs.");
}

function describeSessionResume(result) {
  if (result?.ok && result.resumed) return "Hold lifted; this checkout catches up now.";
  if (result?.reason === "not_held") return "This checkout is not held.";
  if (result?.reason === "no_active_session") return "This clone is not in a live session.";
  return `Resume failed: ${result?.reason || "unknown error"}`;
}

function printSessionSyncRows(log, C, derived, { observing = false, listedInstanceIds = new Set() } = {}) {
  const sync = derived?.sync;
  log(`  Sync: ${sync ? sync.label : `${SESSION_SYNC_GLYPHS[SESSION_SYNC_STATES.UNKNOWN]} unknown`}`
    + `${observing ? ` ${C.dim}(posse go owns the session)${C.reset}` : ""}`);
  for (const peer of derived?.peers_sync || []) {
    if (listedInstanceIds.has(String(peer.instance_id || ""))) continue;
    log(`    ${C.dim}peer${C.reset} ${formatPeerSyncRow(peer)}`);
  }
}

function printHostConsoleMembers(log, members) {
  if (members.length === 0) {
    log("  No members yet.");
    return;
  }
  for (const member of members) {
    log(`  ${shortId(member.id)}  ${member.state}/${member.role || "member"}  ${shortId(member.instance_id)}`);
  }
}

function pidProvablyDead(pid, kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    // Only ESRCH proves the process is gone; EPERM and platform errors do not.
    return error?.code === "ESRCH";
  }
}

// A live scheduler lock means posse go may own the session heartbeat. The lock
// outlives a killed process for up to its lease, so a holder whose own runtime
// row names a PID that is provably gone no longer counts.
function schedulerLockHolderLive(kill) {
  if (!getLiveSchedulerBlockMessage("main")) return false;
  let lock;
  try {
    lock = getSchedulerLockInfo("main");
  } catch {
    return true;
  }
  if (!lock) return false;
  const status = readRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER);
  if (!status || status.owner_id !== lock.owner_id) return true;
  return !pidProvablyDead(Number(status.process_pid), kill);
}

// After releasing the scheduler lock, a posse go still owns the session only
// while it provably heartbeats: its link row names it and attempted within a
// few beats. One sitting in its wrap-up screen, or a dead or reused pid, has
// stopped, and the Remote lease would lapse unless the console takes over.
function schedulerStillHeartbeating(state, pid, nowMs) {
  const link = readSessionLink({ stateId: state?.id });
  if (link?.owner !== SESSION_LINK_OWNERS.SCHEDULER || Number(link.owner_pid) !== pid) return false;
  const attemptMs = Date.parse(String(link.last_attempt_at || ""));
  return Number.isFinite(attemptMs) && nowMs - attemptMs <= SESSION_SYNC_POLICY.LINK_SILENT_AFTER_MS;
}

// A drain request older than this belongs to a close that died with its
// process; it no longer keeps the console from taking the session back.
const DRAIN_REQUEST_FRESH_MS = 10 * 60_000;

// A close in progress belongs to whichever process started it: a live close
// claim, or a recent graceful-drain request whose closer has not claimed yet.
function sessionCloseInProgress(state, kill, nowMs) {
  const claim = activeSessionCloseClaim({ stateId: state?.id, kill });
  if (claim) return { ownerPid: Number(claim.owner_pid) || null };
  const drain = readRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_DRAIN_REQUEST);
  const requestedMs = Date.parse(String(drain?.requested_at || ""));
  if (drain && Number.isFinite(requestedMs) && nowMs - requestedMs <= DRAIN_REQUEST_FRESH_MS) {
    return { ownerPid: null };
  }
  return null;
}

/**
 * Who heartbeats the session right now: this console ("self"), a posse go
 * that holds the scheduler lock or still heartbeats ("scheduler"), a close in
 * progress in another process ("closing"), or nobody ("vacant": this console
 * takes the session back).
 */
function consoleSessionOwnership(state, kill, nowMs = Date.now()) {
  const pid = Number(state?.process_pid);
  if (pid === process.pid) return "self";
  if (schedulerLockHolderLive(kill)) return "scheduler";
  if (Number.isSafeInteger(pid) && pid > 0 && !pidProvablyDead(pid, kill)
    && schedulerStillHeartbeating(state, pid, nowMs)) return "scheduler";
  if (sessionCloseInProgress(state, kill, nowMs)) return "closing";
  return "vacant";
}

// GitHub can take a few seconds to honor a deploy key it has just accepted,
// and a member's first fetch runs the moment it is admitted. An auth rejection
// then is retried for a bounded window instead of failing the whole join.
const SESSION_KEY_RETRY_DELAYS_MS = Object.freeze([2_000, 3_000, 5_000, 8_000, 13_000, 20_000]);

function sessionKeyNotYetAccepted(error) {
  return /Permission denied \(publickey\)|Repository not found|Could not read from remote repository/iu
    .test(String(error?.message || ""));
}

// A connection that never reached GitHub (a blocked port, no route, no DNS)
// also ends with "Could not read from remote repository", but no wait for the
// session key fixes it, and each retry is one more port-22 connection for the
// network's scan detector to count. A connection GitHub opened and then
// dropped or reset ("kex_exchange_identification", "Connection closed by") is
// left out: GitHub drops connections briefly, and the retry rides that out.
const SSH_CONNECTION_BLOCKED_PATTERNS = Object.freeze([
  /ssh: connect to host \S+ port \d+: (?:Connection timed out|Connection refused|No route to host|Network is unreachable)/iu,
  /ssh: Could not resolve hostname/iu,
  /Connection timed out during banner exchange/iu,
]);

/** The ssh line that shows the connection to GitHub never opened, or null. */
function sshConnectionBlockedLine(error) {
  const message = String(error?.message || "");
  if (/Permission denied \(publickey\)/iu.test(message)) return null;
  return message.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => SSH_CONNECTION_BLOCKED_PATTERNS.some((pattern) => pattern.test(line))) || null;
}

function sshBlockedError(line, cause) {
  // A failed name lookup is more often a dropped connection (a laptop waking
  // up) than a firewall, so it gets its own advice.
  const advice = /Could not resolve hostname/iu.test(line)
    ? "This computer could not look up github.com; check its internet connection and try again. "
      + "If it keeps failing, the network may be blocking GitHub."
    : "A firewall or security tool on this network blocked the SSH connection to GitHub; this is not "
      + "a problem with the session key. Join from another network.";
  return Object.assign(new Error(`Could not connect to GitHub over SSH (${line}). ${advice}`), {
    code: "pairing_github_ssh_blocked", cause,
  });
}

async function retryWhileSessionKeyPropagates(operation, {
  delays = SESSION_KEY_RETRY_DELAYS_MS,
  onWait = () => {},
  wait = sleep,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const blockedLine = sshConnectionBlockedLine(error);
      if (blockedLine) throw sshBlockedError(blockedLine, error);
      if (attempt >= delays.length || !sessionKeyNotYetAccepted(error)) throw error;
      onWait(attempt + 1, delays[attempt]);
      await wait(delays[attempt]);
    }
  }
}

function leaseLapsedError(error, leaseSec) {
  const message = `Session heartbeats failed for longer than the Remote's ${leaseSec}s lease: ${safeError(error)}`;
  return Object.assign(new Error(message), {
    code: error?.code || "pairing_heartbeat_lease_lapsed",
    status: error?.status,
    cause: error,
  });
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/gu;

function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

// The session console runs `posse add` / `posse go` in its own terminal: the
// same entry point this process was started with, in this checkout.
function spawnPosseInForeground(args, { cwd } = {}) {
  return spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

async function monitorPairing(remoteClient, stateId, {
  projectDir = process.cwd(),
  C,
  json = false,
  input = process.stdin,
  output = process.stdout,
  sessionCode = null,
  heartbeatMs = HEARTBEAT_MS,
  retryMs = HEARTBEAT_RETRY_MS,
  tickMs = 250,
  nowMs = () => Date.now(),
  kill = process.kill.bind(process),
  trunkPoller = null,
  spawnPosse = spawnPosseInForeground,
} = {}) {
  let forceRequested = false;
  // A posse command (`add`, `go`) this console handed the terminal to. Ctrl+C
  // then belongs to that command, never to the session.
  let foreground = null;
  let gracefulRequested = false;
  let lastTeamHandoffPollAt = 0;
  const seenPeerActivity = new Map();
  const seenMembers = new Map();
  let latestStatus = null;
  let latestMembers = [];
  let latestSync = null;
  let lastSyncState = null;
  // While posse go owns the session this console only observes: it never
  // heartbeats, fetches, or writes the peer snapshot, so exactly one local
  // process speaks for this clone.
  let observing = false;
  let observedOwner = null;
  let detached = false;
  // While it owns the session this console also keeps the checkout synced:
  // posse go exits when its queue is empty, and someone with nothing queued
  // must still get the others' work. A person's own checkout is often
  // mid-edit, so a blocked fast-forward is shown rather than raised as a gate.
  // posse go takes the poller over while it runs.
  const consolePoller = trunkPoller || createSharedTrunkPoller({
    projectDir,
    sync: (dir, options) => syncSharedTrunkFromOrigin(dir, { ...options, raiseBlockedGate: false }),
  });
  let consolePoll = null;
  let landingAfterHeartbeat = false;
  let landingShown = false;
  // Set once the loop has ended: nothing may start another poll while this
  // process closes, leaves or hands over.
  let stopping = false;
  // Monitoring starts right after the Remote accepted this clone, which counts
  // as the first proof that the lease is live.
  let lastHeartbeatOkMs = nowMs();
  const stop = () => {
    if (foreground) return;
    forceRequested = true;
  };
  // Closing the terminal must close and integrate like Ctrl+C. Output to the
  // gone terminal is dropped rather than allowed to crash the shutdown.
  const hangup = () => {
    for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
    forceRequested = true;
  };
  const stateAtStart = getPairingState(stateId);
  const role = stateAtStart?.role === "host" ? "host" : "member";
  const leaseSec = sessionLeaseSec(role);
  let log = (text = "") => console.log(text);
  const emit = (event, text) => {
    if (json) log(JSON.stringify(event));
    else log(text);
  };
  const readSync = (state) => {
    try {
      return readSessionSync({ state, snapshot: readPairingPeerSnapshot(), nowMs: nowMs() });
    } catch {
      return null;
    }
  };
  const reportSyncTransition = (state) => {
    latestSync = readSync(state);
    const sync = latestSync?.sync;
    if (!sync || sync.state === lastSyncState) return;
    // Nothing is known before the first fetch completes; say nothing yet.
    updatePrompt();
    if (lastSyncState == null && sync.state === SESSION_SYNC_STATES.UNKNOWN) return;
    const first = lastSyncState == null;
    lastSyncState = sync.state;
    // The first settled state is the moment the session is ready to use: the
    // session screen says it (and more) instead of a feed line.
    if (first && !json && !landingShown) {
      printLanding(state);
      return;
    }
    emit(
      { event: "pairing_sync", state: sync.state, label: sync.label, reasons: sync.reasons },
      `  ${C.cyan}[sync]${C.reset} ${sessionSyncFeedLabel(sync)}`,
    );
  };
  const peopleInSession = () => {
    const peers = readPairingPeerSnapshot()?.peers;
    const admitted = latestMembers.filter((member) => member?.state === "admitted").length;
    return 1 + Math.max(Array.isArray(peers) ? peers.length : 0, admitted);
  };
  const updatePrompt = () => {
    try {
      sessionConsole?.setPrompt(sessionPrompt({ sync: latestSync?.sync, peopleCount: peopleInSession(), observing }));
    } catch { /* the prompt is advisory */ }
  };
  const printLanding = (state = getPairingState(stateId)) => {
    if (json || !state) return;
    landingShown = true;
    latestSync = readSync(state) || latestSync;
    const snapshot = readPairingPeerSnapshot();
    const status = (observing ? snapshot : null) || latestStatus;
    let local = { work_items: [], jobs: [] };
    try {
      local = { work_items: collectPairingWorkItems(), jobs: collectPairingJobs() };
    } catch { /* an unreadable queue shows as idle */ }
    const lines = formatSessionLanding({
      role,
      sessionCode,
      branch: state.shared_branch,
      sync: latestSync?.sync,
      peersSync: latestSync?.peers_sync,
      peers: snapshot?.peers || status?.peers || [],
      members: latestMembers,
      local,
      scopeLabel: role === "host" ? null : describeSessionWriteScope(status?.scope_set || state.scopeSet),
      observing,
    });
    log("");
    lines.forEach((line, index) => {
      const color = index === 0 ? C.bold
        : /^(Needs you|Waiting to join)/u.test(line) ? C.yellow
          : line.startsWith("Next:") ? C.cyan : "";
      log(`  ${color}${line}${color ? C.reset : ""}`);
    });
    updatePrompt();
  };
  // Run a posse command (`add`, `go`) in this terminal, then come back here.
  const runForeground = async (args) => {
    if (!sessionConsole?.interactive) {
      log(`  ${C.yellow}[session]${C.reset} run \`posse ${args.join(" ")}\` in another terminal in this folder`);
      return;
    }
    sessionConsole.suspend();
    let outcome = null;
    try {
      foreground = spawnPosse(args, { cwd: projectDir });
      outcome = await new Promise((resolve) => {
        foreground.once("error", (error) => resolve({ error }));
        foreground.once("exit", (code, signal) => resolve({ code, signal }));
      });
    } catch (error) {
      outcome = { error };
    } finally {
      foreground = null;
      const held = sessionConsole.resume()
        .filter((line) => !/posse go (now owns|finished;)/u.test(stripAnsi(line)));
      if (held.length > 0) {
        log(`  ${C.dim}While that ran:${C.reset}`);
        if (held.length > 10) log(`  ${C.dim}(${held.length - 10} earlier lines)${C.reset}`);
        for (const line of held.slice(-10)) log(line);
      }
    }
    if (outcome?.error) log(`  ${C.yellow}[session]${C.reset} could not run posse ${args[0]}: ${safeError(outcome.error)}`);
    // A posse go that took the session over hands it back on the next lap,
    // which shows the screen; one that never took it (nothing to do) ends here.
    if (!observing) printLanding();
  };
  const pollTrunk = (status = null, { force = false } = {}) => {
    if (consolePoll || stopping || observing) return;
    // Another process closing the session needs the merge lock for its final
    // sync; a console fetch holding it would fail that close.
    try {
      if (sessionCloseInProgress(getPairingState(stateId), kill, nowMs())) return;
    } catch { /* an unreadable claim row: skip this lap */ return; }
    const hints = status ? pairingPeerTrunkHints(status.peers || []) : undefined;
    consolePoll = consolePoller.poll({ force, ...(hints ? { hints } : {}) })
      .catch(() => null)
      .finally(() => {
        consolePoll = null;
        try {
          const current = getPairingState(stateId);
          if (current && !observing && !stopping) reportSyncTransition(current);
        } catch { /* the feed line is advisory */ }
      });
  };
  const refreshHostMembers = async (state) => {
    if (state.role !== "host") return;
    try {
      const listed = await remoteClient.members(state.relay_token, { pendingOnly: false });
      latestMembers = Array.isArray(listed?.members) ? listed.members : [];
      printMemberChanges(log, C, diffPairingMembers(latestMembers, seenMembers), { json });
    } catch {
      // The member list is display only; the heartbeat is the lease.
    }
  };
  const runSessionConsoleCommand = async (parsed) => {
    const state = getPairingState(stateId);
    try {
      if (parsed.kind === "empty") return;
      if (parsed.kind === "invalid") {
        log(`  ${C.yellow}${parsed.message}${C.reset}`);
      } else if (parsed.kind === "help") {
        for (const line of sessionConsoleHelp(role, { observing })) log(`  ${C.dim}${line}${C.reset}`);
      } else if (parsed.kind === "status") {
        printLanding(state);
      } else if (parsed.kind === "add") {
        // Word by word, as a shell would pass them, so `add --oneshot fix it`
        // reaches posse add as a flag and a task.
        await runForeground(["add", ...(parsed.task ? parsed.task.split(/\s+/u) : [])]);
      } else if (parsed.kind === "go") {
        if (observing || schedulerLockHolderLive(kill)) {
          log(`  ${C.yellow}[session]${C.reset} posse go is already running this session in another terminal; new tasks queued here wait for its next run.`);
          return;
        }
        await runForeground(["go"]);
      } else if (parsed.kind === "members") {
        printHostConsoleMembers(log, latestMembers);
      } else if (parsed.kind === "hold") {
        const held = setSessionHold({ stateId, reason: parsed.reason || null });
        log(held.ok
          ? `  ${C.cyan}[sync]${C.reset} ${describeSessionHold(held.hold)}`
          : `  ${C.yellow}[sync]${C.reset} Hold not set: ${held.reason}`);
      } else if (parsed.kind === "resume") {
        const resumed = requestSessionResume({ stateId });
        log(`  ${resumed.ok && resumed.resumed ? C.cyan : C.yellow}[sync]${C.reset} ${describeSessionResume(resumed)}`);
        if (resumed.ok && resumed.resumed && !observing) pollTrunk(latestStatus);
      } else if (parsed.kind === "admit") {
        log(`  ${C.cyan}[session]${C.reset} admitting ${parsed.code}...`);
        const admitted = await admitPairingMember({ state, code: parsed.code, projectDir, remoteClient });
        log(`  ${C.green}[session]${C.reset} admitted ${admitted.member ? `${memberLabel(admitted.member)} with ` : ""}`
          + `${admitted.countersign}; they are checking out ${state.shared_branch}`);
        await refreshHostMembers(state);
        printLanding(state);
      } else if (parsed.kind === "kick") {
        const matches = latestMembers.filter((member) => String(member.id).startsWith(parsed.id));
        if (matches.length !== 1) {
          log(`  ${C.yellow}[session]${C.reset} ${matches.length ? "Several" : "No"} members match "${parsed.id}"; type members to see ids`);
          return;
        }
        await kickPairingMember({ state, memberId: matches[0].id, projectDir, remoteClient });
        log(`  ${C.yellow}[session]${C.reset} removed ${memberLabel(matches[0])}`);
        await refreshHostMembers(state);
      }
    } catch (error) {
      log(`  ${C.yellow}[session]${C.reset} ${safeError(error)}`);
    }
  };
  let commandChain = Promise.resolve();
  const sessionConsole = !json
    ? createSessionConsole({
        input,
        output,
        onLine: (line) => {
          const parsed = parseSessionConsoleLine(line, { role });
          if (parsed.kind === "leave") {
            log(`  ${C.cyan}[session]${C.reset} leaving the session…`);
            gracefulRequested = true;
            return;
          }
          if (parsed.kind === "close") {
            if (observing || schedulerLockHolderLive(kill)) {
              log(`  ${C.yellow}[session]${C.reset} posse go owns the session; close from the run screen (u → close), or stop posse go first.`);
            } else {
              gracefulRequested = true;
            }
            return;
          }
          // One command at a time; a slow admit must not interleave with a kick.
          commandChain = commandChain.then(() => runSessionConsoleCommand(parsed));
        },
        onInterrupt: () => { forceRequested = true; },
        onHangup: () => hangup(),
      })
    : null;
  if (sessionConsole) log = sessionConsole.print;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", hangup);
  const waitForNextLap = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += tickMs) {
      if (forceRequested || gracefulRequested || pairingProcessShouldStop(stateId)) break;
      await sleep(tickMs);
    }
  };
  try {
    while (!forceRequested && !gracefulRequested && !pairingProcessShouldStop(stateId)) {
      let state = getPairingState(stateId);
      let ownership = consoleSessionOwnership(state, kill, nowMs());
      if (ownership === "vacant") {
        // posse go stopped heartbeating (exited, or sits in its wrap-up
        // screen): take the heartbeat back unless another process adopted the
        // session (or it ended) since it was read.
        const link = readSessionLink({ stateId });
        if (!readoptPairingProcess(stateId, { fromPid: state?.process_pid ?? null })) {
          await waitForNextLap(tickMs);
          continue;
        }
        ownership = "self";
        state = getPairingState(stateId);
        if (observing) {
          observing = false;
          // The lease runs from the last heartbeat that actually succeeded,
          // whichever process sent it.
          const lastOkMs = Date.parse(String(link?.last_ok_at || ""));
          lastHeartbeatOkMs = Number.isFinite(lastOkMs) ? lastOkMs : nowMs();
          emit(
            { event: "pairing_owner", owner: "console" },
            `  ${C.green}[session]${C.reset} posse go finished; this console is running the session again`,
          );
          // Shown after this console's first heartbeat as owner, once the
          // link, the peer snapshot and the fetch owner are its own again.
          landingAfterHeartbeat = !foreground;
        }
      }
      if (ownership === "scheduler" || ownership === "closing") {
        const ownerLabel = ownership === "closing" ? "closing" : "scheduler";
        if (!observing || observedOwner !== ownerLabel) {
          observing = true;
          observedOwner = ownerLabel;
          emit(
            { event: "pairing_owner", owner: ownerLabel },
            ownership === "closing"
              ? `  ${C.yellow}[session]${C.reset} the session is closing in another process; this console stays attached`
              : `  ${C.cyan}[session]${C.reset} posse go now owns the session; this console stays attached`,
          );
        }
        // Read-only view of what the scheduler maintains.
        const snapshot = readPairingPeerSnapshot();
        if (snapshot) printPeerActivityChanges(C, snapshot, seenPeerActivity, { json, log });
        await refreshHostMembers(state);
        reportSyncTransition(state);
        await waitForNextLap(heartbeatMs);
        continue;
      }
      let status;
      try {
        status = validatePairingRemoteResponse(
          "heartbeat",
          await remoteClient.heartbeat(state.relay_token, collectPairingPresence(projectDir)),
        );
        assertPairingStatusMatches(state, status);
        const nextScope = status.scope_set || {};
        const scopeChanged = JSON.stringify(nextScope) !== JSON.stringify(state.scopeSet || {});
        // Remote is authoritative for this policy but may never walk it
        // backwards; the scheduler session monitor enforces the same rule.
        const policyRegression = teamPolicyRegression(state, status);
        if (policyRegression) {
          throw Object.assign(new Error(teamPolicyRegressionMessage(policyRegression)), {
            code: "pairing_team_policy_regressed",
          });
        }
        const teamPolicyChanged = status.submission_approval_enabled != null
          && (Number(status.submission_approval_enabled) !== Number(state.submission_approval_enabled)
            || status.submission_policy_revision !== Number(state.submission_approval_revision));
        updatePairingEnrollment(state.id, {
          phase: "active",
          scopeSet: nextScope,
          computePolicy: status.compute_policy,
          integrationPolicy: status.integration_policy,
          enrollmentOpen: status.enrollment_open,
          submissionApprovalEnabled: status.submission_approval_enabled,
          submissionPolicyRevision: status.submission_policy_revision,
          teamPublicationMode: status.team_publication_mode,
          teamPublicationRevision: status.team_publication_revision,
        });
        if (scopeChanged || teamPolicyChanged) {
          pulseTokenManager.clearAuthentication();
          const { invalidateVerifiedTeamGrantCache } = await import("./team-submissions.js");
          invalidateVerifiedTeamGrantCache();
        }
        touchPairingState(stateId);
        lastHeartbeatOkMs = nowMs();
        recordSessionLinkSuccess({
          stateId, owner: SESSION_LINK_OWNERS.CONSOLE, leaseSec, nowMs: lastHeartbeatOkMs,
        });
        writePairingPeerSnapshot(status);
        if (state.role === "host" && status.submission_approval_enabled === true
          && Date.now() - lastTeamHandoffPollAt >= 15_000) {
          lastTeamHandoffPollAt = Date.now();
          const { reconcileTeamFileHandoff } = await import("./team-submissions.js");
          const handoff = await reconcileTeamFileHandoff({
            projectDir, remoteClientFactory: () => remoteClient,
          });
          if (handoff.handedOff && !json) {
            log(`  ${C.green}[session handoff]${C.reset} ${handoff.predecessorWorkItemId} -> ${handoff.successorWorkItemId} (${handoff.acceptedOid.slice(0, 8)})`);
          }
          if (Array.isArray(handoff.expiredSuccessors) && handoff.expiredSuccessors.length && !json) {
            log(`  ${C.yellow}[session handoff]${C.reset} expired stale file request(s) ${handoff.expiredSuccessors.join(", ")}; the member must request again`);
          }
        }
        printPeerActivityChanges(C, status, seenPeerActivity, { json, log });
        latestStatus = status;
        await refreshHostMembers(state);
        if (status.status === "active") pollTrunk(status);
        if (landingAfterHeartbeat) {
          landingAfterHeartbeat = false;
          printLanding(state);
        }
      } catch (error) {
        recordSessionLinkFailure({ stateId, owner: SESSION_LINK_OWNERS.CONSOLE, leaseSec, error, nowMs: nowMs() });
        if ([401, 403].includes(Number(error?.status))) {
          pulseTokenManager.clearAuthentication();
          throw error;
        }
        // Keep retrying for as long as the Remote would still hold this
        // clone's lease; only a lapsed lease ends the console.
        if (nowMs() - lastHeartbeatOkMs > leaseSec * 1000) throw leaseLapsedError(error, leaseSec);
        // Git sync does not depend on the relay; keep the checkout current.
        pollTrunk();
        reportSyncTransition(state);
        await waitForNextLap(retryMs);
        continue;
      }
      reportSyncTransition(state);
      if (status.status !== "active") return { reason: status.status, status };
      await waitForNextLap(heartbeatMs);
    }
    // Ctrl+C or a closed terminal detaches a console while posse go owns the
    // session, including while it is still starting and has not adopted yet;
    // it never force-closes a session posse go is running.
    if ((forceRequested || gracefulRequested) && (observing || schedulerLockHolderLive(kill))) {
      detached = true;
      if (!json) log(`  ${C.dim}[session] console detached; posse go keeps the session${C.reset}`);
      return { reason: "scheduler_handoff", detached: true };
    }
    return {
      reason: gracefulRequested ? "graceful_close" : forceRequested ? "force_close" : "local_leave",
    };
  } finally {
    stopping = true;
    // A foreground command (or one queued behind a slow admit) finishes
    // before the prompt closes and before leaving can race it.
    await commandChain.catch(() => {});
    sessionConsole?.close();
    if (consolePoll) {
      consolePoller.abortInFlight?.("The session console is exiting");
      await consolePoll;
    }
    // The scheduler owns the peer snapshot while it runs.
    if (!observing && !detached) clearPairingPeerSnapshot();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", hangup);
  }
}

function readSessionSyncBestEffort(state) {
  try {
    return readSessionSync({ state, snapshot: readPairingPeerSnapshot() });
  } catch {
    return null;
  }
}

function printActive(C, state, status = null, derived = null) {
  console.log(`\n  ${C.bold}Posse pairing${C.reset}`);
  console.log(`  Role: ${state.role}`);
  console.log(`  Branch: ${state.shared_branch}`);
  console.log(`  Remote: ${state.remote_name}`);
  console.log(`  State: ${status?.status || state.phase}`);
  if (status && Number.isFinite(status.active_members)) {
    console.log(`  Connected members: ${status.active_members}`);
  }
  if (derived) printSessionSyncRows((text) => console.log(text), C, derived);
  const peers = status?.peers || [];
  const peerItems = peers.flatMap((peer) => (
    (peer.work_items || []).map((workItem) => ({ peer, workItem }))
  ));
  const peerJobs = peers.flatMap((peer) => (
    (peer.jobs || []).map((job) => ({ peer, job }))
  ));
  if (peerItems.length > 0 || peerJobs.length > 0) {
    console.log("  Peer work (read-only; not in this clone's queue):");
    for (const { peer, workItem } of peerItems) {
      console.log(`    [peer ${peer.label}] WI#${workItem.id} ${workItem.status}: ${workItem.title}`);
    }
    for (const { peer, job } of peerJobs) {
      const wi = job.work_item_id ? ` WI#${job.work_item_id}` : "";
      console.log(`    [peer ${peer.label}] job #${job.id}${wi} ${job.job_type}/${job.status}: ${job.title}`);
    }
  }
  if (state.last_error) console.log(`  ${C.yellow}Restore blocked:${C.reset} ${state.last_error}`);
  console.log("");
}

async function waitForRemoteMembersToLeave(remoteClient, state, {
  graceful,
  projectDir,
  C,
  json,
} = {}) {
  let localStopped = false;
  let localError = null;
  const localStop = waitForPairingSchedulerStop({
    state,
    graceful,
    onProgress: (message) => {
      if (!json) console.log(`  ${C.yellow}[pair close]${C.reset} ${message}`);
    },
  }).then(() => { localStopped = true; }, (error) => {
    localError = error;
    localStopped = true;
  });
  const startedAt = Date.now();
  let status = null;
  while (true) {
    status = validatePairingRemoteResponse(
      graceful ? "heartbeat" : "status",
      graceful
        ? await remoteClient.heartbeat(state.relay_token, collectPairingPresence(projectDir))
        : await remoteClient.status(state.relay_token),
    );
    assertPairingStatusMatches(state, status);
    if (localStopped && status.active_members === 0) break;
    if (!graceful && Date.now() - startedAt > 120_000) {
      throw Object.assign(new Error(
        `${status.active_members} paired client(s) did not acknowledge forced shutdown; promotion remains pending`,
      ), { code: "pairing_shutdown_clients_not_drained" });
    }
    await sleep(1_000);
  }
  await localStop;
  if (localError) throw localError;
  return status;
}

// Every close path (console, `u → close`, `posse session close`, crash
// recovery) funnels here; the claim keeps two of them from integrating the
// same session at once.
function describePromotionBestEffort(root) {
  try {
    return describePairingPromotion(root);
  } catch {
    // The summary is advisory; approval still checks the exact frozen OIDs.
    return null;
  }
}

// What the host is asked to approve: where it goes, the session's commits and
// who wrote them, and the files it changes.
function printPromotionForApproval(C, summary, print = console.log) {
  if (!summary) return;
  const kind = summary.strategy === "fast-forward" ? "history-preserving" : "squash";
  print(`\n  ${C.bold}Ready to publish to ${summary.target}${C.reset} (${kind})`);
  if (summary.commitCount > 0) {
    const authors = summary.authors.map((author) => `${author.name} (${author.count})`).join(", ");
    print(`  ${summary.commitCount} session commit${summary.commitCount === 1 ? "" : "s"} by ${authors}:`);
    for (const commit of summary.commits) print(`    ${commit.sha} ${commit.author}: ${commit.subject}`);
    if (summary.commitCount > summary.commits.length) {
      print(`    ... and ${summary.commitCount - summary.commits.length} more`);
    }
  }
  if (summary.files.length > 0) {
    print("  Changes:");
    for (const line of summary.files) print(`    ${line}`);
    if (summary.moreFiles > 0) print(`    ... and ${summary.moreFiles} more file(s)`);
  }
  if (summary.changeSummary) print(`  ${summary.changeSummary}`);
}

function printPendingApprovalGuidance(C, candidateOid, originOid) {
  console.log(`  ${C.yellow}Not published.${C.reset} Review and publish it with \`posse session integrate\`, or drop it with \`posse session abandon-integration\`.`);
  console.log(`  ${C.dim}Scripted approval: posse session integrate --approve-source-oid ${candidateOid} --approve-origin-oid ${originOid}${C.reset}\n`);
}

// Asks on the terminal only. Returns true or false for the host's answer, and
// null when there is no one to ask (a closed terminal, piped input): the
// candidate then stays frozen and only exact OIDs can approve it.
async function askToPublishPromotion(C, summary, { input = process.stdin, output = process.stdout } = {}) {
  if (!summary || !input?.isTTY || !output?.isTTY || input.readableEnded) return null;
  if (input.isRaw) input.setRawMode(false);
  const prompt = createInterface({ input, output });
  // Input that ends at the prompt (Ctrl+D, a closed stream) closes readline
  // without settling the question, so the close itself answers it.
  const closed = new Promise((resolve) => prompt.once("close", () => resolve(null)));
  // Publishing takes the whole word: a stray "y" and Enter typed while the
  // close drained sit in the terminal's buffer and would otherwise answer a
  // question the host has not read yet.
  const asked = prompt.question(`\n  Type ${C.bold}yes${C.reset} to publish to ${C.cyan}${summary.target}${C.reset} (anything else keeps it frozen): `);
  asked.catch(() => {});
  try {
    const answer = await Promise.race([asked, closed]);
    return answer !== null && String(answer).trim().toLowerCase() === "yes";
  } catch (error) {
    // Ctrl+C or Ctrl+D at the prompt is a no: the candidate stays frozen.
    if (error?.name === "AbortError") return false;
    throw error;
  } finally {
    prompt.close();
  }
}

async function finishHostShutdown(root, remoteClient, state, options = {}) {
  const claim = claimSessionClose({ stateId: state.id });
  if (!claim.ok) {
    throw Object.assign(new Error(claim.ownerPid
      ? `Another process (pid ${claim.ownerPid}) is already closing this session; let it finish`
      : "Could not claim the session close; try again"), { code: claim.reason });
  }
  const renewal = setInterval(() => renewSessionClose({ stateId: state.id }), SESSION_CLOSE_CLAIM_RENEW_MS);
  renewal.unref?.();
  try {
    return await withSessionCredentialMutation(state, "session close", () => (
      closeClaimedHostSession(root, remoteClient, state, options)
    ), { allowClosing: true });
  } finally {
    clearInterval(renewal);
    releaseSessionClose({ stateId: state.id });
  }
}

function sessionClosingError(claim) {
  return Object.assign(new Error(claim?.owner_pid
    ? `Another process (pid ${claim.owner_pid}) is closing this session; member access cannot change`
    : "This session is closing; member access cannot change"), {
    code: "session_close_in_progress",
  });
}

async function withSessionCredentialMutation(state, operation, callback, { allowClosing = false } = {}) {
  if (!allowClosing) {
    const closing = activeSessionCloseClaim({ stateId: state.id });
    if (closing) throw sessionClosingError(closing);
  }
  const claimed = claimSessionCredentialMutation({ stateId: state.id, operation });
  if (!claimed.ok) {
    throw Object.assign(new Error(claimed.ownerPid
      ? `Another process (pid ${claimed.ownerPid}) is changing session credentials (${claimed.operation}); try again when it finishes`
      : "Could not claim the session credential update; try again"), { code: claimed.reason });
  }
  const ownerId = claimed.claim.owner_id;
  const renewal = setInterval(() => renewSessionCredentialMutation({ stateId: state.id, ownerId }), SESSION_CLOSE_CLAIM_RENEW_MS);
  renewal.unref?.();
  try {
    // Close takes its claim before this lock. Rechecking after acquisition
    // closes the only race between the first close check and our lock write.
    if (!allowClosing) {
      const closing = activeSessionCloseClaim({ stateId: state.id });
      if (closing) throw sessionClosingError(closing);
    }
    return await callback();
  } finally {
    clearInterval(renewal);
    releaseSessionCredentialMutation({ stateId: state.id, ownerId });
  }
}

function revokeSessionMemberKeys(root, state) {
  try {
    revokeGitHubMemberDeployKeys(state.temporary_repository, { cwd: root });
  } catch (error) {
    throw Object.assign(new Error(
      `Could not revoke the session members' deploy keys on ${state.temporary_repository}: ${safeError(error)}\n`
        + "  The close stops before freezing the session's work so no member can still push to it. Fix GitHub CLI access (`gh auth status`), then close again.",
    ), { code: "pairing_member_keys_not_revoked" });
  }
}

async function closeClaimedHostSession(root, remoteClient, state, {
  graceful,
  C,
  json,
  reason,
  publish = true,
  keepBranch = false,
  historyPreserving = false,
  approvalPromptFollows = false,
} = {}) {
  // A hold stops applying once the close claim exists; clearing it here makes
  // the release visible, since held merges must reach the final sync.
  if (readSessionHoldStatus({ stateId: state.id }).state !== SESSION_HOLD_STATES.NONE) {
    clearSessionHold({ stateId: state.id });
    if (!json) console.log(`  ${C.yellow}[sync]${C.reset} Released this checkout's hold so held work is included in the integration.`);
  }
  // Persist the chosen close action before the journal exists. Crash recovery
  // recomputes the promotion strategy from this column, and a journal frozen
  // with a strategy the column does not name can never be resumed.
  const closeAction = keepBranch ? "keep-branch" : historyPreserving ? "integrate-fast-forward" : null;
  if (closeAction && state.close_action !== closeAction) {
    state = updatePairingEnrollment(state.id, { closeAction }) || { ...state, close_action: closeAction };
  }
  let journal = keepBranch ? null : beginPairingPromotion(state, {
    projectDir: root, reason,
    strategy: historyPreserving || state.close_action === "integrate-fast-forward" ? "fast-forward" : "squash",
  });
  if (journal) journal = markPairingPromotion(journal, { phase: graceful ? "draining" : "closing" });
  if (graceful) {
    const closing = validatePairingRemoteResponse(
      "close",
      await remoteClient.close(state.relay_token, "graceful"),
    );
    assertPairingStatusMatches(state, closing);
    if (!json) {
      console.log(`\n  ${C.yellow}Graceful close started.${C.reset} New jobs are stopped; active jobs may finish.`);
    }
  } else {
    const remote = await leaveRemoteBestEffort(remoteClient, state);
    if (remote?.error) throw Object.assign(new Error(remote.error), { code: remote.code });
    if (!json) {
      console.log(reason === "host_crash_recovery"
        ? `\n  ${C.yellow}Recovering the interrupted session on ${state.shared_branch}.${C.reset} Stopping paired clients and freezing its work for integration.`
        : `\n  ${C.yellow}Forced close started.${C.reset} Stopping paired clients.`);
    }
  }

  await waitForRemoteMembersToLeave(remoteClient, state, {
    graceful,
    projectDir: root,
    C,
    json,
  });
  if (graceful) {
    const remote = await leaveRemoteBestEffort(remoteClient, state);
    if (remote?.error) throw Object.assign(new Error(remote.error), { code: remote.code });
  }
  if (journal) journal = markPairingPromotion(journal, { phase: "clients_drained" });
  // Member deploy keys end with the session. Revoking them before the final
  // sync means nothing can reach the source after it is frozen below, and a
  // kept or undeletable repository is no longer writable by anyone but the
  // host. A revocation that cannot be proven leaves the close to recovery.
  if (state.temporary_repository) revokeSessionMemberKeys(root, state);

  const peerSnapshot = readPairingPeerSnapshot();
  if (checkoutSharedBranchForClose(root, state.shared_branch) && !json) {
    console.log(`  ${C.dim}[pair close] switched back to ${state.shared_branch} to take the final sync${C.reset}`);
  }
  const synced = await retryWhileMergeLockBusy(() => syncSharedTrunkFromOrigin(root, {
    provenance: state.baseline_oid ? {
      baselineOid: state.baseline_oid,
      gitIdentities: (peerSnapshot?.peers || [])
        .flatMap((peer) => Array.isArray(peer.git_identities) ? peer.git_identities : []),
    } : null,
  }));
  if (!synced.ok) {
    const blocked = synced.reason === "fast_forward_blocked"
      ? ` (${synced.blockedReason === "dirty"
        ? `${state.shared_branch} has uncommitted changes; commit or stash them, then run \`posse session integrate\``
        : `${synced.blockedReason || "the checkout could not be fast-forwarded"}; switch to ${state.shared_branch} with a clean checkout, then run \`posse session integrate\``})`
      : "";
    throw Object.assign(new Error(`Final shared-trunk sync failed: ${synced.reason || "unknown error"}${blocked}`), {
      code: "pairing_shutdown_sync_failed",
      result: synced,
    });
  }
  // Promotion integrates exactly the object this sync observed, never a tip
  // the session branch reaches afterwards. A frozen source is never moved.
  if (journal) {
    journal = markPairingPromotion(journal, {
      phase: "trunk_frozen",
      ...(!journal.source_sha && TRUNK_HEAD_PATTERN.test(String(synced.remoteSha || ""))
        ? { source_sha: synced.remoteSha } : {}),
    });
  }
  if (keepBranch) {
    const restored = await restoreLocalPairing(root, getPairingState(state.id));
    if (!restored.ok) {
      throw Object.assign(new Error(restored.message), { code: restored.code || "pairing_restore_blocked" });
    }
    return {
      ok: true,
      kept: true,
      sourceBranch: state.shared_branch,
      sourceUrl: state.remote_url,
    };
  }
  const promoted = await retryWhileMergeLockBusy(() => promotePairingTrunk(root, {
    journal,
    publish: publish && journal?.approval_required !== true,
    onProgress: (message) => {
      if (!json) console.log(`  ${C.cyan}[pair integrate]${C.reset} ${message}`);
    },
  }));
  if (!promoted.ok) {
    throw Object.assign(new Error(promoted.reason || "Pairing promotion deferred"), {
      code: promoted.reason || "pairing_promotion_deferred",
    });
  }
  if ((!publish || journal?.approval_required === true) && promoted.pending) {
    if (!json) {
      if (journal?.approval_required === true) {
        // A typed close asks right after this returns and prints the summary
        // there; otherwise say how to review it later.
        if (!approvalPromptFollows) {
          printPromotionForApproval(C, describePromotionBestEffort(root));
          printPendingApprovalGuidance(C, promoted.mergeHash, promoted.targetBaseOid);
        }
      } else {
        console.log(`  ${C.yellow}The session's work is committed on local ${promoted.targetBranch} (${String(promoted.mergeHash || "").slice(0, 8)}) but not published.${C.reset}\n`
          + `  Run \`posse session integrate\` to publish it to ${promoted.remote || "origin"}/${promoted.targetBranch}, `
          + "or `posse session abandon-integration` to drop it.\n");
      }
    }
    return promoted;
  }
  const restored = await restoreLocalPairing(root, getPairingState(state.id));
  if (!restored.ok) {
    throw Object.assign(new Error(restored.message), { code: restored.code || "pairing_restore_blocked" });
  }
  const cleanup = state.temporary_repository
    ? cleanupGitHubSessionRepository(state.temporary_repository, { cwd: root })
    : null;
  if (!json && promoted.skipped === "already_up_to_date") {
    console.log(`  ${C.green}Session closed.${C.reset} It added nothing ${promoted.targetBranch} lacks, so there was nothing to integrate.\n`);
  } else if (!json && publish) {
    console.log(`  ${C.green}Integrated and published${C.reset} ${promoted.sourceBranch} -> ${promoted.targetBranch} (${promoted.mergeHash.slice(0, 8)}).\n`);
  }
  if (!json) reportRepositoryCleanupFailure(C, cleanup);
  return { ...promoted, cleanup };
}

async function runHost({ projectDir, remoteClient, remote, branch, C, json }) {
  const root = repositoryRoot(projectDir);
  assertPairingSchedulerStopped();
  assertCleanPairingCheckout(root);
  retireEndedSessionQueueRows();
  const ambiguous = listUnresolvedSharedTrunkMergeOperations()
    .filter((operation) => operation.phase === "publish_unknown");
  if (ambiguous.length > 0) {
    throw Object.assign(new Error(
      `Shared-trunk publication ${ambiguous[0].operationId} may already have landed. Inspect it with \`posse shared-trunk ops\` before joining another session.`,
    ), { code: "shared_trunk_publication_unknown" });
  }
  const pendingPromotion = readPairingPromotionJournal();
  if (pendingPromotion) {
    throw Object.assign(new Error(
      `The previous session's integration (${pendingPromotion.source_branch || pendingPromotion.session_id || "unknown"}) has not finished. `
        + "Run `posse session integrate` to publish it, or `posse session abandon-integration` to drop it, then start the session again.",
    ), { code: "pairing_promotion_already_pending" });
  }
  const original = currentCheckout(root);
  const sharedBranch = validateBranchName(
    root,
    branch || `posse/pair-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
  );
  const { url } = assertPairingRemoteTargets(root, remote);
  const defaultBranch = remoteDefaultBranch(root, remote);
  if (original.branch !== defaultBranch) {
    throw Object.assign(new Error(
      `Host pairing must start on ${remote}/${defaultBranch} so automatic close integrates into the repository trunk; current branch is ${original.branch}`,
    ), { code: "pairing_host_not_on_default_branch" });
  }
  if (!githubRepositoryName(url)) {
    throw Object.assign(new Error(
      "Session hosting currently requires a GitHub origin so Posse can isolate members in a private throwaway repository",
    ), { code: "pairing_provider_unsupported" });
  }
  assertSessionSshPathSupported(root);
  assertHostTrunkMatchesRemote(root, remote, defaultBranch);
  const { owner: githubOwner } = assertGitHubCliReady(root);
  const state = createPairingState({
    role: "host",
    remoteName: remote,
    remoteUrl: url,
    sharedBranch,
    originalBranch: original.branch,
    originalHead: original.head,
    originalSettings: snapshotPairingSettings(root),
    instanceId: ensureBridgeInstanceId(root),
    originalSshCommand: readLocalSshCommand(root),
  });
  let sessionRemote = remote;
  let sessionUrl = url;
  let provisioned = null;
  let publishedOid = null;
  let started = null;
  try {
    if (githubRepositoryName(url)) {
      // Record the repository before creating it, so a host killed in between
      // still leaves recovery the name to delete.
      updatePairingEnrollment(state.id, {
        temporaryRepository: githubSessionRepositoryName(githubOwner, state.id),
      });
      provisioned = provisionGitHubSessionRepository({
        projectDir: root,
        sessionId: state.id,
        originRemoteUrl: url,
        defaultBranch,
        owner: githubOwner,
      });
      sessionRemote = pairingTemporaryRemoteName(root, state.id);
      sessionUrl = provisioned.remoteUrl;
      addPairingRemote(root, sessionRemote, sessionUrl);
      configureRepositorySessionSsh(root, provisioned.identity.sshCommand);
      updatePairingEnrollment(state.id, {
        remoteName: sessionRemote,
        remoteUrl: sessionUrl,
        addedRemoteName: sessionRemote,
        addedRemoteUrl: sessionUrl,
        originRemoteName: remote,
        originRemoteUrl: url,
        temporaryRepository: provisioned.repository,
        credentialDirectory: provisioned.identity.directory,
        phase: "enrolling",
      });
    }
    await withWorktreeLockAsync(root, root, async () => {
      assertPairingSchedulerStopped();
      publishedOid = createAndPublishPairingBranch(root, {
        remote: sessionRemote,
        branch: sharedBranch,
        expectedUrl: sessionUrl,
        baseBranch: provisioned ? defaultBranch : null,
      });
      // The session repository's default is the trunk it was cut from; the
      // shared branch stays a side branch, as shared-trunk preflight requires.
      if (provisioned) setGitHubDefaultBranch(provisioned.repository, defaultBranch, { cwd: root });
      configurePairingSettings(root, { remote: sessionRemote, branch: sharedBranch });
      const preflight = await runSharedTrunkAccessPreflight(root);
      if (!preflight.ok) {
        throw Object.assign(new Error(preflight.message), { code: preflight.code, preflight });
      }
    });
    started = validatePairingRemoteResponse("sessions", await remoteClient.start({
      instance_id: ensureBridgeInstanceId(root),
      repository_url: sessionUrl,
      repository_fingerprint: repositoryFingerprint(sessionUrl),
      branch: sharedBranch,
    }));
    assertPairingRepositoryUnchanged({
      url: sessionUrl,
      fingerprint: repositoryFingerprint(sessionUrl),
      branch: sharedBranch,
    }, started.repository);
    updatePairingEnrollment(state.id, {
      remoteSessionId: started.session_id,
      relayToken: started.host_token,
      baselineOid: publishedOid,
    });

    if (json) {
      console.log(JSON.stringify({
        ok: true,
        role: "host",
        code: started.code,
        branch: sharedBranch,
        remote: sessionRemote,
        session_id: started.session_id,
      }));
    } else {
      console.log(`\n  ${C.bold}Session is open${C.reset}`);
      console.log(`  Pairing code: ${C.cyan}${C.bold}${started.code}${C.reset}`);
      console.log(`  Invite link: ${C.cyan}posse://session?token=${encodeURIComponent(started.code)}${C.reset}`);
      console.log(`  Shared branch: ${sharedBranch}`);
      console.log(`  Others join with: ${C.cyan}posse session join ${started.code}${C.reset}`);
      console.log(`  Join requests appear below. Type a member's countersign and press Enter to admit them.`);
      console.log(`  ${C.dim}This screen stays open for the whole session and keeps this folder in sync. Queue work with add, run it with go, type help for more.${C.reset}\n`);
    }
    const outcome = await monitorPairing(remoteClient, state.id, {
      projectDir: root, C, json, sessionCode: started.code,
    });
    if (["graceful_close", "force_close", "draining", "closed", "expired"].includes(outcome.reason)) {
      const liveState = getPairingState(state.id);
      const promotion = await finishHostShutdown(root, remoteClient, liveState, {
        graceful: ["graceful_close", "draining"].includes(outcome.reason),
        C,
        json,
        reason: outcome.reason,
        keepBranch: liveState.close_action === "keep-branch",
        historyPreserving: liveState.close_action === "integrate-fast-forward",
        approvalPromptFollows: outcome.reason === "graceful_close" && !json,
      });
      // A typed close is the host at the terminal: ask right here. Ctrl+C, a
      // closed terminal, or a close from elsewhere leave the candidate frozen
      // for `posse session integrate`.
      if (outcome.reason === "graceful_close" && !json && promotion?.pending) {
        const journal = readPairingPromotionJournal();
        if (journal?.approval_required === true) {
          const summary = describePromotionBestEffort(root);
          printPromotionForApproval(C, summary);
          if (await askToPublishPromotion(C, summary) === true) {
            const published = await runPendingIntegration({
              projectDir: root, action: "integrate", C, json,
              approval: { sourceOid: journal.candidate_sha, originOid: journal.target_base_sha },
            });
            return { ok: true, role: "host", outcome: outcome.reason, promotion: published };
          }
          printPendingApprovalGuidance(C, journal.candidate_sha, journal.target_base_sha);
        }
      }
      return { ok: true, role: "host", outcome: outcome.reason, promotion };
    }
    if (outcome.reason === "scheduler_handoff") {
      return { ok: true, role: "host", outcome: outcome.reason };
    }
    if (outcome.reason !== "local_leave") {
      const result = await unpair(root, remoteClient, getPairingState(state.id));
      if (!result.ok) throw Object.assign(new Error(result.local.message), { code: result.local.code });
    }
    return { ok: true, role: "host", outcome: outcome.reason };
  } catch (error) {
    // Once the Remote registered the session, members may have published work
    // that exists only in the session repository. Keep the repository, the
    // checkout, and the pairing state; the next posse command's crash recovery
    // freezes an integration candidate from them instead of deleting it.
    if (started) {
      error.message = `${safeError(error)}\n  The session repository and local pairing state were kept; `
        + "run any posse command here to recover, then `posse session integrate`.";
      throw error;
    }
    if (publishedOid) {
      try {
        await withWorktreeLockAsync(root, root, () => deletePublishedPairingBranch(root, {
          remote: sessionRemote,
          branch: sharedBranch,
          expectedOid: publishedOid,
        }));
      } catch {
        // The leased delete is best-effort; never delete a branch that moved.
      }
    }
    const restored = await restoreLocalPairing(root, getPairingState(state.id));
    const cleanup = provisioned
      ? cleanupGitHubSessionRepository(provisioned.repository, { cwd: root })
      : null;
    // Report whatever rollback could not undo, with the command to finish it.
    const unfinished = [];
    if (!restored.ok) unfinished.push(`automatic restore blocked: ${restored.message}`);
    if (cleanup && !cleanup.ok) {
      unfinished.push(`temporary repository ${cleanup.repository} was not deleted (${safeError(cleanup.message)}). ${cleanup.remediation}`);
    }
    if (unfinished.length) error.message = [safeError(error), ...unfinished].join("\n  ");
    throw error;
  }
}

async function runJoin({ projectDir, remoteClient, code, C, json }) {
  if (!code) {
    throw Object.assign(new Error("A pairing code is required: posse pair <CODE>"), {
      code: "pairing_code_required",
    });
  }
  // Outside any Git checkout the member joins from an empty folder and takes
  // the session repository's history once admitted.
  let root;
  let freshCheckout = false;
  try {
    root = repositoryRoot(projectDir);
  } catch {
    root = initializeFreshPairingCheckout(projectDir);
    freshCheckout = true;
  }
  try {
    return await runJoinInCheckout({ root, freshCheckout, remoteClient, code, C, json });
  } catch (error) {
    if (freshCheckout) discardFreshPairingCheckout(root);
    throw error;
  }
}

async function runJoinInCheckout({ root, freshCheckout, remoteClient, code, C, json }) {
  assertPairingSchedulerStopped();
  assertCleanPairingCheckout(root);
  retireEndedSessionQueueRows();
  const ambiguous = listUnresolvedSharedTrunkMergeOperations()
    .filter((operation) => operation.phase === "publish_unknown");
  if (ambiguous.length > 0) {
    throw Object.assign(new Error(
      `Shared-trunk publication ${ambiguous[0].operationId} may already have landed. Inspect it with \`posse shared-trunk ops\` before joining another session.`,
    ), { code: "shared_trunk_publication_unknown" });
  }
  const pendingPromotion = readPairingPromotionJournal();
  if (pendingPromotion) {
    throw Object.assign(new Error(
      `The previous session's integration (${pendingPromotion.source_branch || pendingPromotion.session_id || "unknown"}) has not finished. `
        + "Run `posse session integrate` to publish it, or `posse session abandon-integration` to drop it, then join again.",
    ), { code: "pairing_promotion_already_pending" });
  }
  const original = currentCheckout(root, { allowUnborn: freshCheckout });
  const resolved = validatePairingRemoteResponse("resolve", await remoteClient.resolve(code));
  const metadata = resolved?.repository || {};
  if (repositoryFingerprint(metadata.url) !== String(metadata.fingerprint || "").toLowerCase()) {
    throw Object.assign(new Error("Pairing repository fingerprint does not match its remote URL"), {
      code: "pairing_repository_fingerprint_mismatch",
    });
  }
  if (!githubRepositoryName(metadata.url)) {
    throw Object.assign(new Error(
      "This client only joins sessions backed by an isolated GitHub throwaway repository",
    ), { code: "pairing_provider_unsupported" });
  }
  const sharedBranch = validateBranchName(root, metadata.branch);
  if (original.branch === sharedBranch) {
    throw Object.assign(new Error(
      `Pairing branch ${sharedBranch} is already checked out; switch to the branch that should be restored first`,
    ), { code: "pairing_local_branch_checked_out" });
  }
  const existingRemote = findPairingRemote(root, metadata.url);
  const instanceId = ensureBridgeInstanceId(root);
  const chosenRemote = existingRemote?.remote || pairingTemporaryRemoteName(root, resolved.session_id);
  const state = createPairingState({
    role: "member",
    remoteName: chosenRemote,
    remoteUrl: metadata.url,
    sharedBranch,
    originalBranch: original.branch,
    originalHead: original.head,
    // An empty folder had no settings of its own; rows keyed by this path are
    // leftovers (a deleted folder's killed session) and must not be restored.
    originalSettings: freshCheckout ? {} : snapshotPairingSettings(root),
    instanceId,
    originalSshCommand: readLocalSshCommand(root),
  });
  let sessionIdentity = null;
  let joined = null;
  try {
    if (githubRepositoryName(metadata.url)) {
      sessionIdentity = prepareSessionSshIdentity(root, resolved.session_id);
      configureRepositorySessionSsh(root, sessionIdentity.sshCommand);
      updatePairingEnrollment(state.id, {
        credentialDirectory: sessionIdentity.directory,
        phase: "enrolling",
      });
    }
    joined = validatePairingRemoteResponse(
      "join",
      await remoteClient.requestJoin(code, instanceId, {
        sshPublicKey: sessionIdentity?.publicKeyText || null,
      }),
    );
    if (joined.session_id !== resolved.session_id) {
      throw Object.assign(new Error("Pairing session changed while admission was requested"), {
        code: "pairing_session_changed",
      });
    }
    assertPairingRepositoryUnchanged(metadata, joined.repository);
    const memberToken = joined.member_token || joined.pending_token;
    updatePairingEnrollment(state.id, {
      remoteSessionId: joined.session_id,
      relayToken: memberToken,
      phase: joined.status === "pending" ? "pending" : "enrolling",
    });
    if (joined.status === "pending") {
      if (json) {
        console.log(JSON.stringify({
          ok: true,
          pending: true,
          session_id: joined.session_id,
          countersign: joined.countersign,
        }));
      } else {
        console.log(`\n  ${C.bold}Waiting for host admission${C.reset}`);
        console.log(`  Confirm this countersign with the host: ${C.cyan}${C.bold}${joined.countersign}${C.reset}\n`);
      }
      const admission = await waitForPairingAdmission(remoteClient, state.id, memberToken, { C, json });
      if (admission.status !== "admitted") {
        throw Object.assign(new Error(`Session admission ended: ${admission.status}`), {
          code: `pairing_admission_${admission.status}`,
        });
      }
      markPairingPhase(state.id, "enrolling");
    }
    pulseTokenManager.setSessionContext({ instanceId, sessionId: joined.session_id });
    let pairingRemote = existingRemote;
    let baselineOid = null;
    await withWorktreeLockAsync(root, root, async () => {
      assertPairingSchedulerStopped();
      if (!pairingRemote) {
        updatePairingEnrollment(state.id, {
          remoteName: chosenRemote,
          addedRemoteName: chosenRemote,
          addedRemoteUrl: metadata.url,
          phase: "enrolling",
        });
        pairingRemote = addPairingRemote(root, chosenRemote, metadata.url);
      }
      // This fetch + leased dry-run push is the per-user repo-access gate.
      // Admission only activates the relay credential; the member is not
      // counted live until this preflight succeeds and monitoring begins.
      // GitHub accepts a new deploy key unevenly for a while: one request can
      // succeed and the next still fail, so every network step retries.
      let keyWaitAnnounced = false;
      const onKeyWait = (attempt, waitMs) => {
        if (json) return;
        if (!keyWaitAnnounced) {
          keyWaitAnnounced = true;
          console.log(`  ${C.dim}Waiting for GitHub to accept this clone's session key...${C.reset}`);
        } else {
          console.log(`  ${C.dim}still waiting (retry in ${Math.round(waitMs / 1000)}s)${C.reset}`);
        }
      };
      baselineOid = await retryWhileSessionKeyPropagates(() => preflightAndCheckoutPairingBranch(root, {
        remote: pairingRemote.remote,
        branch: sharedBranch,
        expectedUrl: metadata.url,
      }), { onWait: onKeyWait });
      configurePairingSettings(root, { remote: pairingRemote.remote, branch: sharedBranch });
      await retryWhileSessionKeyPropagates(async () => {
        const preflight = await runSharedTrunkAccessPreflight(root, {
          requireScopeEnforcement: true,
          onCapabilities: (capabilities) => {
            pulseTokenManager.confirmNativeScopeEnforcement(capabilities?.scopeEnforcement === true);
          },
        });
        if (!preflight.ok) {
          throw Object.assign(new Error(preflight.message), { code: preflight.code, preflight });
        }
      }, { onWait: onKeyWait });
    });
    updatePairingEnrollment(state.id, {
      remoteSessionId: joined.session_id,
      relayToken: memberToken,
      baselineOid,
      phase: "active",
    });
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        role: "member",
        branch: sharedBranch,
        remote: pairingRemote.remote,
        session_id: joined.session_id,
      }));
    } else {
      console.log(freshCheckout
        ? `\n  ${C.green}Paired.${C.reset} Checked out ${sharedBranch} from the session repository into ${root}.`
        : `\n  ${C.green}Paired.${C.reset} Switched to ${sharedBranch}.`);
      console.log(`  ${C.dim}This screen stays open for the whole session and keeps this folder in sync. Queue work with add, run it with go,${C.reset}`);
      console.log(`  ${C.dim}and type leave to disconnect (the host closing the session also ends it). Type help for more.${C.reset}\n`);
    }
    const outcome = await monitorPairing(remoteClient, state.id, {
      projectDir: root, C, json, sessionCode: String(code).trim().toUpperCase(),
    });
    if (outcome.reason === "scheduler_handoff") {
      return { ok: true, role: "member", outcome: outcome.reason };
    }
    if (outcome.reason !== "local_leave") {
      await waitForPairingSchedulerStop({
        state: getPairingState(state.id),
        graceful: outcome.reason === "draining",
        onProgress: (message) => {
          if (!json) console.log(`  ${C.yellow}[pair close]${C.reset} ${message}`);
        },
      });
      const result = await unpair(root, remoteClient, getPairingState(state.id));
      if (!result.ok) throw Object.assign(new Error(result.local.message), { code: result.local.code });
      if (!json) {
        console.log(`\n  ${MEMBER_EXIT_REASONS[outcome.reason] || "You left the session"}.`);
        const finalSync = describeFinalMemberSync(result.finalSync);
        if (finalSync) console.log(`  ${finalSync}`);
        console.log(freshCheckout
          ? `  This folder keeps the session's work on branch ${original.branch}.\n`
          : `  Switched back to ${original.branch}; the session's work stays on ${sharedBranch}.\n`);
      }
    }
    return { ok: true, role: "member", outcome: outcome.reason };
  } catch (error) {
    if (joined?.member_token || joined?.pending_token) await leaveRemoteBestEffort(remoteClient, {
      ...getPairingState(state.id),
      relay_token: joined.member_token || joined.pending_token,
    });
    const restored = await restoreLocalPairing(root, getPairingState(state.id));
    if (!restored.ok) error.message = `${safeError(error)}; automatic restore blocked: ${restored.message}`;
    throw error;
  }
}

function remoteClientBestEffort(remoteClient, remoteClientFactory) {
  if (remoteClient) return remoteClient;
  try {
    return remoteClientFactory();
  } catch {
    return null;
  }
}

async function runStatus({
  projectDir,
  remoteClient,
  remoteClientFactory,
  pairingProcessIsAlive,
  C,
  json,
}) {
  const state = getLivePairingState();
  if (!state) {
    clearPairingPeerSnapshot();
    const result = { ok: true, paired: false };
    if (json) console.log(JSON.stringify(result));
    else console.log("\n  This clone is not paired.\n");
    return result;
  }
  if (state.phase === "pending") {
    if (!pairingProcessIsAlive(state)) {
      const recovered = await unpair(
        repositoryRoot(projectDir),
        remoteClientBestEffort(remoteClient, remoteClientFactory),
        state,
      );
      const result = {
        ok: recovered.ok,
        paired: false,
        ended: "pending_monitor_exited",
        restored: recovered.local,
      };
      if (json) console.log(JSON.stringify(result));
      else console.log(`\n  Pending session join ended; ${recovered.ok ? `restored ${state.original_branch}` : recovered.local.message}.\n`);
      return result;
    }
    const client = remoteClient || remoteClientFactory();
    const pending = validatePairingRemoteResponse(
      "pending",
      await client.pendingStatus(state.relay_token),
    );
    const result = {
      ok: true,
      paired: false,
      pending: pending.status === "pending",
      role: state.role,
      phase: state.phase,
      status: pending,
    };
    if (json) console.log(JSON.stringify(result));
    else printActive(C, state, pending);
    return result;
  }
  if (state.phase !== "active") {
    clearPairingPeerSnapshot();
    const restored = await restoreLocalPairing(repositoryRoot(projectDir), state);
    const result = { ok: restored.ok, paired: false, ended: state.phase, restored };
    if (json) console.log(JSON.stringify(result));
    else console.log(`\n  Pairing recovery ${restored.ok ? `restored ${state.original_branch}` : `is blocked: ${restored.message}`}.\n`);
    return result;
  }
  if (!pairingProcessIsAlive(state) && state.role === "host" && readPairingPromotionJournal()) {
    // The integration still needs this session's key and remote to finish;
    // integrate or abandon-integration restores the checkout afterwards.
    clearPairingPeerSnapshot();
    const journal = readPairingPromotionJournal();
    const result = { ok: true, paired: false, ended: "host_exited", integration_pending: true, phase: journal.phase };
    if (json) console.log(JSON.stringify(result));
    else {
      console.log(`\n  No live session. The last one (${journal.source_branch || state.shared_branch}) ended unexpectedly;`
        + " its work waits for `posse session integrate` (or `posse session abandon-integration`).\n");
    }
    return result;
  }
  if (!pairingProcessIsAlive(state)) {
    clearPairingPeerSnapshot();
    const recovered = await unpair(
      repositoryRoot(projectDir),
      remoteClientBestEffort(remoteClient, remoteClientFactory),
      state,
    );
    const result = {
      ok: recovered.ok,
      paired: false,
      ended: "monitor_exited",
      restored: recovered.local,
      remote: recovered.remote,
    };
    if (json) console.log(JSON.stringify(result));
    else if (!recovered.ok) console.log(`\n  The session's console is gone, and restoring this checkout is blocked: ${recovered.local.message}.\n`);
    else console.log(`\n  No live session: its console is gone. Switched back to ${state.original_branch}.\n`);
    return result;
  }
  const client = remoteClient || remoteClientFactory();
  let status = null;
  if (state.relay_token) {
    try {
      status = validatePairingRemoteResponse("status", await client.status(state.relay_token));
      assertPairingStatusMatches(state, status);
    } catch (error) {
      if (error?.status !== 401) throw error;
      status = { status: "closed", active_members: 0 };
    }
  }
  if (status && status.status !== "active") {
    clearPairingPeerSnapshot();
    const restored = await restoreLocalPairing(repositoryRoot(projectDir), state);
    const result = { ok: restored.ok, paired: false, ended: status.status, restored };
    if (json) console.log(JSON.stringify(result));
    else console.log(`\n  Pairing ${status.status}; ${restored.ok ? `switched back to ${state.original_branch}` : restored.message}.\n`);
    return result;
  }
  if (status) writePairingPeerSnapshot(status);
  const derived = readSessionSyncBestEffort(state);
  const result = {
    ok: true,
    paired: true,
    role: state.role,
    phase: state.phase,
    status,
    sync: derived?.sync || null,
    peers_sync: derived?.peers_sync || [],
  };
  if (json) console.log(JSON.stringify(result));
  else printActive(C, state, status, derived);
  return result;
}

// Admit the pending member whose countersign the host typed, then grant its
// session key write access to the throwaway repository. A member whose key
// cannot be installed is removed again only after key absence is proven; an
// uncertain credential remains visible in the relay roster for recovery.
async function admitPairingMember({ state, code, projectDir, remoteClient }) {
  if (!code) {
    throw Object.assign(new Error("A 4-character countersign is required: posse session admit <CODE>"), {
      code: "pairing_countersign_required",
    });
  }
  return withSessionCredentialMutation(state, "member admission", async () => {
    const admitted = validatePairingRemoteResponse(
      "admit",
      await remoteClient.admit(state.relay_token, code),
    );
    assertPairingStatusMatches(state, admitted);
    if (state.temporary_repository) {
      const root = repositoryRoot(projectDir);
      try {
        addGitHubMemberDeployKey(state.temporary_repository, admitted.admitted_member, { cwd: root });
      } catch (error) {
        const memberId = admitted.admitted_member?.id;
        if (memberId) {
          let keyRemovalProven = false;
          // A failed add can still have created the key (GitHub applied the
          // POST but its response was lost), so rollback removes any key under
          // the member's title before it counts as done.
          try {
            removeGitHubMemberDeployKeys(state.temporary_repository, memberId, { cwd: root });
            keyRemovalProven = true;
          } catch (cleanupError) {
            error.message = `${safeError(error)}\n  This member remains admitted because their deploy key may still be active on ${state.temporary_repository} `
              + `(removing it failed: ${safeError(cleanupError)}). Retry \`posse session kick ${memberId}\`, or close the session; `
              + `to revoke it manually, find the key titled "Posse member ${memberId} ..." with \`gh api repos/${state.temporary_repository}/keys\` `
              + `and delete it with \`gh api --method DELETE repos/${state.temporary_repository}/keys/<id>\`.`;
          }
          // Never hide an unproven credential by removing its durable relay
          // roster entry. Keeping the member admitted makes the outstanding
          // access visible and gives kick/close a recoverable cleanup target.
          if (keyRemovalProven) {
            try { await remoteClient.kick(state.relay_token, memberId); } catch { /* revoke pulse best effort */ }
          }
        }
        throw error;
      }
    }
    return { ok: true, admitted: true, countersign: String(code).toUpperCase(), member: admitted.admitted_member || null };
  });
}

async function kickPairingMember({ state, memberId, projectDir, remoteClient }) {
  return withSessionCredentialMutation(state, "member removal", async () => {
    if (state.temporary_repository) {
      removeGitHubMemberDeployKeys(state.temporary_repository, memberId, { cwd: repositoryRoot(projectDir) });
    }
    return validatePairingRemoteResponse("status", await remoteClient.kick(state.relay_token, memberId));
  });
}

async function runAdmit({ projectDir, remoteClient, code, C, json }) {
  const state = getLivePairingState();
  if (!state || state.role !== "host" || !state.relay_token) {
    throw Object.assign(new Error("This clone is not hosting a live session"), {
      code: "pairing_host_session_required",
    });
  }
  const admitted = await admitPairingMember({ state, code, projectDir, remoteClient });
  const result = { ok: admitted.ok, admitted: admitted.admitted, countersign: admitted.countersign };
  if (json) console.log(JSON.stringify(result));
  else console.log(`\n  ${C.green}Admitted session member ${result.countersign}.${C.reset}\n`);
  return result;
}

function liveHostState() {
  const state = getLivePairingState();
  if (!state || state.role !== "host" || state.phase !== "active" || !state.relay_token) {
    throw Object.assign(new Error("This clone is not hosting a live session"), {
      code: "pairing_host_session_required",
    });
  }
  return state;
}

async function runSessionManagement({ projectDir, remoteClient, action, code, value, C, json }) {
  const state = liveHostState();
  if (["members", "pending"].includes(action)) {
    const result = await remoteClient.members(state.relay_token, { pendingOnly: action === "pending" });
    if (json) console.log(JSON.stringify(result));
    else if (result.members.length === 0) console.log(`\n  No ${action === "pending" ? "pending " : ""}session members.\n`);
    else {
      console.log(`\n  ${C.bold}${action === "pending" ? "Pending" : "Session"} members${C.reset}`);
      for (const member of result.members) {
        console.log(`  ${member.id}  ${member.state}/${member.role}  ${member.instance_id}`);
      }
      console.log("");
    }
    return result;
  }
  let status;
  if (action === "kick") {
    status = await kickPairingMember({ state, memberId: code, projectDir, remoteClient });
  } else if (action === "invite") {
    if (!["open", "close"].includes(code)) {
      throw Object.assign(new Error("Session invite action must be open or close"), {
        code: "pairing_invite_action_invalid",
      });
    }
    status = await remoteClient.setInviteOpen(state.relay_token, code === "open");
  } else if (action === "scope") {
    let parsed;
    try {
      parsed = JSON.parse(String(value || ""));
    } catch {
      throw Object.assign(new Error("Session scope must be valid JSON"), { code: "pairing_scope_invalid" });
    }
    // Narrowing paths keeps the member's role unless the JSON names one; this
    // used to send "operator" and quietly promote a viewer.
    const role = parsed?.role == null ? null : String(parsed.role);
    const scopeSet = parsed?.write || parsed;
    status = await remoteClient.setScope(state.relay_token, code, scopeSet, role);
  } else if (action === "policy") {
    if (!["each-member", "capability-routing", "host-only"].includes(code)) {
      throw Object.assign(new Error("Session compute policy must be each-member, capability-routing, or host-only"), {
        code: "pairing_policy_invalid",
      });
    }
    status = await remoteClient.setPolicy(state.relay_token, code);
  }
  status = validatePairingRemoteResponse("status", status);
  assertPairingStatusMatches(state, status);
  const result = { ok: true, action, status };
  if (json) console.log(JSON.stringify(result));
  else console.log(`\n  ${C.green}Session ${action} updated.${C.reset}\n`);
  return result;
}

// Hold and resume only touch this clone's database: the scheduler's poller
// applies them, so they need neither the Remote nor native Git.
function runSessionHoldCommand({ action, reason = null, C, json }) {
  const result = action === "hold"
    ? setSessionHold({ reason })
    : requestSessionResume();
  if (json) {
    console.log(JSON.stringify(result));
  } else if (action === "hold") {
    console.log(result.ok
      ? `\n  ${C.cyan}${describeSessionHold(result.hold).replace("Type resume", "Run `posse session resume`")}${C.reset}\n`
      : `\n  ${C.yellow}Hold not set: ${result.reason === "no_active_session" ? "this clone is not in a live session" : result.reason}.${C.reset}\n`);
  } else {
    console.log(`\n  ${result.ok && result.resumed ? C.cyan : C.yellow}${describeSessionResume(result)}${C.reset}\n`);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function runPendingIntegration({
  projectDir, action, C, json, approval = null, silent = false, ask = askToPublishPromotion,
  workflowFactory = undefined,
}) {
  const root = repositoryRoot(projectDir);
  let journal = readPairingPromotionJournal();
  if (!journal) {
    if (approval) throw Object.assign(new Error("There is no frozen promotion to approve"), {
      code: "pairing_promotion_approval_stale",
    });
    const result = { ok: true, skipped: "no_pending_integration" };
    if (!silent && json) console.log(JSON.stringify(result));
    else if (!silent) console.log("\n  No session integration is pending.\n");
    return result;
  }
  if (action === "abandon-integration") {
    clearPairingPromotionJournal();
    const state = getLivePairingState();
    const restored = state ? await restoreLocalPairing(root, state) : { ok: true, alreadyLeft: true };
    const suffix = String(journal.session_id || "recovery")
      .replace(/[^a-zA-Z0-9-]/gu, "")
      .slice(0, 64) || "recovery";
    const result = {
      ok: restored.ok,
      abandoned: true,
      candidateRef: journal.candidate_sha ? `refs/posse/pairing-promotions/${suffix}` : null,
      restored,
    };
    if (!silent && json) console.log(JSON.stringify(result));
    else if (!silent) console.log(`\n  Session integration abandoned${result.candidateRef ? `; candidate preserved at ${result.candidateRef}` : ""}.\n`);
    return result;
  }
  let promoted = null;
  if (journal.approval_required === true && !approval) {
    // Build the candidate for review: a recovered close may not have built it
    // yet, and one frozen before origin moved is rebuilt on the new origin.
    // Nothing is published here.
    const previousCandidate = journal.candidate_sha || null;
    const frozen = await retryWhileMergeLockBusy(() => promotePairingTrunk(root, { journal, publish: false, workflowFactory }));
    if (!frozen.ok) return frozen;
    if (frozen.pending) {
      journal = readPairingPromotionJournal();
      if (previousCandidate && journal.candidate_sha !== previousCandidate && !json && !silent) {
        console.log(`  ${C.yellow}${frozen.remote || "origin"}/${frozen.targetBranch} moved since the candidate was frozen; rebuilt it on the new origin.${C.reset}`);
      }
    } else {
      // Origin already has the session's work: finish the cleanup below.
      promoted = frozen;
    }
    if (!promoted && !json && !silent) {
      const summary = describePromotionBestEffort(root);
      printPromotionForApproval(C, summary);
      const answer = await ask(C, summary);
      if (answer === true) {
        approval = { sourceOid: journal.candidate_sha, originOid: journal.target_base_sha };
      } else if (answer === false) {
        console.log(`  ${C.dim}Not published. It stays frozen for \`posse session integrate\` or \`posse session abandon-integration\`.${C.reset}\n`);
        return { ok: true, published: false, pending: true };
      }
    }
  }
  if (!promoted) {
    if (journal.approval_required === true
      && (approval?.sourceOid !== journal.candidate_sha || approval?.originOid !== journal.target_base_sha)) {
      throw Object.assign(new Error(
        `Integration requires --approve-source-oid ${journal.candidate_sha} --approve-origin-oid ${journal.target_base_sha}`,
      ), { code: "pairing_promotion_approval_required" });
    }
    promoted = await retryWhileMergeLockBusy(() => promotePairingTrunk(root, {
      journal,
      publish: true,
      approval,
      workflowFactory,
      onProgress: (message) => {
        if (!json && !silent) console.log(`  ${C.cyan}[session integrate]${C.reset} ${message}`);
      },
    }));
    if (!promoted.ok) return promoted;
  }
  const state = getLivePairingState();
  const restored = state ? await restoreLocalPairing(root, state) : { ok: true, alreadyLeft: true };
  const cleanup = journal.temporary_repository
    ? cleanupGitHubSessionRepository(journal.temporary_repository, { cwd: root })
    : null;
  const result = { ...promoted, restored, cleanup };
  if (!silent && json) console.log(JSON.stringify(result));
  else if (!silent && promoted.skipped === "already_up_to_date") {
    console.log(`\n  ${C.green}Nothing to publish:${C.reset} ${promoted.targetBranch} already has the session's work. Cleaned up.\n`);
  } else if (!silent) console.log(`\n  ${C.green}Session integration published${C.reset} ${promoted.targetBranch} (${promoted.mergeHash.slice(0, 8)}).\n`);
  if (!silent && !json) reportRepositoryCleanupFailure(C, cleanup);
  return result;
}

export async function approvePairingPromotion({ projectDir = process.cwd(),
  session_id: sessionId, source_oid: sourceOid, origin_oid: originOid, action_id: actionId,
} = {}) {
  const state = getLivePairingState();
  const journal = readPairingPromotionJournal();
  const root = repositoryRoot(projectDir);
  if (!state || state.role !== "host" || state.remote_session_id !== sessionId
    || !journal || journal.session_id !== sessionId || journal.approval_required !== true
    || journal.candidate_sha !== sourceOid || journal.target_base_sha !== originOid
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(sourceOid || "")
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(originOid || "")
    || typeof actionId !== "string" || !actionId) {
    return { ok: false, reason: "pairing_promotion_approval_stale" };
  }
  try {
    const result = await runPendingIntegration({ projectDir: root, action: "integrate", C: {},
      json: false, silent: true, approval: { sourceOid, originOid } });
    if (!result?.ok || result.mergeHash !== sourceOid || result.restored?.ok !== true) {
      return { ok: false, reason: "pairing_promotion_receipt_unverified" };
    }
    return { ok: true, protocol: "posse.team_promotion.v1", repo_path: root,
      session_id: sessionId, action_id: actionId,
      source_oid: sourceOid, origin_oid: originOid, published_oid: result.mergeHash };
  } catch (error) {
    return { ok: false, reason: error?.code || "pairing_promotion_unavailable" };
  }
}

export async function runPairingCommand(argv = [], {
  projectDir = process.cwd(),
  C = new Proxy({}, { get: () => "" }),
  remoteClient = null,
  remoteClientFactory = createPairingRemoteClient,
  pairingProcessIsAlive = pairingOwnerProcessIsAlive,
} = {}) {
  const args = parsePairArgs(argv);
  let client = remoteClient;
  if (!client && !["status", "integrate", "abandon-integration", "hold", "resume"].includes(args.action)) {
    try {
      client = remoteClientFactory();
    } catch (error) {
      if (args.action !== "leave") throw error;
      client = null;
    }
  }
  if (args.action === "host") return runHost({ ...args, projectDir, remoteClient: client, C });
  if (args.action === "join") return runJoin({ ...args, projectDir, remoteClient: client, C });
  if (args.action === "admit") return runAdmit({ ...args, projectDir, remoteClient: client, C });
  if (["hold", "resume"].includes(args.action)) return runSessionHoldCommand({ ...args, C });
  if (["integrate", "abandon-integration"].includes(args.action)) {
    return runPendingIntegration({ ...args, projectDir, C });
  }
  if (args.action === "publication") {
    const { setTeamPublicationMode } = await import("./team-submissions.js");
    const result = await setTeamPublicationMode(args.code, {
      projectDir, remoteClientFactory: () => client,
    });
    if (args.json) console.log(JSON.stringify(result));
    else if (result.ok) console.log(`\n  ${C.green}Session publication mode: ${result.mode}.${C.reset}\n`);
    else console.error(`\n  ${C.red}Publication mode unchanged: ${result.reason}.${C.reset}\n`);
    return result;
  }
  if (["members", "pending", "kick", "invite", "scope", "policy"].includes(args.action)) {
    return runSessionManagement({ ...args, projectDir, remoteClient: client, C });
  }
  if (args.action === "status") {
    return runStatus({
      ...args,
      projectDir,
      remoteClient: client,
      remoteClientFactory,
      pairingProcessIsAlive,
      C,
    });
  }

  const state = getLivePairingState();
  const root = repositoryRoot(projectDir);
  let result;
  if (state?.role === "host" && pairingProcessIsAlive(state) && state.process_pid !== process.pid) {
    if (args.keepBranch || args.historyPreserving) updatePairingEnrollment(state.id, {
      closeAction: args.keepBranch ? "keep-branch" : "integrate-fast-forward",
    });
    const closing = validatePairingRemoteResponse(
      "close",
      await client.close(state.relay_token, "graceful"),
    );
    assertPairingStatusMatches(state, closing);
    if (!args.json) console.log("\n  Graceful close requested; waiting for the host scheduler to drain.\n");
    await waitForPairingSchedulerStop({
      state,
      graceful: true,
      onProgress: (message) => {
        if (!args.json) console.log(`  ${C.cyan}[session drain]${C.reset} ${message}`);
      },
    });
    result = await finishHostShutdown(root, client, getPairingState(state.id), {
      graceful: true,
      C,
      json: args.json,
      reason: "host_leave",
      keepBranch: args.keepBranch || state.close_action === "keep-branch",
      historyPreserving: args.historyPreserving || state.close_action === "integrate-fast-forward",
    });
  } else {
    result = state?.role === "host"
      ? await finishHostShutdown(root, client, state, {
        graceful: true,
        C,
        json: args.json,
        reason: "host_leave",
        keepBranch: args.keepBranch || state.close_action === "keep-branch",
        historyPreserving: args.historyPreserving || state.close_action === "integrate-fast-forward",
      })
      : await unpair(root, client, state);
  }
  if (args.json) console.log(JSON.stringify(result));
  else if (!state || result.alreadyLeft) console.log("\n  This clone is not paired.\n");
  else if (state.role === "host" && result.ok) {
    // finishHostShutdown already printed the integration result.
  }
  else if (result.ok) {
    const finalSync = describeFinalMemberSync(result.finalSync);
    console.log(`\n  Left the session; switched back to ${state.original_branch}.${finalSync ? `\n  ${finalSync}` : ""}\n`);
  }
  else console.error(`\n  ${C.red}Unpair restore blocked:${C.reset} ${result.local.message}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

export async function runUnpairCommand(argv = [], options = {}) {
  return runPairingCommand(["leave", ...argv], options);
}

export async function recoverInterruptedPairing(projectDir = process.cwd(), {
  C = new Proxy({}, { get: () => "" }),
  remoteClientFactory = createPairingRemoteClient,
  pairingProcessIsAlive = pairingOwnerProcessIsAlive,
  json = false,
} = {}) {
  const state = getLivePairingState();
  const journal = readPairingPromotionJournal();
  if (state && pairingProcessIsAlive(state)) {
    if (journal) {
      return {
        ok: false,
        attempted: true,
        pending: true,
        code: "pairing_shutdown_in_progress",
        message: "Pairing graceful close is still draining or integrating",
      };
    }
    return { ok: true, attempted: false };
  }
  if (journal?.phase === "candidate") {
    return {
      ok: false,
      attempted: true,
      pending: true,
      code: "pairing_integration_required",
      message: "Session integration candidate is ready; run `posse session integrate` or `posse session abandon-integration`",
      journal,
    };
  }
  if (!journal && !state) return { ok: true, attempted: false };
  const root = repositoryRoot(projectDir);
  try {
    if (state?.role === "member" && !pairingProcessIsAlive(state)) {
      await waitForPairingSchedulerStop({ state, graceful: false });
      const client = remoteClientFactory();
      const result = await unpair(root, client, state);
      if (!json && result.ok) {
        console.log(`  Left the interrupted session on ${state.shared_branch}; switched back to ${state.original_branch}.`);
      }
      return {
        ok: result.ok,
        attempted: true,
        recovered: result.ok,
        member: true,
        result,
      };
    }
    if (state?.role === "host" && state.phase !== "left" && !state.remote_session_id
      && (!journal || journal.session_id === state.id)
      && !pairingBranchHasOwnCommits(root, state.shared_branch, state.original_head)) {
      // The host died before the Remote registered the session: no member could
      // have joined or pushed, and there is no credential to close it with. Undo
      // it locally instead of integrating through the Remote.
      if (journal) clearPairingPromotionJournal();
      const restored = await restoreLocalPairing(root, state);
      const cleanup = state.temporary_repository
        ? cleanupGitHubSessionRepository(state.temporary_repository, { cwd: root })
        : null;
      if (!json) reportRepositoryCleanupFailure(C, cleanup);
      return { ok: restored.ok, attempted: true, recovered: restored.ok, unregistered: true, restored, cleanup };
    }
    if (state?.role === "host" && state.phase !== "left") {
      const client = remoteClientFactory();
      // A journal frozen for this session already names its strategy; recovery
      // must resume it rather than recompute one from a column the interrupted
      // close may not have written.
      const frozenStrategy = journal && journal.session_id === state.remote_session_id
        ? (journal.strategy || "squash") : null;
      const promotion = await finishHostShutdown(root, client, state, {
        graceful: false,
        C,
        json,
        reason: "host_crash_recovery",
        publish: false,
        keepBranch: !journal && state.close_action === "keep-branch",
        historyPreserving: frozenStrategy
          ? frozenStrategy === "fast-forward"
          : state.close_action === "integrate-fast-forward",
      });
      if (promotion.kept || promotion.skipped) return { ok: true, attempted: true, recovered: true, promotion };
      return {
        ok: false,
        attempted: true,
        pending: true,
        // finishHostShutdown already told the operator what to run.
        reported: !json,
        code: "pairing_integration_required",
        message: "Session integration candidate is ready; run `posse session integrate` or `posse session abandon-integration`",
        promotion,
      };
    }
    return {
      ok: false,
      attempted: true,
      pending: true,
      code: "pairing_integration_required",
      message: "Session integration is pending; run `posse session integrate` or `posse session abandon-integration`",
      journal,
    };
  } catch (error) {
    const activeJournal = readPairingPromotionJournal();
    if (activeJournal) {
      markPairingPromotion(activeJournal, {
        last_error: safeError(error),
      });
    }
    return {
      ok: false,
      attempted: true,
      pending: true,
      code: error?.code || "pairing_recovery_failed",
      message: safeError(error),
    };
  }
}

export const __testPairingCommandInternals = Object.freeze({
  monitorPairing, printMemberChanges, finishHostShutdown, retryWhileSessionKeyPropagates,
  retireEndedSessionQueueRows, retryWhileMergeLockBusy, runPendingIntegration, printPromotionForApproval,
  askToPublishPromotion,
});
