import {
  ATLAS_WARM_JOB_POLICY,
  ATLAS_WARM_JOB_TYPE,
} from "../../atlas/functions/v2/contracts/jobs.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import {
  createOperatorNudge,
  createWorkItem,
  getJob,
  getLiveSchedulerBlockMessage,
  getSchedulerLockInfo,
  getWorkItem,
  runInTransaction,
  updateWorkItemStatus,
} from "../../queue/functions/index.js";
import {
  RUNTIME_STATUS_KEYS,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import {
  classifyResearchForRouting,
  createInitialResearchOrPlanJob,
} from "../../research/functions/intake-routing.js";
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
  return runInTransaction(() => {
    const item = createWorkItem(title, description, "normal", {
      source: "bridge",
      requested_by: String(context.actor || "bridge"),
      mode: "build",
    });

    if (getLiveSchedulerBlockMessage("main")) {
      const projectDir = context.projectDir || process.cwd();
      const deepthinkBudget = "normal";
      updateWorkItemStatus(item.id, "planning");
      createInitialResearchOrPlanJob(item, {
        deepthinkBudget,
        source: "bridge_inject",
        projectDir,
        routing: classifyResearchForRouting({
          projectDir,
          workItem: item,
          mode: item.mode,
          source: "bridge_inject",
          live: true,
        }),
      });
    }

    return {
      work_item: projectBridgeWorkItem(getWorkItem(item.id) || item),
    };
  });
}

export async function startBridgeRun(args = {}, context = {}) {
  if (typeof context.startPosse !== "function") {
    return { ok: false, reason: "run_launcher_unavailable" };
  }
  return context.startPosse(args);
}

/**
 * Ask the live run to wind down gracefully. The bridge only shares the
 * SQLite DB with the detached run process, so the request travels as a
 * runtime_status row the scheduler loop polls (~2s). Owner-stamped so a
 * request can never outlive its target and stop a later run; the ack means
 * "stop requested", not "stopped" — clients watch instance_status for the
 * wind-down.
 */
export function stopBridgeRun(args = {}, context = {}) {
  if (!getLiveSchedulerBlockMessage("main")) {
    return { stopping: false, not_running: true };
  }
  const lock = getSchedulerLockInfo("main");
  const written = writeRuntimeStatus(RUNTIME_STATUS_KEYS.STOP_REQUEST, {
    requested_at: new Date().toISOString(),
    owner_id: lock?.owner_id || null,
    source: "bridge",
    actor: String(context.actor || "remote-operator"),
  });
  if (!written) return { ok: false, reason: "stop_request_write_failed" };
  return { stopping: true };
}

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const NUDGE_BODY_MAX_CHARS = 4000;
// Job types that never run a provider agent, so they never produce a tool
// result that can carry direct feedback. A nudge written against one sits
// unread forever, and is silently expired at finalize — worse than an
// honest refusal.
const NUDGE_INELIGIBLE_JOB_TYPES = new Set(["human_input", "atlas_warm"]);

/**
 * Deliver operator guidance to a live job. Running agents pick the nudge up
 * on their next tool result as a direct delivery; latest nudge wins
 * (createOperatorNudge supersedes prior actives atomically).
 */
export function nudgeBridgeJob(args = {}, context = {}) {
  const jobId = Number(args.job_id ?? args.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) return { ok: false, reason: "invalid_job_id" };
  const body = String(args.body ?? "").trim();
  if (!body) return { ok: false, reason: "invalid_body" };
  if (body.length > NUDGE_BODY_MAX_CHARS) {
    return { ok: false, reason: "invalid_body", message: "nudge body is too long" };
  }
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: "no_such_job" };
  if (TERMINAL_JOB_STATUS_SET.has(job.status)) {
    return { ok: false, reason: "job_not_active" };
  }
  if (NUDGE_INELIGIBLE_JOB_TYPES.has(job.job_type)) {
    return {
      ok: false,
      reason: "job_not_nudgeable",
      message: `${job.job_type} jobs never read operator feedback; answer the gate instead`,
    };
  }
  const row = createOperatorNudge({
    job_id: jobId,
    work_item_id: Number(job.work_item_id) || null,
    body,
    source: "bridge",
    author: String(context.actor || "remote-operator"),
  });
  return { interaction_id: Number(row.id) };
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
