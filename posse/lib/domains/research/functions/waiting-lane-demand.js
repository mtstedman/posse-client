// @ts-check
//
// Waiting-lane demand belongs at routing/research boundaries, not in provider
// execution. These helpers deliberately perform only bounded local reads and
// durable queue updates. Missing settings, legacy Atlas views, and any failure
// to prove an exact published generation all fail closed without creating a
// preparation row.

import { WAITING_LANE_SETTING_KEYS, normalizeWaitingLaneGeneration } from "../../../catalog/waiting-lane.js";
import { View } from "../../atlas/classes/v2/View.js";
import { mainViewPath } from "../../atlas/functions/v2/runtime-paths.js";
import {
  getWaitingLanePreparation,
  storeWaitingLaneHotPaths,
} from "../../queue/functions/waiting-lane-preparations.js";
import { requestWaitingLanePreparation } from "../../scheduler/functions/waiting-lane-coordinator.js";
import { getSetting } from "../../settings/functions/repository-settings.js";
import { extractResearcherFiles } from "../../handoff/functions/helpers/researcher-output.js";
import { recordWaitingLaneTelemetry } from "../../observability/functions/waiting-lane-telemetry.js";

const DEFAULT_MAX_HOT_PATHS = 64;

function settingEnabled(value) {
  return /^(?:1|true|yes|on)$/iu.test(String(value || "").trim());
}

function demandControlsEnabled(projectDir, getSettingFn = getSetting) {
  try {
    const options = projectDir ? { projectDir } : {};
    const shadowMode = String(getSettingFn(WAITING_LANE_SETTING_KEYS.SHADOW_MODE, options) || "off")
      .trim()
      .toLowerCase();
    const gitEnabled = settingEnabled(getSettingFn(
      WAITING_LANE_SETTING_KEYS.GIT_PREPARATION_ENABLED,
      options,
    ));
    return shadowMode === "shadow" || gitEnabled;
  } catch {
    return false;
  }
}

function maxHotPaths(projectDir, getSettingFn = getSetting) {
  try {
    const raw = Number.parseInt(String(getSettingFn(
      WAITING_LANE_SETTING_KEYS.MAX_HOT_PATHS,
      projectDir ? { projectDir } : {},
    ) || ""), 10);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_HOT_PATHS;
  } catch {
    return DEFAULT_MAX_HOT_PATHS;
  }
}

function skipped(reason, preparation = null) {
  return { outcome: "ineligible", preparation, reason };
}

function observedDemand(event, result, { workItemId, demandReason }) {
  recordWaitingLaneTelemetry(event, {
    preparation: result?.preparation,
    workItemId: Number(workItemId),
    demandReason,
    outcome: result?.outcome,
    reason: result?.reason,
  });
  return result;
}

/**
 * @param {{ workItem?: any, payload?: Record<string, any>, reportMode?: boolean, webOnlyAnswer?: boolean }} [args]
 */
function researchDemandSuppression({ workItem, payload = {}, reportMode = false, webOnlyAnswer = false } = {}) {
  if (!workItem?.id) return "missing_work_item";
  if (payload?.fanout_shadow === true) return "shadow_fanout";
  if (payload?._is_loopback === true || payload?._human_clarification_completed === true) {
    return "follow_up_research";
  }
  if (webOnlyAnswer || payload?.web_only_answer === true) return "web_only_answer";
  const taskMode = String(payload?.task_mode || workItem?.mode || "").trim().toLowerCase();
  if (reportMode || ["report", "question"].includes(taskMode)) return "report_or_question";
  if (["artifact", "content", "image"].includes(taskMode)) return "artifact_only";
  return null;
}

/**
 * Read an exact generation from durable main-view metadata. Old views do not
 * expose generationLocal(), and unpublished views return null by contract.
 *
 * @param {string | null | undefined} repoRoot
 * @param {{ ViewClass?: typeof View, mainViewPathFn?: typeof mainViewPath }} [deps]
 */
