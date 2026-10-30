// @ts-check
import { readonlySet, readonlyMap } from "./readonly-collections.js";



export const ACTION_METADATA_KEY = "work_item_action";

// Interaction kinds whose metadata carries an operator action reservation
// under ACTION_METADATA_KEY: question answers reserve an `approval` row and
// operator nudges a `nudge` row. The lookup predicate and its partial index
// are built from the same two fragments so SQLite matches them verbatim.
export const ACTION_BEARING_INTERACTION_KINDS = readonlySet(["approval", "nudge"]);

export const ACTION_BEARING_INTERACTION_KINDS_SQL = [...ACTION_BEARING_INTERACTION_KINDS]
  .map((kind) => `'${kind}'`)
  .join(", ");

export const ACTION_ID_LOOKUP_EXPRESSION_SQL = `json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.action_id')`;

export const QUESTION_CAPABILITY = "question.answer";

export const MAX_QUESTIONS = 20;

export const MAX_NUDGES = 64;

export const MAX_FEEDBACK = 64;

export const MAX_PROMPT_CHARS = 2000;

export const MAX_CONTEXT_CHARS = 1000;

export const MAX_FEEDBACK_SUMMARY_CHARS = 180;

export const MAX_FEEDBACK_DETAIL_CHARS = 360;

export const MAX_NUDGE_BODY_CHARS = 4000;

export const MAX_ACTION_ID_BYTES = 128;

export const DIRECT_ACTION_RESERVATION_STALE_MS = 30 * 60 * 1000;

export const LIVE_OWNER_DELIVERY_HANDLERS = readonlySet(["scope", "review", "human_input", "one_shot"]);

export const LIVE_OWNER_DELIVERY_HANDLERS_SQL = [...LIVE_OWNER_DELIVERY_HANDLERS]
  .map((handler) => `'${handler}'`)
  .join(",");

export const FEEDBACK_PHASES = readonlySet([
  "reading", "planning", "editing", "testing", "verifying", "blocked", "finalizing", "handoff",
]);

export const FEEDBACK_STATUSES = readonlySet(["running", "blocked", "waiting", "verifying", "done"]);



export const HANDLER_BY_KIND = readonlyMap([
  ["clarification", "human_input"],
  ["planner_clarification", "human_input"],
  ["dirty_worktree_recovery", "human_input"],
  ["assessment_evidence_missing", "review"],
  ["stall_exhausted_recovery", "human_input"],
  ["failure_threshold_exhausted", "human_input"],
  ["fix_chain_exhausted", "human_input"],

  ["plan_approval", "plan"],
  ["file_scope_approval", "scope"],
  ["environment_setup", "human_input"],
  ["assessment_review", "review"],
  ["assessment_transport_recovery", "review"],
  ["assessment_retry_limit", "review"],
  ["unexecuted_replan_recovery", "review"],
  ["pipeline_head_recovery", "review"],
  ["blocked_recovery", "human_input"],
  ["partial_work_recovery", "human_input"],
  ["dead_letter_recovery", "human_input"],
  ["artifact_routing_admin", "human_input"],
  ["one_shot_file_scope", "one_shot"],
  ["push_offer", "git_push"],
  ["shared_trunk_publication_unprovable", "human_input"],
  ["shared_trunk_fast_forward_blocked", "human_input"],
  ["shared_trunk_push_refused", "human_input"],
  ["shared_trunk_push_remote_error", "human_input"],
  ["shared_trunk_provenance", "human_input"],
  ["work_item_failure_disposition", "human_input"],
  ["merge_verification_review", "human_input"],
  ["merge_failure_recovery", "human_input"],
  ["post_merge_db_task", "human_input"],
  ["cross_wi_upstream_disposition", "human_input"],
]);
