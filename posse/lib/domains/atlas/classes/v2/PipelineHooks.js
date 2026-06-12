// @ts-check
//
// ATLAS v2 PipelineHooks — transactional outbox for ATLAS pipeline events.
//
// Each pipeline emission writes one row to the existing `events` table
// (audit / observability) AND enqueues an `atlas_warm` job, both inside the
// same DB transaction. If the host process crashes mid-emission, either
// both rows land or neither does. The warmer is just a posse role, so the
// scheduler picks up the queued job whenever it runs.
//
// Workstream E owns this file (emission side). Workstream F's warmer
// consumes the `atlas_warm` job that this module enqueues; the event row is
// purely for observability and is NOT what drives warming.

import { getDb } from "../../../../shared/storage/functions/index.js";
import {
  ATLAS_EVENTS,
  ATLAS_WARM_JOB_POLICY,
  ATLAS_WARM_JOB_TYPE,
} from "../../functions/v2/contracts/index.js";
import { ledgerBranchForWi } from "../../functions/v2/runtime-paths.js";
import { getAtlasIntegrationConfig } from "../../../integrations/functions/atlas/config.js";
import { normalizeAtlasV2Mode } from "../../../integrations/functions/atlas-v2-mode.js";
import { getRetrievalCache } from "./RetrievalCache.js";

/** @typedef {import("../../functions/v2/contracts/events.js").AtlasEventName} AtlasEventName */
/** @typedef {import("../../functions/v2/contracts/events.js").ResearchCompletePayload} ResearchCompletePayload */
/** @typedef {import("../../functions/v2/contracts/events.js").DevLeasedPayload} DevLeasedPayload */
/** @typedef {import("../../functions/v2/contracts/events.js").DevCommittedPayload} DevCommittedPayload */
/** @typedef {import("../../functions/v2/contracts/events.js").MergedToMainPayload} MergedToMainPayload */
/** @typedef {import("../../functions/v2/contracts/events.js").MainAdvancedPayload} MainAdvancedPayload */
/** @typedef {import("../../functions/v2/contracts/events.js").ScipRestageRequestedPayload} ScipRestageRequestedPayload */
/** @typedef {import("../../functions/v2/contracts/events.js").WiCleanupPayload} WiCleanupPayload */
/** @typedef {import("../../functions/v2/contracts/events.js").EmbeddingsResumePayload} EmbeddingsResumePayload */
/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmJobPayload} AtlasWarmJobPayload */
/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmPurpose} AtlasWarmPurpose */

const ATLAS_ACTOR_TYPE = "atlas";
/** @type {ReadonlySet<AtlasEventName>} */
const CACHE_INVALIDATING_EVENTS = new Set([
  ATLAS_EVENTS.DEV_COMMITTED,
  ATLAS_EVENTS.MERGED_TO_MAIN,
  ATLAS_EVENTS.MAIN_ADVANCED,
  ATLAS_EVENTS.SCIP_RESTAGE_REQUESTED,
  ATLAS_EVENTS.WI_CLEANUP,
]);

