// Auto merge/deploy for trusted teams. Whichever process owns the session
// (the session console, or `posse go` while it runs the session) calls
// tickSessionAutoPublish after each trunk poll. When team work has landed and
// the trunk has been quiet for a moment, it starts one unattended
// `posse session merge|deploy --unattended` child and reports what it did.
//
// The trigger compares state, not poll events: the host's own work-item merges
// move the trunk without a poll ever reporting an advance. Its bookkeeping
// lives in runtime status, so the console and `posse go` hand it over.

import { spawn } from "node:child_process";

import {
  SESSION_AUTO_PUBLISH_POLICY,
  SESSION_OWNER_CHILD_ENV,
  SESSION_PUBLISH_MODES,
} from "../../../catalog/session-sync.js";
import { adminGitExecAsync } from "../../git/functions/admin-git.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS, writeRuntimeStatus } from "../../queue/functions/runtime-status.js";
import { readPairingPromotionJournal } from "./promotion.js";
import { activeSessionCloseClaim } from "./session-close-claim.js";
import { recordUnattendedFailure } from "./session-publish-command.js";
import { getLivePairingState } from "./state.js";

// The run's result is its last line, so the tail is what is kept.
const OUTPUT_MAX_CHARS = 64 * 1024;
// A drain request this recent means the session is closing.
const DRAIN_REQUEST_FRESH_MS = 10 * 60_000;
const SHA_RE = /^[0-9a-f]{40,64}$/u;

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Pure decision: which unattended run is due now, if any, and the record to
 * store. `record` is this session's runtime-status row.
 */
export function autoPublishDecision({
  mergeAuto, deployAuto, trunkSha, baselineSha = null, localAhead = false, signature, record = {}, nowMs,
  policy = SESSION_AUTO_PUBLISH_POLICY,
}) {
  const mergePending = mergeAuto && SHA_RE.test(String(trunkSha || ""))
    && trunkSha !== baselineSha && trunkSha !== record.evaluated_trunk;
  // Deploy never merges unless merge is auto too; with merge on ask it pushes
  // only what the host already merged.
  const deployPending = deployAuto && (mergePending || localAhead);
  if (!mergePending && !deployPending) {
    return { action: null, record: { ...record, pending_since: null, signature: null, last_change_at: null } };
  }
  const changed = record.signature !== signature;
  const next = {
    ...record,
    signature,
    pending_since: record.pending_since || new Date(nowMs).toISOString(),
    last_change_at: changed || !record.last_change_at ? new Date(nowMs).toISOString() : record.last_change_at,
  };
  const retryAfter = Date.parse(String(record.retry_after || ""));
  if (Number.isFinite(retryAfter) && nowMs < retryAfter) return { action: null, record: next, waiting: "retry" };
  const quietFor = nowMs - Date.parse(next.last_change_at);
  const pendingFor = nowMs - Date.parse(next.pending_since);
  if (quietFor < policy.QUIET_MS && pendingFor < policy.MAX_WAIT_MS) return { action: null, record: next, waiting: "quiet" };
  return { action: deployPending ? "deploy" : "merge", record: next };
}

function spawnUnattended(action, { cwd }) {
  return spawn(process.execPath, [...process.execArgv, process.argv[1], "session", action, "--unattended", "--json"], {
    cwd,
    // Started by the live owner (so it never recovers the owner's session),
    // and never waiting on a credential prompt no one will answer.
    env: { ...process.env, [SESSION_OWNER_CHILD_ENV]: String(process.pid), GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group: Ctrl+C at the console must not cut a push short.
    detached: true,
    windowsHide: true,
  });
}

/** One line for the owner's feed from an unattended run's JSON result. */
export function describeUnattendedResult(action, result) {
  if (!result || result.skipped || result.nothing) return null;
  if (result.ok && result.deployed) {
    return { ok: true, text: `deployed ${String(result.deployOid || "").slice(0, 8)}${result.merged ? " (merged the team's latest work first)" : ""}` };
  }
  if (result.ok && result.merged) {
    return { ok: true, text: `merged the team's latest work into your branch (${String(result.mergeOid || "").slice(0, 8)})` };
  }
  if (result.ok) return null;
  const message = String(result.message || result.reason || "failed").split("\n")[0];
  return {
    ok: false,
    text: result.paused
      ? `${message} — auto ${action} is paused and asks you again (auto ${action} on resumes it)`
      : `${message} — it tries again shortly`,
  };
}

function parseResult(output) {
  const lines = String(output || "").split(/\r?\n/u).filter((line) => line.trim().startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch { /* not the result line */ }
  }
  return null;
}

let ticking = null;
let lastTickMs = 0;

/**
 * Called by the session owner after each trunk poll. Never throws and never
 * waits for the run it starts; `report(text, { ok })` receives its outcome.
 * `sessionActive: false` (the Remote reports the session is not active, or
 * the owner's heartbeat failed) skips the tick.
 */
export function tickSessionAutoPublish(options = {}) {
  if (ticking) return ticking;
  const nowMs = options.nowMs ?? Date.now();
  const minInterval = (options.policy || SESSION_AUTO_PUBLISH_POLICY).TICK_MIN_INTERVAL_MS;
  if (nowMs - lastTickMs < minInterval) return Promise.resolve(null);
  lastTickMs = nowMs;
  ticking = tickOnce({ ...options, nowMs }).catch(() => null).finally(() => { ticking = null; });
  return ticking;
}

function sessionClosing(state, nowMs) {
  if (activeSessionCloseClaim({ stateId: state.id }) || readPairingPromotionJournal()) return true;
  const drain = readRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_DRAIN_REQUEST);
  const requestedMs = Date.parse(String(drain?.requested_at || ""));
  return Boolean(drain) && Number.isFinite(requestedMs) && nowMs - requestedMs <= DRAIN_REQUEST_FRESH_MS;
}

