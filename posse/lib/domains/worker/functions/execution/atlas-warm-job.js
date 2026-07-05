// ATLAS v2 warm-job executor.
//
// Workstream E provides the scheduling seam: this function is called by
// Worker for `atlas_warm` jobs. Phase 2.1 wires the Warmer behind this
// executor so the result reflects real ledger/view work; if the ledger
// isn't bootstrapped yet (fresh install with no ATLAS v2 setup), the
// executor falls back to an all-paths-skipped stub result so the
// scheduler can still drain the queue without blocking pipeline work.

import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import {
  completeAttempt,
  incrementAndCreateAttempt,
  logEvent,
  refreshWorkItemStatus,
  setJobResult,
  storeArtifact,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { ATLAS_WARM_JOB_POLICY } from "../../../atlas/functions/v2/contracts/jobs.js";
import { runSqliteWrite } from "../../../../shared/concurrency/functions/sqlite-gate.js";
import { appendRunTelemetry } from "../../../../shared/telemetry/functions/run-telemetry.js";
import { resolveTargetBranchAsync } from "../../../git/functions/target-branch.js";
import { ledgerDbPath, mainViewPath } from "../../../atlas/functions/v2/runtime-paths.js";
import { getSharedConductor } from "../../../atlas/functions/v2/parse/conductor.js";
import { emitEmbeddingsResume, emitScipStaged } from "../../../atlas/classes/v2/PipelineHooks.js";
import { warmReadinessStarted, warmReadinessProgress, warmReadinessDone } from "../../../atlas/functions/v2/warm-progress.js";
import { getAtlasIntegrationConfig, getAtlasRuntimeDisabledReason } from "../../../integrations/functions/atlas/config.js";
import {
  formatAtlasError,
  isVerboseAtlasErrors,
  logAtlasError,
} from "../../../atlas/functions/v2/verbose-errors.js";
import { logAttemptSkippedStaleLease } from "./attempt-logging.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

function nowMs() {
  return Date.now();
}

// How long a runtime-disabled warm job stays unready after being released
// back to the queue. Long enough that the scheduler does not lease/skip it in
// a hot loop for the rest of the disabled run; short enough that the next
// boot (which clears the in-memory disable) picks it up promptly.
const ATLAS_WARM_DISABLED_REQUEUE_DELAY_MS = 10 * 60 * 1000;

function clampPaths(paths, max = 100) {
  if (!Array.isArray(paths)) return { paths: [], truncated: false };
  const out = [];
  const seen = new Set();
  let truncated = false;
  for (const value of paths) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (out.length >= max) {
      truncated = true;
      break;
    }
    out.push(trimmed);
  }
  return { paths: out, truncated };
}

// Async on purpose: this runs on the orchestrator main loop at every warm
// dispatch, and the sync native-git resolve was a visible TUI hiccup.
async function resolveAtlasWarmBaselineBranch(repoRoot) {
  try {
    return await resolveTargetBranchAsync(repoRoot);
  } catch {
    return "main";
  }
}

function positiveMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function capString(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function errorSummary(err) {
  if (!err) return null;
  const cause = err.cause && err.cause !== err ? err.cause : null;
  return {
    name: err?.name || null,
    code: err?.code || err?.errno || null,
    status: err?.status || err?.statusCode || null,
    message: capString(err?.message || String(err), 700),
    cause: cause ? {
      name: cause?.name || null,
      code: cause?.code || cause?.errno || null,
      status: cause?.status || cause?.statusCode || null,
      message: capString(cause?.message || String(cause), 700),
    } : null,
  };
}

function logAtlasWarmTelemetry(kind, extra = {}) {
  appendRunTelemetry("diagnostics", {
    kind,
    component: "atlas_warm",
    ...extra,
  });
}

function atlasWarmTelemetryContext({ jobId, purpose, branch, baselineBranch, repoRoot, paths, budgetMs, timeoutMs }) {
  return {
    job_id: jobId ?? null,
    purpose: purpose || null,
    branch: branch || null,
    baseline_branch: baselineBranch || null,
    repo_root_basename: path.basename(String(repoRoot || "")) || null,
    path_count: Array.isArray(paths) ? paths.length : 0,
    path_sample: Array.isArray(paths) ? paths.slice(0, 20) : [],
    budget_ms: Number(budgetMs) || null,
    timeout_ms: Number(timeoutMs) || null,
  };
}

// One embeddings slice is encode-bound, not parse-bound: budget for the slice
// cap at a conservative local-ONNX rate plus model warm-up, independent of the
// boot/scip timeouts that size full warms.
const ATLAS_EMBEDDINGS_SLICE_BUDGET_MS = 10 * 60_000;

function atlasWarmRuntimeBudgetMs(purpose, config = {}) {
  const policyBudget = positiveMs(ATLAS_WARM_JOB_POLICY.maxRuntimeMs) || 60_000;
  if (purpose === "wi" || purpose === "wi-cleanup") return policyBudget;
  if (purpose === "embeddings") return Math.max(policyBudget, ATLAS_EMBEDDINGS_SLICE_BUDGET_MS);
  const candidates = [policyBudget];
  if (purpose === "main-full" || purpose === "main-incremental" || purpose === "scip-restage") {
    candidates.push(
      positiveMs(config.bootTimeoutMs),
      positiveMs(config.scipIndexTimeoutMs),
      positiveMs(config.scipColdIndexTimeoutMs),
    );
  } else if (purpose === "main-merge") {
    candidates.push(positiveMs(config.bootTimeoutMs));
  }
  return Math.max(...candidates.filter((n) => n != null));
}

// Gate-wait and post-acquire runtime are DISTINCT budgets. The conductor gets
// its full per-purpose runtime budget once it holds the gate; this caps only how
// long a warm waits IN LINE for the gate before skipping (best-effort). It must
// NOT be the full runtime budget, or a bulk warm could wait ~one budget then run
// another (~2x wall-clock) and keep a worker occupied long enough to recreate
// the starvation this is meant to reduce.
//   - wi / wi-cleanup: give up fast so cheap views never queue behind bulk work.
//   - main-* / embeddings / scip-*: a bounded fair-share wait; on timeout the
//     warm skips and the scheduler re-enqueues it, rather than holding a worker.
const ATLAS_WARM_SHORT_GATE_WAIT_MS = 30_000;
const ATLAS_WARM_BULK_GATE_WAIT_MS = 3 * 60_000;
export function atlasWarmGateWaitMs(purpose) {
  if (purpose === "wi" || purpose === "wi-cleanup") return ATLAS_WARM_SHORT_GATE_WAIT_MS;
  return ATLAS_WARM_BULK_GATE_WAIT_MS;
}

// wi / wi-cleanup warms take write-gate intake priority so they jump a backlog of
// queued bulk warms (main-*, embeddings, boot index) instead of waiting it out —
// keeping WI-view freshness during big indexes. The gate ages queued bulk warms
// so they still make progress (no starvation).
export function atlasWarmGatePriority(purpose) {
  return (purpose === "wi" || purpose === "wi-cleanup") ? 1 : 0;
}

function atlasRuntimeDisabledReasonForRepo(repoRoot) {
  return getAtlasRuntimeDisabledReason()
    || getAtlasRuntimeDisabledReason(repoRoot)
    || getAtlasRuntimeDisabledReason(path.basename(String(repoRoot || "")))
    || getAtlasRuntimeDisabledReason(ledgerDbPath(repoRoot));
}

function atlasWarmSkippedResult({ payload, purpose, paths, reason, message }) {
  const skippedPaths = paths.length > 0 ? paths : ["."];
  return {
    purpose: /** @type {any} */ (purpose),
    paths_considered: paths.length,
    paths_indexed: 0,
    blobs_ingested: 0,
    blobs_reused: 0,
    ledger_entries_appended: 0,
    view_written: payload.out_view_path || null,
    view_etag: null,
    duration_ms: 0,
    skipped: skippedPaths.map((repo_rel_path) => ({ repo_rel_path, reason, message })),
  };
}

function isAtlasWarmGateBusy(err) {
  return err?.code === "ASYNC_GATE_BUSY" || err?.code === "ASYNC_GATE_TIMEOUT";
}

function isAtlasWarmSoftInfrastructureMiss(err) {
  return err?.code === "THREAD_TIMEOUT" || err?.code === "DAEMON_TIMEOUT";
}

export async function runAtlasWarmJob(worker, job, wrappedJob, { leaseToken, abortSignal = null } = {}) {
  const startTime = nowMs();
  let attempt = null;
  try {
    const payload = parseJobPayload(job) || {};
    const purpose = String(payload.purpose || "wi");
    const repoRoot = resolveAtlasRepoRoot(worker);
    const clamped = clampPaths(payload.paths);
    // A truncated path list must not silently narrow reindex coverage: for
    // incremental warms, drop the partial hints and force the freshness scan
    // instead — it re-derives staleness from the ledger and covers the
    // dropped tail. (The coalescer sets paths_truncated the same way when its
    // union overflows.)
    const forceFreshnessScan = purpose === "main-incremental"
      && (clamped.truncated || payload.paths_truncated === true);
    const paths = forceFreshnessScan ? [] : clamped.paths;
    if (forceFreshnessScan) payload.paths_truncated = true;
    const config = getAtlasIntegrationConfig();
    const disabledReason = atlasRuntimeDisabledReasonForRepo(repoRoot);

    // Runtime disable is transient and clears at next boot. Do not create an
    // attempt row here: releaseWithoutAttemptPenalty previously decremented
    // jobs.attempt_count, but the next attempt number still came from the
    // attempt table, so disabled warms could exceed maxAttempts=1 on paper.
    if (disabledReason) {
      const released = worker._releaseLease(job, leaseToken, "queued", {
        readyAt: new Date(Date.now() + ATLAS_WARM_DISABLED_REQUEUE_DELAY_MS).toISOString(),
      });
      if (released && job.work_item_id) refreshWorkItemStatus(job.work_item_id);
      worker.emit(job.id, `${C.dim}[atlas] warm (${purpose}) deferred: ATLAS disabled for this run (${disabledReason}) — left queued for next boot${C.reset}`);
      return;
    }

    worker._throwIfKilled?.(job.id);

    attempt = incrementAndCreateAttempt(job.id, leaseToken, "system", "atlas-warm", null);
    if (!attempt) {
      logAttemptSkippedStaleLease(job, "system", "Skipped atlas_warm attempt because the lease was stale or expired");
      worker.emit(job.id, `${C.red}[stale-lease]${C.reset} job #${job.id} atlas_warm — lease lost`);
      return;
    }

    const baselineBranch = await resolveAtlasWarmBaselineBranch(repoRoot);
    const branch = typeof payload.branch === "string" ? payload.branch : (purpose === "wi" ? null : baselineBranch);

    // Bounded runtime guard — surface a deterministic skip if the policy
    // budget has already been exhausted (e.g. shutdown right before lease).
    const elapsed = nowMs() - startTime;
    const budgetMs = atlasWarmRuntimeBudgetMs(purpose, config);
    const exceeded = elapsed > budgetMs;

    /** @type {import("../../../atlas/functions/v2/contracts/jobs.js").AtlasWarmJobResult} */
    let result;
    let backend = "atlas-v2-stub";
    if (config?.enabled === false) {
      const reason = config?.disabledReason || config?.skipped || "atlas_disabled";
      result = {
        purpose: /** @type {any} */ (purpose),
        paths_considered: paths.length,
        paths_indexed: 0,
        blobs_ingested: 0,
        blobs_reused: 0,
        ledger_entries_appended: 0,
        view_written: payload.out_view_path || null,
        view_etag: null,
        duration_ms: 0,
        skipped: (paths.length > 0 ? paths : ["."]).map((repo_rel_path) => ({
          repo_rel_path,
          reason: "atlas_disabled",
          message: `ATLAS disabled by configuration: ${reason}`,
        })),
      };
      backend = "atlas-v2-disabled";
    } else if (exceeded) {
      result = {
        purpose: /** @type {any} */ (purpose),
        paths_considered: paths.length,
        paths_indexed: 0,
        blobs_ingested: 0,
        blobs_reused: 0,
        ledger_entries_appended: 0,
        view_written: payload.out_view_path || null,
        view_etag: null,
        duration_ms: 0,
        skipped: paths.map((repo_rel_path) => ({
          repo_rel_path,
          reason: "size_exceeded",
          message: "runtime budget exhausted before warm",
        })),
      };
    } else {
      const real = await runRealWarmer({ payload, branch, paths, worker, jobId: job.id, baselineBranch, repoRoot, abortSignal, timeoutMs: budgetMs - elapsed, config });
      if (real) {
        result = real;
        backend = "atlas-v2";
      } else {
        result = {
          purpose: /** @type {any} */ (purpose),
          paths_considered: paths.length,
          paths_indexed: 0,
          blobs_ingested: 0,
          blobs_reused: 0,
          ledger_entries_appended: 0,
          view_written: payload.out_view_path || null,
          view_etag: null,
          duration_ms: 0,
          skipped: paths.map((repo_rel_path) => ({
            repo_rel_path,
            reason: "unsupported_lang",
            message: "ATLAS v2 ledger not bootstrapped for this repo yet",
          })),
        };
      }
    }
    result.duration_ms = nowMs() - startTime;

    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.attempt.id,
      event_type: EVENT_TYPES.ATLAS_WARM_COMPLETED,
      actor_type: EVENT_ACTORS.ATLAS,
      message: `ATLAS warm (${purpose}) completed: considered=${paths.length} branch=${branch || baselineBranch}`,
      event_json: JSON.stringify({
        purpose,
        branch,
        paths_considered: paths.length,
        backend,
        trigger_event: payload.trigger_event || null,
      }),
    });

    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.attempt.id,
      artifact_type: "response",
      content_long: JSON.stringify(result),
    });

    setJobResult(job.id, result);

    // Budget-sliced resume loop: an embeddings warm that stopped short of
    // parity enqueues the next slice (coalescing with any already-queued one).
    // A slice that made zero progress AND errored does not re-enqueue — that
    // would hot-loop a deterministic failure; the next boot readiness check or
    // pipeline event retries instead.
    if (purpose === "embeddings" && backend === "atlas-v2" && result.embeddings_complete === false) {
      const encoded = Number(result.embeddings_indexed) || 0;
      const remaining = Number(result.embeddings_remaining) || 0;
      if (remaining > 0 && (encoded > 0 || !result.embeddings_error)) {
        try {
          emitEmbeddingsResume({
            payload: {
              target_branch: branch || baselineBranch,
              reason: "warm_incomplete",
              remaining,
            },
            jobId: job.id,
            maxSymbols: Number.isInteger(payload.max_symbols) && payload.max_symbols > 0
              ? payload.max_symbols
              : null,
          });
          worker.emit(job.id, `${C.dim}[atlas] embeddings resume: ${remaining} symbols remaining — next slice queued${C.reset}`);
        } catch { /* best effort — readiness self-repair re-detects the gap */ }
      }
    }

    // A standalone scip-restage only STAGES artifacts; nothing ingests them
    // until a main warm runs (WI warms are hot-view-only and readiness
    // reports staged artifacts as ready, so no repair fires either). When the
    // restage staged fresh artifacts, enqueue the coalescing main-incremental
    // intake now instead of letting the symbols wait for the next unrelated
    // commit.
    if (purpose === "scip-restage" && backend === "atlas-v2" && result.scip_staged_fresh === true) {
      try {
        emitScipStaged({
          payload: {
            target_branch: branch || baselineBranch,
            reason: "scip_restage_staged_fresh",
          },
          jobId: job.id,
        });
        worker.emit(job.id, `${C.dim}[atlas] scip restage staged fresh artifacts — main intake warm queued${C.reset}`);
      } catch { /* best effort — the next main warm ingests staged scip anyway */ }
    }

    completeAttempt(attempt.attempt.id, {
      status: "succeeded",
      duration_ms: result.duration_ms,
      output_chars: 0,
    });
    if (worker._releaseLease(job, leaseToken, "succeeded") && job.work_item_id) {
      refreshWorkItemStatus(job.work_item_id);
    }
  } catch (err) {
    if (!attempt) {
      const msg = err?.message || String(err);
      worker.emit(job.id, `${C.yellow}[atlas] warm job #${job.id} could not start: ${msg}${C.reset}`);
      logAtlasError("[atlas-warm] job #" + job.id + " failed before attempt creation:", err);
      return;
    }
    if (worker._handleDeterministicInterruption?.(job, attempt.attempt.id, startTime, leaseToken, err)) {
      return;
    }
    const msg = err?.message || String(err);
    const verbose = isVerboseAtlasErrors();
    worker.emit(job.id, `${C.yellow}[atlas] warm job #${job.id} failed: ${msg}${C.reset}`);
    logAtlasError(`[atlas-warm] job #${job.id} threw:`, err);
    completeAttempt(attempt.attempt.id, {
      status: "failed",
      duration_ms: nowMs() - startTime,
      // Verbose mode: persist the full stack in error_text so an
      // operator can `posse audit` the failed job and see what blew up.
      error_text: verbose ? formatAtlasError(err) : msg,
    });
    try { await wrappedJob?.setError?.(msg); } catch { /* best effort */ }
    // ATLAS_WARM_JOB_POLICY.maxAttempts is 1 — _retryOrFail dead-letters this.
    worker._retryOrFail(job, leaseToken, msg);
  }
}