function nowIso() {
  return new Date().toISOString();
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {AtlasEventName} eventType
 * @returns {string} A human-readable description used as the `title` of the
 *   enqueued atlas_warm job.
 */
function warmJobTitle(eventType) {
  switch (eventType) {
    case ATLAS_EVENTS.RESEARCH_COMPLETE:
      return "ATLAS warm: per-WI prefetch after research";
    case ATLAS_EVENTS.DEV_LEASED:
      return "ATLAS warm: prepare WI view";
    case ATLAS_EVENTS.DEV_COMMITTED:
      return "ATLAS warm: refresh WI view after dev commit";
    case ATLAS_EVENTS.MERGED_TO_MAIN:
      return "ATLAS merge replay: WI partition onto main";
    case ATLAS_EVENTS.MAIN_ADVANCED:
      return "ATLAS reindex: incremental main refresh";
    case ATLAS_EVENTS.SCIP_RESTAGE_REQUESTED:
      return "ATLAS SCIP restage";
    case ATLAS_EVENTS.WI_CLEANUP:
      return "ATLAS warm: WI cleanup view disposal";
    case ATLAS_EVENTS.EMBEDDINGS_RESUME:
      return "ATLAS embeddings resume: close vector index gap";
    case ATLAS_EVENTS.SELF_REPAIR:
      return "ATLAS self-repair: rebuild degraded layer";
    default:
      return `ATLAS warm: ${eventType}`;
  }
}

/**
 * @param {AtlasEventName} eventType
 * @returns {AtlasWarmPurpose}
 */
function purposeForEvent(eventType) {
  if (eventType === ATLAS_EVENTS.MAIN_ADVANCED) return "main-incremental";
  if (eventType === ATLAS_EVENTS.MERGED_TO_MAIN) return "main-merge";
  if (eventType === ATLAS_EVENTS.SCIP_RESTAGE_REQUESTED) return "scip-restage";
  if (eventType === ATLAS_EVENTS.WI_CLEANUP) return "wi-cleanup";
  if (eventType === ATLAS_EVENTS.EMBEDDINGS_RESUME) return "embeddings";
  // Self-repair emitters always pass an explicit warmJobPayload; this default
  // only labels the event row when one is (incorrectly) omitted.
  if (eventType === ATLAS_EVENTS.SELF_REPAIR) return "main-full";
  return "wi";
}

function isWiScopedPurpose(purpose) {
  return purpose === "wi" || purpose === "wi-cleanup" || purpose === "main-merge";
}

function warmJobPriority(eventType) {
  // Lease-time warm jobs are on the active dev path; post-change reindexing
  // stays low priority background maintenance.
  if (eventType === ATLAS_EVENTS.DEV_LEASED) return "high";
  return ATLAS_WARM_JOB_POLICY.defaultPriority;
}

function priorityRank(priority) {
  switch (priority) {
    case "urgent": return 0;
    case "high": return 1;
    case "normal": return 2;
    default: return 3;
  }
}

function strongerPriority(left, right) {
  return priorityRank(left) <= priorityRank(right) ? left : right;
}

function warmTargetKey(payload) {
  const purpose = String(payload?.purpose || "wi");
  const target = String(
    payload?.branch
    || (payload?.work_item_id != null ? ledgerBranchForWi(payload.work_item_id) : "")
    || payload?.onto_branch
    || payload?.target_branch
    || "main",
  ).trim();
  if (!target) return null;
  return `${purpose}:${target}`;
}

function mergeWarmPayload(existing, incoming) {
  const merged = { ...existing, ...incoming };
  const paths = [];
  const seen = new Set();
  for (const value of [
    ...(Array.isArray(existing?.paths) ? existing.paths : []),
    ...(Array.isArray(incoming?.paths) ? incoming.paths : []),
  ]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    paths.push(trimmed);
    if (paths.length >= 200) break;
  }
  if (paths.length > 0) merged.paths = paths;
  const eventCount = warmEventCount(existing) + warmEventCount(incoming);
  if (eventCount > 1) merged._atlas_event_count = eventCount;
  const eventTypes = uniqueWarmEventTypes([
    ...(Array.isArray(existing?._atlas_event_types) ? existing._atlas_event_types : []),
    existing?.trigger_event,
    ...(Array.isArray(incoming?._atlas_event_types) ? incoming._atlas_event_types : []),
    incoming?.trigger_event,
  ]);
  if (eventTypes.length > 0) merged._atlas_event_types = eventTypes;
  return merged;
}

function warmEventCount(payload) {
  const parsed = Number(payload?._atlas_event_count || 1);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function uniqueWarmEventTypes(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.slice(-8);
}

function annotateWarmPayload(payload, eventType) {
  const eventTypes = uniqueWarmEventTypes([
    ...(Array.isArray(payload?._atlas_event_types) ? payload._atlas_event_types : []),
    payload?.trigger_event,
    eventType,
  ]);
  const annotated = {
    ...payload,
    _atlas_event_count: warmEventCount(payload),
  };
  if (eventTypes.length > 0) annotated._atlas_event_types = eventTypes;
  return annotated;
}

function findCoalescableQueuedWarm(db, effectiveWarmPayload) {
  const key = warmTargetKey(effectiveWarmPayload);
  if (!key) return null;
  const rows = db.prepare(`
    SELECT id, priority, payload_json
    FROM jobs
    WHERE job_type = ?
      AND status = 'queued'
    ORDER BY id ASC
  `).all(ATLAS_WARM_JOB_TYPE);
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json, {});
    if (warmTargetKey(payload) === key) return { row, payload };
  }
  return null;
}

