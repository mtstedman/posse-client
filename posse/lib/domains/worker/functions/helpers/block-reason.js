// lib/domains/worker/functions/helpers/block-reason.js
//
// Classifies an agent-reported BLOCKED reason. Most blocks are genuine
// ("I need a human to expand scope / make a decision") and should escalate.
// But a class of blocks are transient *infrastructure/routing* failures — most
// commonly the agent CLI failing to attach or recognize the Posse MCP gateway,
// or Codex selecting its intentionally read-only native patch path instead of
// the issued scoped write/edit tools. Those should be auto-requeued with the
// runtime tool guard, not escalated to a human.
//
// This is provider-agnostic on purpose: the attach-under-load failure has been
// observed from both the claude CLI ("No such tool available") and the codex
// CLI, so we match on the gateway/MCP-unavailable shape rather than any one
// CLI's wording.

import { formatToolReference, TOOL_REFS } from "../../../../catalog/tool-references.js";
import { providerInterruptionRetryContext } from "./provider-quota-pause.js";

// Prefix of the job/attempt error recorded for an agent-reported BLOCKED
// handoff; the retry path reads it back to tell a block from a failure.
export const AGENT_BLOCKED_ERROR_PREFIX = "Agent BLOCKED:";
// The legacy no-write completion branch records its blocks under this prefix.
const LEGACY_DEV_BLOCKED_ERROR_PREFIX = "Dev BLOCKED:";

// The role prompt is composed once and reused when the provider client falls
// back to another provider, so the retry note names the canonical issued tool;
// the RUNTIME CAPABILITY MANIFEST maps it to the provider's callable name.
const ISSUED_EDIT_TOOL = formatToolReference(TOOL_REFS.tools.editFile);

function blockedReasonFromError(text) {
  for (const prefix of [AGENT_BLOCKED_ERROR_PREFIX, LEGACY_DEV_BLOCKED_ERROR_PREFIX]) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return null;
}

// A transient routing block is not a constraint the task states, so neither
// the remote "PREVIOUS ATTEMPT FAILED" section nor the operator-retry note may
// carry it: a provider whose read-only sandbox is still read-only (by design)
// re-reads the quoted reason as confirmation and blocks again (WI 164 job 2136,
// 2026-10-01). Replace the reason with the correction instead.
function transientBlockRetryNote(reason, recovery, writeTool, provider = null) {
  const guidance = recovery?.action === "retry" && recovery.bare_retry !== true
    ? ["  The operator chose retry; their guidance is under BLOCKED RECOVERY GUIDANCE in the task."]
    : [];
  if (isProviderSandboxMisreadBlock(reason, { provider })) {
    return [
      "PREVIOUS ATTEMPT CORRECTION:",
      "  The previous attempt misread the provider sandbox notice and reported BLOCKED.",
      `  The provider's read-only sandbox, "approval policy never", and filesystem-permission notices apply only to native apply_patch and shell writes. They do not restrict ${writeTool}.`,
      `  ${writeTool} is this job's write path for its assigned files; call it by the exact name the runtime capability manifest lists, and make the edits through it.`,
      "  Do not report BLOCKED for the sandbox notice or read-only filesystem permissions.",
      ...guidance,
      "",
    ].join("\n");
  }
  return [
    "PREVIOUS ATTEMPT CORRECTION:",
    "  The previous attempt reported BLOCKED because the issued Posse tools were unavailable. That was a transient tool-routing failure, not a task constraint; this attempt starts a fresh provider session.",
    "  Use the issued tools for this job. Report BLOCKED only if a tool you need is still unavailable, and name that tool.",
    ...guidance,
    "",
  ].join("\n");
}

