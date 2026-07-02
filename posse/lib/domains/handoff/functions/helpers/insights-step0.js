// lib/domains/handoff/functions/helpers/insights-step0.js
//
// Cross-run insight loading and step-0 context assembly.

import {
  getSetting,
  getInsights,
  getRecentJobsByFiles,
  getRecentWorkItemSummaries,
} from "../../../queue/functions/index.js";
import {
  HANDOFF_MEMORY_PREFETCH_ORIGIN,
  callAtlasMemoryAction,
} from "../../../integrations/functions/atlas-memory.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";

const KAIZEN_RUN_INSIGHTS_SURFACE_ENABLED = false;

export function kaizenRunInsightsSurfaceEnabled() {
  return KAIZEN_RUN_INSIGHTS_SURFACE_ENABLED;
}

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
  settingReader = getSetting,
} = {}) {
  const configured = settingValue(settingReader, SETTING_KEYS.ATLAS_MEMORY_SURFACE) ?? "on";
  const raw = String(configured).trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  if (raw === "auto") return true;
  return false;
}

function surfacedAtlasMemoryInsights(rows = []) {
  return rows.filter((row) =>
    row?.surfaced_memory === true
    || row?.insight_type === "atlas_memory"
    || String(row?.source || "").startsWith("memory:")
  );
}

function normalizeMemorySurface(value = {}) {
  const symbols = Array.isArray(value?.symbols) ? value.symbols.map(String).filter(Boolean) : [];
  const files = Array.isArray(value?.files) ? value.files.map(String).filter(Boolean) : [];
  return {
    symbols: [...new Set(symbols)],
    files: [...new Set(files)],
  };
}

export function buildMemoryPrefetchNotice(surfaceOrRows = []) {
  if (!Array.isArray(surfaceOrRows)) {
    const surface = normalizeMemorySurface(surfaceOrRows);
    const count = surface.symbols.length + surface.files.length;
    if (count <= 0) return null;
    const lines = [
      "ATLAS MEMORY PREFETCH:",
      `Memory is attached to ${count} scoped anchor(s).`,
    ];
    if (surface.symbols.length > 0) lines.push(`Symbols: ${surface.symbols.slice(0, 12).join(", ")}`);
    if (surface.files.length > 0) lines.push(`Files: ${surface.files.slice(0, 12).join(", ")}`);
    lines.push("Use memory.get only for anchors you are about to rely on; no memory bodies were prefetched.");
    lines.push("Do not perform broad memory search, and do not fetch every listed anchor unless each is directly relevant.");
    return lines.join("\n");
  }
  const rows = surfaceOrRows;
  const count = surfacedAtlasMemoryInsights(rows).length;
  if (count <= 0) return null;
  return [
    "ATLAS MEMORY PREFETCH:",
    `${count} relevant ATLAS memory item(s) were surfaced during handoff.`,
    "Treat those historical insight entries as the first memory pass; do not run another broad memory lookup just to rediscover them.",
    "Query ATLAS memory again only for a specific missing-memory question.",
  ].join("\n");
}

function currentWorkItemLocalInsights(rows = [], payload = {}, limit = 6) {
  if (!payload?.work_item_id) return [];
  return rows
    .filter((row) => row?.work_item_id && Number(row.work_item_id) === Number(payload.work_item_id))
    .slice(0, limit);
}

function memorySurfaceArgs({ symbolIds = [], fileRelPaths = [] } = {}) {
  const args = {};
  if (symbolIds.length > 0) args.symbolIds = symbolIds.slice(0, 100);
  if (fileRelPaths.length > 0) args.fileRelPaths = fileRelPaths.slice(0, 100);
  return args;
}

export async function loadMemorySurfaceAsync(role, payload, { cwd = process.cwd(), telemetry = null } = {}) {
  const surfaceEnabled = memorySurfaceEnabled();
  recordTelemetry(telemetry, {
    surface_enabled: surfaceEnabled,
    role_supported: ["planner", "researcher", "dev", "fix", "assessor"].includes(role),
    memory_surface_symbols: 0,
    memory_surface_files: 0,
  });
  if (!surfaceEnabled || !["planner", "researcher", "dev", "fix", "assessor"].includes(role)) {
    return { symbols: [], files: [] };
  }
  const symbolIds = collectInsightSymbolIds(payload);
  const fileRelPaths = collectInsightFilePaths(payload);
  if (symbolIds.length === 0 && fileRelPaths.length === 0) {
    return { symbols: [], files: [] };
  }
  try {
    const result = await callAtlasMemoryAction("memory.surface", memorySurfaceArgs({
      symbolIds,
      fileRelPaths,
    }), { cwd, origin: HANDOFF_MEMORY_PREFETCH_ORIGIN });
    const surface = normalizeMemorySurface(result?.json?.data || result?.json || {});
    recordTelemetry(telemetry, {
      memory_surface_symbols: surface.symbols.length,
      memory_surface_files: surface.files.length,
    });
    return surface;
  } catch (err) {
    recordTelemetry(telemetry, { error: String(err?.message || err || "memory_surface_failed").slice(0, 200) });
    return { symbols: [], files: [] };
  }
}

export function loadRelevantInsights(role, payload) {
  if (!kaizenRunInsightsSurfaceEnabled()) return [];
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
    const fileScoped = [];

    if (["dev", "fix", "researcher", "planner"].includes(role) && filePaths.length > 0) {
      pushUnique(fileScoped, getInsights({ limit: 8, file_paths: filePaths, only_actionable: true }), new Set());
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
    pushUnique(selected, fileScoped, seen);

    if (selected.length > 0) {
      return selected.slice(0, 6);
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
  if (!kaizenRunInsightsSurfaceEnabled()) {
    recordTelemetry(telemetry, {
      kaizen_run_insights_surface_enabled: false,
      surfaced: 0,
    });
    return [];
  }
  void cwd;
  const local = loadRelevantInsights(role, payload);
  const scopedLocal = currentWorkItemLocalInsights(local, payload, limit);
  recordTelemetry(telemetry, {
    kaizen_run_insights_surface_enabled: kaizenRunInsightsSurfaceEnabled(),
    surface_enabled: memorySurfaceEnabled(),
    role_supported: ["planner", "researcher", "dev", "fix", "assessor"].includes(role),
    atlas_returned: 0,
    stale_dropped: 0,
    surfaced: scopedLocal.length,
  });
  return scopedLocal;
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
  kaizenRunInsightsSurfaceEnabled,
  normalizeMemorySurface,
  buildMemoryPrefetchNotice,
  memorySurfaceArgs,
  memorySurfaceEnabled,
};
