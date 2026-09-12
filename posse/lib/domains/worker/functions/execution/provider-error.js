// Shared provider-failure classification for fallback and attempt recovery.
// Prefer structured adapter errors; message patterns cover older CLI/API errors.

const PROVIDER_ERROR_PATTERNS = [
  /overloaded_error/i,
  /API Error:\s*5\d\d/i,
  /api_error.*internal server error/i,
  /rate.?limit|429|too many requests/i,
  /out of.*usage|usage.*reset|usage limit|usage cap|usage exhausted|over usage|quota exceeded|credit balance is too low|session limit|hit your.*limit/i,
  /configuration.*corrupted/i,
  /Failed to spawn claude/i,
  /claude exited null/i,
  /claude exited with unknown status/i,
  /claude exited via signal/i,
  /socket connection was closed unexpectedly/i,
  /^Codex CLI exited with code 1\s*$/i,
  /MCP_ATTACH_PROOF_MISSING|MCP_ATTACH_PROJECTION_MISMATCH|MCP attach proof missing|deterministic MCP attach proof missing|deterministic MCP projection mismatch/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT/i,
  /connection error/i,
  /circuit breaker open/i,
];

export function isProviderInfrastructureError(err) {
  if (err?.providerFailure === true) return true;
  const code = String(err?.code || "");
  if (code.startsWith("COPILOT_") && code !== "COPILOT_ABORTED") return true;
  if (code === "MCP_ATTACH_PROOF_MISSING" || code === "MCP_ATTACH_PROJECTION_MISMATCH") return true;
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(String(err?.message || "")));
}