// A blocked job retried by the operator is not a failed attempt. The remote
// retry section ("PREVIOUS ATTEMPT FAILED ... take a different approach")
// renders only when last_error is set, and it pushes a dev to work around a
// constraint its task states. Replace it with a blocked-specific note: re-check
// the blocker, and report BLOCKED again when it still holds. Transient routing
// blocks and provider-sandbox misreads get a correction on every retry path;
// a misread-shaped block from a provider without that sandbox (recorded under
// BLOCKED_PROVIDER_PAYLOAD_KEY) keeps the genuine-block note. A payload from
// before that key was recorded falls back to `provider`, the job's provider,
// so a legacy Claude block is not corrected as a Codex misread. A previous
// attempt that a provider pause or transient provider error interrupted is
// not reported as failed.
export function blockedRetryContext(payload = {}, lastError = null, { writeTool = ISSUED_EDIT_TOOL, provider = null } = {}) {
  const providerInterruption = providerInterruptionRetryContext(lastError);
  if (providerInterruption) return providerInterruption;
  const recovery = payload?._blocked_recovery;
  const text = typeof lastError === "string" ? lastError.trim() : "";
  const blockedReason = blockedReasonFromError(text);
  const blockProvider = payload?.[BLOCKED_PROVIDER_PAYLOAD_KEY] || provider || null;
  if (blockedReason && isTransientMcpInfraBlock(blockedReason, { provider: blockProvider })) {
    return { lastError: null, block: transientBlockRetryNote(blockedReason, recovery, writeTool, blockProvider) };
  }
  if (recovery?.action !== "retry" || !text.startsWith(AGENT_BLOCKED_ERROR_PREFIX)) {
    return { lastError, block: null };
  }
  const reason = text.slice(AGENT_BLOCKED_ERROR_PREFIX.length).trim();
  return {
    lastError: null,
    block: [
      "PREVIOUS ATTEMPT BLOCKED:",
      `  ${reason || "(no reason recorded)"}`,
      recovery.bare_retry === true
        ? "  The operator chose retry without new instructions."
        : "  The operator chose retry; their guidance is under BLOCKED RECOVERY GUIDANCE in the task.",
      "  First re-check whether the blocker still holds: inputs, WORK ITEM RESEARCH REFS, and your issued tools (including any web fallback) may have changed since the last attempt.",
      "  If it still holds, report BLOCKED again with the same reason rather than working around a constraint the task states.",
      "",
    ].join("\n"),
  };
}

