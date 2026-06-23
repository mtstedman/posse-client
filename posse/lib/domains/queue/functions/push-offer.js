// Push-offer gates: persistent "push to remote?" prompts that survive the
// run process so the phone (or a later CLI session) can deploy the merged
// work. Modeled as human_input jobs with payload.subtype = "push_offer" —
// the bridge gate machinery (ChangeStream transitions, snapshots,
// gates.list, relay push notifications) picks them up for free, while the
// PUSH_OFFER_SUBTYPE exclusions keep them out of work-item status math.
//
// Lifecycle: created/refreshed at run wrap-up when unpushed commits exist
// (singleton — a new offer supersedes the previous one); closed by
// `git.push` from the bridge, a TTY push at the terminal, an explicit
// decline, or superseded at the next run boot (a fresh offer with current
// state is recreated at that run's wrap-up).

import {
  createJob,
  forceUpdateJobStatus,
  getJob,
  listWorkItems,
  setJobResult,
} from "./index.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { PUSH_OFFER_SUBTYPE, TERMINAL_WORK_ITEM_STATUSES, runImmediateTransaction } from "./common.js";

const OPEN_GATE_STATUSES = ["queued", "waiting_on_human"];
const OPEN_GATE_STATUSES_SQL = `(${OPEN_GATE_STATUSES.map((status) => `'${status}'`).join(", ")})`;

function closeOpenPushOfferGate(jobId, status, result) {
  if (!forceUpdateJobStatus(jobId, status, { expectedStatuses: OPEN_GATE_STATUSES })) return false;
  setJobResult(jobId, result);
  return true;
}

/** Latest open push-offer gate job, or null. */
export function findOpenPushOfferJob() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id FROM jobs
       WHERE job_type = 'human_input'
         AND status IN ${OPEN_GATE_STATUSES_SQL}
         AND payload_json LIKE '%"subtype":"${PUSH_OFFER_SUBTYPE}"%'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get();
  return row ? getJob(row.id) : null;
}

/**
 * Cancel every open push-offer gate (normally at most one). Used when a new
 * run boots (the offer's ahead-count is about to go stale) and when a fresh
 * offer supersedes an old one.
 */
export function cancelOpenPushOfferGates(reason = "superseded") {
  const db = getDb();
  const execute = () => {
    const rows = db
      .prepare(
        `SELECT id FROM jobs
         WHERE job_type = 'human_input'
           AND status IN ${OPEN_GATE_STATUSES_SQL}
           AND payload_json LIKE '%"subtype":"${PUSH_OFFER_SUBTYPE}"%'`,
      )
      .all();
    let canceled = 0;
    for (const row of rows) {
      if (closeOpenPushOfferGate(row.id, "canceled", { declined: false, superseded: true, reason })) {
        canceled += 1;
      }
    }
    return canceled;
  };
  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}

/**
 * Close the open push-offer gate as satisfied after a push that happened
 * outside the gate command (terminal 'y' at the wrap-up prompt).
 */
export function markOpenPushOfferGatePushed(details = {}) {
  const db = getDb();
  const execute = () => {
    const job = findOpenPushOfferJob();
    if (!job) return false;
    return closeOpenPushOfferGate(job.id, "succeeded", { pushed: true, ...details });
  };
  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}

/**
 * Work item to attach the gate to (jobs.work_item_id is NOT NULL): prefer
 * the most recently merged WI, fall back to the most recent terminal WI.
 * Returns null when the queue has never produced anything pushable.
 */
function pickAnchorWorkItemId() {
  const items = listWorkItems();
  const terminalSet = new Set(TERMINAL_WORK_ITEM_STATUSES);
  let merged = null;
  let terminal = null;
  for (const wi of items) {
    if (!wi?.id) continue;
    if (wi.merge_state === "merged" && (!merged || wi.id > merged)) merged = wi.id;
    if (terminalSet.has(wi.status) && (!terminal || wi.id > terminal)) terminal = wi.id;
  }
  return merged || terminal || null;
}

/**
 * Create (or refresh) the singleton push-offer gate from a
 * collectPushOfferState() result. Returns { ok, jobId } or { ok:false,
 * reason } when no gate is warranted/possible.
 */
export function upsertPushOfferGate(state = {}, { createdBy = "run_wrapup" } = {}) {
  const aheadCount = Number.isFinite(state.aheadCount) ? state.aheadCount : null;
  const mergedCount = Number(state.mergedCount) || 0;
  if (!state.hasRemote || !state.pushBranch) {
    return { ok: false, reason: "no_push_target" };
  }
  if ((aheadCount ?? 0) <= 0 && mergedCount <= 0) {
    return { ok: false, reason: "nothing_to_push" };
  }
  const workItemId = pickAnchorWorkItemId();
  if (!workItemId) return { ok: false, reason: "no_work_item" };

  cancelOpenPushOfferGates("superseded_by_new_offer");

  const remote = String(state.effectiveRemote || "origin");
  const branch = String(state.pushBranch);
  const countText = aheadCount != null ? `${aheadCount} commit(s)` : "pending commits";
  const payload = {
    subtype: PUSH_OFFER_SUBTYPE,
    remote,
    push_branch: branch,
    target_branch: String(state.targetBranch || branch),
    ahead_count: aheadCount,
    merged_count: mergedCount,
    working_tree_dirty: Boolean(String(state.workingTreeStatus || "").trim()),
    unmerged_wis: (Array.isArray(state.unmergedWIs) ? state.unmergedWIs : [])
      .slice(0, 10)
      .map((item) => ({
        wi_id: item.wiId ?? item.wi_id ?? null,
        title: String(item.title || "").slice(0, 120),
        branch: String(item.branchName || item.branch || "").slice(0, 120),
      })),
    prompt: `Push ${countText} on ${branch} to ${remote}?`,
    created_by: createdBy,
  };

  const job = createJob({
    work_item_id: workItemId,
    job_type: "human_input",
    title: `Push ${countText} to ${remote}/${branch}`,
    payload_json: JSON.stringify(payload),
  });
  const jobId = Number(job?.id ?? job?.lastInsertRowid ?? job);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return { ok: false, reason: "job_create_failed" };
  }
  // Straight to waiting_on_human: the scheduler must never lease this into
  // a terminal prompt — the gate is answered out-of-band (phone/CLI).
  forceUpdateJobStatus(jobId, "waiting_on_human");
  return { ok: true, jobId, workItemId };
}