export function readPublishedWaitingLaneGeneration(repoRoot, {
  ViewClass = View,
  mainViewPathFn = mainViewPath,
} = {}) {
  if (!repoRoot || typeof repoRoot !== "string") return null;
  let view = null;
  try {
    view = ViewClass.mount({ dbPath: mainViewPathFn(repoRoot), mode: "readonly" });
    if (typeof view?.generationLocal !== "function") return null;
    return normalizeWaitingLaneGeneration(view.generationLocal());
  } catch {
    return null;
  } finally {
    try { view?.close?.(); } catch { /* read-only probe cleanup is best effort */ }
  }
}

/**
 * Request the one durable research demand after handoff/context prefetch. A
 * second fanout child, synthesis job, or retry observes the existing WI row
 * and performs no new generation read or state transition.
 *
 * @param {any} [args]
 * @param {any} [deps]
 */
export function requestWaitingLaneResearchDemand({
  workItem,
  payload = {},
  projectDir = null,
  atlasRepoRoot = null,
  reportMode = false,
  webOnlyAnswer = false,
  generation = null,
} = {}, {
  getSettingFn = getSetting,
  getPreparationFn = getWaitingLanePreparation,
  requestPreparationFn = requestWaitingLanePreparation,
  readGenerationFn = readPublishedWaitingLaneGeneration,
} = {}) {
  if (!demandControlsEnabled(projectDir, getSettingFn)) {
    return observedDemand("demand_suppressed", skipped("disabled"), {
      workItemId: workItem?.id,
      demandReason: "research",
    });
  }
  const suppression = researchDemandSuppression({ workItem, payload, reportMode, webOnlyAnswer });
  if (suppression) {
    return observedDemand("demand_suppressed", skipped(suppression), {
      workItemId: workItem?.id,
      demandReason: "research",
    });
  }

  try {
    const existing = getPreparationFn(Number(workItem.id));
    if (existing) {
      return observedDemand("demand_deduped", {
        outcome: "already_current",
        preparation: existing,
        reason: "deduped_existing",
      }, { workItemId: workItem.id, demandReason: "research" });
    }

    const published = normalizeWaitingLaneGeneration(
      generation || readGenerationFn(atlasRepoRoot || projectDir),
    );
    if (!published) {
      return observedDemand("demand_suppressed", skipped("published_generation_unavailable"), {
        workItemId: workItem.id,
        demandReason: "research",
      });
    }

    return requestPreparationFn(/** @type {any} */ ({
      workItemId: Number(workItem.id),
      demandReason: "research",
      targetBranch: published.target_branch,
      generation: published,
    }));
  } catch {
    return observedDemand("demand_suppressed", skipped("demand_write_failed"), {
      workItemId: workItem?.id,
      demandReason: "research",
    });
  }
}

/**
 * Promote an existing research/planner row when planning materializes real dev
 * work. This never invents a generation: a legacy or partial row is inert.
 *
 * @param {any} [args]
 * @param {any} [deps]
 */
export function promoteWaitingLaneOnDevDemand({ workItemId, projectDir = null } = {}, {
  getSettingFn = getSetting,
  getPreparationFn = getWaitingLanePreparation,
  requestPreparationFn = requestWaitingLanePreparation,
} = {}) {
  if (!demandControlsEnabled(projectDir, getSettingFn)) {
    return observedDemand("demand_suppressed", skipped("disabled"), {
      workItemId,
      demandReason: "dev",
    });
  }
  if (!Number.isSafeInteger(Number(workItemId)) || Number(workItemId) <= 0) {
    return observedDemand("demand_suppressed", skipped("missing_work_item"), {
      workItemId,
      demandReason: "dev",
    });
  }
  try {
    const existing = getPreparationFn(Number(workItemId));
    const generation = normalizeWaitingLaneGeneration(existing?.desired_generation);
    if (!existing) {
      return observedDemand("demand_suppressed", skipped("missing_preparation"), {
        workItemId,
        demandReason: "dev",
      });
    }
    if (!generation) {
      return observedDemand(
        "demand_suppressed",
        skipped("published_generation_unavailable", existing),
        { workItemId, demandReason: "dev" },
      );
    }
    return requestPreparationFn(/** @type {any} */ ({
      workItemId: Number(workItemId),
      demandReason: "dev",
      targetBranch: generation.target_branch,
      generation,
    }));
  } catch {
    return observedDemand("demand_suppressed", skipped("demand_write_failed"), {
      workItemId,
      demandReason: "dev",
    });
  }
}