/**
 * Delegate the warm to the persistent Atlas-Conductor daemon, which hosts a
 * `ParseEngine` over warm Ledger/View handles for the whole session (no per-job
 * thread spawn or DB reopen). The parent still holds the process-wide SQLite
 * write gate (`runSqliteWrite`) for the ledger path across the call, so no other
 * main-thread writer races the conductor; the conductor serializes its own ops
 * internally on its write-queue semaphore. ParseEngine writes the merged view
 * itself from the job's `out_view_path`.
 *
 * Progress is coarser than the old per-job worker: the Daemon transport is
 * strict request/response, so ParseEngine's per-stage `onProgress` lines are not
 * streamed back. The completion result is unchanged. (Streaming progress would
 * need a Daemon protocol extension — tracked as a follow-up.)
 *
 * Verbose ATLAS error mode re-throws errors at this boundary so the outer
 * executor turns them into a job failure with the full stack in `error_text`.
 *
 * @param {{
 *   payload: any,
 *   branch: string | null,
 *   paths: string[],
 *   worker: any,
 *   jobId: number,
 *   baselineBranch: string,
 *   repoRoot: string,
 *   abortSignal?: AbortSignal | null,
 *   timeoutMs?: number | null,
 *   config?: any,
 * }} args
 * @returns {Promise<import("../../../atlas/functions/v2/contracts/jobs.js").AtlasWarmJobResult | null>}
 */
