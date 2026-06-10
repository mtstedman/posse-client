// Job-domain catalogue.
//
// Job types, statuses, model tiers, reasoning efforts, assessor verdicts/
// confidence, lease lifecycle statuses, and the named subsets that govern
// scheduling and locking. Schema CHECK constraints, runtime status guards,
// and worker routing all consume these — keep the array as the canonical
// source and derive SQL / Set forms from it so they cannot drift.

const sqlList = (values) => values.map((v) => `'${v}'`).join(", ");

export const JOB_TYPES = Object.freeze([
  "research",
  "plan",
  "delegate",
  "dev",
  "assess",
  "fix",
  "summarize",
  "human_input",
  "artificer",
  "promote",
  "preflight",
  "atlas_warm",
]);
export const JOB_TYPE_LIST_SQL = sqlList(JOB_TYPES);

export const JOB_STATUSES = Object.freeze([
  "queued",
  "leased",
  "running",
  "awaiting_assessment",
  "blocked",
  "waiting_on_human",
  "waiting_on_review",
  "succeeded",
  "failed",
  "dead_letter",
  "canceled",
]);
export const JOB_STATUS_LIST_SQL = sqlList(JOB_STATUSES);

export const JOB_MODEL_TIERS = Object.freeze(["cheap", "standard", "strong"]);
export const JOB_MODEL_TIER_LIST_SQL = sqlList(JOB_MODEL_TIERS);

export const JOB_REASONING_EFFORTS = Object.freeze(["low", "medium", "high"]);
export const JOB_REASONING_EFFORT_LIST_SQL = sqlList(JOB_REASONING_EFFORTS);

// Worker types persisted on job_attempts.worker_type. These are execution
// identities, not provider-selectable roles: deterministic/system paths and
// human gates are intentionally present here but absent from PROVIDER_ROLE_NAMES.
export const JOB_ATTEMPT_WORKER_TYPES = Object.freeze([
  "researcher",
  "planner",
  "delegator",
  "dev",
  "assessor",
  "system",
  "human",
  "artificer",
  "preflight",
]);
export const JOB_ATTEMPT_WORKER_TYPE_LIST_SQL = sqlList(JOB_ATTEMPT_WORKER_TYPES);

export const JOB_ASSESSOR_VERDICTS = Object.freeze([
  "pass",
  "fail",
  "blocked",
  "needs_replan",
  "needs_review",
  "not_assessed",
]);
export const JOB_ASSESSOR_VERDICT_LIST_SQL = sqlList(JOB_ASSESSOR_VERDICTS);

export const JOB_ASSESSOR_CONFIDENCE = Object.freeze(["low", "medium", "high"]);
export const JOB_ASSESSOR_CONFIDENCE_LIST_SQL = sqlList(JOB_ASSESSOR_CONFIDENCE);

// ── Lifecycle subsets used by scheduler / queue / worker ─────────────────────

export const LEASE_HOLDING_STATUSES = Object.freeze([
  "leased",
  "running",
  "awaiting_assessment",
  "waiting_on_human",
  "waiting_on_review",
]);
export const LEASE_HOLDING_STATUSES_SQL = sqlList(LEASE_HOLDING_STATUSES);

export const LOCK_HOLDING_JOB_STATUSES = Object.freeze([
  ...LEASE_HOLDING_STATUSES,
  "blocked",
]);
export const LOCK_HOLDING_JOB_STATUSES_SQL = sqlList(LOCK_HOLDING_JOB_STATUSES);

export const ACTIVE_LEASE_STATUSES = Object.freeze([
  "leased",
  "running",
  "awaiting_assessment",
]);
export const ACTIVE_LEASE_STATUSES_SQL = sqlList(ACTIVE_LEASE_STATUSES);

export const PROVIDER_QUEUE_JOB_STATUSES = Object.freeze([
  "queued",
  "leased",
  "running",
]);
export const PROVIDER_QUEUE_JOB_STATUSES_SQL = sqlList(PROVIDER_QUEUE_JOB_STATUSES);

export const STALE_CANCELABLE_JOB_STATUSES = Object.freeze([
  "queued",
  "blocked",
  "waiting_on_human",
  "waiting_on_review",
]);
export const STALE_CANCELABLE_JOB_STATUSES_SQL = sqlList(STALE_CANCELABLE_JOB_STATUSES);

