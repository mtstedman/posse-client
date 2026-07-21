import { RemotePromptClient } from "./RemotePromptClient.js";
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
import { getSetting } from "../../queue/functions/settings.js";
import { getWorkItem } from "../../queue/functions/index.js";
import { atlasMemoryEnabled } from "../../../shared/policies/functions/memory-mode.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import {
  estimateTokensFromChars,
  resolveContextCompactionConfig,
} from "../../settings/functions/context-compaction.js";
import { normalizeRemoteIssuedPolicy } from "../../../shared/tools/functions/issued-tool-policy.js";

const DEFAULT_LOCAL_ENRICHMENT_ENABLED = false;

function joinPromptParts(parts = []) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function withoutRemoteMemoryContract(value) {
  if (typeof value !== "string" || !value) return value;
  return value
    .replace(
      /\n={20,}\nMEMORY CURATION\n={20,}\n[\s\S]*?(?=\n={20,}\nROLE BOUNDARIES)/u,
      "",
    )
    .replace(
      /\n\s*"memories"\s*:\s*\[[\s\S]*?\n\s*"planner_file_priorities"\s*:/u,
      '\n  "planner_file_priorities":',
    )
    .replace(
      /\n {2}- memories: REQUIRED array[\s\S]*?(?=\n {2}- planner_file_priorities:)/u,
      "",
    );
}

function withoutRemoteMemoryContractFields(response) {
  if (!response || typeof response !== "object") return response;
  const out = { ...response };
  for (const field of ["system_prompt", "stable_context", "user_prompt", "final_prompt"]) {
    if (typeof out[field] === "string") out[field] = withoutRemoteMemoryContract(out[field]);
  }
  return out;
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
    readSetting = getSetting,
    readWorkItem = getWorkItem,
    now = () => Date.now(),
    warn = log.warn,
    enableLocalEnrichment = DEFAULT_LOCAL_ENRICHMENT_ENABLED,
  } = {}) {
    this.client = client || new RemotePromptClient({
      baseUrl: getPosseRemoteUrl(),
      timeoutMs: getPosseRemoteTimeoutMs(),
      maxRetries: 0,
      ...clientOptions,
    });
    this.renderEnrichment = renderEnrichment;
    this.reloadPromptBundle = typeof reloadPromptBundle === "function" ? reloadPromptBundle : loadRemotePromptBundle;
    this.readSetting = typeof readSetting === "function" ? readSetting : getSetting;
    this.readWorkItem = typeof readWorkItem === "function" ? readWorkItem : getWorkItem;
    this.now = now;
    this.warn = typeof warn === "function" ? warn : () => {};
    this.enableLocalEnrichment = enableLocalEnrichment === true;
  }

  async composePrompt(packet, instructions, {
    providerName = null,
    maxPromptChars = null,
    maxContextChars = null,
  } = {}) {
    const localPolicyBeforeRemote = localPolicyCeiling(packet?.tool_policy);
    const request = buildRemoteCompileRequest(packet, instructions, {
      providerName,
      maxPromptChars,
      maxContextChars,
      includeFinalPrompt: true,
    });
    const started = this.now();
    const compiledResponse = await this.client.compile(request);
    const response = atlasMemoryEnabled() && request?.options?.memory_mode !== "off"
      ? compiledResponse : withoutRemoteMemoryContractFields(compiledResponse);
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
    let skeleton = response?.final_prompt || joinPromptParts([
      systemPrompt,
      stableContext,
      remoteUserPrompt,
    ]);
    if (!skeleton) throw new Error("remote prompt compile returned an empty prompt");
    const localPolicyOverlay = renderLocalPolicyOverlay(packet, {
      localPolicy: packet?.tool_policy,
    });
    // The enrichment cwd is the local file-read sandbox root. It must come
    // from the local packet, never the remote response — a compromised remote
    // could otherwise point cwd at an arbitrary directory and have its files
    // inlined into the provider prompt.
    const enrichment = this.enableLocalEnrichment
      ? this.renderEnrichment(response?.handoff, {
        cwd: packet?.cwd || process.cwd(),
      })
      : "";
    const prompt = joinPromptParts([skeleton, localPolicyOverlay, enrichment]);
    const userPrompt = joinPromptParts([remoteUserPrompt || skeleton, localPolicyOverlay, enrichment]);
    const promptCap = Number(maxPromptChars);
    if (Number.isFinite(promptCap) && promptCap > 0 && prompt.length > promptCap) {
      const err = new Error(`remote prompt exceeded max prompt chars (${prompt.length} > ${promptCap})`);
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
      issuance: packet?.remote_issuance || null,
      latencyMs,
      localEnrichmentEnabled: this.enableLocalEnrichment,
      metadata: {
        ...(response?.metadata || {}),
        prompt_version: promptVersion,
        ...(bundlePromptVersion ? { bundle_prompt_version: bundlePromptVersion } : {}),
        ...(promptVersionSkew ? { prompt_version_skew: promptVersionSkew } : {}),
        local_enrichment_enabled: this.enableLocalEnrichment,
        latency_ms: latencyMs,
      },
    };
    recordPromptSectionAccounting(packet, composed, {
      readSetting: this.readSetting,
      readWorkItem: this.readWorkItem,
    });
    return composed;
  }
}

