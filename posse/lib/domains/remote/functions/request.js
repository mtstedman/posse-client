import {
  HASH_REF_ALIAS_PATTERN,
  HASH_REF_LANES,
  normalizeHashRefAlias,
} from "../../../catalog/hash-store.js";
import { localModelProfile } from "../../../catalog/local-model.js";
import { atlasMemoryEnabled } from "../../../shared/policies/functions/memory-mode.js";

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

function narrowBoolCapability(value, ceiling = false) {
  return ceiling === true && value !== false;
}

function nonNegativeInteger(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function capabilitiesFromPacket(packet = {}, providerName = null) {
  const explicit = packet?.capabilities || packet?.local_capabilities || {};
  const tools = explicit.tools || {};
  const atlas = packet?.atlas || {};
  const atlasExplicit = explicit.atlas || {};
  const localAtlasAvailable = !!(atlas.active && !atlas.prefetchFailed);
  const atlasAvailable = localAtlasAvailable && atlasExplicit.available !== false;
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
  const role = String(packet?.recipient || packet?.job_type || "").trim().toLowerCase();
  const taskMode = String(
    packet?._raw_payload?.assessmentContext?.task_mode
    || packet?._raw_payload?.assessment_context?.task_mode
    || packet?._raw_payload?.task_mode
    || "",
  ).trim().toLowerCase();
  const localProjectDbCapability = taskMode === "db" && (role === "dev" || role === "fix")
    ? "write"
    : (taskMode === "db" && role === "assessor" ? "read" : "none");
  const assertedProjectDbCapability = String(tools.project_db || tools.projectDb || localProjectDbCapability).trim().toLowerCase();
  const projectDbRanks = { none: 0, read: 1, write: 2 };
  const projectDbCapability = (projectDbRanks[assertedProjectDbCapability] ?? 0) < projectDbRanks[localProjectDbCapability]
    ? assertedProjectDbCapability
    : localProjectDbCapability;
  const imageGenerationAvailable = !!(packet?.needs_image_generation || packet?.needsImageGeneration);

  const capabilities = {
    tools: {
      read: narrowBoolCapability(tools.read, packet?.tool_policy?.allow_read === true),
      write: narrowBoolCapability(tools.write, packet?.tool_policy?.allow_write === true),
      shell: narrowBoolCapability(tools.shell, packet?.tool_policy?.allow_shell === true),
      tests: narrowBoolCapability(tools.tests, packet?.tool_policy?.allow_tests === true),
      image_generation: narrowBoolCapability(tools.image_generation, imageGenerationAvailable),
      project_db: ["read", "write"].includes(projectDbCapability) ? projectDbCapability : "none",
    },
    atlas: atlasCapabilities,
    coordination: {
      agent_handoff_v1: packet?.agent_coordination?.agent_handoff_v1 === true,
      sub_agent_v1: false,
    },
  };
  const provider = String(providerName || packet?.execution_provider || packet?.provider || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  if (provider !== "posse-local") return capabilities;

  const localToolRole = ["planner", "dev", "artificer"].includes(role);
  const localWriteRole = ["dev", "artificer"].includes(role);
  return {
    tools: {
      read: localToolRole && capabilities.tools.read,
      write: localWriteRole && capabilities.tools.write,
      shell: false,
      tests: false,
      image_generation: false,
      project_db: "none",
    },
    atlas: {
      available: false,
      backend: null,
      transport: null,
    },
    coordination: {
      agent_handoff_v1: capabilities.coordination.agent_handoff_v1,
      sub_agent_v1: false,
    },
  };
}

export function __testCapabilitiesFromPacket(packet = {}, providerName = null) {
  return capabilitiesFromPacket(packet, providerName);
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

const MAX_HASH_REFS_PER_LANE = 24;
const MAX_HASH_WHY_CHARS = 180;
const MAX_HASH_DROPPED_REFS = 12;
const MAX_DEV_HANDOFF_FILES = 16;
const MAX_DEV_HANDOFF_SUMMARY_CHARS = 700;

function compactText(value, max = 220) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function compactDevHandoffPriority(value, fallbackRank) {
  const source = objectValue(value);
  if (!source) return null;
  const filePath = normalizedPath(compactText(source.path || source.file || source.file_path, 220));
  if (!filePath) return null;
  const rank = Number(source.rank);
  const out = {
    path: filePath,
    rank: Number.isFinite(rank) && rank > 0 ? Math.floor(rank) : fallbackRank,
  };
  const usefulness = compactText(source.usefulness, 60);
  const evidence = compactText(source.evidence, 60);
  const reason = compactText(source.reason || source.why, 180);
  if (usefulness && usefulness !== "unspecified") out.usefulness = usefulness;
  if (evidence && evidence !== "unspecified") out.evidence = evidence;
  if (reason) out.reason = reason;
  return out;
}

function compactDevHandoffForRemote(packet = {}) {
  const role = String(packet?.recipient || packet?.job_type || "").trim().toLowerCase();
  if (role !== "dev" && role !== "fix") return null;

  const brief = objectValue(packet?._raw_payload?.dev_brief)
    || objectValue(packet?.dev_brief);
  const briefSource = compactText(brief?.source || brief?.evidence_source, 40).toLowerCase();
  const atlasBacked = briefSource === "atlas";
  const writeScope = uniqueStrings([
    ...(packet?.files_to_modify || []),
    ...(packet?.files_to_create || []),
    ...(packet?.files_to_delete || []),
  ]);
  const keyFiles = uniqueStrings([
    ...(Array.isArray(brief?.key_files) ? brief.key_files : []),
    ...writeScope,
  ]).slice(0, MAX_DEV_HANDOFF_FILES);
  const keyFileSet = new Set(keyFiles);
  const relatedFiles = uniqueStrings([
    ...(Array.isArray(brief?.related_files) ? brief.related_files : []),
    ...(packet?.related_files || []),
  ]).filter((filePath) => !keyFileSet.has(filePath)).slice(0, MAX_DEV_HANDOFF_FILES);

  const priorities = [];
  const seenPriorities = new Set();
  for (const value of Array.isArray(brief?.planner_file_priorities) ? brief.planner_file_priorities : []) {
    const priority = compactDevHandoffPriority(value, priorities.length + 1);
    if (!priority || seenPriorities.has(priority.path)) continue;
    seenPriorities.add(priority.path);
    priorities.push(priority);
    if (priorities.length >= MAX_DEV_HANDOFF_FILES) break;
  }

  const summary = compactText(
    brief?.summary || brief?.synthesis || packet?.title || packet?._raw_payload?.title,
    MAX_DEV_HANDOFF_SUMMARY_CHARS,
  );
  return {
    source: atlasBacked ? "atlas" : "planner_scope",
    ...(summary ? { summary } : {}),
    ...(keyFiles.length > 0 ? { key_files: keyFiles } : {}),
    ...(relatedFiles.length > 0 ? { related_files: relatedFiles } : {}),
    ...(priorities.length > 0 ? { planner_file_priorities: priorities } : {}),
  };
}

export function __testCompactDevHandoffForRemote(packet = {}) {
  return compactDevHandoffForRemote(packet);
}

function normalizeRef(value) {
  const text = normalizeHashRefAlias(compactText(value, 80));
  return HASH_REF_ALIAS_PATTERN.test(text) ? text : "";
}

function compactHashPreviewSymbol(value) {
  const symbol = objectValue(value);
  if (!symbol) return null;
  const symbolId = compactText(symbol.symbolId || symbol.symbol_id || symbol.id || "", 90);
  const name = compactText(symbol.qualifiedName || symbol.qualified_name || symbol.name || symbol.symbolName || symbol.symbol_name || "", 160);
  if (!symbolId && !name) return null;
  const out = {};
  if (symbolId) out.symbolId = symbolId;
  if (name) out.name = name;
  if (symbol.qualifiedName || symbol.qualified_name) out.qualifiedName = compactText(symbol.qualifiedName || symbol.qualified_name, 180);
  if (symbol.kind) out.kind = compactText(symbol.kind, 60);
  if (symbol.lang) out.lang = compactText(symbol.lang, 40);
  const location = objectValue(symbol.location || symbol.loc || symbol);
  if (location) {
    const path = compactText(location.repo_rel_path || location.repoRelPath || location.path || location.file || "", 220);
    const startLine = Number(location.startLine ?? location.start_line ?? location.range_start_line);
    const endLine = Number(location.endLine ?? location.end_line ?? location.range_end_line);
    const loc = {};
    if (path) loc.path = path;
    if (Number.isFinite(startLine) && startLine > 0) loc.startLine = startLine;
    if (Number.isFinite(endLine) && endLine > 0) loc.endLine = endLine;
    if (Object.keys(loc).length > 0) out.location = loc;
  }
  if (Number.isFinite(Number(symbol.score))) out.score = Number(symbol.score);
  if (symbol.relevance) out.relevance = compactText(symbol.relevance, 40);
  return out;
}

function compactHashPreview(value) {
  const preview = objectValue(value);
  if (!preview) return null;
  const symbols = (Array.isArray(preview.symbols) ? preview.symbols : [])
    .map(compactHashPreviewSymbol)
    .filter(Boolean)
    .slice(0, 8);
  if (symbols.length === 0) return null;
  return {
    kind: "symbols",
    symbols,
    ...(Number.isFinite(Number(preview.total)) ? { total: Math.max(symbols.length, Number(preview.total)) } : {}),
    ...(preview.truncated === true ? { truncated: true } : {}),
  };
}

function compactHashRefEntry(entry) {
  const source = typeof entry === "string" ? { ref: entry } : objectValue(entry);
  if (!source) return null;
  const ref = normalizeRef(source.ref ?? source.hash ?? source.ref_hash);
  if (!ref) return null;
  const out = { ref };
  const why = compactText(source.why ?? source.reason ?? source.note, MAX_HASH_WHY_CHARS);
  const sourceRef = normalizeRef(source.source_ref ?? source.sourceRef);
  const objectType = compactText(source.object_type ?? source.objectType, 80);
  const entryKind = compactText(source.entry_kind ?? source.entryKind, 40);
  if (why) out.why = why;
  if (sourceRef) out.source_ref = sourceRef;
  if (objectType) out.object_type = objectType;
  if (entryKind) out.entry_kind = entryKind;
  if (Number.isFinite(Number(source.size_chars ?? source.sizeChars))) {
    out.size_chars = Math.max(0, Number(source.size_chars ?? source.sizeChars));
  }
  if (/^[0-9a-f]{64}$/i.test(String(source.content_hash ?? source.contentHash ?? ""))) {
    out.content_hash = String(source.content_hash ?? source.contentHash).toLowerCase();
  }
  const preview = compactHashPreview(source.preview);
  if (preview) out.preview = preview;
  if (source.unresolved === true) out.unresolved = true;
  if (source.error) out.error = compactText(source.error, 120);
  return out;
}

function compactHashRefDropped(entry) {
  const source = objectValue(entry);
  if (!source) return null;
  const lane = compactText(source.lane, 20);
  const ref = normalizeRef(source.ref);
  const reason = compactText(source.reason || source.error, 120);
  if (!lane && !ref && !reason) return null;
  return {
    ...(lane ? { lane } : {}),
    ...(ref ? { ref } : {}),
    ...(reason ? { reason } : {}),
  };
}

function compactHashRefPacketForRemote(packet = {}) {
  const sourcePacket = objectValue(packet?._raw_payload?.hash_ref_packet)
    || objectValue(packet?._raw_payload?.dev_brief?.hash_ref_packet)
    || objectValue(packet?.hash_ref_packet)
    || objectValue(packet?.dev_brief?.hash_ref_packet);
  if (!sourcePacket) return null;
  const source = compactText(sourcePacket.source || sourcePacket.evidence_source || "atlas", 40).toLowerCase();
  if (source !== "atlas") return null;
  const lanes = {};
  const seen = new Set();
  const duplicateDropped = [];
  const capDropped = [];
  const truncatedLanes = {};
  for (const lane of HASH_REF_LANES) {
    const entries = Array.isArray(sourcePacket?.lanes?.[lane])
      ? sourcePacket.lanes[lane]
      : (Array.isArray(sourcePacket?.[lane]) ? sourcePacket[lane] : []);
    lanes[lane] = [];
    let omittedCount = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const compact = compactHashRefEntry(entry);
      if (!compact) continue;
      if (seen.has(compact.ref)) {
        duplicateDropped.push({
          lane,
          ref: compact.ref,
          reason: "duplicate_ref",
        });
        continue;
      }
      if (lanes[lane].length >= MAX_HASH_REFS_PER_LANE) {
        omittedCount += 1;
        capDropped.push({
          lane,
          ref: compact.ref,
          reason: "lane_cap_truncated",
        });
        continue;
      }
      seen.add(compact.ref);
      lanes[lane].push(compact);
    }
    if (omittedCount > 0) truncatedLanes[lane] = omittedCount;
  }
  const refCount = HASH_REF_LANES.reduce((sum, lane) => sum + lanes[lane].length, 0);
  if (refCount === 0) return null;
  const dropped = [
    ...(Array.isArray(sourcePacket.dropped) ? sourcePacket.dropped : []),
    ...(Array.isArray(sourcePacket.upstream_dropped) ? sourcePacket.upstream_dropped : []),
    ...duplicateDropped,
    ...capDropped,
  ].map(compactHashRefDropped).filter(Boolean).slice(0, MAX_HASH_DROPPED_REFS);
  return {
    schema_version: Number.isFinite(Number(sourcePacket.schema_version)) ? Number(sourcePacket.schema_version) : 1,
    source,
    destination: compactText(sourcePacket.destination || "handoff", 40) || "handoff",
    render_mode: "compact_hash_ref_map",
    synthesis: compactText(sourcePacket.synthesis || sourcePacket.summary, 1200),
    lanes,
    ref_count: refCount,
    ...(dropped.length > 0 ? { dropped } : {}),
    ...(Object.keys(truncatedLanes).length > 0 ? { truncated_lanes: truncatedLanes } : {}),
    ...(Number.isFinite(Number(sourcePacket.reissued_count)) ? { reissued_count: Number(sourcePacket.reissued_count) } : {}),
    ...(Number.isFinite(Number(sourcePacket.missed_count)) ? { missed_count: Number(sourcePacket.missed_count) } : {}),
    ...(Array.isArray(sourcePacket.proof_expansions) && sourcePacket.proof_expansions.length > 0
      ? { omitted_proof_expansion_count: sourcePacket.proof_expansions.length }
      : {}),
  };
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

function databasePrefetchForRemote(packet = {}) {
  const dbContext = packet?.atlas_db_context;
  if (!dbContext?.ok) return null;
  const operations = dbContext.operations && typeof dbContext.operations === "object"
    ? dbContext.operations
    : {};
  const out = {
    db: dbContext.db || null,
  };
  const counts = {};
  for (const [operation, entry] of Object.entries(operations)) {
    const ref = entry?.ref || dbContext[operation];
    if (!ref) continue;
    out[operation] = ref;
    const callerCount = Number(entry?.callers ?? dbContext.counts?.[operation]);
    if (Number.isFinite(callerCount) && callerCount >= 0) counts[operation] = Math.floor(callerCount);
  }
  if (dbContext.telemetry && Number(dbContext.telemetry_count || 0) > 0) {
    out.telemetry = dbContext.telemetry;
    counts.telemetry = Number(dbContext.telemetry_count || 0);
  }
  if (Object.keys(out).length <= 1) return null;
  if (Object.keys(counts).length > 0) out.counts = counts;
  return out;
}

export function buildRemoteCompileRequest(packet, instructions, {
  providerName = null,
  maxPromptChars = null,
  maxContextChars = null,
  includeFinalPrompt = true,
} = {}) {
  const memoryEnabled = atlasMemoryEnabled() && packet?.memory_mode !== "off";
  const role = packet?.recipient || "dev";
  const provider = providerName || packet?.execution_provider || packet?.provider || "claude";
  const normalizedProvider = String(provider).trim().toLowerCase().replaceAll("_", "-");
  const normalizedPacketProvider = String(packet?.execution_provider || packet?.provider || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  const localProfile = normalizedProvider === "posse-local"
    ? localModelProfile(packet?.model_name || null, packet?.model_tier || "standard")
    : null;
  const projectedModelName = localProfile?.modelId
    || (normalizedProvider === normalizedPacketProvider ? packet?.model_name || null : null);
  const boundedMaxPromptChars = localProfile && Number(maxPromptChars) > 0
    ? Math.min(Number(maxPromptChars), localProfile.remoteMaxPromptChars)
    : (localProfile ? localProfile.remoteMaxPromptChars : maxPromptChars);
  const boundedMaxContextChars = localProfile && Number(maxContextChars) > 0
    ? Math.min(Number(maxContextChars), localProfile.remoteMaxContextChars)
    : (localProfile ? localProfile.remoteMaxContextChars : maxContextChars);
  const atlasSummary = sanitizeAtlasSummary(packet?.atlas?.summary);
  const requestInstructions = dedupeAtlasSummaryFromInstructions(instructions, packet?.atlas?.summary, atlasSummary);
  const shellPolicyHint = assessorShellPolicyHint(role, packet);
  const promptProfile = packet?.prompt_profile || packet?.promptProfile || null;
  const renderJobIdentity = role !== "researcher";
  const selectedSkills = Array.isArray(packet?.skills_attached)
    ? packet.skills_attached
    : (Array.isArray(packet?.skills) ? packet.skills : []);
  return {
    request_id: packet?.job_id != null ? `local-job-${packet.job_id}` : undefined,
    role,
    provider,
    job_type: packet?.job_type || role,
    governance_tier: packet?.governance_tier || "mvp",
    ...(renderJobIdentity ? {
      work_item: {
        id: packet?.work_item_id ?? null,
      },
      job: {
        id: packet?.job_id ?? null,
        title: packet?.title || "",
        job_type: packet?.job_type || null,
        model_tier: packet?.model_tier || null,
        model_name: projectedModelName,
        reasoning_effort: packet?.reasoning_effort || null,
      },
    } : {}),
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
      // Researcher instructions already carry the work-item description. Do
      // not make the relay render the same question again as PROJECT SUMMARY.
      project_summary: role === "researcher" ? null : (packet?.project_context || null),
      atlas_summary: atlasSummary,
      step0_context: packet?.step0_context || null,
      memory_prefetch: memoryEnabled ? memoryPrefetchForRemote(packet) : null,
      database_prefetch: databasePrefetchForRemote(packet),
      memory_surface: memoryEnabled ? (packet?.memory_surface || null) : null,
      dev_handoff: compactDevHandoffForRemote(packet),
      hash_ref_packet: compactHashRefPacketForRemote(packet),
      file_snippets: readOnlyFileSnippets(packet),
      insights: Array.isArray(packet?.run_insights) ? packet.run_insights.map(insightForRemote) : [],
    },
    capabilities: capabilitiesFromPacket(packet, provider),
    skills: selectedSkills,
    requested_skills: Array.isArray(packet?.requested_skills) ? packet.requested_skills : [],
    limits: {
      max_prompt_chars: boundedMaxPromptChars,
      max_context_chars: boundedMaxContextChars,
    },
    options: {
      include_final_prompt: includeFinalPrompt,
      privacy_mode: "full_context",
      embed_extra: false,
      memory_mode: memoryEnabled ? "on" : "off",
    },
    extra: {
      local_prompt_contract: "remote_skeleton_hash_refs",
      ...(promptProfile ? { prompt_profile: promptProfile } : {}),
      ...(packet?.research_role_mode ? { research_role_mode: packet.research_role_mode } : {}),
      ...(packet?.research_budget ? { research_budget: packet.research_budget } : {}),
      ...(packet?.fanout_context ? { fanout: packet.fanout_context } : {}),
      ...(shellPolicyHint ? { shell_policy_hint: shellPolicyHint } : {}),
      memory_mode: memoryEnabled ? "on" : "off",
    },
  };
}