// How many automatic requeues before we terminate a persistent gateway-attach
// failure as infrastructure. Operator task guidance cannot repair this surface.
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
const REQUIRED_EXECUTABLE_TOOL_TARGET = /(atlas\.(?:traverse_ref|fetch_ref)|repository\s+read|scoped\s+file[-\s]write\s+tools?)/i;
const TOOL_ROUTING_FAILURE = /(?:deterministic\s+)?tool(?:[-\s]surface)?\s+routing.*(?:feedback[-\s]?poll\s+errors?|instead of\s+(?:scoped\s+)?(?:file|repository)\s+access)/i;
const REQUIRED_FILE_ACCESS_FAILURE = /(?:instead of\s+(?:scoped\s+)?(?:file|repository)\s+access|could not be\s+(?:inspected|read|modified|written))/i;
const DETERMINISTIC_SCOPED_READ_FAILURE = /missing\s+exact\s+file\s+contents\s+for\s+[`'\"]?[a-z0-9_./\\-]+[`'\"]?.*atlas\s+could\s+not\s+read\s+the\s+file.*no\s+usable\s+deterministic\s+read\s+response\s+was\s+available/i;
const SCOPED_PATH_MUTATION_FAILURE = /scoped\s+[`'\"]?[a-z0-9_./\\-]+[`'\"]?\s+(?:edit|write|mutation)(?:\s+and\s+verification)?\s+remain(?:s)?\s+undone\s+due\s+unavailable\s+posse\s+file\s+mutation\s+tool\s+access/i;
const REQUIRED_EXECUTION_CAPABILITY_FAILURE = /missing\s+execution\s+capability\s+prevented\s+reading,\s*editing,\s*and\s+running\s+[`'\"]?node\s+--test\s+[a-z0-9_./\\-]+[`'\"]?/i;
const SCOPED_EXECUTABLE_ACCESS_FAILURE = /missing\s+executable\s+access\s+to\s+[`'\"]?[a-z0-9_./\\-]+[`'\"]?\s+through\s+the\s+provided\s+posse\s+tools\s+prevented\s+any\s+in-scope\s+change/i;
const HUMAN_FILE_AUTHORITY_REQUIRED = /(?:human|operator)\s+(?:permission|approval)|credentials?|access\s+policy|scope\s+expansion/i;
const CODEX_WINDOWS_SANDBOX_HELPER = /\b(?:codex-windows-sandbox-setup|codex(?:-windows)?-command-runner)\.exe\b/i;
const CODEX_WINDOWS_SANDBOX_HELPER_FAILURE = /(?:orchestrator_helper_launch_failed|not found|program not found|failed to launch|could not (?:be )?launch(?:ed)?|unable to launch)/i;
const CODEX_NATIVE_PATCH_SANDBOX_REJECTION = /(?:workspace is read-only and sandbox policy rejects file writes|writing is blocked by read-only sandbox|apply_patch.{0,120}read-only sandbox)/i;
// Codex also blocks by quoting its own sandbox notice as if it covered the
// issued Posse edit tools ("filesystem sandbox is read-only with approval
// policy never, so ... edits are prohibited"; WI 149 job 1927, 2026-10-01).
const CODEX_SANDBOX_NOTICE_MISREAD = /(?:sandbox(?:\s+mode)?\s+(?:is\s+)?read[-\s]?only|read[-\s]?only\s+(?:filesystem\s+)?sandbox|approval\s+policy\s+(?:is\s+)?never).{0,200}(?:prohibit|block|prevent|cannot|can't|not\s+(?:allowed|permitted))/i;
// The same notice paraphrased without "sandbox" ("The supplied filesystem
// permissions allow reads only, which conflicts with the required repository
// edits"; WI 164 job 2136, 2026-10-01). Require the provider-supplied subject
// ("supplied"/"provided" filesystem permissions, or the filesystem sandbox),
// a read-only grant, and an edit/write object. A bare "<x> filesystem is
// read-only" is a genuine environment block (a deploy target, a container
// root, a mount) and stays with a human, as do database grants and
// single-file modes.
const CODEX_FILESYSTEM_PERMISSION_MISREAD = new RegExp([
  String.raw`(?:(?:supplied|provided)\s+file[-\s]?system(?:\s+sandbox)?|file[-\s]?system\s+sandbox)`,
  String.raw`(?:\s+(?:permissions?|access|policy|mode))?`,
  String.raw`\s+(?:(?:is|are|remains?|stays?|was|were)\s+)?`,
  String.raw`(?:(?:only\s+)?(?:allows?|permits?|grants?)\s+(?:only\s+)?reads?(?:\s+only)?|read[-\s]?only)\b`,
  String.raw`.{0,200}(?:edit|writ|modif|mutat|creat)`,
].join(""), "i");
// Only Codex runs writable jobs under a forced read-only native sandbox
// (codex/call-provider.js forceReadOnlySandbox) with "approval policy never",
// so only a Codex attempt can misread that notice. The same words from
// another provider describe a real environment.
const SANDBOX_MISREAD_PROVIDERS = new Set(["codex"]);
// Job payload key recording the provider whose attempt reported the latest
// BLOCKED, so a later retry note classifies the block the same way.
export const BLOCKED_PROVIDER_PAYLOAD_KEY = "_blocked_provider";
// Codex can paraphrase the native sandbox notice without using "sandbox" at
// all. Keep this tied to provider-supplied filesystem permissions plus an
// assigned repository-edit consequence so a genuine request for wider scope
// or credentials still reaches the operator (WI 164 job 2136, 2026-10-01).
const CODEX_PROVIDED_READ_ONLY_PERMISSIONS = /(?:supplied|provided)\s+filesystem\s+permissions?\s+(?:allow|permit)\s+reads?\s+only.{0,300}(?:required\s+repository\s+edits?|implementation\s+requires\s+writable\s+scope|no\s+files?\s+were\s+changed)/i;
const ISSUED_FILE_TOOL_INVOCATION_FAILURE = /(?:(?:write|read|file|repository)(?:\s*\/\s*(?:write|read|file|repository))*\s+(?:path|tools?|surface)|(?:scoped|issued|required)\s+(?:repository\s+)?(?:file\s+)?(?:read|write|mutation)\s+(?:path|tools?|surface)).{0,180}(?:not successfully callable|could not (?:successfully )?(?:invoke|call|reach)|failed to (?:invoke|call|reach)|unavailable|not callable)/i;
const FEEDBACK_TOOL_DISPLACED_FILE_TOOLS = /(?:operator[-\s]?feedback|feedback[-\s]?(?:coordination|poll)|request_user_input).{0,240}(?:could not|unable|failed).{0,120}(?:repository|scoped|issued|required).{0,80}(?:read|write|file|mutation)\s+tools?/i;

/**
 * Returns true for a provider runtime/bootstrap failure that cannot be fixed
 * by human task guidance. These blocks must follow the provider failure path
 * so headless runs terminate and clean their WI worktrees instead of parking a
 * synthetic human_input gate.
 */
export function isPermanentProviderRuntimeBlock(reason) {
  const text = String(reason || "").trim();
  if (!text) return false;
  return CODEX_WINDOWS_SANDBOX_HELPER.test(text)
    && CODEX_WINDOWS_SANDBOX_HELPER_FAILURE.test(text);
}

/**
 * Returns true when a BLOCKED reason says the provider's own read-only
 * sandbox stopped the edit. Writable Codex jobs intentionally keep the native
 * apply_patch sandbox read-only because Posse's issued MCP write/edit tools
 * enforce exact file scope, so the block is a routing or reading mistake, not
 * a missing permission. When `provider` (the provider whose attempt reported
 * the block) is known and is not one that runs that sandbox, the block is
 * genuine.
 * @param {string|null|undefined} reason
 * @param {{ provider?: string|null }} [options]
 * @returns {boolean}
 */
export function isProviderSandboxMisreadBlock(reason, { provider = null } = {}) {
  const text = String(reason || "").trim();
  if (!text) return false;
  if (provider && !SANDBOX_MISREAD_PROVIDERS.has(String(provider).trim().toLowerCase())) return false;
  if (isPermanentProviderRuntimeBlock(text)) return false;
  if (CODEX_NATIVE_PATCH_SANDBOX_REJECTION.test(text)) return true;
  if (HUMAN_FILE_AUTHORITY_REQUIRED.test(text)) return false;
  return CODEX_SANDBOX_NOTICE_MISREAD.test(text)
    || CODEX_FILESYSTEM_PERMISSION_MISREAD.test(text)
    || CODEX_PROVIDED_READ_ONLY_PERMISSIONS.test(text);
}

/**
 * Returns true when a BLOCKED reason (or attempt error_text) looks like a
 * transient scoped mutation routing failure rather than a genuine
 * human-needed block. `provider` scopes the sandbox-misread shapes to the
 * provider that runs that sandbox (see isProviderSandboxMisreadBlock).
 * @param {string|null|undefined} reason
 * @param {{ provider?: string|null }} [options]
 * @returns {boolean}
 */
export function isTransientMcpInfraBlock(reason, { provider = null } = {}) {
  const text = String(reason || "").trim();
  if (!text) return false;
  if (isPermanentProviderRuntimeBlock(text)) return false;

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

  // If the model selects apply_patch anyway, or reads the read-only sandbox
  // notice as covering the issued tools, retry with the runtime tool-priority
  // guard instead of asking a human to fix an internal routing mistake.
  if (isProviderSandboxMisreadBlock(text, { provider })) return true;

  // Codex occasionally routes toward its native feedback surface while the
  // required Posse file surface is detached. These are the production smoke
  // failure shapes that previously escaped the narrower gateway-name regexes
  // and created durable blocked_recovery questions for the operator.
  if (ISSUED_FILE_TOOL_INVOCATION_FAILURE.test(text) && !HUMAN_FILE_AUTHORITY_REQUIRED.test(text)) return true;
  if (FEEDBACK_TOOL_DISPLACED_FILE_TOOLS.test(text) && !HUMAN_FILE_AUTHORITY_REQUIRED.test(text)) return true;

  // Canonical phrasings emitted by the dev agent when the gateway is missing.
  if (/not connected to this execution environment/i.test(text)) return true;
  if (/no such tool available/i.test(text)) return true;

  return false;
}
