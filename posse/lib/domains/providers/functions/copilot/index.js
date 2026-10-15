// Copilot prompt/model projection. Rust owns discovery, launch and event decoding.
import { copyProviderOptions } from "../shared/provider-options.js";
import { PROVIDER_CAPABILITIES } from "../../../../catalog/provider-capabilities.js";
import { verifyProviderDispatchCapabilitiesSync } from "../../../../shared/native/functions/engagement-client.js";
import { providerRuntimeState } from "../../classes/runtime-state-singleton.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { getMaxOutputTokensForProvider } from "../shared/turns.js";
import { normalizeMaxOutputTokens } from "../shared/output-limits.js";
import { resolveProviderStallTimeout } from "../shared/stall-timeout.js";
import { buildNativeDispatchRequest, rejectRawCliControlOptions, runNativeDispatch } from "../shared/native-dispatch.js";
import { nativeIssuedToolIds } from "../shared/native-tool-catalog.js";
import { buildDeterministicReadMcpServerConfigAsync, releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";
import { MODEL_TIERS, escalateTier, getModelOverride, getModelTierConfig } from "./model-config.js";
import { getAuthMethod, hasCredentials, resolveCopilotAuth } from "./auth-state.js";
import { parseCopilotErrorBackoff } from "./failure-classification.js";

export const capabilities = PROVIDER_CAPABILITIES.copilot;
export { MODEL_TIERS, escalateTier, getAuthMethod, getModelTierConfig, hasCredentials };

export function isReady() {
  try { verifyProviderDispatchCapabilitiesSync("copilot"); }
  catch (error) { return { ready: false, reason: String(error?.message || error) }; }
  if (!resolveCopilotAuth()) return { ready: false, reason: "Run copilot login, or configure COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN." };
  return { ready: true, reason: null };
}
export function getRateLimitState() { return providerRuntimeState.getRateLimitState("copilot"); }
export function tripRateLimit(backoffSec = 60, reason = "") { providerRuntimeState.tripRateLimit("copilot", backoffSec, reason || "Copilot rate limited"); }
export function parseErrorBackoff(error) { return parseCopilotErrorBackoff(error); }

export async function callProvider(promptText, opts = {}) {
  rejectRawCliControlOptions("copilot", opts);
  const role = opts.role || "planner";
  const cwd = opts.cwd || opts.projectDir || process.cwd();
  const modelTier = opts.modelTier || "standard";
  const modelName = selectExecutionModel({ jobModelName: opts.modelName, globalModelOverride: getModelOverride(), tierModel: getModelTierConfig(modelTier).model });
  let owner = null;
  try {
    let issuedToolIds = [];
    if (opts.disableAgentTools === true) {
      if (opts.allowWrite) throw new Error("A tool-free Copilot turn cannot have write access");
    } else {
      if (!opts.mcpGate) throw Object.assign(new Error("Copilot agent requires an MCP gate dependency"), { code: "POSSE_AGENT_MCP_GATE_REQUIRED" });
      owner = await buildDeterministicReadMcpServerConfigAsync(role, copyProviderOptions(opts, {
        ...opts, cwd, providerName: "copilot", isolateProviderHome: false,
        remoteToolSurface: opts.mcpGate.remoteToolSurface,
      }));
      if (!owner?.ready) throw Object.assign(new Error(`Copilot MCP gate is not ready: ${owner?.reason || "unknown"}`), { code: "POSSE_AGENT_MCP_GATE_NOT_READY" });
      issuedToolIds = await nativeIssuedToolIds(opts.mcpGate);
    }
    const systemPrompt = opts.remoteSystemPrompt || null;
    opts.recordFinalPrompt?.(promptText, { systemPrompt, systemPromptFiles: [] });
    const request = buildNativeDispatchRequest("copilot", promptText, {
      ...opts, role, cwd, modelTier, modelName, systemPrompt, issuedToolIds,
      maxTurns: opts.maxTurns || 256,
      maxOutputTokens: normalizeMaxOutputTokens(opts.maxOutputTokens) || getMaxOutputTokensForProvider("copilot", { role }),
      stallTimeoutMs: resolveProviderStallTimeout(opts.stallTimeout) * 1000,
    });
    return await runNativeDispatch(request, copyProviderOptions(opts, { projectDir: opts.projectDir || cwd }));
  } finally {
    if (owner?.ownerSession) releaseDeterministicMcpServerSession(owner, { reason: "provider_cleanup", context: { provider: "copilot", role, jobId: opts.jobId, workItemId: opts.workItemId, attemptId: opts.attemptId } });
  }
}
