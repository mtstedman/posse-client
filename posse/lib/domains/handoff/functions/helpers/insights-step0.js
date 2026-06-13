// lib/handoff/helpers/insights-step0.js
//
// Cross-run insight loading and step-0 context assembly.

import {
  getSetting,
  getInsights,
  getRecentJobsByFiles,
  getRecentWorkItemSummaries,
  hasPromotedInsightMemories,
} from "../../../queue/functions/index.js";
import { callAtlasMemoryAction } from "../../../integrations/functions/atlas-memory.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";

function collectInsightFilePaths(payload) {
  const paths = [];
  const push = (value) => {
    if (!value) return;
    const normalized = String(value).replace(/\\/g, "/").trim();
    if (normalized) paths.push(normalized);
  };
  for (const file of payload?.files_to_modify || []) push(file);
  for (const file of payload?.files_to_create || []) push(file);
  for (const file of Object.keys(payload?.source_files || {})) push(file);
  for (const file of payload?.atlas_slice_candidates?.filePaths || []) push(file);
  for (const card of payload?.atlas_slice_candidates?.cards || []) push(card?.file);
  for (const file of payload?.atlas_slice_context?.filePaths || []) push(file);
  for (const card of payload?.atlas_slice_context?.cards || []) push(card?.file);
  for (const file of payload?.atlas_fallback_context?.candidateFiles || []) push(file);
  return [...new Set(paths)];
}

function collectInsightSymbolIds(payload) {
  const ids = [];
  const push = (value) => {
    if (!value) return;
    const text = String(value).trim();
    if (text) ids.push(text);
  };
  for (const card of payload?.atlas_slice_candidates?.cards || []) push(card?.symbolId || card?.symbol_id);
  for (const card of payload?.atlas_slice_context?.cards || []) push(card?.symbolId || card?.symbol_id);
  for (const symbolId of payload?.symbolIds || payload?.symbol_ids || []) push(symbolId);
  return [...new Set(ids)];
}

function settingValue(settingReader, key) {
  try {
    return typeof settingReader === "function" ? settingReader(key) : null;
  } catch {
    return null;
  }
}

function memorySurfaceEnabled({
  hasPromotedMemories = false,
  settingReader = getSetting,
} = {}) {
  const configured = settingValue(settingReader, SETTING_KEYS.ATLAS_MEMORY_SURFACE) ?? "auto";
  const raw = String(configured).trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  return !!hasPromotedMemories;
}

function normalizeSurfaceMemory(memory = {}) {
  const memoryId = memory.memoryId || memory.memory_id || memory.id || null;
  const type = memory.type || "task_context";
  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  const kind = tags.includes("enforcement") ? "enforcement"
    : tags.includes("lesson") ? "lesson"
      : tags.includes("pattern") ? "pattern"
        : type;
  const content = String(memory.content || "");
  const firstLine = content.split("\n").map((line) => line.trim()).find(Boolean) || memory.title || "ATLAS memory";
  return {
    id: memoryId ? `atlas:${memoryId}` : `atlas:${memory.title || firstLine}`,
    memory_id: memoryId,
    insight_type: "atlas_memory",
    summary: memory.title || firstLine,
    detail: content,
    insight_kind: kind,
    action: firstLine,
    confidence: memory.confidence != null ? String(memory.confidence) : null,
    // Provenance: who originally wrote this memory (agent, human, kaizen, ...),
    // carried from the memories.source column; insight_type already marks the
    // surfacing path as atlas_memory.
    source: `memory:${String(memory.source || "agent").trim() || "agent"}`,
    evidence: JSON.stringify([
      `surface score: ${memory.score ?? "n/a"}`,
      ...(Array.isArray(memory.matchedSymbols) && memory.matchedSymbols.length > 0
        ? [`matched symbols: ${memory.matchedSymbols.slice(0, 5).join(", ")}`]
        : []),
    ]),
    file_paths: null,
    surfaced_memory: true,
    why_surface: memory.score != null ? `ATLAS memory.surface score ${memory.score}` : "ATLAS memory.surface",
    stale: !!memory.stale,
  };
}

function nonStaleSurfaceMemories(memories = []) {
  return memories.filter((memory) => !memory?.stale);
}

function currentWorkItemLocalInsights(rows = [], payload = {}, limit = 6) {
  if (!payload?.work_item_id) return [];
  return rows
    .filter((row) => row?.work_item_id && Number(row.work_item_id) === Number(payload.work_item_id))
    .slice(0, limit);
}

function memorySurfaceArgs({ symbolIds = [], fileRelPaths = [], limit = 6 } = {}) {
  const args = {
    limit: Math.max(1, Math.min(5, limit)),
  };
  if (symbolIds.length > 0) args.symbolIds = symbolIds.slice(0, 100);
  if (fileRelPaths.length > 0) args.fileRelPaths = fileRelPaths.slice(0, 100);
  return args;
}

