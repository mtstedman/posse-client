// @ts-check
//
// Compact operator-facing indicators for ATLAS v2 index, warm, and edge health.
// Kept read-only: missing DB files stay missing, and corrupt/incompatible DBs
// are reported as attention states instead of being repaired from this surface.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { C as defaultColors } from "../../../../shared/format/functions/colors.js";
import { formatDuration, formatTokens } from "../../../../shared/format/functions/units.js";
import { parseJsonObject } from "../../../queue/functions/payload.js";
import { FAILED_JOB_STATUSES, FAILED_JOB_STATUSES_SQL } from "../../../../catalog/job.js";
import { ATLAS_WARM_JOB_TYPE } from "./contracts/jobs.js";
import {
  ledgerDbPath,
  mainViewPath,
  atlasDir,
  warmedViewsDir,
} from "./runtime-paths.js";

const ACTIVE_STATUSES = new Set(["leased", "running"]);
const WAITING_STATUSES = new Set(["queued", "blocked"]);
const BAD_STATUSES = new Set(FAILED_JOB_STATUSES);

function nowMs() {
  return Date.now();
}

function statInfo(filePath) {
  let stat = null;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  return {
    path: filePath,
    exists: !!stat,
    size_bytes: stat?.size ?? 0,
    mtime: stat?.mtime ? stat.mtime.toISOString() : null,
    age_ms: stat?.mtime ? nowMs() - stat.mtime.getTime() : null,
  };
}

