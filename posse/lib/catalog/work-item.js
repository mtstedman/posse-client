// Work-item-domain catalogue.
//
// Statuses, modes, priorities, governance tiers, merge states, plan-approval
// states, and session-recycle values. Schema CHECK constraints and runtime
// guards both consume these. Keep arrays as the canonical source; SQL forms
// are derived.

const sqlList = (values) => values.map((v) => `'${v}'`).join(", ");

export const WORK_ITEM_STATUSES = Object.freeze([
  "queued",
  "planning",
  "planned",
  "running",
  "blocked",
  "waiting_on_human",
  "waiting_on_review",
  "complete",
  "failed",
  "canceled",
]);
export const WORK_ITEM_STATUS_LIST_SQL = sqlList(WORK_ITEM_STATUSES);

export const WORK_ITEM_MODES = Object.freeze(["build", "image", "report"]);
export const WORK_ITEM_MODE_LIST_SQL = sqlList(WORK_ITEM_MODES);

export const WORK_ITEM_PRIORITIES = Object.freeze(["low", "normal", "high", "urgent"]);
export const WORK_ITEM_PRIORITY_LIST_SQL = sqlList(WORK_ITEM_PRIORITIES);

export const WORK_ITEM_GOVERNANCE_TIERS = Object.freeze(["prototype", "mvp", "production"]);
export const WORK_ITEM_GOVERNANCE_TIER_LIST_SQL = sqlList(WORK_ITEM_GOVERNANCE_TIERS);

export const WORK_ITEM_MERGE_STATES = Object.freeze(["pending_review", "merged", "merge_failed"]);
export const WORK_ITEM_MERGE_STATE_LIST_SQL = sqlList(WORK_ITEM_MERGE_STATES);

export const UNMERGED_WORK_ITEM_MERGE_STATES = Object.freeze(
  WORK_ITEM_MERGE_STATES.filter((state) => state !== "merged"),
);
export const UNMERGED_WORK_ITEM_MERGE_STATES_SQL = sqlList(UNMERGED_WORK_ITEM_MERGE_STATES);

export const WORK_ITEM_PLAN_APPROVAL_STATES = Object.freeze([
  "not_required",
  "pending",
  "approved",
  "rejected",
]);
export const WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL = sqlList(WORK_ITEM_PLAN_APPROVAL_STATES);

export const WORK_ITEM_SESSION_RECYCLE_VALUES = Object.freeze(["on", "off"]);
export const WORK_ITEM_SESSION_RECYCLE_LIST_SQL = sqlList(WORK_ITEM_SESSION_RECYCLE_VALUES);

// A work item is terminal when it has no more transitions: complete (all jobs
// done), failed (uncaught failure), or canceled (user/system aborted).
export const TERMINAL_WORK_ITEM_STATUSES = Object.freeze([
  "complete",
  "failed",
  "canceled",
]);
export const TERMINAL_WORK_ITEM_STATUSES_SQL = sqlList(TERMINAL_WORK_ITEM_STATUSES);
