import fs from "node:fs";
import path from "node:path";

import { waitingLaneGenerationsEqual } from "../../../../catalog/waiting-lane.js";
import { View } from "../../../atlas/classes/v2/View.js";
import { ViewBuilder } from "../../../atlas/classes/v2/ViewBuilder.js";
import { invalidateStorageCacheNativeAsync } from "../../../atlas/functions/v2/native/storage.js";
import { worktreeViewPath } from "../../../atlas/functions/v2/runtime-paths.js";
import { removeSqliteFile } from "../../../atlas/functions/v2/view-health.js";
import { withAtlasViewWriteLock } from "../../../atlas/functions/v2/view-write-lock.js";
import {
  ensureWorkItemAtlasJoinAsync,
  getAtlasIntegrationConfig,
  resolveWorkItemAtlasContext,
} from "../../../integrations/functions/atlas.js";

function exactViewGeneration(viewPath, generation, ViewClass = View) {
  if (!viewPath || !generation || !fs.existsSync(viewPath)) return false;
  let view = null;
  try {
    view = ViewClass.mount({ dbPath: viewPath, mode: "readonly" });
    return waitingLaneGenerationsEqual(view.generationLocal(), generation);
  } catch {
    return false;
  } finally {
    try { view?.close?.(); } catch { /* best effort */ }
  }
}

/**
 * Materialize a read-only planner clone without consuming or rebranding the
 * parked source. Dev activation remains the sole owner of the WI ledger fork
 * and warmed-view move.
 */
export async function ensureWaitingLanePlannerAtlasReadView({
  projectDir,
  readRoot,
  workItemId,
  plannerRead,
  signal = null,
  config = getAtlasIntegrationConfig(),
  deps = {},
} = {}) {
  const resolveContext = deps.resolveWorkItemAtlasContext || resolveWorkItemAtlasContext;
  const ViewClass = deps.View || View;
  const BuilderClass = deps.ViewBuilder || ViewBuilder;
  const withViewLock = deps.withAtlasViewWriteLock || withAtlasViewWriteLock;
  const invalidateStorage = deps.invalidateStorageCacheNativeAsync || invalidateStorageCacheNativeAsync;
  const removeView = deps.removeSqliteFile || removeSqliteFile;
  const generation = plannerRead?.generation || null;
  if (!generation || plannerRead?.atlasSource === "disabled") {
    return {
      required: true,
      mounted: false,
      viewPath: worktreeViewPath(readRoot),
      reason: "waiting_lane_planner_atlas_generation_unavailable",
      config: null,
    };
  }

  const ctx = resolveContext({
    projectDir,
    worktreePath: readRoot,
    workItemId,
    config,
  });
  const sourcePath = plannerRead.atlasSource === "parked"
    ? ctx.warmedViewDbPath
    : ctx.mainViewDbPath;
  const destPath = ctx.viewDbPath || worktreeViewPath(readRoot);
  if (!sourcePath || !destPath) {
    return { required: true, mounted: false, viewPath: destPath, reason: "waiting_lane_planner_view_path_missing", config: null };
  }

  try {
    await withViewLock(sourcePath, async () => {
      if (!exactViewGeneration(sourcePath, generation, ViewClass)) {
        throw new Error("waiting_lane_planner_source_generation_mismatch");
      }
      await withViewLock(destPath, async () => {
        if (exactViewGeneration(destPath, generation, ViewClass)) return;
        if (fs.existsSync(destPath)) {
          await invalidateStorage([destPath]);
          removeView(destPath);
        }
        if (signal?.aborted) {
          throw (signal.reason instanceof Error ? signal.reason : new Error("planner Atlas clone aborted"));
        }
        const builder = new BuilderClass();
        if (typeof builder.cloneViewAsync === "function") {
          await builder.cloneViewAsync({ sourcePath, destPath }, {
            label: "waiting-lane.planner.clone",
            waitMs: 30_000,
          });
        } else {
          builder.cloneView({ sourcePath, destPath });
        }
        if (!exactViewGeneration(destPath, generation, ViewClass)) {
          try { removeView(destPath); } catch { /* preserve primary mismatch */ }
          throw new Error("waiting_lane_planner_clone_generation_mismatch");
        }
      });
    });
    return {
      required: true,
      mounted: true,
      viewPath: destPath,
      reason: null,
      config: ctx.config || config,
      source: plannerRead.atlasSource,
    };
  } catch (error) {
    return {
      required: true,
      mounted: false,
      viewPath: destPath,
      reason: error?.message || String(error),
      config: null,
    };
  }
}

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
  waitingLanePlannerRead = null,
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

  if (waitingLanePlannerRead?.reserved === true) {
    return ensureWaitingLanePlannerAtlasReadView({
      projectDir: projectRoot,
      readRoot: targetRoot,
      workItemId: numericWorkItemId,
      plannerRead: waitingLanePlannerRead,
      signal,
      config,
    });
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