function shouldRetireQueuedWiWarmJobs(eventType) {
  return eventType === ATLAS_EVENTS.MERGED_TO_MAIN || eventType === ATLAS_EVENTS.WI_CLEANUP;
}

function cancelQueuedWiWarmJobs(db, workItemId, reason) {
  const wiId = Number(workItemId);
  if (!Number.isFinite(wiId) || wiId <= 0) return 0;
  const rows = db.prepare(`
    SELECT id, payload_json
    FROM jobs
    WHERE job_type = ?
      AND status = 'queued'
      AND work_item_id = ?
    ORDER BY id ASC
  `).all(ATLAS_WARM_JOB_TYPE, wiId);

  let canceled = 0;
  const ts = nowIso();
  const update = db.prepare(`
    UPDATE jobs
    SET status = 'canceled',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        finished_at = ?,
        last_error = NULL,
        result_json = ?,
        updated_at = ?
    WHERE id = ?
      AND status = 'queued'
  `);
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json, {});
    if (String(payload?.purpose || "wi") !== "wi") continue;
    if (Number(payload?.work_item_id) !== wiId) continue;
    const info = update.run(
      ts,
      JSON.stringify({ skipped: reason || "wi_warm_retired", retired_by_atlas: true }),
      ts,
      row.id,
    );
    if (info.changes > 0) canceled += info.changes;
  }
  return canceled;
}

/**
 * Write the events-table row + enqueue the atlas_warm job in a single
 * transaction. Designed to be called from any posse code path that wants
 * to emit an ATLAS v2 pipeline event.
 *
 * Failures are swallowed and reported via the optional `onError` callback
 * — pipeline work must never block on the ATLAS outbox.
 *
 * @param {Object} args
 * @param {AtlasEventName} args.eventType
 * @param {Object} args.payload
 * @param {number | null} [args.workItemId]
 * @param {number | null} [args.jobId]
 * @param {AtlasWarmJobPayload} [args.warmJobPayload]
 *   Override the auto-derived warm-job payload. When omitted the hook
 *   constructs one from the event payload + purpose mapping.
 * @param {(err: Error) => void} [args.onError]
 * @returns {{ ok: boolean, eventId: number | null, warmJobId: number | null, skipped?: string, coalesced?: boolean, canceledWarmJobs?: number }}
 */
