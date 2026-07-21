// @ts-check
//
// Helpers for treating ATLAS v2 view databases as rebuildable caches. A view
// file can exist while still being unusable (empty, partially written, old
// schema, missing meta). Callers should validate before mounting it as the
// authoritative read cache.

import fs from "fs";
import path from "path";
import { languageForPath } from "./parse/language-buckets.js";

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove a SQLite database plus advisory WAL sidecars.
 *
 * @param {string} dbPath
 */
export function removeSqliteFile(dbPath) {
  for (const sfx of ["", "-wal", "-shm", "-journal"]) {
    const filePath = dbPath + sfx;
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if (/** @type {any} */ (err)?.code === "ENOENT") continue;
      const label = sfx ? "SQLite sidecar" : "SQLite file";
      const wrapped = new Error(
        `removeSqliteFile: failed to remove ${label} ${filePath}: ${err?.message || err}`,
      );
      /** @type {any} */ (wrapped).cause = err;
      /** @type {any} */ (wrapped).path = filePath;
      throw wrapped;
    }
  }
}

/**
 * Open a view and read its meta in one step. On failure the partially opened
 * handle is closed before returning a structured probe result.
 *
 * @param {string | null | undefined} dbPath
 * @param {{ mount(args: { dbPath: string, mode?: "readonly" | "readwrite" }): any }} ViewClass
 * @param {{ mode?: "readonly" | "readwrite" }} [options]
 * @returns {{
 *   ok: true,
 *   exists: true,
 *   dbPath: string,
 *   view: any,
 *   meta: any,
 *   error: null,
 * } | {
 *   ok: false,
 *   exists: boolean,
 *   dbPath: string | null,
 *   view: null,
 *   meta: null,
 *   error: Error,
 * }}
 */