export const PARKED_JOB_STATUSES = Object.freeze([
  "blocked",
  "waiting_on_human",
  "waiting_on_review",
]);
export const PARKED_JOB_STATUSES_SQL = sqlList(PARKED_JOB_STATUSES);

export const TERMINAL_JOB_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "dead_letter",
  "canceled",
]);
export const TERMINAL_JOB_STATUSES_SQL = sqlList(TERMINAL_JOB_STATUSES);

export const FAILED_JOB_STATUSES = Object.freeze([
  "failed",
  "dead_letter",
]);
export const FAILED_JOB_STATUSES_SQL = sqlList(FAILED_JOB_STATUSES);

export const COMPLETED_OUTCOME_JOB_STATUSES = Object.freeze([
  "succeeded",
  ...FAILED_JOB_STATUSES,
]);
export const COMPLETED_OUTCOME_JOB_STATUSES_SQL = sqlList(COMPLETED_OUTCOME_JOB_STATUSES);

// `succeeded` does not signal a stalled dependency chain, so deadlock
// detection only considers the failure subset.
export const DEADLOCK_TERMINAL_STATUSES = Object.freeze(
  TERMINAL_JOB_STATUSES.filter((status) => status !== "succeeded"),
);
export const DEADLOCK_TERMINAL_STATUSES_SQL = sqlList(DEADLOCK_TERMINAL_STATUSES);

// ── Job-type sets that drive scheduling, locking, and assessment routing ─────
//
// `atlas_warm` is deterministic, non-mutating, and not assessable; it is
// intentionally absent from every set below. Adding it would route warming
// jobs through repo locking, assessment spawning, or worktree mutation, none
// of which apply.

export const MUTATING_JOB_TYPES = new Set(["dev", "fix", "artificer", "promote"]);
export const ASSESSABLE_JOB_TYPES = new Set(["dev", "fix", "artificer"]);
export const QUEUE_LOCKING_JOB_TYPES = new Set(["dev", "fix", "promote"]);

// Job types whose work is local/deterministic and never goes through a
// provider call (no Claude/OpenAI/Codex/etc.). Used by the worker to skip
// agent dispatch for these and run them in-process.
export const NON_PROVIDER_JOB_TYPES = new Set(["human_input", "promote", "atlas_warm"]);

// Job types that emit a declared output contract enforced by the worker
// (allowed/forbidden file lists, scope checks). Other mutating types still
// run but don't carry an explicit contract.
export const DECLARED_OUTPUT_CONTRACT_JOB_TYPES = new Set(["dev", "fix"]);

// Job types that count as "substantive work" when deciding whether an
// iterative work item has produced progress since the last loopback anchor.
// Excludes scheduling/coordination types like research/plan/assess.
export const ITERATIVE_SUBSTANTIVE_JOB_TYPES = new Set([
  "dev", "fix", "artificer", "delegate", "human_input",
]);

// Job types canceled when a replan supersedes the current plan. These are
// downstream task types that would otherwise execute against the now-stale
// plan; preflight/research/plan are excluded because they bootstrap the
// replan itself.
export const REPLAN_CANCELABLE_JOB_TYPES = new Set([
  "dev", "fix", "artificer", "promote", "summarize",
]);

// Job types the planner may emit directly. Excludes coordination types
// (research, plan, delegate, assess) which the runtime spawns implicitly,
// and atlas_warm which is scheduled separately.
export const PLANNER_ALLOWED_JOB_TYPES = new Set([
  "dev", "artificer", "human_input", "promote",
]);

// Job types that represent role-driven planning work (researcher/planner/
// preflight). Treated specially by dead-letter recovery so that a failed
// scheduling job doesn't recur in a tight retry loop.
export const ROLE_DRIVEN_JOB_TYPES = new Set(["research", "plan", "preflight"]);

// Job types that require an isolated git worktree (subset of
// MUTATING_JOB_TYPES — artificer writes only to artifact dirs and does not
// need the worktree).
export const WORKTREE_JOB_TYPES = new Set(["dev", "fix", "promote"]);
