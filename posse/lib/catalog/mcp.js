// @ts-check
import { SUB_AGENT_LIMITS } from "./sub-agent.js";

export const MCP_SESSION_RELEASED_NOTIFICATION = "posse/sessionReleased";

export const POSSE_MCP_GATEWAY_SERVER_NAME = "posse-gateway";
export const POSSE_MCP_GATEWAY_SERVER_INFO_NAME = "posse-gateway-mcp";
export const POSSE_MCP_GATEWAY_TRANSPORT = "mcp-gateway";

export const MCP_OAUTH_ISSUER = "posse";
export const MCP_OAUTH_AUDIENCE = "posse-mcp-gateway";
export const MCP_OAUTH_TOKEN_TYPE = "posse.mcp.oauth.v1";
export const DEFAULT_MCP_OAUTH_TTL_SECONDS = 8 * 60 * 60;

// One scoped typecheck can run for 180 seconds; suites compose several checks.
// Queue residence is not execution time. Transport clients allow the owner's
// active watchdog and its recovery grace to finish before timing out.
export const MCP_REQUEST_TIMEOUT_MS = 210000;
export const MCP_COMPOSED_CHECK_TIMEOUT_MS = 30 * 60 * 1000;
export const MCP_TRANSPORT_TIMEOUT_MS = 2 * MCP_COMPOSED_CHECK_TIMEOUT_MS + 30000;
export const MCP_OWNER_LIVENESS_TIMEOUT_MS = 30000;

// Every provider's MCP client bounds each tool call with its own timeout
// (Codex `tool_timeout_sec`, default 60 s; Claude Code per-server `timeout`
// plus a 30-minute stdio idle default). The owner may legitimately run some
// tools far longer than any of those defaults, so each adapter must raise its
// client's per-call deadline to at least what the issued surface can run.
// The classes below are the single registration of those bounds; adapters
// derive their client configuration from `mcpClientToolDeadlineMs`, never
// from provider-specific constants.
export const MCP_TOOL_DEADLINE_CLASSES = Object.freeze({
  DEFAULT: "default",
  COMPOSED_CHECK: "composed_check",
  LIVE_WAIT: "live_wait",
  CITATION_CHILD: "citation_child",
  AGENT_DISPATCH: "agent_dispatch",
});

// A live scope request parks the tool call on a human answer. The queue's
// wait plus exemption slack (`scope-expansion.js`) must stay inside this bound;
// a test pins that relationship.
export const MCP_LIVE_SCOPE_WAIT_DEADLINE_MS = 150_000;

export const MCP_TOOL_DEADLINE_MS = Object.freeze({
  [MCP_TOOL_DEADLINE_CLASSES.DEFAULT]: MCP_REQUEST_TIMEOUT_MS,
  [MCP_TOOL_DEADLINE_CLASSES.COMPOSED_CHECK]: MCP_COMPOSED_CHECK_TIMEOUT_MS,
  [MCP_TOOL_DEADLINE_CLASSES.LIVE_WAIT]: MCP_LIVE_SCOPE_WAIT_DEADLINE_MS,
  [MCP_TOOL_DEADLINE_CLASSES.CITATION_CHILD]: SUB_AGENT_LIMITS.maxTimeoutMs,
});

export const MCP_TOOL_DEADLINE_CLASS_BY_TOOL = Object.freeze({
  run_scoped_checks: MCP_TOOL_DEADLINE_CLASSES.COMPOSED_CHECK,
  run_test_suite: MCP_TOOL_DEADLINE_CLASSES.COMPOSED_CHECK,
  request_scope: MCP_TOOL_DEADLINE_CLASSES.LIVE_WAIT,
  sub_agent: MCP_TOOL_DEADLINE_CLASSES.CITATION_CHILD,
  dispatch_agent: MCP_TOOL_DEADLINE_CLASSES.AGENT_DISPATCH,
});

// Headroom for owner scheduling and result transfer on top of the owner's own
// bound; not applied to agent dispatch, whose policy already reserves its
// return margin below the transport deadline.
export const MCP_TOOL_DEADLINE_MARGIN_MS = 30_000;
// No client deadline may exceed what the shim transport itself allows.
export const MCP_CLIENT_TOOL_DEADLINE_CAP_MS = MCP_TRANSPORT_TIMEOUT_MS - 1000;

export function mcpToolDeadlineClass(toolName) {
  const raw = String(toolName || "").trim();
  const bare = raw.replace(/^tools[._]/u, "");
  return MCP_TOOL_DEADLINE_CLASS_BY_TOOL[bare] || MCP_TOOL_DEADLINE_CLASSES.DEFAULT;
}

/**
 * The per-call deadline a provider's MCP client must allow for a server that
 * exposes `toolNames`: the longest bound among the issued tools, plus margin,
 * capped at the transport deadline. Atlas actions and unknown tools take the
 * default class. `agentDispatchTimeoutMs` is the dispatch gate's configured
 * tool timeout; when absent, an issued dispatch tool counts as default.
 */
export function mcpClientToolDeadlineMs(toolNames = [], { agentDispatchTimeoutMs = null, marginMs = MCP_TOOL_DEADLINE_MARGIN_MS } = {}) {
  const names = Array.isArray(toolNames) ? toolNames : [];
  const fallback = MCP_TOOL_DEADLINE_MS[MCP_TOOL_DEADLINE_CLASSES.DEFAULT] + marginMs;
  // A server's deadline is the longest bound among its own tools. A server
  // that exposes only agent dispatch takes the gate timeout exactly.
  let deadline = names.length === 0 ? fallback : 0;
  for (const name of names) {
    const cls = mcpToolDeadlineClass(name);
    const bound = cls === MCP_TOOL_DEADLINE_CLASSES.AGENT_DISPATCH
      ? (Number(agentDispatchTimeoutMs) > 0 ? Number(agentDispatchTimeoutMs) : fallback)
      : MCP_TOOL_DEADLINE_MS[cls] + marginMs;
    if (bound > deadline) deadline = bound;
  }
  return Math.min(Math.ceil(deadline), MCP_CLIENT_TOOL_DEADLINE_CAP_MS);
}

export function mcpClientToolDeadlineSec(toolNames = [], options = {}) {
  return Math.ceil(mcpClientToolDeadlineMs(toolNames, options) / 1000);
}
export const MCP_OWNER_HEARTBEAT_INTERVAL_MS = 5000;
export const MCP_OWNER_PROGRESS_HEADER = "x-posse-owner-progress";
export const MCP_CONTROL_METHODS = Object.freeze([
  "initialize", "notifications/initialized", "tools/list", "ping",
  "resources/list", "resources/templates/list",
]);

export const MCP_CONCURRENT_ATLAS_ACTIONS = Object.freeze([
  "action.search",
  "repo.status",
  "repo.overview",
  "repo.quality",
  "buffer.status",
  "symbol.search",
  "symbol.card",
  "symbol.overview",
  "symbol.callers",
  "symbol.get",
  "tree.overview",
  "tree.branch",
  "tree.scope",
  "tree.expand",
  "slice.build",
  "edit.plan",
  "code.skeleton",
  "code.lens",
  "code.window",
  "code.survey",
  "code.structure",
  "code.db",
  "context.summary",
  "review.delta",
  "review.analyze",
  "review.risk",
  "file.read",
  "policy.get",
  "usage.stats",
]);
