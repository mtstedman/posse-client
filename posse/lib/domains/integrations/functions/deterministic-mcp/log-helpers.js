// @ts-check
//
// Pure log-sanitization helpers for the deterministic MCP gateway.
//
// appendToolLog stays in deterministic-mcp-server.js because it closes over the
// server's mutable toolLogPath / provider / role state. These two helpers are
// pure (operate only on their arguments).

export function capString(value, max = 240) {
  const raw = String(value == null ? "" : value);
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}…`;
}

export function sanitizeForLog(value, depth = 0) {
  if (value == null) return value;
  if (depth >= 3) return capString(value, 120);
  if (typeof value === "string") return capString(value, 240);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeForLog(entry, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 40)) {
      out[key] = sanitizeForLog(entry, depth + 1);
    }
    return out;
  }
  return capString(value, 240);
}
