// @ts-check
//
// Helpers for treating ATLAS v2 view databases as rebuildable caches. A view
// file can exist while still being unusable (empty, partially written, old
// schema, missing meta). Callers should validate before mounting it as the
// authoritative read cache.

import fs from "fs";

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
  for (const sfx of ["", "-wal", "-shm"]) {
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
    const meta = view.meta();
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
 * }} args
 * @returns {Promise<ReturnType<typeof openViewWithMeta> & { freshness?: ReturnType<typeof viewFreshness>, attempts?: number }>}
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
  /** @type {ReturnType<typeof openViewWithMeta> & { freshness?: ReturnType<typeof viewFreshness>, attempts?: number }} */
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
