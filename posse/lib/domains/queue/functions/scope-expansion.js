import { parseJobPayload } from "./payload.js";

export const LIVE_SCOPE_WAIT_TIMEOUT_MS = 110_000;
export const LIVE_SCOPE_WAIT_EXEMPTION_SLACK_MS = 40_000;
export const LIVE_SCOPE_WAIT_MAX_EXEMPTION_MS = LIVE_SCOPE_WAIT_TIMEOUT_MS + LIVE_SCOPE_WAIT_EXEMPTION_SLACK_MS;

export function scopeRequestBatchEntries(request = {}) {
  const batch = Array.isArray(request?.batch)
    ? request.batch.filter((entry) => entry?.path)
    : [];
  if (batch.length > 0) return batch;
  return request?.path
    ? [{
        path: request.path,
        access: request.access,
        operation: request.operation,
        reason: request.reason,
      }]
    : [];
}

export function jobHasLivePendingScopeRequest(job, {
  nowMs = Date.now(),
  maxAgeMs = LIVE_SCOPE_WAIT_MAX_EXEMPTION_MS,
} = {}) {
  if (!job) return false;
  const payload = parseJobPayload(job);
  const pending = payload?._pending_scope_request;
  if (pending?.live_wait !== true || pending.decision || pending.abandoned === true) return false;
  if (maxAgeMs == null) return true;
  const requestedAtMs = Date.parse(String(pending.requested_at || ""));
  if (!Number.isFinite(requestedAtMs)) return false;
  const ageMs = Number(nowMs) - requestedAtMs;
  return ageMs >= -LIVE_SCOPE_WAIT_EXEMPTION_SLACK_MS
    && ageMs <= Math.max(0, Number(maxAgeMs) || 0);
}

export function grantApprovedScopeEntries(result, scopePredicates) {
  if (result?.approved !== true) return 0;
  let granted = 0;
  for (const entry of scopeRequestBatchEntries(result)) {
    if (!entry?.path) continue;
    if (scopePredicates?.policy?.grantWritePath?.(entry.path) !== false) granted += 1;
  }
  return granted;
}
