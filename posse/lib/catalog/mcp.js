// @ts-check

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
