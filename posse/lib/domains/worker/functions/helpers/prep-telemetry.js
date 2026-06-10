import { performance } from "node:perf_hooks";
import { logEvent } from "../../../queue/functions/events.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

const PHASE_LABELS = {
  worktree_lock_wait: "setup: waiting for worktree lock",
  worktree_add: "setup: preparing worktree",
  dirty_detect: "setup: checking worktree",
  dirty_recover: "setup: recovering dirty worktree",
  target_merge: "setup: merging target branch",
  sentinel_write: "setup: writing sentinel",
  atlas_join: "setup: joining ATLAS graph",
  cleanup: "setup: cleanup",
};

function nowMs() {
  return performance.now();
}

function durationMs(startMs) {
  return Math.max(0, Math.round((nowMs() - startMs) * 1000) / 1000);
}

function safeMessage(err) {
  return String(err?.message || err || "unknown").split("\n")[0];
}

function emitSetupEvent(ctx = {}, eventType, payload = {}, message = null) {
  if (!ctx?.enabled) return;
  try {
    logEvent({
      work_item_id: ctx.workItemId ?? null,
      job_id: ctx.jobId ?? null,
      attempt_id: ctx.attemptId ?? null,
      event_type: eventType,
      actor_type: EVENT_ACTORS.WORKER,
      actor_id: ctx.actorId ?? null,
      message,
      event_json: payload,
    });
  } catch {
    // Telemetry must never be load-bearing for setup/recovery.
  }
}

function notifyPhase(ctx = {}, event) {
  if (typeof ctx.onPhase !== "function") return;
  try {
    ctx.onPhase(event);
  } catch {
    // Display progress is best-effort.
  }
}

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] || `setup: ${String(phase || "unknown").replace(/_/g, " ")}`;
}

export function startPrepTrace({
  workItemId = null,
  jobId = null,
  attemptId = null,
  actorId = null,
  leaseAcquiredAtMs = null,
  onPhase = null,
  enabled = true,
} = {}) {
  return {
    enabled,
    workItemId,
    jobId,
    attemptId,
    actorId,
    leaseAcquiredAtMs,
    startedAtMs: nowMs(),
    phases: [],
    onPhase,
  };
}

export async function withPhase(phase, ctx, fn, detail = null) {
  const startedAtMs = nowMs();
  const startedAtIso = new Date().toISOString();
  const label = phaseLabel(phase);
  notifyPhase(ctx, { phase, label, state: "started", startedAtIso });
  emitSetupEvent(
    ctx,
    EVENT_TYPES.WORKER_SETUP_PHASE_STARTED,
    { phase, label, started_at: startedAtIso, detail },
    label,
  );

  try {
    const value = await fn();
    const duration = durationMs(startedAtMs);
    const record = { phase, duration_ms: duration, ok: true, detail };
    ctx?.phases?.push(record);
    notifyPhase(ctx, { phase, label, state: "finished", durationMs: duration, ok: true });
    emitSetupEvent(ctx, EVENT_TYPES.WORKER_SETUP_PHASE_FINISHED, record, `${label} finished in ${duration}ms`);
    return value;
  } catch (err) {
    const duration = durationMs(startedAtMs);
    const record = {
      phase,
      duration_ms: duration,
      ok: false,
      error: safeMessage(err),
      detail,
    };
    ctx?.phases?.push(record);
    notifyPhase(ctx, { phase, label, state: "finished", durationMs: duration, ok: false, error: record.error });
    emitSetupEvent(ctx, EVENT_TYPES.WORKER_SETUP_PHASE_FINISHED, record, `${label} failed in ${duration}ms: ${record.error}`);
    if (err instanceof Error) throw err;
    throw new Error(record.error, { cause: err });
  }
}

export function finalizePrepTrace(ctx = {}, extra = {}) {
  const total = durationMs(ctx.startedAtMs || nowMs());
  const phases = Array.isArray(ctx.phases) ? ctx.phases : [];
  const summary = {
    prep_total_ms: total,
    lease_to_setup_ms: Number.isFinite(Number(ctx.leaseAcquiredAtMs))
      ? Math.max(0, Math.round((Date.now() - Number(ctx.leaseAcquiredAtMs)) * 1000) / 1000)
      : null,
    phases,
    ...extra,
  };
  emitSetupEvent(ctx, EVENT_TYPES.WORKER_SETUP_SUMMARY, summary, `Worker setup completed in ${total}ms`);
  return summary;
}
