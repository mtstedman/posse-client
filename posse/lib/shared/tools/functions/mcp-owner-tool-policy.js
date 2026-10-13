import { ATLAS_TOOL_ACTIONS } from "../../../domains/atlas/functions/v2/contracts/tool-params.js";
import { cloneJson, mcpToolErrorPayload, stripToolsPrefix } from "./mcp-owner-session-support.js";
import { stripPosseMcpGatewayPrefix } from "../../../domains/integrations/functions/mcp-gateway.js";
import { isSubAgentEvidenceSafeNativeTool, isSubAgentEvidenceSafeAtlasTool } from "../../../catalog/sub-agent.js";
import { assessorFallbackReadKey } from "../../../domains/assessment/functions/fallback-read-tools.js";
import { isInternalAtlasAction } from "./issued-tool-policy.js";
import { ATLAS_NESTED_ACTION_WRAPPERS } from "./planner-triage.js";
import { researcherDispatcherIssuedActions } from "../../../domains/integrations/functions/deterministic-mcp/researcher-dispatcher.js";
import { ATLAS_HISTORICAL_ACTION_ALIASES } from "../../../catalog/atlas.js";

const ATLAS_TOOL_ACTION_SET = /** @type {Set<string>} */ (new Set(ATLAS_TOOL_ACTIONS));

export function stripGatewaySessionTokenFields(value = {}) {
  const out = cloneJson(value);
  delete out.mcpOAuthToken;
  delete out.mcpOauthToken;
  if (out.mcpAuth && typeof out.mcpAuth === "object") {
    delete out.mcpAuth.accessToken;
    delete out.mcpAuth.token;
  }
  return out;
}

function normalizeAtlasActionName(name) {
  const raw = String(name || "").trim();
  const stripped = raw.startsWith("atlas.")
    ? raw.slice("atlas.".length).trim()
    : (raw.startsWith("atlas_") ? raw.slice("atlas_".length).trim() : raw);
  if (ATLAS_TOOL_ACTION_SET.has(stripped)) return stripped;
  const dotted = stripped.replace(/^atlas_/, "").replace(/_/g, ".").trim();
  if (ATLAS_TOOL_ACTION_SET.has(dotted)) return dotted;
  const lowered = dotted.toLowerCase();
  for (const action of ATLAS_TOOL_ACTION_SET) {
    if (String(action).toLowerCase() === lowered) return action;
  }
  return stripped;
}

function nestedAtlasAction(args = {}) {
  return normalizeAtlasActionName(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  );
}

export function requestedToolPolicyName(name, args = {}) {
  const raw = stripPosseMcpGatewayPrefix(name);
  if (raw.startsWith("atlas.") || raw.startsWith("atlas_")) {
    const action = normalizeAtlasActionName(raw);
    return {
      suite: "atlas",
      name: action,
      nested: nestedAtlasAction(args),
    };
  }
  return {
    suite: "tools",
    name: stripToolsPrefix(raw),
    // A scoped diff is primary change evidence, not a fallback repository
    // read. Preserve the operation here so every persistent MCP transport
    // classifies it the same way as the deterministic gateway.
    nested: stripToolsPrefix(raw) === "git_history"
      ? String(args?.op || "").trim().toLowerCase()
      : "",
  };
}

export function delegatedEvidenceRequestAllowed(name, args) {
  const requested = requestedToolPolicyName(name, args);
  const canonical = requested.suite === "atlas" && requested.name === "query"
    ? `atlas.${requested.nested}` : `${requested.suite}.${requested.name}`;
  return isSubAgentEvidenceSafeNativeTool(canonical) || isSubAgentEvidenceSafeAtlasTool(canonical);
}

export function __testDelegatedEvidenceRequestAllowed(name, args = {}) {
  return delegatedEvidenceRequestAllowed(name, args);
}

export function __testAssessorFallbackReadKey(name, args = {}) {
  return assessorFallbackReadKey(requestedToolPolicyName(name, args));
}

function suiteToolAllowlistPolicy(bootConfig = {}) {
  const source = bootConfig?.toolAllowlist && typeof bootConfig.toolAllowlist === "object" && !Array.isArray(bootConfig.toolAllowlist)
    ? bootConfig.toolAllowlist
    : null;
  const suites = {};
  if (source) {
    for (const [suite, names] of Object.entries(source)) {
      const suiteName = String(suite || "").trim().toLowerCase();
      if (!suiteName || !Array.isArray(names)) continue;
      suites[suiteName] = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    }
  }
  return {
    suites,
    source: source ? "token-allowlist" : "missing-token-allowlist",
    // Every researcher with Atlas gets the direct surface (short symbol
    // handles, typed-result compaction, field projection, argument repair), on
    // any provider. Mirrors researcherDirect in the deterministic MCP server.
    atlasResearcherDirect: String(bootConfig?.role || "").trim().toLowerCase() === "researcher"
      && bootConfig?.atlasAvailable !== false,
  };
}

