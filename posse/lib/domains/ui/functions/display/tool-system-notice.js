// One system-feed line for a harness notice or a nudge pickup recorded under
// tool.* (catalog/observation.js TOOL_SYSTEM_FEED_OBSERVATION_TYPES). The
// "[system]" prefix routes it to the pinned system tail; a failure still
// reaches the main log through the display's alert rule.

const NOTICE_LABELS = Object.freeze({
  "tool.response_control": "model notice",
  "tool.budget_advisory": "budget advisory",
  "tool.dispatch_agent.repaired": "dispatch repair",
  "tool.dispatch_agent.error": "dispatch error",
  "tool.sub_agent.error": "sub-agent error",
  "tool.sub_agent_next_input.error": "sub-agent error",
  "tool.surface.list_failed": "tool surface",
  "tool.get_operator_feedback": "nudge picked up",
  "tool.ack_operator_feedback": "nudge acknowledged",
});

const MAX_SUMMARY_CHARS = 200;

export function toolSystemNoticeKey(row) {
  if (row?.id != null) return `id:${row.id}`;
  return `${row?.created_at || ""}|${row?.observation_type || ""}|${row?.summary || ""}`;
}

export function formatToolSystemNotice(row) {
  const type = String(row?.observation_type || "");
  const label = NOTICE_LABELS[type] || type.replace(/^tool\./, "");
  const job = row?.job_id != null ? ` job #${row.job_id}` : "";
  const summary = String(row?.summary || "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS);
  return `[system]${job} ${label}${summary ? `: ${summary}` : ""}`;
}
