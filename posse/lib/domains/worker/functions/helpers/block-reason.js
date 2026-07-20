// lib/domains/worker/functions/helpers/block-reason.js
//
// Classifies an agent-reported BLOCKED reason. Most blocks are genuine
// ("I need a human to expand scope / make a decision") and should escalate.
// But a class of blocks are transient *infrastructure* failures — most
// commonly the agent CLI failing to attach or recognize the Posse MCP gateway
// (the stdio server that exposes write_file/edit_file/etc.) under concurrent
// load. When that happens the agent may run a full session believing the
// gateway tools are absent even though Posse dispatched the config correctly.
// Those should be auto-requeued (the next attempt usually attaches cleanly),
// not escalated to a human.
//
// This is provider-agnostic on purpose: the attach-under-load failure has been
// observed from both the claude CLI ("No such tool available") and the codex
// CLI, so we match on the gateway/MCP-unavailable shape rather than any one
// CLI's wording.

// How many automatic requeues before we give up and escalate a persistent
// gateway-attach failure to a human (a truly stuck gateway is a real problem).
export const MAX_MCP_INFRA_BLOCK_RETRIES = 3;

// Backoff between automatic requeues (ms), indexed by prior retry count. Gives
// the owner/system a moment to drain concurrent load before re-leasing.
export const MCP_INFRA_BLOCK_BACKOFF_MS = Object.freeze([5000, 15000, 30000]);

