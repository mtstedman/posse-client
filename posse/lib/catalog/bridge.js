export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_HEALTH_PROOF_CONTEXT = `posse-bridge-health-v${BRIDGE_PROTOCOL_VERSION}`;
export const BOSSY_LOCAL_STREAM_PROTOCOL = "posse.local_stream.v1";

export const BRIDGE_PORT_SCAN_START = 7531;
export const BRIDGE_PORT_SCAN_END = 7551;

export const WORK_ITEM_FEED_EVENT_PROTOCOL = "posse.work_item_feed_event.v1";
export const WORK_ITEM_HISTORY_PROTOCOL = "posse.work_item_history.v1";
export const WORK_ITEM_OVERVIEW_PROTOCOL = "posse.work_item_overview.v1";
export const WORK_ITEM_STATS_PROTOCOL = "posse.work_item_stats.v1";
export const WORK_ITEM_ACTION_PROTOCOL = "posse.work_item_action.v1";

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
