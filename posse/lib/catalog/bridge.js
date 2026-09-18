export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_HEALTH_PROOF_CONTEXT = `posse-bridge-health-v${BRIDGE_PROTOCOL_VERSION}`;
export const PROVIDER_USAGE_STREAM_PROTOCOL = "posse.provider_usage_stream.v1";

export const BOSSY_LOCAL_STREAM_PROTOCOL = "posse.local_stream.v1";

export const BRIDGE_PORT_SCAN_START = 7531;
export const BRIDGE_PORT_SCAN_END = 7551;

export const WORK_ITEM_FEED_EVENT_PROTOCOL = "posse.work_item_feed_event.v1";
export const WORK_ITEM_HISTORY_PROTOCOL = "posse.work_item_history.v1";
export const WORK_ITEM_OVERVIEW_PROTOCOL = "posse.work_item_overview.v1";
export const WORK_ITEM_STATS_PROTOCOL = "posse.work_item_stats.v1";
export const WORK_ITEM_ACTION_PROTOCOL = "posse.work_item_action.v1";
export const TEAM_OVERVIEW_PROTOCOL = "posse.team_overview.v1";
export const TEAM_DECISION_PROTOCOL = "posse.team_decision.v1";
export const TEAM_PROVIDER_PR_PROTOCOL = "posse.team_provider_pr.v1";
export const TEAM_POLICY_PROTOCOL = "posse.team_policy.v1";
export const TEAM_GRANT_REQUEST_PROTOCOL = "posse.team_grant_request.v1";
export const TEAM_GRANT_ISSUE_PROTOCOL = "posse.team_grant_issue.v1";
export const TEAM_PROVIDER_PUBLISH_PROTOCOL = "posse.team_provider_publish.v1";
export const TEAM_PROVIDER_PROTECTION_PROTOCOL = "posse.team_provider_protection.v1";
export const TEAM_PROMOTION_PROTOCOL = "posse.team_promotion.v1";

export const WORK_ITEM_BOUNDS = Object.freeze({
  ACTIVE: 100,
  QUEUED: 100,
  AGENTS: 64,
  LANES: 128,
  WAITERS: 32,
  QUESTIONS: 20,
  HISTORY_PAGE: 100,
  HISTORY_TAIL: 20,
  FEED_SUMMARY_CHARS: 500,
  FEED_DETAIL_CHARS: 16_000,
  STREAM_PAYLOAD_BYTES: 64 * 1024,
});

export const BRIDGE_OPEN_GATE_STATUSES = Object.freeze(["queued", "waiting_on_human"]);
export const BRIDGE_NON_AGENT_JOB_TYPES = Object.freeze(["human_input", "atlas_warm"]);

export const BRIDGE_COMMANDS = Object.freeze({
  QUEUE_LIST: "queue.list",
  QUEUE_ADD: "queue.add",
  WORK_ITEM_GET: "work_item.get",
  JOBS_LIST: "jobs.list",
  EVENTS_TAIL: "events.tail",
  COMMAND_STATUS: "command.status",
  GATES_LIST: "gates.list",
  STATE_SNAPSHOT: "state.snapshot",
  RUN_START: "run.start",
  RUN_STOP: "run.stop",
  ATLAS_WARM: "atlas.warm",
  JOB_NUDGE: "job.nudge",
  WORK_ITEMS_OVERVIEW: "work_items.overview",
  WORK_ITEMS_HISTORY: "work_items.history",
  WORK_ITEMS_STATS: "work_items.stats",
  WORK_ITEMS_TAIL: "work_items.tail",
  QUESTION_ANSWER: "question.answer",
  AGENT_NUDGE: "agent.nudge",
  ASK: "ask",
  REVIEW_APPROVE: "review.approve",
  REVIEW_REJECT: "review.reject",
  PLAN_APPROVE: "plan.approve",
  PLAN_REJECT: "plan.reject",
  GIT_PUSH: "git.push",
  TEAM_OVERVIEW: "team.overview",
  TEAM_SUBMISSION_DECIDE: "team.submission.decide",
  TEAM_POLICY_SET: "team.policy.set",
  TEAM_GRANT_REQUEST: "team.grant.request",
  TEAM_GRANT_ISSUE: "team.grant.issue",
  TEAM_PROVIDER_PR_PREPARE: "team.provider_pr.prepare",
  TEAM_PROVIDER_PR_PUBLISH: "team.provider_pr.publish",
  TEAM_PROVIDER_PROTECTION_CONFIGURE: "team.provider_protection.configure",
  TEAM_PROMOTION_APPROVE: "team.promotion.approve",
});

export const BRIDGE_ALLOWED_COMMANDS = Object.freeze(Object.values(BRIDGE_COMMANDS));

export const BRIDGE_EVENT_KINDS = Object.freeze({
  SNAPSHOT: "snapshot",
  WORK_ITEM_UPDATED: "work_item_updated",
  JOB_UPDATED: "job_updated",
  GATE_OPENED: "gate_opened",
  GATE_CLOSED: "gate_closed",
  COST_UPDATED: "cost_updated",
  FAILED: "failed",
  INSTANCE_STATUS: "instance_status",
  JOB_PROGRESS: "job_progress",
  AGENT_ACTIVITY: "agent_activity",
  PROVIDER_USAGE: "provider_usage",
  FEED_EVENT: "feed_event",
});

export const BRIDGE_FRAME_TYPES = Object.freeze({
  HELLO: "hello",
  PING: "ping",
  PONG: "pong",
  COMMAND: "command",
  ACK: "ack",
  EVENT: "event",
});
