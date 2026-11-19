// Vocabulary authority for the posse.agent_conversation.v1 projection: one
// chat-style conversation per Work Item (agent messages, operator messages,
// gates, job markers, and the tool calls folded under each agent message).
// The relay, Bossy, and the phone app mirror the synced names below; the golden
// fixture must exercise every one of them. Nudge and question states and the
// gate kinds are referenced from their own catalogs, never copied here.
import { readonlySet } from "./readonly-collections.js";
import { NUDGE_STATES, QUESTION_STATES, REPLACEABLE_NUDGE_STATES } from "./work-item-interactions.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "./tools/interaction.js";
import { HUMAN_GATE_FEEDBACK_MAX_CHARS } from "./human-input.js";

// @catalog-sync id=posse.agent_conversation.vocabulary role=authority relation=strict compare=names extract=strings
// @linked_repos posse:posse/test/fixtures/agent-conversation/protocol/conversation-v1.json posse-remote:rust/catalog/control/conversation.rs posse-bossy:catalog/agent_conversation.go posse-remote-control:src/catalog/conversation.ts
export const AGENT_CONVERSATION_PROTOCOL = "posse.agent_conversation.v1";
export const AGENT_CONVERSATION_COMMAND = "work_item.conversation";
export const AGENT_CONVERSATION_EVENT_KIND = "conversation_entry";
export const AGENT_CONVERSATION_FRAME_OPS = Object.freeze(["upsert"]);
export const AGENT_CONVERSATION_TIERS = Object.freeze(["remote", "local"]);
export const AGENT_CONVERSATION_ENTRY_KINDS = Object.freeze([
  "job_marker", "agent_message", "tool_group", "operator_message", "gate",
]);
export const AGENT_CONVERSATION_ACTORS = Object.freeze(["agent", "operator", "system"]);
export const AGENT_CONVERSATION_ITEM_TYPES = Object.freeze(["call", "note", "subagent"]);
export const AGENT_CONVERSATION_CALL_STATUSES = Object.freeze(["running", "succeeded", "failed", "rejected"]);
export const AGENT_CONVERSATION_CALL_TIMINGS = Object.freeze(["live", "end_of_call"]);
export const AGENT_CONVERSATION_GROUP_STATES = Object.freeze(["open", "closed"]);
export const AGENT_CONVERSATION_GROUP_CLOSERS = Object.freeze(["agent_message", "gate", "call_end", "job_end"]);
export const AGENT_CONVERSATION_MARKER_PHASES = Object.freeze(["started", "ended"]);
export const AGENT_CONVERSATION_GATE_CTAS = Object.freeze(["question.answer", "open_gate"]);
// Answerable-question vocabulary, shared with the work-item feed questions.
export const QUESTION_INPUT_KINDS = Object.freeze(["single_choice", "informational"]);
export const QUESTION_CHOICE_DANGERS = Object.freeze(["normal", "caution", "destructive"]);
export const QUESTION_UNAVAILABLE_REASONS = Object.freeze(["unstructured_choices"]);
// @catalog-sync end

export const AGENT_CONVERSATION_TIER = Object.freeze({ REMOTE: "remote", LOCAL: "local" });
export const AGENT_CONVERSATION_ENTRY_KIND = Object.freeze({
  JOB_MARKER: "job_marker",
  AGENT_MESSAGE: "agent_message",
  TOOL_GROUP: "tool_group",
  OPERATOR_MESSAGE: "operator_message",
  GATE: "gate",
});
export const AGENT_CONVERSATION_GROUP_CLOSER = Object.freeze({
  AGENT_MESSAGE: "agent_message",
  GATE: "gate",
  CALL_END: "call_end",
  JOB_END: "job_end",
});