/**
 * Reconcile an existing speculative row with the latest published generation
 * at the planner boundary.  Planning never creates a cold lane: without the
 * research-time row it keeps the established main-root path.  Once a planner
 * has reserved an exact asset, later planners in the same chain reuse that
 * frozen applied generation while main publications update only dev's desired
 * generation.
 *
 * @param {any} [args]
 * @param {any} [deps]
 */
export function requestWaitingLanePlannerDemand({
  workItemId,
  projectDir = null,
  atlasRepoRoot = null,
  generation = null,
} = {}, {
  getSettingFn = getSetting,
  getPreparationFn = getWaitingLanePreparation,
  requestPreparationFn = requestWaitingLanePreparation,
  readGenerationFn = readPublishedWaitingLaneGeneration,
} = {}) {
  if (!demandControlsEnabled(projectDir, getSettingFn)) {
    return observedDemand("demand_suppressed", skipped("disabled"), {
      workItemId,
      demandReason: "planner",
    });
  }
  if (!Number.isSafeInteger(Number(workItemId)) || Number(workItemId) <= 0) {
    return observedDemand("demand_suppressed", skipped("missing_work_item"), {
      workItemId,
      demandReason: "planner",
    });
  }
  try {
    const existing = getPreparationFn(Number(workItemId));
    if (!existing) {
      return observedDemand("demand_suppressed", skipped("missing_preparation"), {
        workItemId,
        demandReason: "planner",
      });
    }
    if (existing.state === "activating" && existing.demand_reason === "planner") {
      return observedDemand("demand_deduped", {
        outcome: "already_current",
        preparation: existing,
        reason: "planner_reserved",
      }, { workItemId, demandReason: "planner" });
    }

    const published = normalizeWaitingLaneGeneration(
      generation || readGenerationFn(atlasRepoRoot || projectDir),
    );
    if (!published) {
      return observedDemand(
        "demand_suppressed",
        skipped("published_generation_unavailable", existing),
        { workItemId, demandReason: "planner" },
      );
    }
    return requestPreparationFn(/** @type {any} */ ({
      workItemId: Number(workItemId),
      demandReason: "planner",
      targetBranch: published.target_branch,
      generation: published,
    }));
  } catch {
    return observedDemand("demand_suppressed", skipped("demand_write_failed"), {
      workItemId,
      demandReason: "planner",
    });
  }
}

/**
 * Persist only the bounded canonical paths from the final solo/synthesis
 * research appendix. This updates the existing row; it cannot enqueue or
 * recreate preparation work.
 *
 * @param {any} [args]
 * @param {any} [deps]
 */
export function captureWaitingLaneResearchHotPaths({
  workItemId,
  output,
  roleMode = "solo",
  shadow = false,
  projectDir = null,
} = {}, {
  getSettingFn = getSetting,
  getPreparationFn = getWaitingLanePreparation,
  storeHotPathsFn = storeWaitingLaneHotPaths,
} = {}) {
  if (!demandControlsEnabled(projectDir, getSettingFn)) return skipped("disabled");
  if (shadow) return skipped("shadow_fanout");
  if (!Number.isSafeInteger(Number(workItemId)) || Number(workItemId) <= 0) {
    return skipped("missing_work_item");
  }
  const normalizedRoleMode = String(roleMode || "solo").trim().toLowerCase();
  if (normalizedRoleMode === "child") return skipped("fanout_child");

  try {
    const existing = getPreparationFn(Number(workItemId));
    if (!existing) return skipped("missing_preparation");
    const extracted = extractResearcherFiles([{ content_long: String(output || "") }]);
    if (extracted.length === 0) return { outcome: "already_current", preparation: existing, reason: "no_hot_paths" };
    const limit = maxHotPaths(projectDir, getSettingFn);
    return storeHotPathsFn(/** @type {any} */ ({
      workItemId: Number(workItemId),
      hotPaths: [...extracted, ...(existing.hot_paths || [])],
      maxPaths: limit,
    }));
  } catch {
    return skipped("hot_path_write_failed");
  }
}
