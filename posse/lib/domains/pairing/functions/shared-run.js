// A shared run is `posse go` in a clone that is in a live session. Its queue
// emptying does not end it: the session screen stays up, heartbeats, sync and
// routing keep working, and work added or routed later is picked up. It ends
// when the operator stops it (Ctrl+C) or the session ends for this clone.

import { SHARED_RUN_END_REASONS } from "../../../catalog/shared-run.js";
import { getLivePairingState } from "./state.js";

/**
 * Whether a run may be a shared run at all. A run scoped to named work items
 * is a deliberate one-shot, and an unattended run (`--yes`, cron, a run the
 * bridge launched, input that is not a terminal) has nobody to press Ctrl+C:
 * both end when their work does, as outside a session. A dry run never stays
 * open either.
 */
export function sharedRunEligible({ scoped = false, nonInteractive = false, dryRun = false, terminal = true } = {}) {
  return !scoped && !nonInteractive && !dryRun && terminal === true;
}

/** Whether someone can press Ctrl+C in this process: its input is a terminal. */
export function sharedRunTerminalAttached(input = process.stdin) {
  return input?.isTTY === true;
}

/** Whether this clone is in a live session right now (the database only). */
export function pairingSessionLive(getState = getLivePairingState) {
  try {
    const state = getState();
    return Boolean(state && state.phase === "active" && state.relay_token);
  } catch {
    // An unreadable pairing row must not keep a run open forever.
    return false;
  }
}

// How many reads of the pairing row may fail in a row before a shared run
// treats the session as gone.
const SESSION_LIVE_READ_FAILURES = 3;

/**
 * The live-session probe a running shared run polls. One failed read (a busy
 * database) keeps the last answer, as every other read in a scheduler lap is
 * retried; only repeated failures end the run, so an unreadable row still
 * cannot keep it open forever.
 */
export function createSessionLiveProbe(getState = getLivePairingState, { failures: allowed = SESSION_LIVE_READ_FAILURES } = {}) {
  // The run is shared only because the session was live when it started.
  let last = true, failed = 0;
  return () => {
    try {
      const state = getState();
      failed = 0;
      last = Boolean(state && state.phase === "active" && state.relay_token);
    } catch {
      failed += 1;
      if (failed >= allowed) last = false;
    }
    return last;
  };
}

/**
 * The stay-open decision, taken at every point where a run would otherwise
 * finish: the queue emptied, nothing can progress, or only parked work is
 * left. Pure.
 *
 * @param {object} input
 * @param {boolean} input.enabled The run is eligible (sharedRunEligible).
 * @param {boolean} input.sessionLive This clone is in a live session now.
 * @param {boolean} [input.drainRequested] The session asked this run to
 *   drain: the host closed it, this member was removed, or a local close.
 * @param {boolean} [input.stopRequested] The operator stopped the run.
 * @param {boolean} [input.lockLost] The scheduler lock was lost.
 */
export function sharedRunStaysOpen({
  enabled = false,
  sessionLive = false,
  drainRequested = false,
  stopRequested = false,
  lockLost = false,
} = {}) {
  return enabled === true && sessionLive === true
    && !drainRequested && !stopRequested && !lockLost;
}

/**
 * Why the session asked a run to drain, from the scheduler's session poll.
 * `fatal` is the relay refusing this clone (a removed member, a changed
 * session); otherwise the session itself stopped being active.
 */
export function sharedRunEndFromSessionPoll(sessionPoll) {
  if (sessionPoll?.fatal) return { reason: SHARED_RUN_END_REASONS.ACCESS_REVOKED, status: null };
  if (sessionPoll?.requestsDrain) {
    return { reason: SHARED_RUN_END_REASONS.SESSION_CLOSED, status: sessionPoll.status?.status || null };
  }
  return null;
}

const SESSION_STATUS_WORDS = Object.freeze({
  draining: "The host is closing the session",
  closed: "The session was closed",
  expired: "The session expired",
});

/**
 * What to tell the operator when a shared run ended because the session did.
 * One line; null when the run ended for any other reason.
 */
export function describeSharedRunEnd(end, { role = "member" } = {}) {
  if (!end?.reason) return null;
  const host = role === "host";
  if (end.reason === SHARED_RUN_END_REASONS.ACCESS_REVOKED) {
    return host
      ? "The session relay no longer accepts this host's credential; the run stopped. Run `posse session status` to see where the session stands."
      : "The host removed this clone from the session (or the session changed); the run stopped. Your work in this folder is kept.";
  }
  if (end.reason === SHARED_RUN_END_REASONS.CLOSE_REQUESTED) {
    return host
      ? "This session is closing; the run stopped so its work can be integrated. Nothing is published until you approve it (`posse session integrate`)."
      : "This clone is leaving the session; the run stopped.";
  }
  const words = SESSION_STATUS_WORDS[end.status] || "The session ended";
  return host
    ? `${words}; the run stopped. Nothing is published until you approve it (\`posse session integrate\`).`
    : `${words}; the run stopped. Your work in this folder is kept.`;
}

// A work item another process is still creating (`posse inject` writes the
// work item, its status and its first job as separate statements) must not be
// planned from here in between: only work items that have sat queued this
// long are picked up.
export const SHARED_RUN_SEED_SETTLE_MS = 3_000;

/**
 * Split queued work items into those a shared run may plan now and how many
 * are too new to tell. A timestamp that cannot be read counts as settled.
 */
export function workItemsSettledForSeeding(items, { nowMs = Date.now(), settleMs = SHARED_RUN_SEED_SETTLE_MS } = {}) {
  const settled = [];
  let unsettled = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const createdMs = Date.parse(String(item?.created_at || ""));
    const ageMs = nowMs - createdMs;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < settleMs) unsettled += 1;
    else settled.push(item);
  }
  return { settled, unsettled };
}
