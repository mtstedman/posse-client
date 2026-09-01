import { randomUUID } from "node:crypto";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { ensureBridgeInstanceId } from "../../bridge/functions/auth.js";
import { runSharedTrunkAccessPreflight } from "../../integrations/functions/shared-trunk-preflight.js";
import { getLiveSchedulerBlockMessage } from "../../queue/functions/locks.js";
import { getSetting, setSetting } from "../../settings/functions/repository-settings.js";
import { withWorktreeLockAsync } from "../../git/functions/worktree-locks.js";
import {
  createPairingRemoteClient,
  validatePairingRemoteResponse,
} from "./remote-client.js";
import {
  addPairingRemote,
  assertPairingRemoteTargets,
  assertCleanPairingCheckout,
  createAndPublishPairingBranch,
  currentCheckout,
  deletePublishedPairingBranch,
  findPairingRemote,
  pairingTemporaryRemoteName,
  preflightAndCheckoutPairingBranch,
  removeTemporaryRemote,
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
  markPairingPhase,
  pairingOwnerProcessIsAlive,
  pairingProcessShouldStop,
  touchPairingState,
  updatePairingEnrollment,
} from "./state.js";
import {
  collectPairingPresence,
  diffPairingPeerActivity,
} from "./work-items.js";

// This is both the lease heartbeat and the peer-work sync cadence. Five
// seconds keeps the terminal feed live without turning queue changes into one
// remote request apiece.
const HEARTBEAT_MS = 5_000;
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

