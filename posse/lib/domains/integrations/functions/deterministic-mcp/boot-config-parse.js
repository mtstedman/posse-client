// @ts-check
//
// Pure boot-config parsing helpers for the deterministic MCP gateway.
//
// These functions depend solely on their arguments (no module-level mutable
// state). The stateful parsers that mutate the server's scope-parse flag
// (parseScopeEnvArray / envBootConfig / parseBootConfig / bootConfigFromOAuthToken)
// remain in deterministic-mcp-server.js.

export function parseEnvBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function parseBoolOverride(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return /^(1|true|yes|on)$/i.test(raw);
}

export function bootString(value) {
  return String(value ?? "").trim();
}

export function bootHeadersOverride(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? null : text;
  }
  if (typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value).trim();
  return text === "" ? null : text;
}

export function nonNegativeIntegerOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}
