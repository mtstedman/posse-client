// @ts-check
//
// Path-free aggregate telemetry for waiting-lane rollout. Callers may pass a
// durable preparation row, but this module selects an explicit bounded schema;
// paths, hot-path arrays, prompts, content, and error text have no output slot.

import {
  WAITING_LANE_DEMAND_REASONS,
  WAITING_LANE_STATES,
  normalizeWaitingLaneGeneration,
  waitingLaneGenerationsEqual,
} from "../../../catalog/waiting-lane.js";
import { appendRunTelemetry } from "../../../shared/telemetry/functions/run-telemetry.js";

const EVENTS = new Set([
  "demand_requested",
  "demand_suppressed",
  "demand_deduped",
  "demand_promoted",
  "scheduling_queued",
  "scheduling_coalesced",
  "scheduling_suppressed",
  "generation_advanced",
  "git_preparation_finished",
  "atlas_queue_decision",
  "atlas_settled",
  "atlas_successor",
  "atlas_execution_finished",
  "activation_finished",
  "eviction_finished",
  "boot_reconciled",
]);

const ENUM_VALUES = new Set([
  ...WAITING_LANE_DEMAND_REASONS,
  ...WAITING_LANE_STATES,
  "requested_new",
  "coalesced_queued",
  "promoted",
  "running_successor_marked",
  "already_current",
  "activation_claimed",
  "retired",
  "poisoned",
  "version_conflict",
  "ineligible",
  "queued",
  "coalesced",
  "suppressed",
  "succeeded",
  "failed",
  "canceled",
  "fallback",
  "retry",
  "deferred",
  "git_only",
  "atlas_queued",
  "ready",
  "stale",
  "needs_reprepare",
  "needs_latest",
  "superseded",
  "snapshot",
  "catchup",
  "tail",
  "clone",
  "prefetch",
  "none",
  "wi-snapshot",
  "wi-catchup",
  "prepared_git",
  "prepared_atlas",
  "ordinary_fallback",
  "hard_stop",
  "removed",
  "successor_scheduled",
  "no_successor",
  "preserved",
  "other",
]);

const REASONS = new Set([
  "waiting_lane_disabled",
  "disabled",
  "shadow_only",
  "git_disabled",
  "missing_work_item",
  "missing_preparation",
  "invalid_request",
  "generation_unavailable",
  "published_generation_unavailable",
  "shadow_fanout",
  "follow_up_research",
  "web_only_answer",
  "report_or_question",
  "artifact_only",
  "deduped_existing",
  "demand_write_failed",
  "non_build_mode",
  "question_only",
  "shadow_work_item",
  "terminal_work_item",
  "branch_exists",
  "merge_in_progress",
  "prior_committed_mutation",
  "active_worktree",
  "iterative_lineage",
  "target_branch_mismatch",
  "ownership_mismatch",
  "state_not_schedulable",
  "prepared_lane_capacity",
  "prepared_lane_ttl",
  "native_capability_unavailable",
  "preparation_token_lost",
  "newer_generation_after_git",
  "newer_generation_before_git_only_publish",
  "newer_generation_before_atlas_enqueue",
  "atlas_job_not_current",
  "not_terminal_waiting_lane_atlas",
  "atlas_job_mismatch",
  "invalid_or_missing_generation",
  "lock_timeout",
  "execution_error",
  "none",
  "other",
]);

const COUNT_KEYS = new Set([
  "main_generations",
  "atlas_settled",
  "retired",
  "scheduled",
  "unchanged",
  "actions",
  "occupied",
  "cap",
  "tail_entries",
  "removed",
  "preserved",
  "selected",
  "poisoned",
  "dirty",
  "ownership_mismatch",
]);

let telemetryWriter = appendRunTelemetry;

function safeId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safeNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(max, Math.round(number * 1000) / 1000);
}

function safeEnum(value, allowed = ENUM_VALUES) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function safeReason(value) {
  if (value == null || value === "") return null;
  return safeEnum(value, REASONS) || "other";
}

function safeBranch(value) {
  const branch = String(value || "").trim();
  if (!branch || branch.length > 160) return null;
  if (branch.startsWith("/") || branch.includes("\\") || branch.includes("..")) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) ? branch : null;
}

function safeFingerprint(value) {
  const fingerprint = String(value || "").trim();
  return fingerprint.length > 0
    && fingerprint.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(fingerprint)
    ? fingerprint
    : null;
}