function sessionChanged(message) {
  return Object.assign(new Error(message), { code: "pairing_session_changed" });
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
  if (["host", "join", "leave", "status"].includes(first)) {
    const allowedLength = first === "join" ? 2 : 1;
    if (positional.length > allowedLength) {
      throw Object.assign(new Error(`Unexpected pairing argument: ${positional[allowedLength]}`), {
        code: "pairing_argument_unexpected",
      });
    }
    parsed = { action: first, code: positional[1] || null, json, remote, branch };
  } else {
    if (positional.length > 1) {
      throw Object.assign(new Error(`Unexpected pairing argument: ${positional[1]}`), {
        code: "pairing_argument_unexpected",
      });
    }
    parsed = { action: "join", code: first, json, remote, branch };
  }
  if (parsed.action !== "host" && (hasRemoteFlag || hasBranchFlag)) {
    const option = hasRemoteFlag ? "--remote" : "--branch";
    throw Object.assign(new Error(`${option} is only valid when hosting a pairing`), {
      code: "pairing_option_not_allowed",
    });
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

async function restoreLocalPairing(projectDir, state) {
  if (!state || state.phase === "left") return { ok: true, alreadyLeft: true };
  markPairingPhase(state.id, "leaving");
  try {
    assertPairingSchedulerStopped();
    await withWorktreeLockAsync(projectDir, projectDir, async () => {
      assertPairingSchedulerStopped();
      // Stop new shared-trunk publications before changing checkout state.
      setSetting(SETTING_KEYS.SHARED_TRUNK_ENABLED, "false", { projectDir });
      restoreOriginalBranch(projectDir, state.original_branch);
      restorePairingSettings(projectDir, state.originalSettings);
      if (state.added_remote_name) {
        removeTemporaryRemote(projectDir, {
          remote: state.added_remote_name,
          expectedUrl: state.added_remote_url,
        });
      }
    });
    markPairingPhase(state.id, "left");
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

async function unpair(projectDir, remoteClient, state = getLivePairingState()) {
  if (!state) return { ok: true, alreadyLeft: true };
  markPairingPhase(state.id, "leaving");
  const remote = await leaveRemoteBestEffort(remoteClient, state);
  const local = await restoreLocalPairing(projectDir, getPairingState(state.id));
  return { ok: local.ok, local, remote, role: state.role };
}

function printPeerActivityChanges(C, status, seen, { json = false } = {}) {
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
    console.log(
      `  ${C.dim}[pair peer · read-only]${C.reset} ${change.peer.label} ${verb} `
      + `${C.cyan}${entityLabel}${C.reset} `
      + `${entity.status}: ${entity.title}`,
    );
  }
}

async function monitorPairing(remoteClient, stateId, { projectDir = process.cwd(), C, json = false } = {}) {
  let stoppedBySignal = false;
  let consecutiveFailures = 0;
  const seenPeerActivity = new Map();
  const stop = () => { stoppedBySignal = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stoppedBySignal && !pairingProcessShouldStop(stateId)) {
      const state = getPairingState(stateId);
      let status;
      try {
        status = validatePairingRemoteResponse(
          "heartbeat",
          await remoteClient.heartbeat(state.relay_token, collectPairingPresence(projectDir)),
        );
        assertPairingStatusMatches(state, status);
        touchPairingState(stateId);
        printPeerActivityChanges(C, status, seenPeerActivity, { json });
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 4) throw error;
        await sleep(2_000);
        continue;
      }
      if (status.status !== "active") return { reason: status.status, status };
      for (let elapsed = 0; elapsed < HEARTBEAT_MS; elapsed += 250) {
        if (stoppedBySignal || pairingProcessShouldStop(stateId)) break;
        await sleep(250);
      }
    }
    return { reason: stoppedBySignal ? "signal" : "local_leave" };
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function printActive(C, state, status = null) {
  console.log(`\n  ${C.bold}Posse pairing${C.reset}`);
  console.log(`  Role: ${state.role}`);
  console.log(`  Branch: ${state.shared_branch}`);
  console.log(`  Remote: ${state.remote_name}`);
  console.log(`  State: ${status?.status || state.phase}`);
  if (status && Number.isFinite(status.active_members)) {
    console.log(`  Connected members: ${status.active_members}`);
  }
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

async function runHost({ projectDir, remoteClient, remote, branch, C, json }) {
  const root = repositoryRoot(projectDir);
  assertPairingSchedulerStopped();
  assertCleanPairingCheckout(root);
  const original = currentCheckout(root);
  const sharedBranch = validateBranchName(
    root,
    branch || `posse/pair-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
  );
  const { url } = assertPairingRemoteTargets(root, remote);
  const fingerprint = repositoryFingerprint(url);
  const state = createPairingState({
    role: "host",
    remoteName: remote,
    remoteUrl: url,
    sharedBranch,
    originalBranch: original.branch,
    originalHead: original.head,
    originalSettings: snapshotPairingSettings(root),
  });
  let publishedOid = null;
  let started = null;
  try {
    await withWorktreeLockAsync(root, root, async () => {
      assertPairingSchedulerStopped();
      publishedOid = createAndPublishPairingBranch(root, {
        remote,
        branch: sharedBranch,
        expectedUrl: url,
      });
      configurePairingSettings(root, { remote, branch: sharedBranch });
      const preflight = await runSharedTrunkAccessPreflight(root);
      if (!preflight.ok) {
        throw Object.assign(new Error(preflight.message), { code: preflight.code, preflight });
      }
    });
    started = validatePairingRemoteResponse("sessions", await remoteClient.start({
      instance_id: ensureBridgeInstanceId(root),
      repository_url: url,
      repository_fingerprint: fingerprint,
      branch: sharedBranch,
    }));
    assertPairingRepositoryUnchanged({
      url,
      fingerprint,
      branch: sharedBranch,
    }, started.repository);
    updatePairingEnrollment(state.id, {
      remoteSessionId: started.session_id,
      relayToken: started.host_token,
    });

    if (json) {
      console.log(JSON.stringify({
        ok: true,
        role: "host",
        code: started.code,
        branch: sharedBranch,
        remote,
        session_id: started.session_id,
      }));
    } else {
      console.log(`\n  ${C.bold}Pairing is open${C.reset}`);
      console.log(`  Pairing code: ${C.cyan}${C.bold}${started.code}${C.reset}`);
      console.log(`  Shared branch: ${sharedBranch}`);
      console.log(`  Others join with: ${C.cyan}posse pair ${started.code}${C.reset}`);
      console.log(`  ${C.dim}This pairing session stays open until you press Ctrl-C or run \`posse pair leave\`.${C.reset}\n`);
    }
    const outcome = await monitorPairing(remoteClient, state.id, { projectDir: root, C, json });
    if (outcome.reason !== "local_leave") {
      const result = await unpair(root, remoteClient, getPairingState(state.id));
      if (!result.ok) throw Object.assign(new Error(result.local.message), { code: result.local.code });
    }
    return { ok: true, role: "host", outcome: outcome.reason };
  } catch (error) {
    if (!started && publishedOid) {
      try {
        await withWorktreeLockAsync(root, root, () => deletePublishedPairingBranch(root, {
          remote,
          branch: sharedBranch,
          expectedOid: publishedOid,
        }));
      } catch {
        // The leased delete is best-effort; never delete a branch that moved.
      }
    }
    if (started?.host_token) await leaveRemoteBestEffort(remoteClient, {
      ...getPairingState(state.id),
      relay_token: started.host_token,
    });
    const restored = await restoreLocalPairing(root, getPairingState(state.id));
    if (!restored.ok) error.message = `${safeError(error)}; automatic restore blocked: ${restored.message}`;
    throw error;
  }
}

async function runJoin({ projectDir, remoteClient, code, C, json }) {
  if (!code) {
    throw Object.assign(new Error("A pairing code is required: posse pair <CODE>"), {
      code: "pairing_code_required",
    });
  }
  const root = repositoryRoot(projectDir);
  assertPairingSchedulerStopped();
  assertCleanPairingCheckout(root);
  const original = currentCheckout(root);
  const resolved = validatePairingRemoteResponse("resolve", await remoteClient.resolve(code));
  const metadata = resolved?.repository || {};
  if (repositoryFingerprint(metadata.url) !== String(metadata.fingerprint || "").toLowerCase()) {
    throw Object.assign(new Error("Pairing repository fingerprint does not match its remote URL"), {
      code: "pairing_repository_fingerprint_mismatch",
    });
  }
  const sharedBranch = validateBranchName(root, metadata.branch);
  if (original.branch === sharedBranch) {
    throw Object.assign(new Error(
      `Pairing branch ${sharedBranch} is already checked out; switch to the branch that should be restored first`,
    ), { code: "pairing_local_branch_checked_out" });
  }
  const existingRemote = findPairingRemote(root, metadata.url);
  const chosenRemote = existingRemote?.remote || pairingTemporaryRemoteName(root, resolved.session_id);
  const state = createPairingState({
    role: "member",
    remoteName: chosenRemote,
    remoteUrl: metadata.url,
    sharedBranch,
    originalBranch: original.branch,
    originalHead: original.head,
    originalSettings: snapshotPairingSettings(root),
  });
  let joined = null;
  try {
    let pairingRemote = existingRemote;
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
      // This fetch + leased dry-run push is the per-user repo-access gate. It
      // completes before checkout settings or relay membership are changed.
      preflightAndCheckoutPairingBranch(root, {
        remote: pairingRemote.remote,
        branch: sharedBranch,
        expectedUrl: metadata.url,
      });
      configurePairingSettings(root, { remote: pairingRemote.remote, branch: sharedBranch });
      const preflight = await runSharedTrunkAccessPreflight(root);
      if (!preflight.ok) {
        throw Object.assign(new Error(preflight.message), { code: preflight.code, preflight });
      }
    });
    joined = validatePairingRemoteResponse(
      "join",
      await remoteClient.join(code, ensureBridgeInstanceId(root)),
    );
    if (joined.session_id !== resolved.session_id) {
      throw Object.assign(new Error("Pairing session changed while access was being verified"), {
        code: "pairing_session_changed",
      });
    }
    assertPairingRepositoryUnchanged(metadata, joined.repository);
    updatePairingEnrollment(state.id, {
      remoteSessionId: joined.session_id,
      relayToken: joined.member_token,
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
      console.log(`\n  ${C.green}Paired.${C.reset} Switched to ${sharedBranch}.`);
      console.log(`  ${C.dim}This pairing session stays connected until the host closes it, Ctrl-C, or \`posse pair leave\`.${C.reset}\n`);
    }
    const outcome = await monitorPairing(remoteClient, state.id, { projectDir: root, C, json });
    if (outcome.reason !== "local_leave") {
      const result = await unpair(root, remoteClient, getPairingState(state.id));
      if (!result.ok) throw Object.assign(new Error(result.local.message), { code: result.local.code });
      if (!json && ["closed", "expired"].includes(outcome.reason)) {
        console.log(`  Host pairing ${outcome.reason}; switched back to ${original.branch}.\n`);
      }
    }
    return { ok: true, role: "member", outcome: outcome.reason };
  } catch (error) {
    if (joined?.member_token) await leaveRemoteBestEffort(remoteClient, {
      ...getPairingState(state.id),
      relay_token: joined.member_token,
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
    const result = { ok: true, paired: false };
    if (json) console.log(JSON.stringify(result));
    else console.log("\n  This clone is not paired.\n");
    return result;
  }
  if (state.phase !== "active") {
    const restored = await restoreLocalPairing(repositoryRoot(projectDir), state);
    const result = { ok: restored.ok, paired: false, ended: state.phase, restored };
    if (json) console.log(JSON.stringify(result));
    else console.log(`\n  Pairing recovery ${restored.ok ? `restored ${state.original_branch}` : `is blocked: ${restored.message}`}.\n`);
    return result;
  }
  if (!pairingProcessIsAlive(state)) {
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
    else console.log(`\n  Pairing monitor exited; ${recovered.ok ? `switched back to ${state.original_branch}` : recovered.local.message}.\n`);
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
    const restored = await restoreLocalPairing(repositoryRoot(projectDir), state);
    const result = { ok: restored.ok, paired: false, ended: status.status, restored };
    if (json) console.log(JSON.stringify(result));
    else console.log(`\n  Pairing ${status.status}; ${restored.ok ? `switched back to ${state.original_branch}` : restored.message}.\n`);
    return result;
  }
  const result = { ok: true, paired: true, role: state.role, phase: state.phase, status };
  if (json) console.log(JSON.stringify(result));
  else printActive(C, state, status);
  return result;
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
  if (!client && args.action !== "status") {
    try {
      client = remoteClientFactory();
    } catch (error) {
      if (args.action !== "leave") throw error;
      client = null;
    }
  }
  if (args.action === "host") return runHost({ ...args, projectDir, remoteClient: client, C });
  if (args.action === "join") return runJoin({ ...args, projectDir, remoteClient: client, C });
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
  const result = await unpair(repositoryRoot(projectDir), client, state);
  if (args.json) console.log(JSON.stringify(result));
  else if (result.alreadyLeft) console.log("\n  This clone is not paired.\n");
  else if (result.ok) console.log(`\n  Unpaired; switched back to ${state.original_branch}.\n`);
  else console.error(`\n  ${C.red}Unpair restore blocked:${C.reset} ${result.local.message}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

export async function runUnpairCommand(argv = [], options = {}) {
  return runPairingCommand(["leave", ...argv], options);
}