export function hasSuiteToolAllowlist(bootConfig = {}) {
  const source = bootConfig?.toolAllowlist;
  return !!(source && typeof source === "object" && !Array.isArray(source));
}

export function sessionToolPolicy(session) {
  return suiteToolAllowlistPolicy(session?.bootConfig || {});
}

export function usesResearcherAtlasReadSurface(policy) {
  return policy?.atlasResearcherDirect === true;
}

export function toolAllowedByPolicy(policy, toolName, args = {}) {
  const requested = requestedToolPolicyName(toolName, args);
  const allowed = policy?.suites?.[requested.suite] || new Set();
  if (requested.suite === "atlas") {
    if (!requested.name || isInternalAtlasAction(requested.name)) return false;
    if (!allowed.has(requested.name)) return false;
    if (ATLAS_NESTED_ACTION_WRAPPERS.has(requested.name) && requested.nested) {
      return !isInternalAtlasAction(requested.nested) && allowed.has(requested.nested);
    }
    return true;
  }
  return !!requested.name && allowed.has(requested.name);
}

function issuedAtlasActionsForPolicy(policy) {
  const allowed = policy?.suites?.atlas || new Set();
  const grantable = [...allowed]
    .map((action) => String(action || "").trim())
    .filter((action) => action && !isInternalAtlasAction(action) && !ATLAS_NESTED_ACTION_WRAPPERS.has(action));
  if (policy?.atlasResearcherDirect === true) {
    // Mirror the advertised direct tool set exactly: the model never saw
    // wrappers, excluded compatibility routes, or card-less actions.
    return researcherDispatcherIssuedActions(grantable, { typed: true }).sort();
  }
  return grantable.sort();
}

/**
 * Classify a nested-action denial AFTER the whole-tool policy check failed.
 * Returns null when the denial is about the wrapper tool itself (the existing
 * whole-tool message stays correct there), or when the wrapper is not a
 * nested-action facade. Otherwise distinguishes an action Atlas does not know
 * from a known action absent from (or internal to) this session's signed
 * grant. Both remain denied: this only changes what the model is told.
 */
export function nestedAtlasActionDenial(policy, toolName, args = {}) {
  const requested = requestedToolPolicyName(toolName, args);
  if (requested.suite !== "atlas" || !ATLAS_NESTED_ACTION_WRAPPERS.has(requested.name)) return null;
  const nested = String(requested.nested || "");
  if (!nested || nested === "workflow") return null;
  const allowed = policy?.suites?.atlas || new Set();
  const wrapperReachable = requested.name === "query"
    ? allowed.has("query")
    : allowed.has(requested.name);
  if (!wrapperReachable) return null;
  const issued = issuedAtlasActionsForPolicy(policy);
  // Internal actions are known to Atlas but never issued to a model; they
  // are reported as unissued rather than unknown so the model does not
  // retry a spelling, and never as available.
  const known = ATLAS_TOOL_ACTION_SET.has(nested);
  const alias = ATLAS_HISTORICAL_ACTION_ALIASES[nested] || null;
  const replacement = alias && issued.includes(alias) ? alias : null;
  return {
    code: known ? "action_not_issued" : "unknown_action",
    wrapper: `atlas.${requested.name}`,
    action: nested,
    valid: issued,
    replacement,
  };
}

function nestedAtlasActionDenialPayload(denial) {
  const validText = denial.valid.length > 0 ? denial.valid.join(", ") : "(none issued)";
  const replacementText = denial.replacement
    ? ` Use ${denial.replacement} instead.`
    : "";
  const text = denial.code === "unknown_action"
    ? `Unknown ${denial.wrapper} action "${denial.action}"; the tool itself remains available.${replacementText} Valid actions for this session: ${validText}.`
    : `${denial.wrapper} action "${denial.action}" is not issued to this session; the tool itself remains available.${replacementText} Valid actions for this session: ${validText}.`;
  return mcpToolErrorPayload(text, {
    code: denial.code,
    message: text,
    details: {
      wrapper: denial.wrapper,
      action: denial.action,
      valid: denial.valid,
      ...(denial.replacement ? { replacement: denial.replacement } : {}),
    },
  });
}

export function __testNestedAtlasActionDenial(policy, toolName, args = {}) {
  return nestedAtlasActionDenial(policy, toolName, args);
}

export function deniedToolCallMessage(message, toolName, policy, args = {}) {
  const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  if (id == null) return null;
  const denial = nestedAtlasActionDenial(policy, toolName, args);
  if (denial) {
    return {
      jsonrpc: "2.0",
      id,
      result: nestedAtlasActionDenialPayload(denial),
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{
        type: "text",
        text: `Tool ${toolName || "(unknown)"} is not allowed for this MCP session (${policy.source} policy).`,
      }],
      isError: true,
    },
  };
}

export function __testDeniedToolCallMessage(message, toolName, policy, args = {}) {
  return deniedToolCallMessage(message, toolName, policy, args);
}
