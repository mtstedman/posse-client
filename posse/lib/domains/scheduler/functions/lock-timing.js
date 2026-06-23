// lib/domains/scheduler/functions/lock-timing.js — pure scheduler-lock timing
// and ATLAS-warm / cross-WI handoff path helpers.
//
// Extracted verbatim from classes/Scheduler.js. These are stateless helpers
// (no class/this access, no concurrency state) so they live alongside the
// other scheduler `functions/` modules. The Scheduler class imports them back.

import { parseJobPayload } from "../../queue/functions/payload.js";

export function schedulerLockTiming(lockInfo, lockDurationMs, nowMs = Date.now()) {
  const acquiredMs = Date.parse(lockInfo?.acquired_at || "");
  const expiresMs = Date.parse(lockInfo?.expires_at || "");
  const heartbeatMs = Number.isFinite(acquiredMs)
    ? acquiredMs
    : Number.isFinite(expiresMs)
      ? expiresMs - lockDurationMs
      : NaN;

  return {
    heartbeatAge: Number.isFinite(heartbeatMs) ? nowMs - heartbeatMs : Infinity,
    expiresIn: Number.isFinite(expiresMs) ? expiresMs - nowMs : -Infinity,
    heartbeatFromExpiresAt: !Number.isFinite(acquiredMs) && Number.isFinite(expiresMs),
    heartbeatInvalid: !Number.isFinite(heartbeatMs),
  };
}

export function formatSchedulerLockDuration(ms) {
  return Number.isFinite(ms) ? `${Math.ceil(ms / 1000)}s` : "invalid";
}

export function formatStaleHeartbeatReason(heartbeatAge, thresholdMs) {
  if (!Number.isFinite(heartbeatAge)) return "timestamp invalid";
  return `${formatSchedulerLockDuration(heartbeatAge)} > ${thresholdMs / 1000}s threshold`;
}

export function atlasWarmConcurrencyKey(job) {
  if (job?.job_type !== "atlas_warm") return null;
  const payload = parseJobPayload(job) || {};
  const target = String(
    payload.branch
    || (payload.work_item_id != null ? `wi-${payload.work_item_id}` : "")
    || payload.onto_branch
    || "main",
  ).trim();
  return target || null;
}

export function normalizeHandoffPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

export function handoffCandidateCoversPath(candidate, filePath) {
  const candidatePath = normalizeHandoffPath(candidate?.path);
  const normalizedFile = normalizeHandoffPath(filePath);
  if (!candidatePath || !normalizedFile) return false;
  if (candidate?.lock_kind === "file") return candidatePath === normalizedFile;
  if (candidate?.lock_kind !== "root") return false;
  return candidatePath === "*"
    || candidatePath === "."
    || normalizedFile === candidatePath
    || normalizedFile.startsWith(`${candidatePath}/`);
}