function sectionLabel(section, index) {
  if (!section || typeof section !== "object") return `section_${index + 1}`;
  return String(
    section.label
    || section.name
    || section.id
    || section.key
    || section.type
    || `section_${index + 1}`,
  );
}

function sectionCharCount(section) {
  if (!section || typeof section !== "object") return 0;
  const candidates = [
    section.char_count,
    section.charCount,
    section.chars,
    section.length,
    section.size_chars,
    section.sizeChars,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }
  const tokenCount = Number(section.token_count ?? section.tokenCount ?? section.tokens);
  return Number.isFinite(tokenCount) && tokenCount > 0 ? Math.floor(tokenCount * 4) : 0;
}

function promptSectionsForPnl(composed) {
  const metadataSections = Array.isArray(composed?.metadata?.sections) ? composed.metadata.sections : [];
  if (metadataSections.length > 0) {
    return metadataSections.map((section, index) => ({
      label: sectionLabel(section, index),
      chars: sectionCharCount(section),
    }));
  }
  return [
    { label: "system_prompt", chars: composed?.systemPrompt?.length || 0 },
    { label: "stable_context", chars: composed?.stableContext?.length || 0 },
    { label: "user_prompt", chars: composed?.userPrompt?.length || 0 },
    { label: "local_enrichment", chars: composed?.enrichment?.length || 0 },
  ];
}

function isPinnedExactSection(label) {
  return /(?:^|[^a-z0-9])(system|role|contract|policy|tool|scope|current[_ -]?task|operator|nudge|approval)(?:$|[^a-z0-9])/i
    .test(String(label || ""));
}