export function emitAtlasPipelineEvent({
  eventType,
  payload,
  workItemId = null,
  jobId = null,
  warmJobPayload = undefined,
  onError = undefined,
}) {
  if (!eventType || !payload || typeof payload !== "object") {
    return { ok: false, eventId: null, warmJobId: null, skipped: "invalid_args" };
  }

  const purpose = purposeForEvent(eventType);
  const priority = warmJobPriority(eventType);
  /** @type {AtlasWarmJobPayload} */
  const effectiveWarmPayload = warmJobPayload || (() => {
    /** @type {AtlasWarmJobPayload} */
    const constructed = {
      purpose,
      trigger_event: eventType,
    };
    if (purpose === "wi") {
      if (workItemId != null) constructed.work_item_id = Number(workItemId);
      if (workItemId != null) {
        constructed.branch = ledgerBranchForWi(workItemId);
      } else if (typeof (/** @type {any} */ (payload).branch) === "string") {
        constructed.branch = /** @type {any} */ (payload).branch;
      }
      if (Array.isArray(/** @type {any} */ (payload).files)) {
        constructed.paths = /** @type {string[]} */ (
          /** @type {any} */ (payload).files
        );
      } else if (Array.isArray(/** @type {any} */ (payload).paths)) {
        constructed.paths = /** @type {string[]} */ (
          /** @type {any} */ (payload).paths
        );
      }
    } else if (purpose === "wi-cleanup") {
      if (workItemId != null) constructed.work_item_id = Number(workItemId);
      if (workItemId != null) {
        constructed.branch = ledgerBranchForWi(workItemId);
      } else if (typeof (/** @type {any} */ (payload).branch) === "string") {
        constructed.branch = /** @type {any} */ (payload).branch;
      }
    } else if (purpose === "main-merge") {
      if (workItemId != null) {
        constructed.work_item_id = Number(workItemId);
        constructed.branch = ledgerBranchForWi(workItemId);
      } else if (typeof (/** @type {any} */ (payload).source_branch) === "string") {
        constructed.branch = /** @type {any} */ (payload).source_branch;
      }
      constructed.onto_branch = typeof (/** @type {any} */ (payload).target_branch) === "string"
        ? /** @type {any} */ (payload).target_branch
        : "main";
    } else {
      // main-incremental / main-full / scip-restage
      constructed.branch = typeof (/** @type {any} */ (payload).target_branch) === "string"
        ? /** @type {any} */ (payload).target_branch
        : "main";
      if (Array.isArray(/** @type {any} */ (payload).paths)) {
        constructed.paths = /** @type {string[]} */ (
          /** @type {any} */ (payload).paths
        );
      }
    }
    return constructed;
  })();

  try {
    const db = getDb();
    const eventJson = JSON.stringify({ type: eventType, ...payload });
    const queuedWarmPayload = annotateWarmPayload(effectiveWarmPayload, eventType);
    const warmPayloadJson = JSON.stringify(queuedWarmPayload);

    const insertEvent = db.prepare(`
      INSERT INTO events (work_item_id, job_id, event_type, actor_type, actor_id, message, event_json)
      VALUES (?, ?, ?, ?, NULL, NULL, ?)
    `);
    const insertJob = db.prepare(`
      INSERT INTO jobs (
        work_item_id, job_type, title, parent_job_id,
        priority, model_tier, reasoning_effort, provider,
        max_attempts, payload_json, ready_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
    `);

    let eventId = null;
    let warmJobId = null;
    let coalesced = false;
    let canceledWarmJobs = 0;
    db.transaction(() => {
      if (shouldRetireQueuedWiWarmJobs(eventType)) {
        canceledWarmJobs = cancelQueuedWiWarmJobs(db, workItemId, eventType);
      }
      const eventInfo = insertEvent.run(
        workItemId,
        jobId,
        eventType,
        ATLAS_ACTOR_TYPE,
        eventJson,
      );
      eventId = Number(eventInfo.lastInsertRowid);
      const existingWarm = findCoalescableQueuedWarm(db, queuedWarmPayload);
      if (existingWarm) {
        const mergedPayload = mergeWarmPayload(existingWarm.payload, queuedWarmPayload);
        db.prepare(`
          UPDATE jobs
          SET title = ?,
              priority = ?,
              payload_json = ?,
              ready_at = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          warmJobTitle(eventType),
          strongerPriority(priority, existingWarm.row.priority),
          JSON.stringify(mergedPayload),
          nowIso(),
          nowIso(),
          existingWarm.row.id,
        );
        warmJobId = Number(existingWarm.row.id);
        coalesced = true;
        return;
      }
      const jobInfo = insertJob.run(
        // atlas_warm jobs may have a null work_item_id (main-* purposes have no WI).
        // WI-scoped purposes keep their owning work_item_id and show up in
        // listJobsByWorkItem(wi).
        isWiScopedPurpose(purpose) && workItemId != null ? workItemId : null,
        ATLAS_WARM_JOB_TYPE,
        warmJobTitle(eventType),
        jobId,
        priority,
        ATLAS_WARM_JOB_POLICY.maxAttempts,
        warmPayloadJson,
        nowIso(),
      );
      warmJobId = Number(jobInfo.lastInsertRowid);
    })();
    if (CACHE_INVALIDATING_EVENTS.has(eventType)) {
      getRetrievalCache().invalidateAll();
    }

    return { ok: true, eventId, warmJobId, coalesced, canceledWarmJobs };
  } catch (err) {
    if (typeof onError === "function") onError(/** @type {Error} */ (err));
    return {
      ok: false,
      eventId: null,
      warmJobId: null,
      skipped: "outbox_error",
    };
  }
}

/**
 * Convenience wrappers — one per event name. Each accepts the typed
 * payload + identifiers and forwards to `emitAtlasPipelineEvent`.
 */

/**
 * @param {{ payload: ResearchCompletePayload, jobId?: number | null, onError?: (err: Error) => void }} args
 */
export function emitResearchComplete({ payload, jobId = null, onError = undefined }) {
  return emitAtlasPipelineEvent({
    eventType: ATLAS_EVENTS.RESEARCH_COMPLETE,
    payload,
    workItemId: payload?.wi_id ?? null,
    jobId,
    onError,
  });
}

/**
 * @param {{ payload: DevLeasedPayload, onError?: (err: Error) => void }} args
 */
export function emitDevLeased({ payload, onError = undefined }) {
  return emitAtlasPipelineEvent({
    eventType: ATLAS_EVENTS.DEV_LEASED,
    payload,
    workItemId: payload?.wi_id ?? null,
    jobId: payload?.job_id ?? null,
    onError,
  });
}

/**
 * @param {{ payload: DevCommittedPayload, onError?: (err: Error) => void }} args
 */
export function emitDevCommitted({ payload, onError = undefined }) {
  return emitAtlasPipelineEvent({
    eventType: ATLAS_EVENTS.DEV_COMMITTED,
    payload,
    workItemId: payload?.wi_id ?? null,
    jobId: payload?.job_id ?? null,
    onError,
  });
}

/**
 * @param {{ payload: MergedToMainPayload, jobId?: number | null, onError?: (err: Error) => void }} args
 */
export function emitMergedToMain({ payload, jobId = null, onError = undefined }) {
  return emitAtlasPipelineEvent({
    eventType: ATLAS_EVENTS.MERGED_TO_MAIN,
    payload,
    workItemId: payload?.wi_id ?? null,
    jobId,
    onError,
  });
}

/**
 * @param {{ payload: MainAdvancedPayload, jobId?: number | null, onError?: (err: Error) => void }} args
 */
export function emitMainAdvanced({ payload, jobId = null, onError = undefined }) {
  return emitAtlasPipelineEvent({
    eventType: ATLAS_EVENTS.MAIN_ADVANCED,
    payload,
    workItemId: null,
    jobId,
    onError,
  });
}

/**
 * @param {{ payload: ScipRestageRequestedPayload, jobId?: number | null, onError?: (err: Error) => void }} args
 */
export function emitScipRestageRequested({ payload, jobId = null, onError = undefined }) {
  return emitAtlasPipelineEvent({
    eventType: ATLAS_EVENTS.SCIP_RESTAGE_REQUESTED,
    payload,
    workItemId: null,
    jobId,
    onError,
  });
}

/**
 * @param {{ payload: WiCleanupPayload, jobId?: number | null, onError?: (err: Error) => void }} args
 */
export function emitWiCleanup({ payload, jobId = null, onError = undefined }) {
  return emitAtlasPipelineEvent({
    eventType: ATLAS_EVENTS.WI_CLEANUP,
    payload,
    workItemId: payload?.wi_id ?? null,
    jobId,
    onError,
  });
}

/**
 * @param {{ payload: EmbeddingsResumePayload, jobId?: number | null, maxSymbols?: number | null, onError?: (err: Error) => void }} args
 */
export function emitEmbeddingsResume({ payload, jobId = null, maxSymbols = null, onError = undefined }) {
  /** @type {AtlasWarmJobPayload} */
  const warmJobPayload = {
    purpose: "embeddings",
    branch: typeof payload?.target_branch === "string" && payload.target_branch
      ? payload.target_branch
      : "main",
    trigger_event: ATLAS_EVENTS.EMBEDDINGS_RESUME,
  };
  if (Number.isInteger(maxSymbols) && Number(maxSymbols) > 0) {
    warmJobPayload.max_symbols = Number(maxSymbols);
  }
  return emitAtlasPipelineEvent({
    eventType: ATLAS_EVENTS.EMBEDDINGS_RESUME,
    payload,
    workItemId: null,
    jobId,
    warmJobPayload,
    onError,
  });
}

/**
 * True when ATLAS v2 emissions should fire. Under §3.1 cutover the admin
 * default is `shadow`, so default DB settings still produce emissions.
 * Operators disable emissions with `atlas_v2=off`.
 *
 * @param {Record<string, unknown> | null} [config]
 * @returns {boolean}
 */
export function isAtlasV2EmissionEnabled(config = null) {
  const cfg = config || getAtlasIntegrationConfig();
  return normalizeAtlasV2Mode(String(cfg?.atlasV2Mode || "")) !== "off";
}