async function tickOnce({
  projectDir,
  report = () => {},
  nowMs = Date.now(),
  exec = adminGitExecAsync,
  start = spawnUnattended,
  policy = SESSION_AUTO_PUBLISH_POLICY,
  sessionActive = true,
  recordFailure = recordUnattendedFailure,
} = {}) {
  if (!sessionActive) return null;
  const state = getLivePairingState();
  if (!state || state.role !== "host" || state.phase !== "active" || !state.remote_session_id) return null;
  // Only the process that owns the session acts for it, and only while its
  // own heartbeat is current: a session whose relay link is down is not one
  // to publish from (and its children would see a stale owner).
  if (Number(state.process_pid) !== process.pid) return null;
  const heartbeatMs = Date.parse(String(state.updated_at || ""));
  if (!Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > policy.OWNER_FRESH_MS) return null;
  const mergeAuto = state.merge_mode === SESSION_PUBLISH_MODES.AUTO;
  const deployAuto = state.deploy_mode === SESSION_PUBLISH_MODES.AUTO;
  if (!mergeAuto && !deployAuto) return null;
  if (sessionClosing(state, nowMs)) return null;
  const sessionId = state.remote_session_id;
  const stored = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_AUTO_PUBLISH);
  const record = stored?.session_id === sessionId ? { ...stored } : { session_id: sessionId };
  if (record.run?.pid && processAlive(Number(record.run.pid))) return null;
  if (record.run) delete record.run;

  const trunkStatus = readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK);
  const trunkSha = trunkStatus?.branch === state.shared_branch && trunkStatus?.provenance_blocked !== true
    ? trunkStatus.remote_sha : null;
  const remote = state.origin_remote_name || "origin";
  const target = state.original_branch;
  let localAhead = false;
  let localSha = "";
  if (deployAuto) {
    try {
      localSha = String(await exec(["rev-parse", "--verify", "--quiet", `refs/heads/${target}`], projectDir)).trim();
      const ahead = String(await exec(["rev-list", "--count", `refs/remotes/${remote}/${target}..refs/heads/${target}`], projectDir)).trim();
      localAhead = Number(ahead) > 0;
    } catch { /* no local or remote-tracking target yet */ }
  }
  const decision = autoPublishDecision({
    mergeAuto, deployAuto, trunkSha, baselineSha: state.baseline_oid, localAhead,
    signature: `${trunkSha || ""}:${localSha}`, record, nowMs, policy,
  });
  if (!decision.action) {
    // Ticks come every few seconds; the row changes only when the state does.
    if (JSON.stringify(decision.record) !== JSON.stringify(stored)) {
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_AUTO_PUBLISH, decision.record);
    }
    return { action: null, waiting: decision.waiting || null };
  }
  const action = decision.action;
  let child;
  try {
    child = start(action, { cwd: projectDir });
  } catch (error) {
    report(`could not start auto ${action}: ${error?.message || error}`, { ok: false, action });
    return null;
  }
  writeRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_AUTO_PUBLISH, {
    ...decision.record,
    pending_since: null,
    run: { pid: child.pid, action, started_at: new Date(nowMs).toISOString() },
  });
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
    if (output.length > OUTPUT_MAX_CHARS) output = output.slice(-OUTPUT_MAX_CHARS);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Its own process group: the push and the verify command stop with it.
    try { process.kill(-child.pid, "SIGTERM"); } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }, policy.RUN_TIMEOUT_MS);
  timer.unref?.();
  // `close`, not `exit`: the output may still be arriving at exit.
  child.once("close", (code) => {
    clearTimeout(timer);
    const current = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_AUTO_PUBLISH);
    if (current?.session_id === sessionId && Number(current.run?.pid) === child.pid) {
      const { run: _finished, ...rest } = current;
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_AUTO_PUBLISH, rest);
    }
    let result = parseResult(output);
    if (!result || timedOut) {
      // The run died without saying what happened (or ran out of time); it
      // counts as a failure here, or the next tick would start it again at
      // once, forever.
      const message = timedOut
        ? `took longer than ${Math.round(policy.RUN_TIMEOUT_MS / 60_000)} minutes and was stopped`
        : `stopped without a result (exit ${code})`;
      let handled = { paused: false };
      try {
        handled = recordFailure(action, Object.assign(new Error(message), { code: "session_publish_run_lost" }));
      } catch { /* the backoff row is best effort */ }
      result = { ok: false, message, paused: handled?.paused === true };
    }
    const line = describeUnattendedResult(action, result);
    if (line) report(line.text, { ok: line.ok, action });
  });
  child.once("error", (error) => {
    clearTimeout(timer);
    report(`auto ${action} failed to run: ${error?.message || error}`, { ok: false, action });
  });
  return { action, pid: child.pid };
}

export const __testSessionAutoPublishInternals = Object.freeze({ parseResult, tickOnce });