function recordRollingContextShadowPnl(packet, composed, { readSetting = getSetting, readWorkItem = getWorkItem } = {}) {
  const config = resolveContextCompactionConfig({
    readSetting,
    readWorkItem,
    workItemId: packet?.work_item_id ?? null,
  });
  if (config.mode === "off") return;
  const candidateMinTokens = Math.max(1000, Math.min(8000, Math.floor(config.triggerInputTokens / 4)));
  const sections = promptSectionsForPnl(composed)
    .map((section) => ({
      ...section,
      tokens: estimateTokensFromChars(section.chars),
      pinned_exact: isPinnedExactSection(section.label),
    }))
    .filter((section) => section.tokens > 0);
  const candidates = sections.filter((section) => !section.pinned_exact && section.tokens >= candidateMinTokens);
  if (candidates.length === 0) return;
  const sourceTokens = candidates.reduce((sum, section) => sum + section.tokens, 0);
  const targetTokens = Math.min(
    config.recentTargetTokens,
    Math.max(1000, Math.ceil(sourceTokens * 0.25)),
  );
  const grossSavedTokens = Math.max(0, sourceTokens - targetTokens);
  if (grossSavedTokens <= 0) return;
  const summarizerCostTokens = sourceTokens + targetTokens;
  const paybackCalls = Math.ceil(summarizerCostTokens / grossSavedTokens);
  recordObservation({
    work_item_id: packet?.work_item_id ?? null,
    job_id: packet?.job_id ?? null,
    observation_type: "context.rollup.shadow_pnl",
    summary: `Context rollup shadow P&L: ~${grossSavedTokens} gross token(s) saved, payback ${paybackCalls} call(s)`,
    detail: {
      mode: config.mode,
      estimate_method: "chars_div4_section_shadow",
      total_prompt_chars: composed?.prompt?.length || 0,
      source_tokens: sourceTokens,
      target_tokens: targetTokens,
      gross_saved_tokens: grossSavedTokens,
      summarizer_cost_tokens: summarizerCostTokens,
      payback_calls: paybackCalls,
      candidate_min_tokens: candidateMinTokens,
      thresholds: {
        pressure_input_tokens: config.triggerInputTokens,
        recent_target_tokens: config.recentTargetTokens,
      },
      config_source: config.source || null,
      candidate_sections: candidates.map((section) => ({
        label: section.label,
        chars: section.chars,
        tokens: section.tokens,
      })),
      pinned_exact_sections: sections
        .filter((section) => section.pinned_exact)
        .map((section) => ({ label: section.label, chars: section.chars, tokens: section.tokens })),
    },
  });
}

// Operator-facing accounting of what the compiled prompt cost per section.
// Telemetry only — nothing here is rendered into the agent prompt.
function recordPromptSectionAccounting(packet, composed, { readSetting = getSetting, readWorkItem = getWorkItem } = {}) {
  try {
    const metadata = composed?.metadata || {};
    const droppedCount = Array.isArray(metadata.sections_dropped) ? metadata.sections_dropped.length : 0;
    recordObservation({
      work_item_id: packet?.work_item_id ?? null,
      job_id: packet?.job_id ?? null,
      observation_type: "prompt.section.accounting",
      summary: `Prompt compiled: ${composed.prompt.length} chars`
        + (droppedCount > 0 ? `, ${droppedCount} section(s) dropped` : "")
        + (packet?.atlas_render_meta?.trim_level > 0 ? `, atlas trim level ${packet.atlas_render_meta.trim_level}` : ""),
      detail: {
        total_chars: composed.prompt.length,
        system_prompt_chars: composed.systemPrompt?.length || 0,
        stable_context_chars: composed.stableContext?.length || 0,
        user_prompt_chars: composed.userPrompt?.length || 0,
        enrichment_chars: composed.enrichment?.length || 0,
        sections: Array.isArray(metadata.sections) ? metadata.sections : null,
        sections_dropped: Array.isArray(metadata.sections_dropped) ? metadata.sections_dropped : [],
        atlas_render: packet?.atlas_render_meta || null,
      },
    });
    recordRollingContextShadowPnl(packet, composed, { readSetting, readWorkItem });
  } catch { /* accounting must never break compose */ }
}