function openReadonly(dbPath, fn) {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function count(db, sql, params = []) {
  try {
    const row = db.prepare(sql).get(...params);
    return Number(row?.cnt ?? row?.count ?? 0) || 0;
  } catch {
    return 0;
  }
}

function metaMap(db) {
  try {
    const rows = db.prepare("SELECT key, value FROM meta").all();
    return Object.fromEntries(rows.map((row) => [String(row.key), row.value]));
  } catch {
    return {};
  }
}

function listWarmedViews(root) {
  try {
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".view.db"))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function ledgerStats(dbPath) {
  const info = statInfo(dbPath);
  if (!info.exists) {
    return {
      ...info,
      ok: false,
      error: null,
      main_head_seq: 0,
      branch_count: 0,
      active_branch_count: 0,
      merged_branch_count: 0,
      abandoned_branch_count: 0,
      branch_heads: {},
      indexed_files: 0,
      blobs: 0,
      symbols: 0,
      edges: 0,
      resolved_blob_edges: 0,
      external_blob_edges: 0,
      unresolved_blob_edges: 0,
    };
  }
  try {
    return openReadonly(dbPath, (db) => {
      const branchRows = (() => {
        try {
          return db.prepare("SELECT status, COUNT(*) AS cnt FROM branches GROUP BY status").all();
        } catch {
          return [];
        }
      })();
      const branchCounts = Object.create(null);
      for (const row of branchRows) branchCounts[row.status] = Number(row.cnt || 0);
      const headRows = (() => {
        try {
          return db.prepare("SELECT branch, COALESCE(MAX(seq), 0) AS head FROM symbol_deltas GROUP BY branch").all();
        } catch {
          return [];
        }
      })();
      const branchHeads = Object.create(null);
      for (const row of headRows) branchHeads[row.branch] = Number(row.head || 0);
      const fallbackHead = Object.values(branchHeads).reduce((max, n) => Math.max(max, Number(n || 0)), 0);
      const flatSymbols = count(db, "SELECT COUNT(*) AS cnt FROM blob_symbols");
      const layerSymbols = count(db, "SELECT COUNT(*) AS cnt FROM blob_layer_symbols");
      const flatEdges = count(db, "SELECT COUNT(*) AS cnt FROM blob_edges");
      const layerEdges = count(db, "SELECT COUNT(*) AS cnt FROM blob_layer_edges");
      const hasFlatEdges = flatEdges > 0;
      return {
        ...info,
        ok: true,
        error: null,
        main_head_seq: branchHeads.main || branchHeads.master || fallbackHead,
        branch_count: count(db, "SELECT COUNT(*) AS cnt FROM branches"),
        active_branch_count: branchCounts.active || 0,
        merged_branch_count: branchCounts.merged || 0,
        abandoned_branch_count: branchCounts.abandoned || 0,
        branch_heads: branchHeads,
        indexed_files: count(db, `
          SELECT COUNT(*) AS cnt FROM (
            SELECT d.path_id, d.op
            FROM symbol_deltas d
            WHERE d.branch = 'main'
              AND d.seq = (
                SELECT MAX(d2.seq)
                FROM symbol_deltas d2
                WHERE d2.branch = d.branch AND d2.path_id = d.path_id
              )
          ) latest
          WHERE latest.op <> 'remove'
        `),
        blobs: count(db, "SELECT COUNT(*) AS cnt FROM blobs"),
        symbols: flatSymbols || layerSymbols,
        edges: flatEdges || layerEdges,
        resolved_blob_edges: hasFlatEdges
          ? count(db, "SELECT COUNT(*) AS cnt FROM blob_edges WHERE to_content_hash IS NOT NULL OR to_external_id IS NOT NULL")
          : count(db, `
              SELECT COUNT(*) AS cnt
              FROM blob_layer_edges
              WHERE to_local_id IS NOT NULL
                 OR json_extract(detail_json, '$.to_content_hash') IS NOT NULL
                 OR json_extract(detail_json, '$.to_external_id') IS NOT NULL
            `),
        external_blob_edges: hasFlatEdges
          ? count(db, "SELECT COUNT(*) AS cnt FROM blob_edges WHERE to_external_id IS NOT NULL")
          : count(db, `
              SELECT COUNT(*) AS cnt
              FROM blob_layer_edges
              WHERE json_extract(detail_json, '$.to_external_id') IS NOT NULL
            `),
        unresolved_blob_edges: hasFlatEdges
          ? count(db, "SELECT COUNT(*) AS cnt FROM blob_edges WHERE to_content_hash IS NULL AND to_external_id IS NULL")
          : count(db, `
              SELECT COUNT(*) AS cnt
              FROM blob_layer_edges
              WHERE to_local_id IS NULL
                AND json_extract(detail_json, '$.to_content_hash') IS NULL
                AND json_extract(detail_json, '$.to_external_id') IS NULL
            `),
      };
    });
  } catch (err) {
    return {
      ...info,
      ok: false,
      error: /** @type {any} */ (err)?.message || String(err),
      main_head_seq: 0,
      branch_count: 0,
      active_branch_count: 0,
      merged_branch_count: 0,
      abandoned_branch_count: 0,
      branch_heads: {},
      indexed_files: 0,
      blobs: 0,
      symbols: 0,
      edges: 0,
      resolved_blob_edges: 0,
      external_blob_edges: 0,
      unresolved_blob_edges: 0,
    };
  }
}

function viewStats(dbPath, ledger) {
  const info = statInfo(dbPath);
  if (!info.exists) {
    return {
      ...info,
      ok: false,
      error: null,
      branch: null,
      ledger_seq: 0,
      head_seq: ledger?.main_head_seq || 0,
      built_at: null,
      stale: ledger?.main_head_seq > 0,
      files: 0,
      symbols: 0,
      edges: 0,
      resolved_edges: 0,
      external_edges: 0,
      unresolved_edges: 0,
      prefetched_symbols: null,
      prefetched_edges: null,
    };
  }
  try {
    return openReadonly(dbPath, (db) => {
      const meta = metaMap(db);
      const ledgerSeq = Number(meta.ledger_seq || 0) || 0;
      const branch = String(meta.branch || "main");
      const headSeq = Number(ledger?.branch_heads?.[branch] ?? ledger?.main_head_seq ?? 0) || 0;
      return {
        ...info,
        ok: true,
        error: null,
        branch: meta.branch || null,
        ledger_seq: ledgerSeq,
        head_seq: headSeq,
        built_at: meta.built_at || null,
        stale: !!ledger?.ok && headSeq > ledgerSeq,
        files: count(db, "SELECT COUNT(*) AS cnt FROM path_to_blob"),
        symbols: count(db, "SELECT COUNT(*) AS cnt FROM symbols"),
        edges: count(db, "SELECT COUNT(*) AS cnt FROM edges"),
        resolved_edges: count(db, "SELECT COUNT(*) AS cnt FROM edges WHERE to_global_id IS NOT NULL OR to_external_id IS NOT NULL"),
        external_edges: count(db, "SELECT COUNT(*) AS cnt FROM edges WHERE to_external_id IS NOT NULL"),
        unresolved_edges: count(db, "SELECT COUNT(*) AS cnt FROM edges WHERE to_global_id IS NULL AND to_external_id IS NULL"),
        prefetched_symbols: meta.prefetched_symbols != null ? Number(meta.prefetched_symbols) : null,
        prefetched_edges: meta.prefetched_edges != null ? Number(meta.prefetched_edges) : null,
      };
    });
  } catch (err) {
    return {
      ...info,
      ok: false,
      error: /** @type {any} */ (err)?.message || String(err),
      branch: null,
      ledger_seq: 0,
      head_seq: ledger?.main_head_seq || 0,
      built_at: null,
      stale: false,
      files: 0,
      symbols: 0,
      edges: 0,
      resolved_edges: 0,
      external_edges: 0,
      unresolved_edges: 0,
      prefetched_symbols: null,
      prefetched_edges: null,
    };
  }
}

function warmJobPurpose(job) {
  const payload = parseJsonObject(job?.payload_json, {});
  return String(payload.purpose || "wi");
}

function warmJobEventCount(job) {
  const payload = parseJsonObject(job?.payload_json, {});
  const count = Number(payload._atlas_event_count || 1);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function warmJobTarget(job) {
  const payload = parseJsonObject(job?.payload_json, {});
  if (payload.work_item_id != null) return `wi-${payload.work_item_id}`;
  return String(payload.branch || payload.onto_branch || "main");
}

const ATLAS_WARM_FAMILY_ORDER = ["reindex", "scip", "warm", "replay", "cleanup"];
const ATLAS_WARM_FAMILY_LABELS = {
  reindex: "code map",
  scip: "SCIP restage",
  warm: "context prep",
  replay: "merge replay",
  cleanup: "cleanup",
};

function warmJobFamilyFromPurpose(purpose) {
  const normalized = String(purpose || "wi");
  if (normalized === "main-incremental" || normalized === "main-full") return "reindex";
  if (normalized === "scip-restage") return "scip";
  if (normalized === "main-merge") return "replay";
  if (normalized === "wi-cleanup") return "cleanup";
  return "warm";
}

function addStatusCounts(target, source = {}) {
  for (const [status, count] of Object.entries(source || {})) {
    target[status] = Number(target[status] || 0) + Number(count || 0);
  }
}

function warmQueueFamilyStats(byPurpose = {}) {
  const byFamily = {};
  for (const [purpose, counts] of Object.entries(byPurpose || {})) {
    const family = warmJobFamilyFromPurpose(purpose);
    byFamily[family] ||= {};
    addStatusCounts(byFamily[family], counts);
  }
  return byFamily;
}

/**
 * @param {Record<string, Record<string, number>>} [byFamily]
 * @param {(family: string) => boolean} [predicate]
 */
function countFamilyStatuses(byFamily = {}, predicate = () => true) {
  let active = 0;
  let waiting = 0;
  let failed = 0;
  for (const [family, counts] of Object.entries(byFamily || {})) {
    if (!predicate(family)) continue;
    active += Number(counts.running || 0) + Number(counts.leased || 0);
    waiting += Number(counts.queued || 0) + Number(counts.blocked || 0);
    failed += Number(counts.failed || 0) + Number(counts.dead_letter || 0);
  }
  return { active, waiting, failed };
}

function summarizeWarmResult(job) {
  const result = parseJsonObject(job?.result_json, {});
  if (!Object.keys(result).length) return null;
  return {
    paths_indexed: Number(result.paths_indexed || 0),
    paths_considered: Number(result.paths_considered || 0),
    ledger_entries_appended: Number(result.ledger_entries_appended || 0),
    blobs_ingested: Number(result.blobs_ingested || 0),
    blobs_reused: Number(result.blobs_reused || 0),
    skipped: Array.isArray(result.skipped) ? result.skipped.length : 0,
    view_written: result.view_written || null,
    duration_ms: Number(result.duration_ms || 0),
  };
}

function warmQueueStats({ db, limit }) {
  try {
    const hostDb = db || getDb();
    const statusRows = hostDb.prepare(`
      SELECT status, COUNT(*) AS cnt
      FROM jobs
      WHERE job_type = ?
      GROUP BY status
    `).all(ATLAS_WARM_JOB_TYPE);
    const byStatus = Object.create(null);
    for (const row of statusRows) byStatus[row.status] = Number(row.cnt || 0);

    const purposeRows = hostDb.prepare(`
      SELECT
        COALESCE(json_extract(payload_json, '$.purpose'), 'wi') AS purpose,
        status,
        COUNT(*) AS cnt,
        SUM(COALESCE(json_extract(payload_json, '$._atlas_event_count'), 1)) AS event_cnt
      FROM jobs
      WHERE job_type = ?
      GROUP BY COALESCE(json_extract(payload_json, '$.purpose'), 'wi'), status
      ORDER BY purpose ASC, status ASC
    `).all(ATLAS_WARM_JOB_TYPE);
    const byPurpose = {};
    for (const row of purposeRows) {
      const purpose = String(row.purpose || "wi");
      byPurpose[purpose] ||= {};
      byPurpose[purpose][row.status] = Number(row.cnt || 0);
      byPurpose[purpose][`${row.status}_events`] = Number(row.event_cnt || row.cnt || 0);
    }
    const byFamily = warmQueueFamilyStats(byPurpose);

    const recentRows = hostDb.prepare(`
      SELECT id, work_item_id, status, payload_json, result_json, last_error,
             created_at, updated_at, started_at, finished_at
      FROM jobs
      WHERE job_type = ?
      ORDER BY
        CASE WHEN status IN ('running','leased') THEN 0
             WHEN status IN ('queued','blocked') THEN 1
             WHEN status IN (${FAILED_JOB_STATUSES_SQL}) THEN 2
             ELSE 3 END,
        updated_at DESC,
        id DESC
      LIMIT ?
    `).all(ATLAS_WARM_JOB_TYPE, Math.max(1, Number(limit || 6)));

    const recent = recentRows.map((job) => ({
      id: Number(job.id),
      work_item_id: job.work_item_id == null ? null : Number(job.work_item_id),
      status: String(job.status || "unknown"),
      purpose: warmJobPurpose(job),
      target: warmJobTarget(job),
      event_count: warmJobEventCount(job),
      created_at: job.created_at || null,
      updated_at: job.updated_at || null,
      started_at: job.started_at || null,
      finished_at: job.finished_at || null,
      last_error: job.last_error || null,
      result: summarizeWarmResult(job),
    }));
    const active = recent.filter((job) => ACTIVE_STATUSES.has(job.status));
    const waiting = recent.filter((job) => WAITING_STATUSES.has(job.status));
    const bad = recent.filter((job) => BAD_STATUSES.has(job.status));

    return {
      ok: true,
      error: null,
      by_status: {
        queued: byStatus.queued || 0,
        blocked: byStatus.blocked || 0,
        leased: byStatus.leased || 0,
        running: byStatus.running || 0,
        succeeded: byStatus.succeeded || 0,
        failed: byStatus.failed || 0,
        dead_letter: byStatus.dead_letter || 0,
        canceled: byStatus.canceled || 0,
      },
      by_purpose: byPurpose,
      by_family: byFamily,
      active,
      waiting,
      bad,
      recent,
    };
  } catch (err) {
    return {
      ok: false,
      error: /** @type {any} */ (err)?.message || String(err),
      by_status: {},
      by_purpose: {},
      by_family: {},
      active: [],
      waiting: [],
      bad: [],
      recent: [],
    };
  }
}

function deriveState(indicators) {
  const q = indicators.queue;
  const graphWork = countFamilyStatuses(q.by_family || {}, (family) => family !== "cleanup");
  const allWork = countFamilyStatuses(q.by_family || {});
  if (!indicators.ledger.ok && indicators.ledger.exists) return "attention";
  if (!indicators.main_view.ok && indicators.main_view.exists) return "attention";
  if (allWork.failed > 0) return "attention";
  if (graphWork.active > 0) return "warming";
  if (graphWork.waiting > 0) return "queued";
  if (indicators.main_view.stale) return "stale";
  if (indicators.main_view.exists && indicators.ledger.exists) return "ready";
  if (indicators.ledger.exists) return "needs_view";
  return "cold";
}

/**
 * @param {{ projectDir?: string, db?: any, limit?: number }} [args]
 */
export function loadAtlasV2ProcessIndicators({ projectDir, db = null, limit = 6 } = {}) {
  if (!projectDir) throw new Error("loadAtlasV2ProcessIndicators requires projectDir");
  const ledgerPath = ledgerDbPath(projectDir);
  const mainPath = mainViewPath(projectDir);
  const warmedRoot = warmedViewsDir(projectDir);
  const ledger = ledgerStats(ledgerPath);
  const mainView = viewStats(mainPath, ledger);
  const warmed = listWarmedViews(warmedRoot).map((filePath) => statInfo(filePath));
  const queue = warmQueueStats({ db, limit });
  const indicators = {
    project_dir: projectDir,
    atlas_root: atlasDir(projectDir),
    ledger,
    main_view: mainView,
    warmed_views: {
      count: warmed.length,
      newest: warmed.sort((a, b) => String(b.mtime || "").localeCompare(String(a.mtime || ""))).slice(0, 5),
    },
    queue,
    state: "cold",
  };
  indicators.state = deriveState(indicators);
  return indicators;
}

function colorForState(state, C) {
  if (state === "ready") return C.green;
  if (state === "warming") return C.cyan;
  if (state === "queued" || state === "stale" || state === "needs_view") return C.yellow;
  if (state === "attention") return C.red;
  return C.dim;
}

function bar({ value, total, width = 14, C }) {
  if (!Number.isFinite(total) || total <= 0) return `${C.dim}${"-".repeat(width)}${C.reset}`;
  const fraction = Math.max(0, Math.min(1, Number(value || 0) / total));
  const filled = Math.round(fraction * width);
  return `${C.green}${"#".repeat(filled)}${C.dim}${"-".repeat(width - filled)}${C.reset}`;
}

function compactBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function graphHealthSummary(queue, C) {
  const byFamily = queue?.by_family || {};
  const parts = [];
  for (const family of ATLAS_WARM_FAMILY_ORDER) {
    const counts = byFamily[family] || {};
    const active = Number(counts.running || 0) + Number(counts.leased || 0);
    const waiting = Number(counts.queued || 0) + Number(counts.blocked || 0);
    const failed = Number(counts.failed || 0) + Number(counts.dead_letter || 0);
    const activeEvents = Number(counts.running_events || 0) + Number(counts.leased_events || 0);
    const waitingEvents = Number(counts.queued_events || 0) + Number(counts.blocked_events || 0);
    const queuedSignal = waitingEvents + Math.max(0, activeEvents - active);
    const bits = [];
    if (active > 0) bits.push(`running=${active}`);
    if (queuedSignal > 0) bits.push(`queued=${queuedSignal}`);
    if (failed > 0) bits.push(`failed=${failed}`);
    if (bits.length > 0) parts.push(`${ATLAS_WARM_FAMILY_LABELS[family]} ${bits.join(" ")}`);
  }
  if (parts.length > 0) return parts.join(`${C.dim} · ${C.reset}`);

  const q = queue?.by_status || {};
  const active = (q.running || 0) + (q.leased || 0);
  const waiting = (q.queued || 0) + (q.blocked || 0);
  const failed = (q.failed || 0) + (q.dead_letter || 0);
  return `context running=${active} queued=${waiting} failed=${failed}`;
}

function warmJobLine(job, C, width) {
  const age = job.updated_at ? formatDuration(Math.max(0, nowMs() - Date.parse(job.updated_at))) : "?";
  const result = job.result;
  const isMainReindex = job.purpose === "main-incremental" || job.purpose === "main-full";
  const resultText = result
    ? isMainReindex
      ? ` indexed=${result.paths_indexed}/${result.paths_considered} entries=${result.ledger_entries_appended} skipped=${result.skipped}`
      : ` considered=${result.paths_considered} updated=${result.paths_indexed} entries=${result.ledger_entries_appended} skipped=${result.skipped}`
    : "";
  const errorText = job.last_error ? ` ${C.red}${String(job.last_error).split("\n")[0]}${C.reset}` : "";
  const eventText = Number(job.event_count || 1) > 1 ? ` events=${job.event_count}` : "";
  const raw = `#${job.id} ${job.status} ${job.purpose} ${job.target} age=${age}${eventText}${resultText}${errorText}`;
  return raw.length > width ? `${raw.slice(0, Math.max(0, width - 1))}…` : raw;
}

/**
 * @param {ReturnType<typeof loadAtlasV2ProcessIndicators>} indicators
 * @param {{ colors?: typeof defaultColors, width?: number, compact?: boolean }} options
 */
export function renderAtlasV2ProcessIndicators(indicators, options = {}) {
  const C = options.colors || defaultColors;
  const width = Math.max(40, Number(options.width || 100));
  const compact = !!options.compact;
  const lines = [];
  const stateColor = colorForState(indicators.state, C);
  const stateLabel = indicators.state.replace(/_/g, " ");
  const view = indicators.main_view;
  const ledger = indicators.ledger;
  const headSeq = Number(view.head_seq || ledger.main_head_seq || 0);
  const edgeTotal = Number(view.edges || ledger.edges || 0);
  const edgeResolved = Number(view.resolved_edges || ledger.resolved_blob_edges || 0);
  const edgeExternal = Number(view.external_edges || ledger.external_blob_edges || 0);
  const edgeUnresolved = Number(view.unresolved_edges || ledger.unresolved_blob_edges || 0);
  const edgePct = edgeTotal > 0 ? Math.round((100 * edgeResolved) / edgeTotal) : 100;
  const viewFresh = view.exists
    ? view.stale
      ? `${C.yellow}stale${C.reset}`
      : `${C.green}fresh${C.reset}`
    : `${C.yellow}missing${C.reset}`;

  lines.push(
    ` ${C.bold}Context health${C.reset} ` +
    `${stateColor}${stateLabel}${C.reset}  ` +
    `${C.dim}${graphHealthSummary(indicators.queue, C)}${C.reset}`,
  );
  lines.push(
    `  ${C.cyan}Index${C.reset} ` +
    `ledger=${ledger.exists ? `${C.green}present${C.reset}` : `${C.yellow}missing${C.reset}`} ` +
    `${C.dim}${compactBytes(ledger.size_bytes)}${C.reset}  ` +
    `main-view=${viewFresh} ` +
    `${C.dim}seq ${view.ledger_seq || 0}/${headSeq}, age ${view.age_ms != null ? formatDuration(view.age_ms) : "?"}${C.reset}`,
  );
  lines.push(
    `  ${C.magenta}Edges${C.reset} ${bar({ value: edgeResolved, total: edgeTotal, width: compact ? 10 : 14, C })} ` +
    `${edgePct}% resolved  ` +
    `${C.dim}${formatTokens(edgeResolved)}/${formatTokens(edgeTotal)} edges, ${formatTokens(edgeExternal)} external, ${formatTokens(edgeUnresolved)} unresolved${C.reset}`,
  );
  lines.push(
    `  ${C.blue}Coverage${C.reset} ` +
    `${formatTokens(view.files || ledger.indexed_files)} files  ` +
    `${formatTokens(view.symbols || ledger.symbols)} symbols  ` +
    `${formatTokens(indicators.warmed_views.count)} warmed view${indicators.warmed_views.count === 1 ? "" : "s"}  ` +
    `${C.dim}${ledger.branch_count || 0} ledger branch${ledger.branch_count === 1 ? "" : "es"}${C.reset}`,
  );

  if (!compact) {
    const liveJobs = [...indicators.queue.active, ...indicators.queue.waiting, ...indicators.queue.bad].slice(0, 4);
    if (liveJobs.length > 0) {
      lines.push(`  ${C.bold}Warm jobs${C.reset}`);
      for (const job of liveJobs) lines.push(`   ${warmJobLine(job, C, width - 4)}`);
    }
    const completed = indicators.queue.recent.find((job) => job.status === "succeeded" && job.result);
    if (completed) {
      lines.push(`  ${C.dim}Last warm: ${warmJobLine(completed, C, width - 14)}${C.reset}`);
    }
    if (ledger.error) lines.push(`  ${C.red}Ledger error:${C.reset} ${ledger.error}`);
    if (view.error) lines.push(`  ${C.red}View error:${C.reset} ${view.error}`);
    if (indicators.queue.error) lines.push(`  ${C.red}Queue error:${C.reset} ${indicators.queue.error}`);
  }

  return lines;
}

/**
 * @param {any} job
 */
export function describeAtlasWarmJob(job) {
  const payload = parseJsonObject(job?.payload_json, {});
  const purpose = String(payload.purpose || "wi");
  const target = payload.work_item_id != null
    ? `wi-${payload.work_item_id}`
    : String(payload.branch || payload.onto_branch || "main");
  const paths = Array.isArray(payload.paths) ? payload.paths.length : 0;
  const eventCount = warmJobEventCount(job);
  return { purpose, target, paths, eventCount };
}