function safeGeneration(value) {
  const generation = normalizeWaitingLaneGeneration(value);
  if (!generation) return null;
  const targetBranch = safeBranch(generation.target_branch);
  const fingerprint = safeFingerprint(generation.view_fingerprint);
  if (!targetBranch || !fingerprint || !/^[0-9a-f]{40,64}$/u.test(generation.git_oid)) return null;
  return {
    target_branch: targetBranch,
    git_oid: generation.git_oid,
    atlas_ledger_seq: generation.atlas_ledger_seq,
    atlas_layer_revision: generation.atlas_layer_revision,
    view_fingerprint: fingerprint,
  };
}

function safeCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const counts = {};
  for (const key of COUNT_KEYS) {
    const number = safeNumber(value[key]);
    if (number != null) counts[key] = number;
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function generationState(preparation, nowMs) {
  const desired = safeGeneration(preparation?.desired_generation);
  const applied = safeGeneration(preparation?.applied_generation);
  const stale = preparation?.state === "stale"
    || (!!desired && !!applied && !waitingLaneGenerationsEqual(desired, applied));
  const updatedAt = Date.parse(String(preparation?.updated_at || ""));
  return {
    desired,
    applied,
    stale,
    stalenessAgeMs: stale && Number.isFinite(updatedAt)
      ? Math.max(0, nowMs - updatedAt)
      : null,
  };
}

/**
 * Build the fixed path-free envelope without performing I/O.
 *
 * @param {string} event
 * @param {any} [detail]
 */
export function buildWaitingLaneTelemetryRecord(event, detail = {}) {
  if (!EVENTS.has(event)) return null;
  const preparation = detail?.preparation || null;
  const generation = generationState(preparation, safeNumber(detail.nowMs) ?? Date.now());
  const desired = safeGeneration(detail.desiredGeneration) || generation.desired;
  const applied = safeGeneration(detail.appliedGeneration) || generation.applied;
  return {
    kind: `waiting_lane.${event}`,
    component: "waiting_lane",
    event,
    work_item_id: safeId(detail.workItemId ?? preparation?.work_item_id),
    job_id: safeId(detail.jobId),
    demand_reason: safeEnum(detail.demandReason ?? preparation?.demand_reason),
    state: safeEnum(detail.state ?? preparation?.state),
    outcome: safeEnum(detail.outcome),
    reason: safeReason(detail.reason),
    decision: safeEnum(detail.decision),
    purpose: safeEnum(detail.purpose),
    operation: safeEnum(detail.operation),
    mount_source: safeEnum(detail.mountSource),
    duration_ms: safeNumber(detail.durationMs, 7 * 24 * 60 * 60 * 1000),
    queue_wait_ms: safeNumber(detail.queueWaitMs, 7 * 24 * 60 * 60 * 1000),
    activation_wait_ms: safeNumber(detail.activationWaitMs, 7 * 24 * 60 * 60 * 1000),
    critical_path_saved_ms: safeNumber(detail.criticalPathSavedMs, 7 * 24 * 60 * 60 * 1000),
    critical_path_added_ms: safeNumber(detail.criticalPathAddedMs, 7 * 24 * 60 * 60 * 1000),
    global_atlas_hold_ms: safeNumber(detail.globalAtlasHoldMs, 7 * 24 * 60 * 60 * 1000),
    tail_entries: safeNumber(detail.tailEntries),
    worktree_disk_bytes: safeNumber(detail.worktreeDiskBytes),
    view_disk_bytes: safeNumber(detail.viewDiskBytes),
    disk_measurement_truncated: detail.diskMeasurementTruncated === true,
    staleness_age_ms: detail.stalenessAgeMs == null
      ? generation.stalenessAgeMs
      : safeNumber(detail.stalenessAgeMs, 365 * 24 * 60 * 60 * 1000),
    desired_generation: desired,
    applied_generation: applied,
    successor_needed: preparation?.successor_needed === 1 || detail.successorNeeded === true,
    coalesced: detail.coalesced === true,
    atlas_enabled: detail.atlasEnabled === true,
    git_only: detail.gitOnly === true,
    counts: safeCounts(detail.counts),
  };
}

/**
 * Best-effort append. Telemetry failure must never alter queue/scheduler work.
 *
 * @param {string} event
 * @param {any} [detail]
 */
export function recordWaitingLaneTelemetry(event, detail = {}) {
  try {
    const record = buildWaitingLaneTelemetryRecord(event, detail);
    if (!record) return null;
    telemetryWriter("diagnostics", record);
    return record;
  } catch {
    return null;
  }
}

export function __setWaitingLaneTelemetryWriterForTests(writer = null) {
  telemetryWriter = typeof writer === "function" ? writer : appendRunTelemetry;
}
