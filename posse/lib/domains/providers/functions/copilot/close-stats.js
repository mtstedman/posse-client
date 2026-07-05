import { resolveProviderStallTimeout } from "../shared/stall-timeout.js";

export function buildCopilotCloseStats({
  role,
  modelTier,
  reasoningEffort,
  modelName,
  acc,
  durationMs,
  finalOutputText,
  stdout,
  code,
  sessionHandle,
  priorSessionHandle,
  maxOutputTokens = null,
  outputTruncated = false,
  outputLimitReason = null,
}) {
  const outputBody = (finalOutputText || stdout.trim());
  return {
    role,
    modelTier,
    reasoningEffort,
    modelName,
    provider: "copilot",
    inputTokens: acc?.inputTokens || 0,
    outputTokens: acc?.outputTokens || 0,
    durationMs,
    outputChars: outputBody.length,
    exitCode: code,
    maxOutputTokens,
    outputTruncated: !!outputTruncated,
    outputLimitReason: outputLimitReason || null,
    atlasMethod: "baseline",
    toolUses: Array.isArray(acc?.toolUses) ? acc.toolUses : [],
    toolUsesLoggedByToolkit: false,
    sessionHandle: sessionHandle || null,
    priorSessionHandle: priorSessionHandle || null,
    sessionExpired: false,
  };
}

export function resolveCopilotStallTimeoutMs(stallTimeout = null) {
  const ms = resolveProviderStallTimeout(stallTimeout) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
