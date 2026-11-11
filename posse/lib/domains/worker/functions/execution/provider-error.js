// Shared provider-failure classification for fallback and attempt recovery.
// Prefer structured adapter errors; message patterns cover older CLI/API errors.

import { PROVIDER_WINDOW_LIMIT_REACHED_RE } from "../../../providers/functions/shared/quota-reset.js";
import { nativeProviderNoticeText } from "../../../providers/functions/shared/api-resilience.js";

// The provider-side text of a native CLI failure that is itself a quota or
// rate-limit notice. The other patterns stay message-only.
const NATIVE_NOTICE_QUOTA_RE = /rate.?limit|too many requests|out of.*usage|usage.*reset|usage limit|usage cap|usage exhausted|over usage|quota exceeded|credit balance is too low|session limit|(?:hit|reached) your.*limit/i;

// Classes the native dispatch host assigns to provider-side infrastructure
// failures. Their messages are fixed strings the patterns below predate.
const NATIVE_PROVIDER_FAILURE_CLASSES = new Set(["rate_limit", "transient_provider"]);

const PROVIDER_ERROR_PATTERNS = [
  /overloaded_error/i,
  /API Error:\s*5\d\d/i,
  /api_error.*internal server error/i,
  /rate.?limit|429|too many requests/i,
  /out of.*usage|usage.*reset|usage limit|usage cap|usage exhausted|over usage|quota exceeded|credit balance is too low|session limit|(?:hit|reached) your.*limit/i,
  // Claude's "5-hour limit reached" / "Weekly limit reached" quota wordings.
  PROVIDER_WINDOW_LIMIT_REACHED_RE,
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
  if (code === "provider_circuit_open" || NATIVE_PROVIDER_FAILURE_CLASSES.has(String(err?.classification || ""))) return true;
  const notice = nativeProviderNoticeText(err);
  if (notice && (NATIVE_NOTICE_QUOTA_RE.test(notice) || PROVIDER_WINDOW_LIMIT_REACHED_RE.test(notice))) return true;
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(String(err?.message || "")));
}
