import { readonlySet } from "./readonly-collections.js";
// @ts-check

import { WAITING_LANE_JOB_TYPE } from "./waiting-lane.js";

// Optional compatibility hold (normal dispatch uses per-job freshness):
// while the ATLAS conductor is actively indexing (warm/merge/reindex), new
// non-warm jobs are held back instead of leased: agents attaching mid-warm
// all pound the half-built index and pile up on the conductor queue. Jobs
// that don't touch ATLAS (the warm itself, human gates) still dispatch. The
// failsafe bounds the hold so a wedged warm cannot stall the run forever.
// Keep this short: ATLAS is a freshness accelerator, not a global run gate.
export const ATLAS_INDEXING_HOLD_MAX_MS = 30 * 1000;

export const ATLAS_INDEXING_PAUSE_OFF_VALUES = readonlySet(["off", "false", "0", "no"]);

export const ATLAS_INDEXING_HOLD_EXEMPT_JOB_TYPES = readonlySet([
  "atlas_warm",
  WAITING_LANE_JOB_TYPE,
  "human_input",
]);

export const RUN_BACKGROUND_JOB_TYPES = readonlySet(["atlas_warm", WAITING_LANE_JOB_TYPE]);

// Background maintenance runs on its own small budget so it never consumes one
// of the N agent compute slots. Warm is fail-silent, per-key serialized, and
// deterministic, so a single background slot bounds its CPU without starving
// agent work. A constant, derived from runtime state — NOT a user setting.
export const ATLAS_BACKGROUND_JOB_CONCURRENCY = 1;

export const RUN_LOOP_KEEPALIVE_INTERVAL_MS = 30_000;

// Runtime-watchdog escalation. After the first runtime kill the worker owns
// the abort path; if its promise still hasn't settled, re-send the kill on
// this cadence and, past the wedged threshold, emit a one-shot event so the
// permanently occupied compute slot is visible in telemetry.
export const RUNTIME_KILL_RETRY_MS = 60_000;

export const RUNTIME_KILL_WEDGED_MS = 5 * 60_000;

// A filesystem lock already waits for its own acquisition timeout. Bound
// whole-job retries too, including transitions between setup and commit.
export const WORKTREE_LOCK_MAX_REQUEUES = 2;
export const WORKTREE_LOCK_REQUEUE_DELAY_MS = 5_000;

// When nothing runs and every job that could start waits on a work item that
// cannot progress without an operator, the run finishes as needs-action after
// this long instead of idling forever (finding 1, run 1250b). The grace spans
// a human-gate maintenance sweep, so a disposition gate the stall depends on
// is open (and named) by then.
export const PARKED_UPSTREAM_STALL_GRACE_MS = 90_000;

// A completed work item that this run merges on its own (not parked) but that
// stays unmerged with no merge in flight for this long while the run idles
// counts as parked for the needs-action finish (run 1250b red team 2, finding
// 7): the idle auto-merge fires once per idle stretch, and a merge that throws
// releases its authorization without marking merge_failed, so nothing else
// would end the downstream's wait.
export const AUTO_MERGE_STALL_GRACE_MS = 90_000;

// A merge authorization older than the merge lock lease was left behind by a
// process that died mid-merge; it no longer means a merge is in flight.
export const STALE_MERGE_AUTHORIZATION_MS = 60 * 60_000;

// Holder types that represent SYSTEM holds, not agent-vs-agent contention.
// They must never be counted as the agent pipeline being "on lock".
export const SYSTEM_HOLD_HOLDER_TYPES = readonlySet([
  "atlas_indexing",
  "atlas_warm",
  "waiting_lane_prepare",
]);