function applyRemoteIssuanceToPacket(packet, response) {
  if (!packet || !response) return;
  const issuance = response.issuance || null;
  const localPolicy = localPolicyCeiling(packet.tool_policy);
  const issued = normalizeRemoteIssuedPolicy(issuance, {
    expectedRole: packet.recipient || packet.job_type,
  });
  const localHandoffEnabled = packet?.agent_coordination?.agent_handoff_v1 === true;
  const handoffEnabled = issued.valid
    && localHandoffEnabled
    && issued.coordination?.agentHandoffV1 === true;
  const localSubAgentEnabled = packet?.agent_coordination?.sub_agent_v1 === true;
  const subAgentEnabled = issued.valid
    && handoffEnabled
    && localSubAgentEnabled
    && issued.coordination?.subAgentV1 === true;
  const subAgentNextInputEnabled = subAgentEnabled
    && issued.coordination?.subAgentNextInputV1 === true;
  const effectiveToolSurface = issued.toolSurface.filter(
    (name) => (name !== "tools.agent_handoff" || handoffEnabled)
      && (name !== "tools.sub_agent" || subAgentEnabled),
  );
  packet.remote_issuance = {
    ...(issuance && typeof issuance === "object" ? issuance : {}),
    source: issued.valid ? "posse-remote" : "invalid",
    role: issued.role,
    provider: issued.provider,
    tool_policy: { ...issued.toolPolicy },
    tool_surface: effectiveToolSurface.slice(),
    web_access: { ...issued.webAccess },
    project_db_capability: issued.projectDbCapability,
    atlas: {
      ...(issuance?.atlas && typeof issuance.atlas === "object" ? issuance.atlas : {}),
      available: issued.toolAllowlist.atlas.length > 0,
      agent_surface: issued.toolAllowlist.atlas.map((name) => `atlas.${name}`),
      internal_surface: [],
    },
    coordination: {
      agent_handoff_v1: handoffEnabled,
      sub_agent_v1: subAgentEnabled,
      sub_agent_next_input_v1: subAgentNextInputEnabled,
      status: "experimental",
    },
  };
  packet.remote_tool_surface = effectiveToolSurface.slice();
  packet.agent_coordination = {
    ...(packet.agent_coordination || {}),
    agent_handoff_v1: handoffEnabled,
    sub_agent_v1: subAgentEnabled,
    sub_agent_next_input_v1: subAgentNextInputEnabled,
    remote_acknowledged: issued.coordination?.agentHandoffV1 === true,
    sub_agent_remote_acknowledged: issued.coordination?.subAgentV1 === true,
    sub_agent_next_input_remote_acknowledged: issued.coordination?.subAgentNextInputV1 === true,
  };
  const policy = issued.toolPolicy;
  packet.tool_policy = {
    allow_read: clampPolicyGrant(policy.allow_read, localPolicy, "allow_read"),
    allow_write: clampPolicyGrant(policy.allow_write, localPolicy, "allow_write"),
    allow_shell: clampPolicyGrant(policy.allow_shell, localPolicy, "allow_shell"),
    allow_tests: clampPolicyGrant(policy.allow_tests, localPolicy, "allow_tests"),
  };
  if (issued.valid) {
    packet.budgets = {
      ...(packet.budgets || {}),
      fallback_reads_remaining: resolveFallbackReadBudget(
        policy.fallback_reads,
        packet.budgets?.fallback_reads_remaining,
      ),
    };
  }
  if (packet.atlas) {
    packet.atlas.remoteAgentSurface = issued.toolAllowlist.atlas.map((name) => `atlas.${name}`);
    packet.atlas.remotePrefetchSurface = Array.isArray(issuance?.atlas?.prefetch_surface)
      ? issuance.atlas.prefetch_surface.filter((entry) => !issued.toolSurface.includes(entry)).slice()
      : [];
    packet.atlas.remoteInternalSurface = [];
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

function shouldRenderAssessorReadOnlyShell(packet, localPolicy) {
  return String(packet?.recipient || packet?.job_type || "").toLowerCase() === "assessor"
    && localPolicy?.allow_shell === true
    && localPolicy?.allow_write === false;
}

function renderLocalPolicyOverlay(packet, { localPolicy = null } = {}) {
  if (!shouldRenderAssessorReadOnlyShell(packet, localPolicy || packet?.tool_policy)) return "";
  return [
    "LOCAL EXECUTION POLICY NOTE:",
    "- Assessor shell policy: read-only bash is allowed for inspection and verification commands only.",
    "- Use run_scoped_checks for lint/typecheck, including PHP syntax checks; do not run php -l or php --syntax-check through bash.",
    "- Assessors have no write permission. Bash must not modify files.",
  ].join("\n");
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
