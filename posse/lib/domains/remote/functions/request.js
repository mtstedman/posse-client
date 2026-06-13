function normalizedPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = normalizedPath(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function boolCapability(value, fallback = true) {
  return value == null ? fallback : !!value;
}

function nonNegativeInteger(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function capabilitiesFromPacket(packet = {}) {
  const explicit = packet?.capabilities || packet?.local_capabilities || {};
  const tools = explicit.tools || {};
  const atlas = packet?.atlas || {};
  const atlasExplicit = explicit.atlas || {};
  const atlasAvailable = atlasExplicit.available == null
    ? !!(atlas.active && !atlas.prefetchFailed)
    : !!atlasExplicit.available;
  const atlasMemoryCount = nonNegativeInteger(
    atlasExplicit.memory_count
    ?? atlasExplicit.memoryCount
    ?? atlasExplicit.memories
    ?? atlas.memoryStats?.memories
    ?? atlas.memory_count
    ?? atlas.memoryCount
    ?? atlas.memories,
  );
  const atlasCapabilities = {
    available: atlasAvailable,
    backend: atlasExplicit.backend || atlas.backend || atlas.atlasVersion || (atlasAvailable ? "v2" : null),
    transport: atlasExplicit.transport || atlas.transport || null,
  };
  if (atlasMemoryCount != null) atlasCapabilities.memory_count = atlasMemoryCount;

  return {
    tools: {
      read: boolCapability(tools.read, true),
      write: boolCapability(tools.write, true),
      shell: boolCapability(tools.shell, true),
      image_generation: boolCapability(
        tools.image_generation,
        !!(packet?.needs_image_generation || packet?.needsImageGeneration),
      ),
    },
    atlas: atlasCapabilities,
  };
}

export function __testCapabilitiesFromPacket(packet = {}) {
  return capabilitiesFromPacket(packet);
}

function readOnlyFileSnippets(packet = {}) {
  const paths = uniqueStrings([
    ...(packet.related_files || []),
    ...Object.keys(packet.related_files_content || {}),
  ]);
  return paths.map((filePath) => ({
    path: filePath,
    kind: "read_only",
  }));
}

// The remote renderer trims each insight field to ~240 chars anyway, so cap
// the wire payload to the same order of magnitude instead of shipping full
// detail/evidence bodies that can never reach the prompt.
const INSIGHT_TEXT_CAP = 600;
const INSIGHT_EVIDENCE_ITEMS = 3;
const INSIGHT_EVIDENCE_ITEM_CAP = 160;

function _capInsightText(value) {
  if (value == null) return null;
  const text = String(value);
  return text.length > INSIGHT_TEXT_CAP ? `${text.slice(0, INSIGHT_TEXT_CAP)}…` : text;
}

function _capInsightEvidence(evidence) {
  if (evidence == null) return null;
  let items = evidence;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { return _capInsightText(items); }
  }
  if (!Array.isArray(items)) return _capInsightText(String(evidence));
  return items
    .slice(0, INSIGHT_EVIDENCE_ITEMS)
    .map((item) => {
      const text = String(item ?? "");
      return text.length > INSIGHT_EVIDENCE_ITEM_CAP ? `${text.slice(0, INSIGHT_EVIDENCE_ITEM_CAP)}…` : text;
    });
}

function insightForRemote(item) {
  if (!item || typeof item !== "object") return String(item || "");
  return {
    insight_type: item.insight_type || item.type || null,
    insight_kind: item.insight_kind || item.kind || null,
    confidence: item.confidence || null,
    memory_id: item.memory_id || null,
    summary: _capInsightText(item.summary),
    action: _capInsightText(item.action),
    detail: _capInsightText(item.detail),
    evidence: _capInsightEvidence(item.evidence),
    why_surface: _capInsightText(item.why_surface),
    source: item.source || null,
  };
}

export function buildRemoteCompileRequest(packet, instructions, {
  providerName = null,
  maxPromptChars = null,
  maxContextChars = null,
  includeFinalPrompt = true,
} = {}) {
  const role = packet?.recipient || "dev";
  const provider = providerName || packet?.execution_provider || packet?.provider || "claude";
  const selectedSkills = Array.isArray(packet?.skills_attached)
    ? packet.skills_attached
    : (Array.isArray(packet?.skills) ? packet.skills : []);
  return {
    request_id: packet?.job_id != null ? `local-job-${packet.job_id}` : undefined,
    role,
    provider,
    job_type: packet?.job_type || role,
    governance_tier: packet?.governance_tier || "mvp",
    work_item: {
      id: packet?.work_item_id ?? null,
    },
    job: {
      id: packet?.job_id ?? null,
      title: packet?.title || "",
      job_type: packet?.job_type || null,
      model_tier: packet?.model_tier || null,
      reasoning_effort: packet?.reasoning_effort || null,
    },
    instructions: String(instructions || ""),
    attempt: {
      count: packet?.attempt?.count ?? 1,
      max: packet?.attempt?.max ?? 1,
      last_error: packet?.attempt?.last_error || null,
      escalated: !!packet?.attempt?.escalated,
    },
    scope: {
      cwd: packet?.cwd || null,
      files_to_modify: uniqueStrings(packet?.files_to_modify || []),
      files_to_create: uniqueStrings(packet?.files_to_create || []),
      files_to_delete: uniqueStrings(packet?.files_to_delete || []),
      create_roots: uniqueStrings(packet?.create_roots || []),
      success_criteria: Array.isArray(packet?.success_criteria) ? packet.success_criteria.map(String) : [],
      test_command: packet?.test_command || null,
    },
    context: {
      project_summary: packet?.project_context || null,
      atlas_summary: packet?.atlas?.summary || null,
      step0_context: packet?.step0_context || null,
      file_snippets: readOnlyFileSnippets(packet),
      insights: Array.isArray(packet?.run_insights) ? packet.run_insights.map(insightForRemote) : [],
    },
    capabilities: capabilitiesFromPacket(packet),
    skills: selectedSkills,
    requested_skills: Array.isArray(packet?.requested_skills) ? packet.requested_skills : [],
    limits: {
      max_prompt_chars: maxPromptChars,
      max_context_chars: maxContextChars,
    },
    options: {
      include_final_prompt: includeFinalPrompt,
      privacy_mode: "full_context",
      embed_extra: false,
    },
    extra: {
      local_prompt_contract: "remote_skeleton_local_enrichment",
    },
  };
}
