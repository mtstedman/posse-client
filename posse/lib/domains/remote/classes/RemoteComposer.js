import { RemotePromptClient } from "../functions/client.js";
import {
  getPromptBundleVersion,
  loadRemotePromptBundle,
} from "../functions/prompt-bundle.js";
import { buildRemoteCompileRequest } from "../functions/request.js";
import { renderLocalEnrichment } from "../functions/render-enrichment.js";
import {
  getPosseRemoteTimeoutMs,
  getPosseRemoteUrl,
} from "../functions/mode.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";

function joinPromptParts(parts = []) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function resolveFallbackReadBudget(policyFallbackReads, existingFallbackReads) {
  const localParsed = Number(existingFallbackReads);
  const hasLocal = Number.isFinite(localParsed);
  const localBudget = hasLocal ? Math.max(0, Math.floor(localParsed)) : null;
  const remoteParsed = Number(policyFallbackReads);
  if (!Number.isFinite(remoteParsed)) return localBudget;
  const remoteBudget = Math.max(0, Math.floor(remoteParsed));
  return localBudget == null ? remoteBudget : Math.min(localBudget, remoteBudget);
}

export class RemoteComposer {
  constructor({
    client = null,
    clientOptions = {},
    renderEnrichment = renderLocalEnrichment,
    reloadPromptBundle = loadRemotePromptBundle,
    now = () => Date.now(),
    warn = log.warn,
  } = {}) {
    this.client = client || new RemotePromptClient({
      baseUrl: getPosseRemoteUrl(),
      timeoutMs: getPosseRemoteTimeoutMs(),
      maxRetries: 0,
      ...clientOptions,
    });
    this.renderEnrichment = renderEnrichment;
    this.reloadPromptBundle = typeof reloadPromptBundle === "function" ? reloadPromptBundle : loadRemotePromptBundle;
    this.now = now;
    this.warn = typeof warn === "function" ? warn : () => {};
  }

  async composePrompt(packet, instructions, {
    providerName = null,
    maxPromptChars = null,
    maxContextChars = null,
  } = {}) {
    const request = buildRemoteCompileRequest(packet, instructions, {
      providerName,
      maxPromptChars,
      maxContextChars,
      includeFinalPrompt: true,
    });
    const started = this.now();
    const response = await this.client.compile(request);
    const latencyMs = Math.max(0, this.now() - started);
    const promptVersion = normalizePromptVersion(response?.prompt_version);
    let bundlePromptVersion = getPromptBundleVersion();
    let promptVersionSkew = promptVersionSkewMetadata(bundlePromptVersion, promptVersion);
    if (promptVersionSkew) {
      const previousBundlePromptVersion = bundlePromptVersion;
      const reloadedBundle = await this.reloadPromptBundle({ client: this.client, force: true });
      bundlePromptVersion = normalizePromptVersion(reloadedBundle?.prompt_version) || getPromptBundleVersion();
      promptVersionSkew = promptVersionSkewMetadata(bundlePromptVersion, promptVersion);
      if (promptVersionSkew) {
        packet.remote_prompt_version_skew = promptVersionSkew;
        this.warn("posse-remote", "Remote prompt compile version differs from active prompt bundle after reload", {
          previousBundlePromptVersion,
          bundlePromptVersion,
          compilePromptVersion: promptVersion,
          role: packet?.recipient || null,
          jobId: packet?.job_id || null,
          wiId: packet?.work_item_id || null,
        });
        const err = new Error("Remote prompt compile version differs from active prompt bundle after reload");
        err.code = "POSSE_REMOTE_PROMPT_VERSION_SKEW";
        err.skew = promptVersionSkew;
        throw err;
      }
      packet.remote_prompt_bundle_reloaded = {
        previous_prompt_version: previousBundlePromptVersion,
        prompt_version: bundlePromptVersion,
      };
      this.warn("posse-remote", "Reloaded active prompt bundle after remote prompt compile version changed", {
        previousBundlePromptVersion,
        bundlePromptVersion,
        compilePromptVersion: promptVersion,
        role: packet?.recipient || null,
        jobId: packet?.job_id || null,
        wiId: packet?.work_item_id || null,
      });
    }
    applyRemoteIssuanceToPacket(packet, response);
    const systemPrompt = String(response?.system_prompt || "").trim() || null;
    const stableContext = String(response?.stable_context || "").trim() || null;
    const remoteUserPrompt = String(response?.user_prompt || "").trim() || null;
    const skeleton = response?.final_prompt || joinPromptParts([
      systemPrompt,
      stableContext,
      remoteUserPrompt,
    ]);
    if (!skeleton) throw new Error("remote prompt compile returned an empty prompt");
    // The enrichment cwd is the local file-read sandbox root. It must come
    // from the local packet, never the remote response — a compromised remote
    // could otherwise point cwd at an arbitrary directory and have its files
    // inlined into the provider prompt.
    const enrichment = this.renderEnrichment(response?.handoff, {
      cwd: packet?.cwd || process.cwd(),
    });
    const prompt = joinPromptParts([skeleton, enrichment]);
    const userPrompt = joinPromptParts([remoteUserPrompt || skeleton, enrichment]);
    const promptCap = Number(maxPromptChars);
    if (Number.isFinite(promptCap) && promptCap > 0 && prompt.length > promptCap) {
      const err = new Error(`remote prompt plus local enrichment exceeded max prompt chars (${prompt.length} > ${promptCap})`);
      err.code = "POSSE_PROMPT_TOO_LARGE";
      err.promptChars = prompt.length;
      err.maxPromptChars = promptCap;
      throw err;
    }
    const composed = {
      prompt,
      systemPrompt,
      stableContext,
      userPrompt,
      enrichment: enrichment || null,
      source: "remote",
      request,
      response,
      issuance: response?.issuance || null,
      latencyMs,
      metadata: {
        ...(response?.metadata || {}),
        prompt_version: promptVersion,
        ...(bundlePromptVersion ? { bundle_prompt_version: bundlePromptVersion } : {}),
        ...(promptVersionSkew ? { prompt_version_skew: promptVersionSkew } : {}),
        latency_ms: latencyMs,
      },
    };
    return composed;
  }
}

