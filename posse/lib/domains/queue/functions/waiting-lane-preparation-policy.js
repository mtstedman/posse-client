import path from "node:path";

import {
  LOCK_HOLDING_JOB_STATUSES,
  WORKTREE_JOB_TYPES,
} from "../../../catalog/job.js";
import {
  normalizeWaitingLaneGeneration,
  waitingLaneGenerationsEqual,
} from "../../../catalog/waiting-lane.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";

const DEFAULT_MAX_HOT_PATHS = 32;
const ABSOLUTE_MAX_HOT_PATHS = 256;
const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const LOCK_HOLDING_JOB_STATUS_SET = new Set(LOCK_HOLDING_JOB_STATUSES);

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function taskModeForJob(job) {
  const payload = parseObject(job?.payload_json);
  return String(payload.task_mode || "").trim().toLowerCase();
}

function jobRequiresWorktree(job) {
  if (!WORKTREE_JOB_TYPES.has(job?.job_type)) return false;
  if (job.job_type === "promote") return true;
  const taskMode = taskModeForJob(job);
  return !taskMode || taskMode === "code";
}

/**
 * Pure, conservative eligibility check. Callers may use the reason for shadow
 * telemetry, while the state writer persists only an `ineligible` outcome.
 */
export function evaluateWaitingLaneEligibility({ workItem, jobs = [] } = {}) {
  if (!workItem) return { eligible: false, reason: "missing_work_item" };
  if (workItem.mode !== "build") return { eligible: false, reason: "non_build_mode" };
  if (TERMINAL_WORK_ITEM_STATUS_SET.has(workItem.status)) {
    return { eligible: false, reason: "terminal_work_item" };
  }
  if (normalizeOptionalString(workItem.branch_name)) {
    return { eligible: false, reason: "existing_branch" };
  }
  if (normalizeOptionalString(workItem.merge_state)) {
    return { eligible: false, reason: "existing_merge_state" };
  }

  const metadata = parseObject(workItem.metadata_json);
  const hints = metadata.intake_hints && typeof metadata.intake_hints === "object"
    ? metadata.intake_hints
    : {};
  const outputMode = String(hints.output_mode || metadata.output_mode || "").trim().toLowerCase();
  const desiredOutputs = Array.isArray(hints.desired_outputs)
    ? hints.desired_outputs.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
    : [];

  if (
    workItem.source === "ask"
    || String(metadata.mode || "").trim().toLowerCase() === "question"
    || String(metadata.workflow_mode || "").trim().toLowerCase() === "audit"
    || outputMode === "question_only"
    || desiredOutputs.includes("question_only")
  ) {
    return { eligible: false, reason: "question_only" };
  }
  if (
    outputMode === "artifact"
    || (desiredOutputs.length > 0 && desiredOutputs.every((value) => value === "artifact"))
  ) {
    return { eligible: false, reason: "artifact_only" };
  }
  if (metadata.fanout_shadow === true || metadata.shadow_fanout === true) {
    return { eligible: false, reason: "shadow_fanout" };
  }
  if (metadata.iterate || metadata.workflow_mode) {
    return { eligible: false, reason: "iterative_lineage" };
  }

  if (jobs.some((job) => Number(job.has_committed_attempt) === 1)) {
    return { eligible: false, reason: "prior_committed_mutation" };
  }
  if (jobs.some((job) => LOCK_HOLDING_JOB_STATUS_SET.has(job.status) && jobRequiresWorktree(job))) {
    return { eligible: false, reason: "active_or_parked_worktree" };
  }

  const declaredTaskModes = jobs.map(taskModeForJob).filter(Boolean);
  if (
    declaredTaskModes.length > 0
    && !jobs.some(jobRequiresWorktree)
    && declaredTaskModes.every((mode) => ["report", "content", "image"].includes(mode))
  ) {
    return { eligible: false, reason: "artifact_only" };
  }
  if (declaredTaskModes.length > 0 && !jobs.some(jobRequiresWorktree)) {
    return { eligible: false, reason: "non_worktree_mode" };
  }

  return { eligible: true, reason: null };
}

export function normalizeWaitingLaneHotPaths(hotPaths, maxPaths = DEFAULT_MAX_HOT_PATHS) {
  const requestedMax = Number.isSafeInteger(maxPaths) && maxPaths >= 0
    ? maxPaths
    : DEFAULT_MAX_HOT_PATHS;
  const limit = Math.min(requestedMax, ABSOLUTE_MAX_HOT_PATHS);
  if (!Array.isArray(hotPaths) || limit === 0) return [];

  const normalized = [];
  const seen = new Set();
  for (const candidate of hotPaths) {
    if (typeof candidate !== "string") continue;
    let value = candidate.trim().replaceAll("\\", "/");
    if (
      !value
      || /[\u0000-\u001f]/u.test(value)
      || value.startsWith("/")
      || /^[a-z][a-z0-9+.-]*:/iu.test(value)
    ) continue;
    value = path.posix.normalize(value).replace(/^\.\//u, "");
    if (!value || value === "." || value === ".." || value.startsWith("../")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

/**
 * Compare two generations using their durable monotonic coordinates. A return
 * value of 1 means incoming is newer, 0 means equal, and -1 means the current
 * demand must be retained. Equal coordinates with a different Git OID or
 * fingerprint adopt the later publication supplied by the caller.
 */
export function compareWaitingLaneGenerations(currentValue, incomingValue) {
  const current = normalizeWaitingLaneGeneration(currentValue);
  const incoming = normalizeWaitingLaneGeneration(incomingValue);
  if (!incoming) return -1;
  if (!current) return 1;
  if (waitingLaneGenerationsEqual(current, incoming)) return 0;
  if (current.target_branch !== incoming.target_branch) return -1;
  if (
    incoming.atlas_ledger_seq < current.atlas_ledger_seq
    || incoming.atlas_layer_revision < current.atlas_layer_revision
  ) {
    return -1;
  }
  return 1;
}
