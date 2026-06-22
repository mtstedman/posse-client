import { RemotePromptClient } from "../classes/RemotePromptClient.js";
import { getPosseRemoteTimeoutMs, getPosseRemoteUrl } from "./mode.js";
import {
  loadRemotePromptBundle,
  SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION,
} from "./prompt-bundle.js";
import { buildRemoteCompileRequest } from "./request.js";

const PROBE_FILE = "src/remote-readiness-probe.js";
const RAW_SOURCE_SENTINEL = "POSSE_REMOTE_READINESS_RAW_SOURCE_SENTINEL";
const REQUIRED_ROLE_CONTRACTS = Object.freeze({
  researcher: Object.freeze(["researcher-output"]),
  planner: Object.freeze(["rule-priority", "file-scope", "task-modes"]),
  dev: Object.freeze(["dev-log"]),
  assessor: Object.freeze(["rule-priority", "file-scope", "task-modes"]),
  preflight: Object.freeze([]),
});

function probePacket({ cwd = process.cwd(), providerName = "claude" } = {}) {
  return {
    recipient: "dev",
    job_type: "dev",
    work_item_id: 0,
    job_id: 0,
    title: "Remote prompt compiler readiness probe",
    cwd,
    model_tier: "standard",
    reasoning_effort: "medium",
    governance_tier: "production",
    execution_provider: providerName,
    attempt: {
      count: 2,
      max: 3,
      last_error: "Previous remote readiness probe failed.",
      escalated: true,
    },
    files_to_modify: [PROBE_FILE],
    files_to_create: ["src/remote-readiness-created.js"],
    files_to_delete: [],
    create_roots: ["src/generated"],
    related_files: [PROBE_FILE],
    related_files_content: {
      [PROBE_FILE]: RAW_SOURCE_SENTINEL,
    },
    success_criteria: ["Remote readiness probe includes success criteria"],
    test_command: "npm test -- --remote-readiness",
    risk: { mutating: true, assessable: true },
    tool_policy: { allow_read: true, allow_write: true, allow_shell: true },
    atlas: {
      active: true,
      tools: ["context", "symbol.search"],
    },
    project_context: "Remote readiness project summary.",
    step0_context: "Remote readiness previous-run context.",
    run_insights: [{
      insight_type: "note",
      insight_kind: "readiness",
      confidence: "high",
      summary: "Remote readiness historical insight.",
    }],
    skills: [],
    requested_skills: [],
  };
}

function addSyntheticRawSourceProbe(request) {
  const snippets = request.context?.file_snippets;
  if (!Array.isArray(snippets)) return;
  const existing = snippets.find((snippet) => snippet?.path === PROBE_FILE);
  if (existing) {
    existing.kind = existing.kind || "read_only";
    existing.content = RAW_SOURCE_SENTINEL;
  } else {
    snippets.push({
      path: PROBE_FILE,
      kind: "read_only",
      content: RAW_SOURCE_SENTINEL,
    });
  }
}

function hasPath(entries = [], target) {
  return Array.isArray(entries) && entries.some((entry) => entry === target || entry?.path === target);
}