// Wire bounds. Mirrors copy these numbers; the golden fixture carries them.
export const AGENT_CONVERSATION_BOUNDS = Object.freeze({
  ENTRY_BYTES: 16 * 1024,
  PAGE_ENTRIES: 50,
  PAGE_DEFAULT_ENTRIES: 30,
  PAGE_BYTES: 256 * 1024,
  CURSOR_BYTES: 512,
  ROLE_CHARS: 80,
  ORIGIN_CHARS: 80,
  MARKER_TITLE_CHARS: 120,
  PROVIDER_CHARS: 80,
  MODEL_CHARS: 120,
  MESSAGE_SUMMARY_CHARS: 180,
  MESSAGE_DETAIL_CHARS: 360,
  GROUP_BY_TOOL: 12,
  GROUP_ITEMS: 30,
  GROUP_ITEMS_HEAD: 5,
  GROUP_ITEMS_TAIL: 25,
  TOOL_LABEL_CHARS: 40,
  CALL_TARGET_CHARS: 120,
  CALL_ERROR_CHARS: 200,
  NOTE_CHARS: 180,
  OPERATOR_BODY_CHARS: 4000,
  OPERATOR_AUTHOR_CHARS: 120,
  DELIVERY_REASON_CHARS: 500,
  DELIVERY_TOOL_CHARS: 40,
  GATE_TITLE_CHARS: 160,
  GATE_PROMPT_CHARS: 500,
  GATE_CHOICES: 32,
  CHOICE_LABEL_CHARS: 160,
  CHOICE_CONSEQUENCE_CHARS: 400,
  CHOICE_ID_CHARS: 128,
  ANSWER_FEEDBACK_CHARS: HUMAN_GATE_FEEDBACK_MAX_CHARS,
  ANSWER_LABEL_CHARS: 160,
  ANSWER_TEXT_CHARS: 2000,
});

// Enumerated tokens (states, kinds) never exceed this; the relay rejects
// longer ones. An identifier that would is omitted, never truncated.
export const AGENT_CONVERSATION_TOKEN_CHARS = 80;
// Choice ids share the feed's 128-character bound so one-shot scope
// candidates (`candidate:sha256:<64 hex>`, 81 characters) stay intact.
export const AGENT_CONVERSATION_CHOICE_ID_CHARS = AGENT_CONVERSATION_BOUNDS.CHOICE_ID_CHARS;

// Local-tier detail bounds (Bossy loopback and the in-process terminal).
export const AGENT_CONVERSATION_LOCAL_BOUNDS = Object.freeze({
  PATTERN_CHARS: 60,
  COMMAND_CHARS: 120,
  ATLAS_HINT_CHARS: 120,
  QUERY_CHARS: 80,
});

// Live conversation_entry upserts per entry are coalesced to this interval.
export const AGENT_CONVERSATION_LIVE_COALESCE_MS = 1000;

export const AGENT_CONVERSATION_NUDGE_STATES = NUDGE_STATES;
export const AGENT_CONVERSATION_REPLACEABLE_NUDGE_STATES = REPLACEABLE_NUDGE_STATES;
export const AGENT_CONVERSATION_QUESTION_STATES = QUESTION_STATES;
export const AGENT_CONVERSATION_GATE_KINDS = readonlySet(Object.keys(WORK_ITEM_QUESTION_CHOICE_IDS));

// Rows that are represented elsewhere in the conversation (messages and
// receipts) or are harness bookkeeping, never agent tool calls.
export const AGENT_CONVERSATION_MESSAGE_TOOL_TYPES = readonlySet([
  "tool.agent_feedback",
  "tool.get_operator_feedback",
  "tool.ack_operator_feedback",
]);
export const AGENT_CONVERSATION_NON_CALL_TOOL_TYPES = readonlySet([
  "tool.response_control",
  "tool.response_transform",
  "tool.surface.issued",
  "tool.surface.list_failed",
  "tool.budget_advisory",
  "tool.sub_agent.error",
  "tool.sub_agent_next_input.error",
  "tool.dispatch_agent.error",
]);
export const AGENT_CONVERSATION_HARNESS_TOOL_SUFFIXES = Object.freeze([".prefetch", ".autofeedback"]);
export const AGENT_CONVERSATION_BENIGN_TOOL_TYPES = readonlySet(["tool.read.not_found"]);
