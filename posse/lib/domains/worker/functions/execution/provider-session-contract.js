import crypto from "node:crypto";
import path from "node:path";
import { usesResearcherReportOnlyHandoff } from "../../../../catalog/handoff.js";
import { getAgentHandoffToolSchemaForRole } from "../../../../catalog/native-tools.js";
import { narrowProviderOptionsToRemoteIssuance } from "../../../../shared/tools/functions/issued-tool-policy.js";
import { toolSchemaTelemetry } from "../../../../shared/tools/functions/tool-schema-telemetry.js";
import { resolveAtlasResearcherSchemaDiet } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { getProvider } from "../../../providers/functions/provider.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";
import { isRecyclableLane } from "../../../session/functions/keys.js";

export function agentHandoffToolSchemaTelemetry(
  role,
  compactCompletion = false,
  compactV3 = false,
  compactV4 = false,
  requireResearcherCoverage = false,
) {
  const schema = getAgentHandoffToolSchemaForRole(role, {
    compactCompletion,
    compactV3,
    compactV4,
    requireResearcherCoverage,
  });
  return toolSchemaTelemetry(schema);
}

function sortedUniqueStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  )].sort();
}

export function agentGateSurfaceFingerprint(options = {}) {
  const issued = options?._remoteIssuedPolicy;
  if (issued?.valid !== true) return "unissued";
  return crypto.createHash("sha256").update(JSON.stringify({
    tools: sortedUniqueStrings(issued.toolAllowlist?.tools),
    atlas: sortedUniqueStrings(issued.toolAllowlist?.atlas),
    projectDbCapability: String(issued.projectDbCapability || "none"),
    toolPolicy: {
      allowRead: issued.toolPolicy?.allow_read === true,
      allowWrite: issued.toolPolicy?.allow_write === true,
      allowShell: issued.toolPolicy?.allow_shell === true,
      allowTests: issued.toolPolicy?.allow_tests === true,
      fallbackReads: Number(issued.toolPolicy?.fallback_reads) || 0,
    },
    coordination: {
      agentHandoffV1: issued.coordination?.agentHandoffV1 === true,
      agentHandoffCompactV1: issued.coordination?.agentHandoffCompactV1 === true,
      agentHandoffCompactV2: issued.coordination?.agentHandoffCompactV2 === true,
      agentHandoffCompactV3: issued.coordination?.agentHandoffCompactV3 === true,
      subAgentV1: issued.coordination?.subAgentV1 === true,
      subAgentNextInputV1: issued.coordination?.subAgentNextInputV1 === true,
      dispatchAgentV1: issued.coordination?.dispatchAgentV1 === true,
      researchInvestigationV1: issued.coordination?.researchInvestigationV1 === true,
      webResearchHandoffV1: issued.coordination?.webResearchHandoffV1 === true,
      finalReviewV1: issued.coordination?.finalReviewV1 === true,
    },
    researcherSchemaDiet: String(options?.role || "").trim().toLowerCase() === "researcher"
      && resolveAtlasResearcherSchemaDiet(),
  })).digest("hex");
}

export function issuedAtlasAvailable(options = {}) {
  if (options?._subAgentChild === true) return false;
  const issued = options?._remoteIssuedPolicy;
  if (issued?.valid === true) return (issued.toolAllowlist?.atlas || []).length > 0;
  return options.disableAtlas !== true && options.atlasConfig?.enabled !== false;
}

export function sessionContractFingerprint(options = {}, providerName = "") {
  const effective = narrowProviderOptionsToRemoteIssuance(options);
  const coordination = effective?._remoteIssuedPolicy?.coordination || {};
  const researcherReportOnly = String(effective.role || "").trim().toLowerCase() === "researcher"
    && coordination.agentHandoffCompactV3 === true
    && usesResearcherReportOnlyHandoff(
      effective.promptProfile || effective.sessionPacket?.prompt_profile,
    );
  const schema = agentHandoffToolSchemaTelemetry(
    effective.role,
    coordination.agentHandoffCompactV1 === true,
    coordination.agentHandoffCompactV3 === true,
    researcherReportOnly,
  );
  const packet = effective.sessionPacket || {};
  const remoteSystemPrompt = String(effective.remoteSystemPrompt || "");
  const promptVersion = String(
    packet?.remote_prompt_metadata?.prompt_version
    || packet?.remote_prompt_response?.prompt_version
    || packet?.posse_remote?.metadata?.prompt_version
    || "",
  );
  return crypto.createHash("sha256").update(JSON.stringify({
    provider: String(providerName || "").trim().toLowerCase(),
    role: String(effective.role || "").trim().toLowerCase(),
    disableSystemTools: effective.disableSystemTools === true,
    promptVersion,
    remoteSystemPromptSha256: remoteSystemPrompt
      ? crypto.createHash("sha256").update(remoteSystemPrompt).digest("hex")
      : "",
    agentHandoffSchemaSha256: schema.sha256,
    compactV1: coordination.agentHandoffCompactV1 === true,
    compactV2: coordination.agentHandoffCompactV2 === true,
    compactV3: coordination.agentHandoffCompactV3 === true,
    researcherReportOnly,
    agentGateSurfaceSha256: agentGateSurfaceFingerprint(effective),
  })).digest("hex");
}

function codexReuseContractAllowsScope(opts = {}) {
  const root = path.resolve(opts.cwd || opts.projectDir || process.cwd());
  const scopedPaths = [
    ...(Array.isArray(opts.scopedFiles) ? opts.scopedFiles : []),
    ...(Array.isArray(opts.createFiles) ? opts.createFiles : []),
    ...(Array.isArray(opts.createRoots) ? opts.createRoots : []),
    ...(Array.isArray(opts.deleteFiles) ? opts.deleteFiles : []),
  ];
  for (const entry of scopedPaths) {
    if (!entry) continue;
    const target = path.isAbsolute(String(entry))
      ? path.resolve(String(entry))
      : path.resolve(root, String(entry));
    if (!isInsideRoot(target, root)) return false;
  }
  return true;
}

export function isSessionReuseCandidate({ providerName, opts, job_id, work_item_id }) {
  const provider = String(providerName || "").toLowerCase();
  if (!provider) return false;
  if (opts?._subAgentChild === true) return false;
  if (opts?._webResearchChild === true || opts?._researchChild === true) return false;
  // Provider self-declares session-resume support via the capabilities flag
  // on its module. Replaces a hardcoded ["openai","claude","codex"] whitelist
  // so a new provider that supports resume just sets capabilities.sessionResume.
  let supportsResume = false;
  try {
    const providerInstance = getProvider(null, provider);
    supportsResume = !!providerInstance?.hasCapability?.("sessionResume");
  } catch {
    supportsResume = false;
  }
  if (!supportsResume) return false;
  if (job_id == null || work_item_id == null) return false;
  if (opts?._fallbackAttempted) return false;
  if (provider === "codex" && !codexReuseContractAllowsScope(opts)) return false;
  return isRecyclableLane(opts?.role);
}
