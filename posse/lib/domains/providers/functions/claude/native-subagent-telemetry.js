import crypto from "node:crypto";

function textContent(message = {}) {
  const content = message?.message?.content ?? message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => typeof block?.text === "string" ? block.text : "").filter(Boolean).join("\n");
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function tag(text, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i").exec(text);
  return match ? decodeXml(match[1].trim()) : null;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parseClaudeTaskNotification(message) {
  const text = textContent(message);
  if (!text.includes("<task-notification>")) return null;
  const taskId = tag(text, "task-id");
  const toolUseId = tag(text, "tool-use-id");
  if (!taskId && !toolUseId) return null;
  const usageText = tag(text, "usage") || "";
  return {
    taskId,
    toolUseId,
    status: tag(text, "status") || "unknown",
    summary: tag(text, "summary"),
    reportedTokens: nonNegative(tag(usageText, "subagent_tokens")),
    reportedToolUses: nonNegative(tag(usageText, "tool_uses")),
    durationMs: nonNegative(tag(usageText, "duration_ms")),
  };
}

function promptHash(input) {
  const prompt = String(input?.prompt || input?.message || "");
  return prompt ? crypto.createHash("sha256").update(prompt).digest("hex") : null;
}

export function buildClaudeNativeSubagentTelemetry({ toolUses = [], notifications = [], aggregateUsage = null, totalCostUsd = null } = {}) {
  const dispatches = toolUses
    .filter((entry) => ["Agent", "Task"].includes(String(entry?.tool || "")))
    .map((entry, index) => ({
      ordinal: index + 1,
      toolUseId: entry.id || null,
      tool: entry.tool,
      description: String(entry.input?.description || entry.input?.name || "").trim() || null,
      agentType: String(entry.input?.subagent_type || entry.input?.agent || "").trim() || null,
      background: entry.input?.run_in_background === true,
      promptSha256: promptHash(entry.input),
      providerTurnIndex: entry.providerTurnIndex ?? null,
    }));
  const notificationByTool = new Map(notifications.filter(Boolean).map((entry) => [entry.toolUseId, entry]));
  const matchedTaskIds = new Set();
  const children = dispatches.map((dispatch) => {
    const notification = notificationByTool.get(dispatch.toolUseId) || null;
    if (notification?.taskId) matchedTaskIds.add(notification.taskId);
    return {
      ...dispatch,
      taskId: notification?.taskId || null,
      status: notification?.status || "dispatched",
      summary: notification?.summary || null,
      reportedTokens: notification?.reportedTokens ?? null,
      reportedToolUses: notification?.reportedToolUses ?? null,
      durationMs: notification?.durationMs ?? null,
      costUsd: null,
      usagePrecision: notification?.reportedTokens != null ? "provider_reported_total_only" : "unknown",
    };
  });
  for (const notification of notifications.filter(Boolean)) {
    if (notification.taskId && matchedTaskIds.has(notification.taskId)) continue;
    if (notification.toolUseId && children.some((child) => child.toolUseId === notification.toolUseId)) continue;
    children.push({
      ordinal: children.length + 1,
      toolUseId: notification.toolUseId || null,
      tool: "Agent",
      description: null,
      agentType: null,
      background: null,
      promptSha256: null,
      providerTurnIndex: null,
      taskId: notification.taskId || null,
      status: notification.status || "unknown",
      summary: notification.summary || null,
      reportedTokens: notification.reportedTokens ?? null,
      reportedToolUses: notification.reportedToolUses ?? null,
      durationMs: notification.durationMs ?? null,
      costUsd: null,
      usagePrecision: notification.reportedTokens != null ? "provider_reported_total_only" : "unknown",
    });
  }
  const knownTokens = children.filter((child) => child.reportedTokens != null);
  const childReportedTokens = knownTokens.reduce((total, child) => total + child.reportedTokens, 0);
  return {
    schemaVersion: 1,
    provider: "claude",
    accountingMode: "children_included_in_parent_aggregate",
    additiveToParentTotals: false,
    dispatchCount: dispatches.length,
    childCount: children.length,
    completedCount: children.filter((child) => child.status === "completed").length,
    childReportedTokens: knownTokens.length === children.length ? childReportedTokens : null,
    measuredChildTokens: childReportedTokens,
    childTokenCoverage: { known: knownTokens.length, total: children.length },
    aggregateUsage: aggregateUsage || null,
    aggregateCostUsd: nonNegative(totalCostUsd),
    capturePrecision: children.length > 0 && knownTokens.length === children.length ? "aggregate_parent_plus_reported_child_totals" : "partial",
    dispatches,
    children,
  };
}