async function runRealWarmer({ payload, branch, paths, worker, jobId, baselineBranch, repoRoot, abortSignal = null, timeoutMs = null, config = null }) {
  try {
    const ledgerPath = ledgerDbPath(repoRoot);
    const purpose = String(payload?.purpose || "wi");
    // Skip if the surrounding .posse runtime directory does not exist —
    // that means no posse project is bootstrapped here.
    const fsExistsRuntime = (() => {
      try { return fs.existsSync(ledgerPath) || fs.existsSync(repoRoot + "/.posse"); }
      catch { return false; }
    })();
    if (!fsExistsRuntime) {
      logAtlasWarmTelemetry("atlas.warm.skipped", {
        outcome: "runtime_missing",
        job_id: jobId,
        purpose,
        branch: branch || payload?.branch || null,
        baseline_branch: baselineBranch || null,
        repo_root_basename: path.basename(String(repoRoot || "")) || null,
        path_count: Array.isArray(paths) ? paths.length : 0,
      });
      return null;
    }
    const label = `ATLAS warm conductor job #${jobId}`;
    const budgetMs = Math.max(1, Number(timeoutMs) || Number(ATLAS_WARM_JOB_POLICY.maxRuntimeMs) || 60_000);
    const gateWaitMs = atlasWarmGateWaitMs(purpose);
    const gatePriority = atlasWarmGatePriority(purpose);
    config ||= getAtlasIntegrationConfig();
    const warmTelemetry = atlasWarmTelemetryContext({ jobId, purpose, branch: branch || payload?.branch || null, baselineBranch, repoRoot, paths, budgetMs, timeoutMs });
    // The conductor caches DB handles per (ledgerPath|dbPath) target. `warm` is
    // ledger-only — ParseEngine resolves and writes its own view from the job's
    // out_view_path — so dbPath here is just a stable per-repo handle-cache key.
    const viewKeyPath = mainViewPath(repoRoot);
    const job = { ...payload, purpose, branch: branch || payload?.branch || undefined, paths };
    logAtlasWarmTelemetry("atlas.warm.conductor_dispatch", {
      ...warmTelemetry,
      outcome: "started",
      label,
    });
    emitAtlasWarmProgress(worker, jobId, { stage: purpose, text: "dispatched to conductor" });
    const conductor = getSharedConductor();
    // Feed the conductor's now-streamed per-stage progress to BOTH the job log
    // line and the live ATLAS/ONNX readiness bars in the TUI.
    const onProgress = (event) => {
      emitAtlasWarmProgress(worker, jobId, event);
      warmReadinessProgress(event);
    };
    warmReadinessStarted();
    let warmOk = false;
    try {
      const result = await runSqliteWrite(
        ledgerPath,
        async (gateInfo = {}) => {
          const conductorStartedAt = nowMs();
          logAtlasWarmTelemetry("atlas.warm.conductor_start", {
            ...warmTelemetry,
            sqlite_wait_ms: gateInfo.waitMs ?? null,
            sqlite_depth_at_enqueue: gateInfo.depthAtEnqueue ?? null,
            sqlite_in_flight_at_enqueue: gateInfo.inFlightAtEnqueue ?? null,
            sqlite_mode: gateInfo.mode || null,
          });
          try {
            const result = await conductor.warm(
              {
                ledgerPath,
                dbPath: viewKeyPath,
                repoRoot,
                branch: baselineBranch,
                scipMode: config?.scipMode,
                scipDir: config?.scipDir,
                config,
                job,
              },
              // The conductor gets its OWN full runtime budget, measured from
              // gate acquisition — gate-wait is bounded separately by waitMs
              // below and must not be charged against the conductor deadline.
              { signal: abortSignal, timeoutMs: budgetMs, onProgress },
            );
            logAtlasWarmTelemetry("atlas.warm.conductor_result", {
              ...warmTelemetry,
              outcome: "ok",
              duration_ms: nowMs() - conductorStartedAt,
              paths_indexed: Number(result?.paths_indexed) || 0,
              blobs_ingested: Number(result?.blobs_ingested) || 0,
              ledger_entries_appended: Number(result?.ledger_entries_appended) || 0,
              embeddings_complete: result?.embeddings_complete ?? null,
            });
            return result;
          } catch (err) {
            logAtlasWarmTelemetry("atlas.warm.conductor_result", {
              ...warmTelemetry,
              outcome: "error",
              duration_ms: nowMs() - conductorStartedAt,
              error: errorSummary(err),
            });
            throw err;
          }
        },
        {
          label,
          waitMs: gateWaitMs,
          priority: gatePriority,
          onCancel: (info = {}) => {
            logAtlasWarmTelemetry("atlas.warm.sqlite_gate", {
              ...warmTelemetry,
              outcome: "timeout",
              status: "canceled",
              wait_ms: info.waitMs ?? null,
              depth_at_enqueue: info.depthAtEnqueue ?? null,
              in_flight_at_enqueue: info.inFlightAtEnqueue ?? null,
              label: info.label || label,
              error: errorSummary(info.error),
            });
          },
          onRelease: (info = {}) => {
            logAtlasWarmTelemetry("atlas.warm.sqlite_gate", {
              ...warmTelemetry,
              outcome: info.status === "fulfilled" ? "released" : "error",
              status: info.status || null,
              wait_ms: info.waitMs ?? null,
              depth_at_enqueue: info.depthAtEnqueue ?? null,
              in_flight_at_enqueue: info.inFlightAtEnqueue ?? null,
              sqlite_mode: info.mode || null,
              label: info.label || label,
              error: errorSummary(info.error),
            });
          },
        },
      );
      warmOk = true;
      return result;
    } finally {
      warmReadinessDone(warmOk);
    }
  } catch (err) {
    const purpose = String(payload?.purpose || "wi");
    const message = /** @type {any} */ (err)?.message || String(err);
    if (isAtlasWarmGateBusy(err)) {
      logAtlasWarmTelemetry("atlas.warm.skipped", {
        ...atlasWarmTelemetryContext({ jobId, purpose, branch: branch || payload?.branch || null, baselineBranch, repoRoot, paths, budgetMs: timeoutMs, timeoutMs }),
        outcome: "sqlite_gate_busy",
        error: errorSummary(err),
      });
      // A gate-busy deferral is NOT a no-op: the warm did no work, so the view
      // is now STALE (retrieval keeps serving the last-built view, but new
      // commits are not reflected). This was previously silent — the job
      // reported "succeeded" with 0 updates and nothing surfaced — which let a
      // starved warm gate hide for dozens of jobs. Surface it on the job log
      // like the hard-failure path below, without failing the job (maxAttempts
      // is 1; failing would just dead-letter a transient contention).
      try {
        const gateWaitMs = atlasWarmGateWaitMs(purpose);
        worker.emit(jobId, `${C.yellow}[atlas] warm #${jobId} (${purpose}) deferred — ledger write gate busy after ${gateWaitMs}ms; view left STALE until the next warm acquires the gate${C.reset}`);
      } catch { /* emit is best-effort */ }
      return atlasWarmSkippedResult({ payload, purpose, paths, reason: "busy", message });
    }
    if (err?._killReason || err?.code === "THREAD_ABORTED" || err?.name === "AbortError"
      || err?.code === "DAEMON_ABORTED" || err?.code === "DAEMON_TRANSPORT_GONE") {
      throw err;
    }
    if (isAtlasWarmSoftInfrastructureMiss(err) && !isVerboseAtlasErrors()) {
      logAtlasWarmTelemetry("atlas.warm.skipped", {
        ...atlasWarmTelemetryContext({ jobId, purpose, branch: branch || payload?.branch || null, baselineBranch, repoRoot, paths, budgetMs: timeoutMs, timeoutMs }),
        outcome: "infrastructure_timeout",
        error: errorSummary(err),
      });
      return atlasWarmSkippedResult({ payload, purpose, paths, reason: "infra_unavailable", message });
    }
    // The .posse runtime exists, so warming SHOULD have worked. A
    // failure here is a real bug, not "not ready" — surface it.
    try {
      worker.emit(jobId, `${C.yellow}[atlas] warm failed: ${message}${C.reset}`);
    } catch { /* ignore */ }
    logAtlasError("[atlas-warm] runRealWarmer threw (job #" + jobId + "):", err);
    if (isVerboseAtlasErrors()) {
      // Re-throw so the outer executor records the full stack on the
      // attempt and marks the job failed. Operators set the env var
      // when they want hard-fail visibility; default mode preserves
      // the legacy fall-back-to-stub behavior.
      throw err;
    }
    return null;
  }
}

/**
 * @param {any} worker
 * @param {number} jobId
 * @param {Record<string, unknown>} event
 */
function emitAtlasWarmProgress(worker, jobId, event = {}) {
  const text = typeof event?.text === "string" ? event.text.trim() : "";
  if (!text) return;
  const stage = typeof event?.stage === "string" && event.stage.trim() ? ` ${event.stage.trim()}` : "";
  try {
    worker?.emit?.(jobId, `${C.dim}[atlas] warm${stage}: ${text}${C.reset}`);
  } catch {
    // Progress is observational.
  }
}

/**
 * @param {any} worker
 * @returns {string}
 */
function resolveAtlasRepoRoot(worker) {
  if (worker && typeof worker.repoRoot === "string" && worker.repoRoot) return worker.repoRoot;
  if (worker && typeof worker.projectDir === "string" && worker.projectDir) return worker.projectDir;
  if (worker && typeof worker?.context?.repoRoot === "string") return worker.context.repoRoot;
  return process.cwd();
}