const GATEWAY_IDENTITY = /(mcp__posse[-_]?gateway|posse[-\s]?gateway|posse mcp gateway)/i;
const UNAVAILABLE = /(not connected|unavailable|not available|not callable|could not (?:call|invoke|be called|be invoked)|failed to (?:connect|attach|start|initialize)|did not (?:start|connect)|disconnect|no such tool)/i;
const GENERIC_MCP = /\bmcp\b/i;
const GENERIC_MCP_TARGET = /(gateway|server|tool)/i;
const SCOPED_FILE_TOOL_TARGET = /(scoped\s+(?:read|edit|write|file)(?:\s*\/\s*(?:read|edit|write|file))*\s+(?:gateway\s+)?(?:tools?|actions?)|scoped\s+repository\s+mutation|required\s+posse\s+file\s+tools?|(?:read|edit|write|file)(?:\s*\/\s*(?:read|edit|write|file))+\s+gateway\s+(?:tools?|actions?))/i;
const MISSING_EXECUTABLE_ACCESS = /(?:missing|no|without)\s+executable\s+access/i;
const REQUIRED_EXECUTABLE_TOOL_TARGET = /(atlas\.fetch_ref|repository\s+read|scoped\s+file[-\s]write\s+tools?)/i;
const TOOL_ROUTING_FAILURE = /(?:deterministic\s+)?tool(?:[-\s]surface)?\s+routing.*(?:feedback[-\s]?poll\s+errors?|instead of\s+(?:scoped\s+)?(?:file|repository)\s+access)/i;
const REQUIRED_FILE_ACCESS_FAILURE = /(?:instead of\s+(?:scoped\s+)?(?:file|repository)\s+access|could not be\s+(?:inspected|read|modified|written))/i;
const DETERMINISTIC_SCOPED_READ_FAILURE = /missing\s+exact\s+file\s+contents\s+for\s+[`'\"]?[a-z0-9_./\\-]+[`'\"]?.*atlas\s+could\s+not\s+read\s+the\s+file.*no\s+usable\s+deterministic\s+read\s+response\s+was\s+available/i;
const SCOPED_PATH_MUTATION_FAILURE = /scoped\s+[`'\"]?[a-z0-9_./\\-]+[`'\"]?\s+(?:edit|write|mutation)(?:\s+and\s+verification)?\s+remain(?:s)?\s+undone\s+due\s+unavailable\s+posse\s+file\s+mutation\s+tool\s+access/i;
const REQUIRED_EXECUTION_CAPABILITY_FAILURE = /missing\s+execution\s+capability\s+prevented\s+reading,\s*editing,\s*and\s+running\s+[`'\"]?node\s+--test\s+[a-z0-9_./\\-]+[`'\"]?/i;
const SCOPED_EXECUTABLE_ACCESS_FAILURE = /missing\s+executable\s+access\s+to\s+[`'\"]?[a-z0-9_./\\-]+[`'\"]?\s+through\s+the\s+provided\s+posse\s+tools\s+prevented\s+any\s+in-scope\s+change/i;
const HUMAN_FILE_AUTHORITY_REQUIRED = /(?:human|operator)\s+(?:permission|approval)|credentials?|access\s+policy|scope\s+expansion/i;

/**
 * Returns true when a BLOCKED reason (or attempt error_text) looks like a
 * transient MCP-gateway attach failure rather than a genuine human-needed block.
 * @param {string|null|undefined} reason
 * @returns {boolean}
 */
export function isTransientMcpInfraBlock(reason) {
  const text = String(reason || "").trim();
  if (!text) return false;

  // Direct gateway identity + an unavailability signal.
  if (GATEWAY_IDENTITY.test(text) && UNAVAILABLE.test(text)) return true;

  // Generic "MCP <gateway|server|tool> ... <unavailable>" shape (covers other
  // CLIs whose wording differs from claude's).
  if (GENERIC_MCP.test(text) && GENERIC_MCP_TARGET.test(text) && UNAVAILABLE.test(text)) return true;

  // Some provider responses omit the MCP/gateway name and identify only the
  // mandatory scoped file surface. Keep this narrow so ordinary missing tools
  // or human-required capabilities are not mistaken for transient infra.
  if (SCOPED_FILE_TOOL_TARGET.test(text) && UNAVAILABLE.test(text)) return true;

  // Codex may describe the same failed MCP attachment as missing "executable
  // access" and list the mandatory issued-reference/read/write surfaces. The
  // required-tool target keeps this distinct from a genuine request for new
  // product access or credentials.
  if (MISSING_EXECUTABLE_ACCESS.test(text) && REQUIRED_EXECUTABLE_TOOL_TARGET.test(text)) return true;

  // A detached Codex MCP surface may route every intended file-tool call to
  // the feedback poller instead. Match that exact routing/file-access shape,
  // not generic poll errors or genuine filesystem permission requests.
  if (TOOL_ROUTING_FAILURE.test(text) && REQUIRED_FILE_ACCESS_FAILURE.test(text)) return true;

  // A detached repair surface may report the assigned file path but fail both
  // ATLAS and the deterministic read fallback. Require all three parts of that
  // exact shape, and never absorb genuine permission or scope requests.
  if (DETERMINISTIC_SCOPED_READ_FAILURE.test(text) && !HUMAN_FILE_AUTHORITY_REQUIRED.test(text)) return true;

  // A one-shot provider may identify the assigned path and the unavailable
  // Posse mutation surface without calling it a gateway. Keep the full
  // path/edit/undone/tool-access shape to avoid swallowing product decisions.
  if (SCOPED_PATH_MUTATION_FAILURE.test(text) && !HUMAN_FILE_AUTHORITY_REQUIRED.test(text)) return true;

  // Codex may describe the absent deterministic read/write/test surface as a
  // missing execution capability, or bind missing executable access directly
  // to the assigned path. Both are retryable only in their full scoped shapes.
  if (REQUIRED_EXECUTION_CAPABILITY_FAILURE.test(text) && !HUMAN_FILE_AUTHORITY_REQUIRED.test(text)) return true;
  if (SCOPED_EXECUTABLE_ACCESS_FAILURE.test(text) && !HUMAN_FILE_AUTHORITY_REQUIRED.test(text)) return true;

  // Canonical phrasings emitted by the dev agent when the gateway is missing.
  if (/not connected to this execution environment/i.test(text)) return true;
  if (/no such tool available/i.test(text)) return true;

  return false;
}