export function openViewWithMeta(dbPath, ViewClass, options = {}) {
  if (!dbPath || typeof dbPath !== "string") {
    return {
      ok: false,
      exists: false,
      dbPath: null,
      view: null,
      meta: null,
      error: new Error("view path is missing"),
    };
  }
  let exists = false;
  try { exists = fs.existsSync(dbPath); } catch { exists = false; }
  if (!exists) {
    return {
      ok: false,
      exists: false,
      dbPath,
      view: null,
      meta: null,
      error: new Error("view path does not exist"),
    };
  }

  let view = null;
  try {
    view = ViewClass.mount({ dbPath, mode: options.mode || "readonly" });
    // This probe mounts the handle itself, so the local (in-process) meta read
    // applies; View.meta() is daemon-routed and async. Stub ViewClasses without
    // metaLocal keep their sync meta().
    const meta = typeof view.metaLocal === "function" ? view.metaLocal() : view.meta();
    return { ok: true, exists: true, dbPath, view, meta, error: null };
  } catch (err) {
    try { view?.close?.(); } catch { /* ignore close failures while probing */ }
    return {
      ok: false,
      exists: true,
      dbPath,
      view: null,
      meta: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * @param {any} meta
 * @param {any} ledger
 * @param {{ layerMerge?: boolean | null }} [options]
 * @returns {{ current: boolean, branch: string | null, ledgerSeq: number, headSeq: number | null, reason: string | null }}
 */
export function viewFreshness(meta, ledger, options = {}) {
  const branch = typeof meta?.branch === "string" && meta.branch ? meta.branch : null;
  const ledgerSeq = Number(meta?.ledger_seq);
  const modeMismatch = viewLayerMergeMismatch(meta, options.layerMerge);
  if (modeMismatch) {
    return {
      current: false,
      branch,
      ledgerSeq: Number.isInteger(ledgerSeq) ? ledgerSeq : 0,
      headSeq: null,
      reason: modeMismatch,
    };
  }
  if (!ledger || !branch || !Number.isInteger(ledgerSeq)) {
    return {
      current: true,
      branch,
      ledgerSeq: Number.isInteger(ledgerSeq) ? ledgerSeq : 0,
      headSeq: null,
      reason: null,
    };
  }
  try {
    if (typeof ledger.getBranch === "function" && !ledger.getBranch(branch)) {
      return {
        current: false,
        branch,
        ledgerSeq,
        headSeq: null,
        reason: `ledger branch '${branch}' is missing`,
      };
    }
    if (typeof ledger.headSeq !== "function") {
      return { current: true, branch, ledgerSeq, headSeq: null, reason: null };
    }
    const headSeq = Number(ledger.headSeq(branch));
    if (Number.isInteger(headSeq) && ledgerSeq > headSeq) {
      return {
        current: false,
        branch,
        ledgerSeq,
        headSeq,
        reason: `view ${branch}@${ledgerSeq} is ahead of ledger head ${branch}@${headSeq}`,
      };
    }
    if (Number.isInteger(headSeq) && headSeq > ledgerSeq) {
      return {
        current: false,
        branch,
        ledgerSeq,
        headSeq,
        reason: `view ${branch}@${ledgerSeq} is behind ledger head ${branch}@${headSeq}`,
      };
    }
    return {
      current: true,
      branch,
      ledgerSeq,
      headSeq: Number.isInteger(headSeq) ? headSeq : null,
      reason: null,
    };
  } catch (err) {
    return {
      current: false,
      branch,
      ledgerSeq,
      headSeq: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function viewLayerMergeMismatch(meta, expected) {
  if (expected == null) return null;
  const actual = meta?.layer_merge === true;
  if (expected === true && actual !== true) {
    return "view was built without layer-merge symbols";
  }
  if (expected === false && actual === true) {
    return "view was built with layer-merge symbols";
  }
  return null;
}

/**
 * Wait briefly for one of the candidate view DBs to be mountable and caught up
 * to its ledger branch. This covers races where a worker sees a file before
 * the warm job has finished writing its meta rows.
 *
 * @param {{
 *   viewPaths: Array<string | null | undefined>,
 *   ViewClass: { mount(args: { dbPath: string, mode?: "readonly" | "readwrite" }): any },
 *   ledger?: any,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   layerMerge?: boolean | null,
 *   allowStale?: boolean,
 * }} args
 * @returns {Promise<ReturnType<typeof openViewWithMeta> & { freshness?: ReturnType<typeof viewFreshness>, attempts?: number, stale?: boolean }>}
 */
export async function waitForCurrentView({
  viewPaths,
  ViewClass,
  ledger = null,
  timeoutMs = 0,
  intervalMs = 75,
  layerMerge = null,
  // Ledger-only callers (memory, policy, usage, status reporting) accept a
  // stale view rather than waiting or failing: they only need meta/branch,
  // and view currency says nothing about ledger-backed state.
  allowStale = false,
}) {
  const paths = [];
  const seen = new Set();
  for (const p of Array.isArray(viewPaths) ? viewPaths : []) {
    if (typeof p !== "string" || !p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
  /** @type {ReturnType<typeof openViewWithMeta> & { freshness?: ReturnType<typeof viewFreshness>, attempts?: number, stale?: boolean }} */
  let last = {
    ok: false,
    exists: false,
    dbPath: paths[0] || null,
    view: null,
    meta: null,
    error: new Error(paths.length > 0 ? "view is not ready" : "view path is missing"),
    attempts: 0,
  };
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const pause = Math.max(10, Number(intervalMs) || 75);
  do {
    last.attempts = Number(last.attempts || 0) + 1;
    for (const p of paths) {
      const probe = openViewWithMeta(p, ViewClass);
      if (!probe.ok) {
        last = { ...probe, attempts: last.attempts };
        continue;
      }
      const freshness = viewFreshness(probe.meta, ledger, { layerMerge });
      if (freshness.current) return { ...probe, freshness, attempts: last.attempts };
      if (allowStale) return { ...probe, freshness, stale: true, attempts: last.attempts };
      try { probe.view.close(); } catch { /* ignore stale probe close */ }
      last = {
        ok: false,
        exists: true,
        dbPath: p,
        view: null,
        meta: probe.meta,
        error: new Error(freshness.reason || "view is stale"),
        freshness,
        attempts: last.attempts,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pause, remaining));
  } while (Date.now() <= deadline);
  return last;
}

/**
 * Summarize quality problems inside a mounted ATLAS view. Unlike freshness,
 * these checks do not decide whether the view is usable; they expose drift and
 * noise patterns that should be visible in diagnostics.
 *
 * @param {import("better-sqlite3").Database} viewDb
 * @param {{
 *   ledgerDb?: import("better-sqlite3").Database | null,
 *   repoRoot?: string | null,
 *   sampleLimit?: number,
 * }} [options]
 * @returns {{
 *   totals: { paths: number, symbols: number, edges: number },
 *   missingPathsOnDisk: { count: number, sample: string[] },
 *   currentPathsWithoutSymbols: { count: number, sample: Array<{ repo_rel_path: string, content_hash: string, layerSymbols: number | null }> },
 *   sameStartDuplicates: { groups: number, extras: number, rows: number, byKind: Array<{ kind: string, groups: number, extras: number, rows: number }> },
 *   localNamedSymbols: { count: number, ratio: number },
 *   pathLikeQualifiedNames: { count: number, ratio: number },
 *   danglingEdges: { count: number, bySourceKind: Array<{ source: string, kind: string, count: number }> },
 *   resolvedEdgeNameMismatches: { count: number, bySource: Array<{ source: string, count: number }> },
 *   warnings: Array<{ kind: string, count: number, detail: string }>,
 * }}
 */
export function auditViewQuality(viewDb, options = {}) {
  const sampleLimit = Math.max(1, Number(options.sampleLimit) || 20);
  const ledgerDb = options.ledgerDb || null;
  const repoRoot = typeof options.repoRoot === "string" && options.repoRoot
    ? options.repoRoot
    : null;

  const count = (table) => {
    if (!tableExists(viewDb, table)) return 0;
    return Number(viewDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0);
  };
  const totals = {
    paths: count("path_to_blob"),
    symbols: count("symbols"),
    edges: count("edges"),
  };

  const pathRows = tableExists(viewDb, "path_to_blob")
    ? /** @type {Array<{ repo_rel_path: string, content_hash: string }>} */ (
      viewDb.prepare("SELECT repo_rel_path, content_hash FROM path_to_blob ORDER BY repo_rel_path").all()
    )
    : [];

  const missingPathSample = [];
  if (repoRoot) {
    for (const row of pathRows) {
      const abs = path.join(repoRoot, row.repo_rel_path.replace(/\//g, path.sep));
      if (!fs.existsSync(abs)) missingPathSample.push(row.repo_rel_path);
      if (missingPathSample.length >= sampleLimit) break;
    }
  }
  const missingPathCount = repoRoot
    ? pathRows.reduce((n, row) => {
      const abs = path.join(repoRoot, row.repo_rel_path.replace(/\//g, path.sep));
      return n + (fs.existsSync(abs) ? 0 : 1);
    }, 0)
    : 0;

  const symbolCountForPath = tableExists(viewDb, "symbols")
    ? viewDb.prepare("SELECT COUNT(*) AS n FROM symbols WHERE repo_rel_path = ? AND content_hash = ?")
    : null;
  const currentPathsWithoutSymbols = [];
  if (symbolCountForPath) {
    for (const row of pathRows) {
      const viewSymbols = Number(symbolCountForPath.get(row.repo_rel_path, row.content_hash)?.n || 0);
      if (viewSymbols > 0) continue;
      const layerSymbols = ledgerDb ? countLayerSymbolsForPath(ledgerDb, row.content_hash, row.repo_rel_path) : null;
      if (ledgerDb && Number(layerSymbols || 0) <= 0) continue;
      currentPathsWithoutSymbols.push({
        repo_rel_path: row.repo_rel_path,
        content_hash: row.content_hash,
        layerSymbols,
      });
    }
  }

  const duplicateByKind = tableExists(viewDb, "symbols")
    ? /** @type {Array<{ kind: string, groups: number, extras: number, rows: number }>} */ (
      viewDb.prepare(`
        SELECT kind, COUNT(*) AS groups, SUM(c)-COUNT(*) AS extras, SUM(c) AS rows
        FROM (
          SELECT repo_rel_path, kind, name, range_start, range_start_line, COUNT(*) AS c
          FROM symbols
          GROUP BY repo_rel_path, kind, name, range_start, range_start_line
          HAVING c > 1
        )
        GROUP BY kind
        ORDER BY kind
      `).all()
    )
    : [];
  const sameStartDuplicates = duplicateByKind.reduce(
    (acc, row) => ({
      groups: acc.groups + Number(row.groups || 0),
      extras: acc.extras + Number(row.extras || 0),
      rows: acc.rows + Number(row.rows || 0),
      byKind: acc.byKind,
    }),
    { groups: 0, extras: 0, rows: 0, byKind: duplicateByKind },
  );

  const localNamedCount = tableExists(viewDb, "symbols")
    ? Number(viewDb.prepare("SELECT COUNT(*) AS n FROM symbols WHERE name GLOB 'local [0-9]*'").get()?.n || 0)
    : 0;
  const pathLikeQnames = tableExists(viewDb, "symbols")
    ? Number(viewDb.prepare(`
      SELECT COUNT(*) AS n
      FROM symbols
      WHERE qualified_name LIKE '%.ts.%'
         OR qualified_name LIKE '%.tsx.%'
         OR qualified_name LIKE '%.js.%'
         OR qualified_name LIKE '%.jsx.%'
         OR qualified_name LIKE '%.py.%'
         OR qualified_name LIKE '%.php.%'
    `).get()?.n || 0)
    : 0;

  const danglingBySourceKind = tableExists(viewDb, "edges")
    ? /** @type {Array<{ source: string, kind: string, count: number }>} */ (
      viewDb.prepare(`
        SELECT source, kind, COUNT(*) AS count
        FROM edges
        WHERE to_global_id IS NULL AND to_external_id IS NULL
        GROUP BY source, kind
        ORDER BY count DESC, source, kind
      `).all()
    )
    : [];
  const danglingCount = danglingBySourceKind.reduce((sum, row) => sum + Number(row.count || 0), 0);

  const mismatchBySource = tableExists(viewDb, "edges") && tableExists(viewDb, "symbols")
    ? /** @type {Array<{ source: string, count: number }>} */ (
      viewDb.prepare(`
        SELECT e.source, COUNT(*) AS count
        FROM edges e
        JOIN symbols t ON t.global_id = e.to_global_id
        WHERE e.to_global_id IS NOT NULL
          AND e.to_name <> t.name
          AND REPLACE(e.to_name, 'local-', 'local ') <> t.name
        GROUP BY e.source
        ORDER BY count DESC, e.source
      `).all()
    )
    : [];
  const mismatchCount = mismatchBySource.reduce((sum, row) => sum + Number(row.count || 0), 0);

  const warnings = [];
  if (missingPathCount > 0) warnings.push({ kind: "missing_paths_on_disk", count: missingPathCount, detail: "path_to_blob contains files that no longer exist" });
  if (currentPathsWithoutSymbols.length > 0) warnings.push({ kind: "current_paths_without_symbols", count: currentPathsWithoutSymbols.length, detail: "current path hashes have indexed layer symbols but no view symbols" });
  if (sameStartDuplicates.groups > 0) warnings.push({ kind: "same_start_duplicate_symbols", count: sameStartDuplicates.groups, detail: "symbols share path/kind/name/start and may indicate failed source unification" });
  if (localNamedCount > 0) warnings.push({ kind: "local_named_symbols", count: localNamedCount, detail: "SCIP local temporaries leaked into the retrieval view" });
  if (pathLikeQnames > 0) warnings.push({ kind: "path_like_qualified_names", count: pathLikeQnames, detail: "qualified names contain file-extension path segments" });
  if (danglingCount > 0) warnings.push({ kind: "dangling_edges", count: danglingCount, detail: "edges have no resolved internal or external target" });
  if (mismatchCount > 0) warnings.push({ kind: "resolved_edge_name_mismatches", count: mismatchCount, detail: "resolved edges point at symbols whose names do not match the edge target" });

  return {
    totals,
    missingPathsOnDisk: { count: missingPathCount, sample: missingPathSample },
    currentPathsWithoutSymbols: {
      count: currentPathsWithoutSymbols.length,
      sample: currentPathsWithoutSymbols.slice(0, sampleLimit),
    },
    sameStartDuplicates,
    localNamedSymbols: { count: localNamedCount, ratio: totals.symbols > 0 ? localNamedCount / totals.symbols : 0 },
    pathLikeQualifiedNames: { count: pathLikeQnames, ratio: totals.symbols > 0 ? pathLikeQnames / totals.symbols : 0 },
    danglingEdges: { count: danglingCount, bySourceKind: danglingBySourceKind },
    resolvedEdgeNameMismatches: { count: mismatchCount, bySource: mismatchBySource },
    warnings,
  };
}

function tableExists(db, table) {
  try {
    return !!db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function countLayerSymbolsForPath(ledgerDb, contentHash, repoRelPath) {
  if (!tableExists(ledgerDb, "blob_layers") || !tableExists(ledgerDb, "blob_layer_symbols")) return null;
  const lang = languageForPath(repoRelPath);
  const params = [contentHash];
  let langWhere = "";
  if (lang && lang !== "unknown") {
    langWhere = "AND bl.lang = ?";
    params.push(lang);
  }
  const row = ledgerDb.prepare(`
    SELECT COUNT(*) AS n
    FROM blob_layers bl
    JOIN blob_layer_symbols s ON s.layer_id = bl.id
    WHERE bl.content_hash = ?
      ${langWhere}
      AND bl.status = 'indexed'
  `).get(...params);
  return Number(row?.n || 0);
}
