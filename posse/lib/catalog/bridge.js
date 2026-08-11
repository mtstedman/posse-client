export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_HEALTH_PROOF_CONTEXT = `posse-bridge-health-v${BRIDGE_PROTOCOL_VERSION}`;

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