function applyRemoteIssuanceToPacket(packet, response) {
  if (!packet || !response) return;
  const issuance = response.issuance || null;
  if (issuance) {
    packet.remote_issuance = issuance;
    packet.remote_tool_surface = Array.isArray(issuance.tool_surface)
      ? issuance.tool_surface.slice()
      : [];
  }
  const policy = issuance?.tool_policy || response?.handoff?.tool_policy || null;
  if (policy) {
    const localPolicy = localPolicyCeiling(packet.tool_policy);
    packet.tool_policy = {
      allow_read: clampPolicyGrant(policy.allow_read, localPolicy, "allow_read"),
      allow_write: clampPolicyGrant(policy.allow_write, localPolicy, "allow_write"),
      allow_shell: clampPolicyGrant(policy.allow_shell, localPolicy, "allow_shell"),
    };
    packet.budgets = {
      ...(packet.budgets || {}),
      fallback_reads_remaining: resolveFallbackReadBudget(
        policy.fallback_reads,
        packet.budgets?.fallback_reads_remaining,
      ),
    };
  }
  if (packet.atlas && issuance?.atlas) {
    packet.atlas.remoteAgentSurface = Array.isArray(issuance.atlas.agent_surface)
      ? issuance.atlas.agent_surface.slice()
      : [];
    packet.atlas.remotePrefetchSurface = Array.isArray(issuance.atlas.prefetch_surface)
      ? issuance.atlas.prefetch_surface.slice()
      : [];
    packet.atlas.remoteInternalSurface = Array.isArray(issuance.atlas.internal_surface)
      ? issuance.atlas.internal_surface.slice()
      : [];
  }
}

function normalizePromptVersion(value) {
  const text = String(value || "").trim();
  return text || null;
}

function promptVersionSkewMetadata(bundlePromptVersion, compilePromptVersion) {
  if (!bundlePromptVersion || !compilePromptVersion || bundlePromptVersion === compilePromptVersion) return null;
  return {
    bundle_prompt_version: bundlePromptVersion,
    compile_prompt_version: compilePromptVersion,
  };
}

function localPolicyCeiling(policy) {
  if (!policy || typeof policy !== "object") return null;
  return policy;
}

function clampPolicyGrant(remoteGrant, localPolicy, key) {
  if (!remoteGrant) return false;
  if (!localPolicy || localPolicy[key] == null) return true;
  return !!localPolicy[key];
}

let defaultComposer = null;

export function getDefaultRemoteComposer() {
  if (!defaultComposer) defaultComposer = new RemoteComposer();
  return defaultComposer;
}

export function resetDefaultRemoteComposerForTest() {
  defaultComposer = null;
}
