import {
  ATLAS_WARM_JOB_POLICY,
  ATLAS_WARM_JOB_TYPE,
} from "../../atlas/functions/v2/contracts/jobs.js";
import { createWorkItem, getLiveSchedulerBlockMessage } from "../../queue/functions/index.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { projectBridgeWorkItem } from "./state-snapshot.js";

const MAX_WORK_ITEM_DESCRIPTION_CHARS = 20_000;

export function addBridgeWorkItem(args = {}, context = {}) {
  const description = String(args.description || "").trim();
  if (!description) return { ok: false, reason: "invalid_description" };
  if (description.length > MAX_WORK_ITEM_DESCRIPTION_CHARS) {
    return { ok: false, reason: "invalid_description", message: "description is too long" };
  }

  const title = (
    description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || description
  ).slice(0, 100);
  const item = createWorkItem(title, description, "normal", {
    source: "bridge",
    requested_by: String(context.actor || "bridge"),
    mode: "build",
  });

  return {
    work_item: projectBridgeWorkItem(item),
  };
}

export async function startBridgeRun(args = {}, context = {}) {
  if (typeof context.startPosse !== "function") {
    return { ok: false, reason: "run_launcher_unavailable" };
  }
  return context.startPosse(args);
}

/**
 * Stage an incremental main-branch ATLAS warm and kick the detached run so
 * the warm executes now instead of at the next `posse go` boot. The warm job
 * itself is drained by the scheduler's background lane (AtlasWarmRole); the
 * run is what hosts that lane, so an idle repo boots, warms, and winds down.
 * If work is already queued the run will pick it up too — clients must say
 * so in their confirmation UX.
 */
export async function warmBridgeAtlas(args = {}, context = {}) {
  const db = getDb();
  const payload = {
    purpose: "main-incremental",
    branch: "main",
    paths: [],
    trigger_event: "bridge.atlas_warm",
  };
  const info = db.prepare(`
    INSERT INTO jobs (
      work_item_id, job_type, title,
      priority, model_tier, reasoning_effort, provider,
      max_attempts, payload_json, ready_at
    ) VALUES (NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
  `).run(
    ATLAS_WARM_JOB_TYPE,
    "ATLAS warm: main-incremental",
    ATLAS_WARM_JOB_POLICY.defaultPriority,
    ATLAS_WARM_JOB_POLICY.maxAttempts,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
  const jobId = Number(info.lastInsertRowid);

  // A live scheduler will drain the warm on its own; otherwise launch the
  // detached run to host it. startPosse is idempotent under the scheduler
  // lock, so the race between this check and the spawn is harmless.
  const schedulerLive = Boolean(getLiveSchedulerBlockMessage("main"));
  let run = { started: false, already_running: schedulerLive };
  if (!schedulerLive && typeof context.startPosse === "function") {
    run = await context.startPosse({});
  }
  return {
    queued: true,
    job_id: jobId,
    purpose: payload.purpose,
    run,
  };
}
