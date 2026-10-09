// lib/domains/worker/functions/helpers/image-provider-block.js
//
// A BLOCKED job whose latest generate_image call in the attempt found no ready
// image provider is reporting a provider outage, not a task problem. It is
// requeued through the ordinary retry path a bounded number of times before a
// blocked-recovery gate opens. The classification reads the tool's recorded
// result for the attempt, never the agent's own wording of the block.

import { getDb } from "../../../../shared/storage/functions/index.js";
import { NO_IMAGE_PROVIDERS_AVAILABLE } from "../../../providers/functions/execution-routing.js";
import { AGENT_BLOCKED_ERROR_PREFIX } from "./block-reason.js";

export const MAX_IMAGE_PROVIDER_BLOCK_RETRIES = 2;

// Job payload key listing the blocked attempts already requeued this way.
export const IMAGE_PROVIDER_BLOCK_REQUEUES_PAYLOAD_KEY = "_image_provider_block_requeues";

// The error handed to the retry path. The readiness reasons stay out of it:
// credential wording ("grok credentials not found") reads as a permanent
// provider configuration error there and would dead-letter the job at once.
export const IMAGE_PROVIDER_BLOCK_RETRY_ERROR = `${AGENT_BLOCKED_ERROR_PREFIX} ${NO_IMAGE_PROVIDERS_AVAILABLE}`;

const TOOL_ERROR_PREFIX = "Error: ";
const NO_IMAGE_PROVIDERS_TOOL_ERROR = `${TOOL_ERROR_PREFIX}${NO_IMAGE_PROVIDERS_AVAILABLE}`;

/**
 * The readiness text of the attempt's latest generate_image result when that
 * result found no ready image provider, e.g. "No image providers available
 * (grok: XAI_API_KEY not set)"; null when the latest call got further or no
 * call was recorded.
 * @param {number} attemptId
 * @param {{ db?: object }} [options]
 * @returns {string|null}
 */
export function unreadyImageProviderReadiness(attemptId, { db = getDb() } = {}) {
  const id = Number(attemptId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ?
        AND observation_type = 'tool.generate_image'
      ORDER BY id ASC
    `).all(id);
  } catch {
    return null;
  }
  let readiness = null;
  for (const row of rows) {
    let detail = null;
    try {
      detail = JSON.parse(String(row?.detail_json || "{}"));
    } catch {
      detail = null;
    }
    const result = String(detail?.rejection_reason || detail?.error || "");
    readiness = result.startsWith(NO_IMAGE_PROVIDERS_TOOL_ERROR)
      ? result.slice(TOOL_ERROR_PREFIX.length)
      : null;
  }
  return readiness;
}

function requeuedAttemptIds(payload) {
  const ids = Array.isArray(payload?.[IMAGE_PROVIDER_BLOCK_REQUEUES_PAYLOAD_KEY])
    ? payload[IMAGE_PROVIDER_BLOCK_REQUEUES_PAYLOAD_KEY]
    : [];
  return new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
}

/**
 * Decide whether a BLOCKED attempt is requeued because no image provider was
 * ready. Requeues are counted in the job's current retry generation, so an
 * operator retry from the gate earns them again. A job with no attempt left
 * goes to the gate rather than to the retry path's dead letter.
 * @param {{ job: object, payload: object, attemptId: number, attempts: object[], db?: object }} input
 * @returns {{ readiness: string|null, requeue: boolean, retry: number, generationRequeues: number, requeuedBlocks: number }}
 */
export function imageProviderBlockDisposition({ job, payload, attemptId, attempts = [], db = getDb() }) {
  const requeued = requeuedAttemptIds(payload);
  const generation = Math.max(0, Number(payload?._retry_generation) || 0);
  const requeuedAttempts = attempts.filter((entry) => requeued.has(Number(entry?.id)));
  const generationRequeues = requeuedAttempts
    .filter((entry) => Number(entry?.attempt_number || 0) > generation)
    .length;
  // Requeued blocks never reached a gate, so they do not count toward the
  // blocked-recovery gate's dead letter.
  const requeuedBlocks = requeuedAttempts.filter((entry) => entry?.status === "blocked").length;
  const readiness = unreadyImageProviderReadiness(attemptId, { db });
  const attemptLeft = Number(job?.attempt_count || 0) < Number(job?.max_attempts || 0);
  return {
    readiness,
    requeue: !!readiness && attemptLeft && generationRequeues < MAX_IMAGE_PROVIDER_BLOCK_RETRIES,
    retry: generationRequeues + 1,
    generationRequeues,
    requeuedBlocks,
  };
}

/**
 * The payload with this attempt recorded as requeued for an unready image
 * provider.
 * @param {object} payload
 * @param {number} attemptId
 * @returns {object}
 */
export function withImageProviderBlockRequeue(payload, attemptId) {
  const ids = [...requeuedAttemptIds(payload), Number(attemptId)];
  return { ...payload, [IMAGE_PROVIDER_BLOCK_REQUEUES_PAYLOAD_KEY]: [...new Set(ids)] };
}