function pushMissing(errors, label, value) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} is missing`);
}

function requireContains(errors, label, text, needle) {
  if (!String(text || "").includes(needle)) errors.push(`${label} missing ${JSON.stringify(needle)}`);
}

export function validateRemoteCompileReadinessResponse(response) {
  const errors = [];
  pushMissing(errors, "prompt_version", response?.prompt_version);
  pushMissing(errors, "system_prompt", response?.system_prompt);
  pushMissing(errors, "stable_context", response?.stable_context);
  pushMissing(errors, "user_prompt", response?.user_prompt);
  pushMissing(errors, "final_prompt", response?.final_prompt);

  const systemPrompt = String(response?.system_prompt || "");
  const stableContext = String(response?.stable_context || "");
  const userPrompt = String(response?.user_prompt || "");
  const finalPrompt = String(response?.final_prompt || "");
  const combinedPrompt = [systemPrompt, stableContext, userPrompt, finalPrompt].join("\n\n");

  requireContains(errors, "system_prompt", systemPrompt, "ROLE CLASS: dev");
  requireContains(errors, "system_prompt", systemPrompt, "FILE SCOPE CONTRACT");
  requireContains(errors, "system_prompt", systemPrompt, "DEV LOG FORMAT");
  requireContains(errors, "stable_context", stableContext, "STABLE EXECUTION CONTEXT");
  requireContains(errors, "stable_context", stableContext, "source_policy: no_raw_source");
  requireContains(errors, "stable_context", stableContext, "enrichment_owner: local_client");
  requireContains(errors, "stable_context", stableContext, "tool_surface:");
  requireContains(errors, "stable_context", stableContext, "tool_policy:");
  requireContains(errors, "stable_context", stableContext, "files_to_modify:");
  requireContains(errors, "user_prompt", userPrompt, "INSTRUCTIONS (literal JSON string):");
  requireContains(errors, "user_prompt", userPrompt, "PREVIOUS ATTEMPT FAILED");
  requireContains(errors, "user_prompt", userPrompt, "SUCCESS CRITERIA (literal JSON string):");
  requireContains(errors, "user_prompt", userPrompt, "TEST COMMAND (literal JSON string):");
  requireContains(errors, "user_prompt", userPrompt, "GOVERNANCE TIER: PRODUCTION");
  requireContains(errors, "user_prompt", userPrompt, "CONTEXT FROM PREVIOUS RUNS");
  requireContains(errors, "user_prompt", userPrompt, "PROJECT SUMMARY (literal JSON string):");
  requireContains(errors, "user_prompt", userPrompt, "HISTORICAL INSIGHTS");

  if (combinedPrompt.includes(RAW_SOURCE_SENTINEL)) {
    errors.push("compiled prompt leaked synthetic raw source content");
  }

  const handoff = response?.handoff || {};
  if (handoff.source_policy !== "no_raw_source") errors.push("handoff.source_policy must be no_raw_source");
  if (handoff.enrichment_owner !== "local_client") errors.push("handoff.enrichment_owner must be local_client");
  if (handoff.enrichment_stage !== "before_provider_call") errors.push("handoff.enrichment_stage must be before_provider_call");
  if (!hasPath(handoff.files?.files_to_modify, PROBE_FILE)) errors.push("handoff.files.files_to_modify missing probe file");
  if (!hasPath(handoff.files?.read_only_context, PROBE_FILE)) errors.push("handoff.files.read_only_context missing probe file");
  if (!Array.isArray(handoff.instructions) || handoff.instructions.length === 0) {
    errors.push("handoff.instructions are missing");
  }

  const metadata = response?.metadata || {};
  if (metadata.resolved_role !== "dev") errors.push("metadata.resolved_role must be dev");
  if (!Number.isFinite(Number(metadata.prompt_chars)) || Number(metadata.prompt_chars) <= 0) {
    errors.push("metadata.prompt_chars must be positive");
  }
  if (!hasPath(metadata.raw_source_omitted_files, PROBE_FILE)) {
    errors.push("metadata.raw_source_omitted_files missing probe file");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function checkRemotePromptCompilerReadiness({
  client = null,
  baseUrl = getPosseRemoteUrl(),
  timeoutMs = getPosseRemoteTimeoutMs(),
  cwd = process.cwd(),
  providerName = "claude",
} = {}) {
  const promptClient = client || new RemotePromptClient({ baseUrl, timeoutMs });
  const request = buildRemoteCompileRequest(
    probePacket({ cwd, providerName }),
    "Remote compiler readiness probe instructions.",
    {
      providerName,
      maxPromptChars: 120000,
      maxContextChars: 60000,
      includeFinalPrompt: true,
    },
  );
  addSyntheticRawSourceProbe(request);
  const response = await promptClient.compile(request);
  const validation = validateRemoteCompileReadinessResponse(response);
  if (!validation.ok) {
    const err = new Error(`remote prompt compiler readiness failed: ${validation.errors.join("; ")}`);
    err.code = "POSSE_REMOTE_READINESS_FAILED";
    err.validation = validation;
    throw err;
  }
  return {
    ok: true,
    baseUrl,
    promptVersion: response.prompt_version || null,
    serviceUrl: response.service_url || null,
    response,
  };
}

export function validateRemotePromptBundleReadinessResponse(bundle) {
  const errors = [];
  if (!bundle?.prompt_version) errors.push("prompt_version is missing");
  if (!bundle?.schema_version) errors.push("schema_version is missing");
  else if (Number(bundle.schema_version) !== SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION) {
    errors.push(
      `schema_version mismatch: remote=${bundle.schema_version}, code=${SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION}`,
    );
  }

  const roles = bundle?.roles;
  for (const role of ["researcher", "planner", "dev", "assessor", "preflight"]) {
    if (!roles?.has?.(role)) errors.push(`role prompt missing: ${role}`);
  }

  const contracts = bundle?.contracts;
  for (const contract of ["rule-priority", "file-scope", "task-modes", "researcher-output"]) {
    if (!contracts?.has?.(contract)) errors.push(`contract missing: ${contract}`);
  }

  const roleContracts = bundle?.role_contracts;
  for (const [role, requiredContracts] of Object.entries(REQUIRED_ROLE_CONTRACTS)) {
    if (!roleContracts?.has?.(role)) {
      errors.push(`${role} role contract mapping missing`);
      continue;
    }
    const mappedContracts = roleContracts.get(role) || [];
    for (const contract of requiredContracts) {
      if (!mappedContracts.includes(contract)) {
        errors.push(`${role} role contract mapping missing ${contract}`);
      }
    }
    for (const contract of mappedContracts) {
      if (!contracts?.has?.(contract)) {
        errors.push(`${role} role contract mapping references missing contract ${contract}`);
      }
    }
  }

  const skills = Array.isArray(bundle?.skills) ? bundle.skills : [];
  if (skills.length === 0) errors.push("skills are missing");
  for (const skill of skills) {
    if (!skill.id) errors.push("skill id is missing");
    if (!String(skill.body || "").trim()) errors.push(`skill body is missing: ${skill.id || "(unknown)"}`);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function checkRemotePromptBundleReadiness({
  client = null,
  baseUrl = getPosseRemoteUrl(),
  timeoutMs = getPosseRemoteTimeoutMs(),
} = {}) {
  const bundle = await loadRemotePromptBundle({ client, baseUrl, timeoutMs, force: true });
  const validation = validateRemotePromptBundleReadinessResponse(bundle);
  if (!validation.ok) {
    const err = new Error(`remote prompt bundle readiness failed: ${validation.errors.join("; ")}`);
    err.code = "POSSE_REMOTE_BUNDLE_READINESS_FAILED";
    err.validation = validation;
    throw err;
  }
  return {
    ok: true,
    baseUrl,
    promptVersion: bundle.prompt_version || null,
    schemaVersion: bundle.schema_version || null,
    roles: bundle.roles?.size || 0,
    contracts: bundle.contracts?.size || 0,
    skills: bundle.skills?.length || 0,
  };
}