export function loadRelevantInsights(role, payload) {
  try {
    const filePaths = collectInsightFilePaths(payload);

    const pushUnique = (target, rows, seen) => {
      for (const row of rows || []) {
        if (!row?.id || seen.has(row.id)) continue;
        seen.add(row.id);
        target.push(row);
      }
    };

    const byCreatedDesc = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
    const seen = new Set();
    const selected = [];

    if (["dev", "fix", "researcher", "planner"].includes(role) && filePaths.length > 0) {
      pushUnique(selected, getInsights({ limit: 8, file_paths: filePaths, only_actionable: true }), seen);
    }

    if (["planner", "researcher", "dev", "fix"].includes(role)) {
      const humanOverrides = getInsights({ limit: 8, insight_type: "human_override" }).sort(byCreatedDesc);
      const scopeIssues = filePaths.length > 0
        ? getInsights({ limit: 8, insight_type: "scope_issue", file_paths: filePaths, only_actionable: true }).sort(byCreatedDesc)
        : [];
      const infoRequests = getInsights({ limit: 8, insight_type: "information_request" }).sort(byCreatedDesc);
      const failures = filePaths.length > 0
        ? getInsights({ limit: 8, insight_type: "failure", file_paths: filePaths, only_actionable: true }).sort(byCreatedDesc)
        : [];
      const patterns = filePaths.length > 0
        ? getInsights({ limit: 8, insight_type: "pattern", file_paths: filePaths, only_actionable: true }).sort(byCreatedDesc)
        : [];

      // Feed forward reusable project habits first.
      pushUnique(selected, humanOverrides.slice(0, 3), seen);
      if (["planner", "researcher"].includes(role)) {
        pushUnique(selected, infoRequests.slice(0, 2), seen);
      }
      pushUnique(selected, scopeIssues.slice(0, 3), seen);
      pushUnique(selected, failures.slice(0, 2), seen);
      pushUnique(selected, patterns.slice(0, 2), seen);
    }

    if (selected.length > 0) {
      return selected
        .sort(byCreatedDesc)
        .slice(0, 6);
    }
    return [];
  } catch {
    return [];
  }
}

function recordTelemetry(telemetry, patch) {
  if (!telemetry || typeof telemetry !== "object") return;
  Object.assign(telemetry, patch);
}

export async function loadRelevantInsightsAsync(role, payload, { cwd = process.cwd(), limit = 6, telemetry = null } = {}) {
  const local = loadRelevantInsights(role, payload);
  const scopedLocal = currentWorkItemLocalInsights(local, payload, limit);
  const surfaceEnabled = memorySurfaceEnabled({
    hasPromotedMemories: hasPromotedInsightMemories(),
  });
  recordTelemetry(telemetry, {
    surface_enabled: surfaceEnabled,
    role_supported: ["planner", "researcher", "dev", "fix", "assessor"].includes(role),
    atlas_returned: 0,
    stale_dropped: 0,
    surfaced: 0,
  });
  if (!surfaceEnabled || !["planner", "researcher", "dev", "fix", "assessor"].includes(role)) {
    recordTelemetry(telemetry, { surfaced: scopedLocal.length });
    return scopedLocal;
  }
  const symbolIds = collectInsightSymbolIds(payload);
  const fileRelPaths = collectInsightFilePaths(payload);
  if (symbolIds.length === 0 && fileRelPaths.length === 0) {
    recordTelemetry(telemetry, { surfaced: scopedLocal.length });
    return scopedLocal;
  }
  try {
    const result = await callAtlasMemoryAction("memory.surface", memorySurfaceArgs({
      symbolIds,
      fileRelPaths,
      limit,
    }), { cwd });
    const rawMemories = Array.isArray(result?.json?.memories) ? result.json.memories.map(normalizeSurfaceMemory) : [];
    const memories = nonStaleSurfaceMemories(rawMemories);
    recordTelemetry(telemetry, {
      atlas_returned: rawMemories.length,
      stale_dropped: rawMemories.length - memories.length,
    });
    if (memories.length === 0) {
      recordTelemetry(telemetry, { surfaced: scopedLocal.length });
      return scopedLocal;
    }
    const combined = [...scopedLocal.slice(0, 2), ...memories];
    const seen = new Set();
    const dedup = combined.filter((row) => {
      const key = row.memory_id ? `memory:${row.memory_id}` : `insight:${row.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
    recordTelemetry(telemetry, { surfaced: dedup.length });
    return dedup;
  } catch (err) {
    recordTelemetry(telemetry, { error: String(err?.message || err || "memory_surface_failed").slice(0, 200), surfaced: scopedLocal.length });
    return scopedLocal;
  }
}

export function buildStep0Context(role, payload) {
  try {
    const parts = [];
    const filePaths = collectInsightFilePaths(payload);

    // For dev/fix: show recent jobs that touched the same files
    if (["dev", "fix"].includes(role) && filePaths.length > 0) {
      const recentJobs = getRecentJobsByFiles({ file_paths: filePaths, limit: 5 });
      if (recentJobs.length > 0) {
        parts.push("Recent activity on your files:");
        for (const j of recentJobs) {
          let line = `  - [${j.status}] "${j.title}" (${j.job_type})`;
          if (j.assessor_verdict && j.assessor_verdict !== "not_assessed") {
            line += ` — verdict: ${j.assessor_verdict}`;
          }
          if (j.last_error) {
            line += ` — error: ${j.last_error}`;
          }
          parts.push(line);
        }
      }
    }

    // For researcher/planner: show recent work item outcomes
    if (["researcher", "planner"].includes(role)) {
      const recentWIs = getRecentWorkItemSummaries({ limit: 5 });
      if (recentWIs.length > 0) {
        parts.push("Recent work items:");
        for (const wi of recentWIs) {
          const tierTag = wi.governance_tier !== "mvp" ? ` [${wi.governance_tier}]` : "";
          parts.push(`  - WI#${wi.id} "${wi.title}" — ${wi.status}${tierTag}`);
        }
      }
    }

    return parts.length > 0 ? parts.join("\n") : null;
  } catch {
    return null;
  }
}

export const __test = {
  collectInsightFilePaths,
  collectInsightSymbolIds,
  currentWorkItemLocalInsights,
  memorySurfaceArgs,
  memorySurfaceEnabled,
  nonStaleSurfaceMemories,
  normalizeSurfaceMemory,
};
