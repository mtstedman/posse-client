// @ts-check
//
// Batch session directory GC. Every SCIP batch staging session writes
// `<scipDir>/batches/<sessionId>/` (manifest + one `.scip` per batch) and
// nothing removed them, so the scip dir grew by a full artifact set per
// session. After a completed full-fileset session, only that session and the
// sessions its reused batches point into can still be read: batch reuse
// resolves outputs inside the session that owns the file, and the current
// manifest names every such owner in `resumedFromSessions`.

import fs from "node:fs";
import path from "node:path";

/**
 * A `running` session (or a directory whose manifest is not written yet) is
 * treated as in progress while it was touched this recently. The manifest is
 * rewritten after every acknowledged batch, so an older one belongs to a
 * process that died mid-session.
 */
export const SCIP_BATCH_SESSION_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   removed: string[],
 *   kept: string[],
 *   failed: Array<{ session: string, error: string }>,
 *   skipped: string | null,
 * }} ScipBatchSessionGcResult
 */

/**
 * Delete the batch session directories the completed session `currentSessionId`
 * no longer references. Fail closed: nothing is deleted unless the current
 * session's own manifest is readable and `complete`, and the batches root is a
 * real directory inside the scip dir. Entries that are not real directories
 * (symlinks included) are never touched. A failed delete is reported and the
 * rest continue; the next completed session retries it.
 *
 * @param {{ scipDir: string, currentSessionId: string, nowMs?: number }} input
 * @returns {Promise<ScipBatchSessionGcResult>}
 */
export async function collectScipBatchSessions({ scipDir, currentSessionId, nowMs = Date.now() }) {
  /** @type {ScipBatchSessionGcResult} */
  const result = { removed: [], kept: [], failed: [], skipped: null };
  const current = String(currentSessionId || "");
  if (!scipDir || !current || current !== path.basename(current)) {
    return { ...result, skipped: "no_current_session" };
  }
  const batchesRoot = path.join(scipDir, "batches");
  try {
    const stat = await fs.promises.lstat(batchesRoot);
    if (!stat.isDirectory()) return { ...result, skipped: "batches_root_not_directory" };
    const [realScipDir, realBatchesRoot] = await Promise.all([
      fs.promises.realpath(scipDir),
      fs.promises.realpath(batchesRoot),
    ]);
    if (realBatchesRoot !== path.join(realScipDir, "batches")) {
      return { ...result, skipped: "batches_root_escapes_scip_dir" };
    }
  } catch {
    return { ...result, skipped: "batches_root_unreadable" };
  }

  const currentManifest = await readSessionManifest(path.join(batchesRoot, current));
  if (!currentManifest || currentManifest.state?.status !== "complete"
    || String(currentManifest.state?.sessionId || current) !== current) {
    return { ...result, skipped: "current_session_not_complete" };
  }
  const referenced = new Set([current]);
  for (const sessionId of Array.isArray(currentManifest.state?.resumedFromSessions)
    ? currentManifest.state.resumedFromSessions
    : []) {
    referenced.add(String(sessionId));
  }

  let entries = [];
  try {
    entries = await fs.promises.readdir(batchesRoot, { withFileTypes: true });
  } catch {
    return { ...result, skipped: "batches_root_unreadable" };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Dirent types come from lstat: a symlink is never a directory here, so a
    // link out of the scip root is neither followed nor removed.
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(batchesRoot, entry.name);
    const manifest = await readSessionManifest(sessionDir);
    const manifestSessionId = manifest?.state?.sessionId ? String(manifest.state.sessionId) : null;
    if (referenced.has(entry.name) || (manifestSessionId && referenced.has(manifestSessionId))) {
      result.kept.push(entry.name);
      continue;
    }
    if (await sessionMayBeInProgress(sessionDir, manifest, nowMs)) {
      result.kept.push(entry.name);
      continue;
    }
    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      result.removed.push(entry.name);
    } catch (err) {
      result.failed.push({ session: entry.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * @param {string} sessionDir
 * @returns {Promise<{ state: Record<string, any>, mtimeMs: number } | null>}
 */
async function readSessionManifest(sessionDir) {
  const manifestPath = path.join(sessionDir, "manifest.json");
  try {
    const stat = await fs.promises.lstat(manifestPath);
    if (!stat.isFile()) return null;
    const state = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    if (!state || typeof state !== "object") return null;
    return { state, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * @param {string} sessionDir
 * @param {{ state: Record<string, any>, mtimeMs: number } | null} manifest
 * @param {number} nowMs
 */
async function sessionMayBeInProgress(sessionDir, manifest, nowMs) {
  const status = String(manifest?.state?.status || "").toLowerCase();
  if (manifest && status !== "running") return false;
  let touchedMs = manifest?.mtimeMs ?? null;
  if (touchedMs == null) {
    try { touchedMs = (await fs.promises.lstat(sessionDir)).mtimeMs; } catch { return true; }
  }
  return nowMs - touchedMs < SCIP_BATCH_SESSION_STALE_MS;
}
