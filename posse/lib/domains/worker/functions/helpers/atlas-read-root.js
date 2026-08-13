import fs from "node:fs";
import path from "node:path";

import { worktreeViewPath } from "../../../atlas/functions/v2/runtime-paths.js";
import {
  ensureWorkItemAtlasJoinAsync,
  getAtlasIntegrationConfig,
} from "../../../integrations/functions/atlas.js";

/**
 * Read-only planner/research roles can inspect a WI worktree or a detached
 * branch snapshot without going through the mutating worktree setup path.
 * ATLAS still requires a view mounted inside that exact read root. Prepare
 * the mount before handoff resolution and return a fail-open signal when the
 * mount cannot be made; callers then disable ATLAS for that packet so native
 * reads are available immediately.
 */
export async function ensureAtlasReadRootMounted({
  projectDir,
  readRoot,
  workItemId,
  signal = null,
  ensureJoin = ensureWorkItemAtlasJoinAsync,
  config = getAtlasIntegrationConfig(),
} = {}) {
  const projectRoot = path.resolve(String(projectDir || process.cwd()));
  const targetRoot = path.resolve(String(readRoot || projectRoot));
  if (targetRoot === projectRoot) {
    return { required: false, mounted: true, viewPath: null, reason: null, config: null };
  }

  const numericWorkItemId = Number(workItemId);
  const viewPath = worktreeViewPath(targetRoot);
  if (!Number.isInteger(numericWorkItemId) || numericWorkItemId <= 0) {
    return {
      required: true,
      mounted: false,
      viewPath,
      reason: "missing_work_item_id",
      config: null,
    };
  }

  let joined = null;
  try {
    joined = await ensureJoin({
      projectDir: projectRoot,
      worktreePath: targetRoot,
      workItemId: numericWorkItemId,
      config,
      signal,
    });
    const mounted = joined?.mounted === true && fs.existsSync(viewPath);
    return {
      required: true,
      mounted,
      viewPath,
      reason: mounted ? null : (joined?.error || joined?.skipped || joined?.state || "view_not_mounted"),
      config: joined?.config || null,
    };
  } catch (error) {
    return {
      required: true,
      mounted: false,
      viewPath,
      reason: error?.message || String(error),
      config: null,
    };
  } finally {
    try { joined?.view?.close?.(); } catch { /* best effort */ }
  }
}
