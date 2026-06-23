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

function isAtlasSummaryBlock(value) {
  const text = String(value || "");
  return /(?:^|\n)===\s*ATLAS/i.test(text)
    || /\bATLASv2 CONTEXT\b/i.test(text)
    || /\bATLAS ASSESSMENT BASELINE\b/i.test(text)
    || /\bATLAS RESEARCH PREFETCH\b/i.test(text);
}

function isPlaceholderAtlasFrontierLine(line) {
  const text = String(line || "").replace(/^\s*[-*]\s*/, "").trim().toLowerCase();
  return !text || text === "unknown" || text === "(unknown)";
}

function sanitizeAtlasSummary(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*Top frontier hints:\s*$/i.test(line)) {
      const kept = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!/^\s*[-*]\s+/.test(next) && next.trim() !== "") break;
        if (next.trim() !== "" && !isPlaceholderAtlasFrontierLine(next)) kept.push(next);
        j += 1;
      }
      if (kept.length > 0) {
        out.push(line);
        out.push(...kept);
      }
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() || null;
}

function dedupeAtlasSummaryFromInstructions(instructions, rawAtlasSummary, sanitizedAtlasSummary) {
  let text = String(instructions || "");
  const candidates = [String(rawAtlasSummary || "").trim(), sanitizedAtlasSummary]
    .filter((candidate, index, values) =>
      candidate
      && candidate.length > 80
      && isAtlasSummaryBlock(candidate)
      && values.indexOf(candidate) === index
    )
    .sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    if (text.includes(candidate)) {
      text = text.split(candidate).join("");
    }
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function assessorShellPolicyHint(role, packet = {}) {
  if (String(role || "").toLowerCase() !== "assessor") return null;
  if (packet?.tool_policy?.allow_shell !== true && packet?.capabilities?.tools?.shell !== true) return null;
  return "Assessor shell policy: read-only bash is allowed for inspection/verification only. Use run_scoped_checks for lint/typecheck, including PHP syntax checks; do not run php -l through bash.";
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

function memoryPrefetchForRemote(packet = {}) {
  const insights = Array.isArray(packet?.run_insights) ? packet.run_insights : [];
  const memorySurface = packet?.memory_surface || {};
  const surfaceCount = (Array.isArray(memorySurface.symbols) ? memorySurface.symbols.length : 0)
    + (Array.isArray(memorySurface.files) ? memorySurface.files.length : 0);
  const legacyCount = insights.filter((item) =>
    item?.surfaced_memory === true
    || item?.insight_type === "atlas_memory"
    || String(item?.source || "").startsWith("memory:")
  ).length;
  const notice = packet?.memory_prefetch_context || null;
  const count = surfaceCount || legacyCount;
  if (count <= 0 && !notice) return null;
  return {
    supplied: true,
    origin: "handoff_memory_prefetch",
    action: "memory.surface",
    count,
    notice: _capInsightText(notice || "ATLAS memory anchor presence was prefetched during handoff; call memory.get only for anchors you will rely on."),
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
  const atlasSummary = sanitizeAtlasSummary(packet?.atlas?.summary);
  const requestInstructions = dedupeAtlasSummaryFromInstructions(instructions, packet?.atlas?.summary, atlasSummary);
  const shellPolicyHint = assessorShellPolicyHint(role, packet);
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
    instructions: requestInstructions,
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
      atlas_summary: atlasSummary,
      step0_context: packet?.step0_context || null,
      memory_prefetch: memoryPrefetchForRemote(packet),
      memory_surface: packet?.memory_surface || null,
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
      ...(shellPolicyHint ? { shell_policy_hint: shellPolicyHint } : {}),
    },
  };
}
