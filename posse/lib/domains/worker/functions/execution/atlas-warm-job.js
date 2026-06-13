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
  if (!Array.isArray(paths)) return [];
  const out = [];
  const seen = new Set();
  for (const value of paths) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
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

function atlasRuntimeDisabledReasonForRepo(repoRoot) {
  return getAtlasRuntimeDisabledReason()
    || getAtlasRuntimeDisabledReason(repoRoot)
    || getAtlasRuntimeDisabledReason(path.basename(String(repoRoot || "")))
    || getAtlasRuntimeDisabledReason(ledgerDbPath(repoRoot));
}

export async function runAtlasWarmJob(worker, job, wrappedJob, { leaseToken, abortSignal = null } = {}) {
  const attempt = incrementAndCreateAttempt(job.id, leaseToken, "system", "atlas-warm", null);
  if (!attempt) {
    logAttemptSkippedStaleLease(job, "system", "Skipped atlas_warm attempt because the lease was stale or expired");
    worker.emit(job.id, `${C.red}[stale-lease]${C.reset} job #${job.id} atlas_warm — lease lost`);
    return;
  }

  const startTime = nowMs();
  try {
    const payload = parseJobPayload(job) || {};
    const purpose = String(payload.purpose || "wi");
    const repoRoot = resolveAtlasRepoRoot(worker);
    const baselineBranch = await resolveAtlasWarmBaselineBranch(repoRoot);
    const branch = typeof payload.branch === "string" ? payload.branch : (purpose === "wi" ? null : baselineBranch);
    const paths = clampPaths(payload.paths);
    const config = getAtlasIntegrationConfig();
    const disabledReason = atlasRuntimeDisabledReasonForRepo(repoRoot);

    worker._throwIfKilled?.(job.id);

    // Runtime disable (e.g. the owner-gone repair path disabled this repo
    // after queueing self-repair warms): the disable is in-memory and clears
    // at the next boot, so leave the job QUEUED instead of consuming it as a
    // no-op "success" — these are often the very repair warms the disable
    // path just enqueued, and the wrap-up message promises to leave them for
    // the next boot. The readyAt backoff keeps the scheduler from re-leasing
    // in a hot loop while the disable lasts. (A configuration disable below
    // is durable, so those jobs are still consumed as no-op stubs.)
    if (disabledReason) {
      completeAttempt(attempt.attempt.id, {
        status: "interrupted",
        duration_ms: nowMs() - startTime,
        error_text: `ATLAS disabled for this run: ${disabledReason}`,
      });
      worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", {
        readyAt: new Date(Date.now() + ATLAS_WARM_DISABLED_REQUEUE_DELAY_MS).toISOString(),
      });
      worker.emit(job.id, `${C.dim}[atlas] warm (${purpose}) deferred: ATLAS disabled for this run (${disabledReason}) — left queued for next boot${C.reset}`);
      return;
    }

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
    // Skip if the surrounding .posse runtime directory does not exist —
    // that means no posse project is bootstrapped here.
    const fsExistsRuntime = (() => {
      try { return fs.existsSync(ledgerPath) || fs.existsSync(repoRoot + "/.posse"); }
      catch { return false; }
    })();
    if (!fsExistsRuntime) return null;
    const label = `ATLAS warm conductor job #${jobId}`;
    const budgetMs = Math.max(1, Number(timeoutMs) || Number(ATLAS_WARM_JOB_POLICY.maxRuntimeMs) || 60_000);
    const gateStartedAt = nowMs();
    config ||= getAtlasIntegrationConfig();
    const purpose = String(payload?.purpose || "wi");
    // The conductor caches DB handles per (ledgerPath|dbPath) target. `warm` is
    // ledger-only — ParseEngine resolves and writes its own view from the job's
    // out_view_path — so dbPath here is just a stable per-repo handle-cache key.
    const viewKeyPath = mainViewPath(repoRoot);
    const job = { ...payload, purpose, branch: branch || payload?.branch || undefined, paths };
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
        () => conductor.warm(
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
          { signal: abortSignal, timeoutMs: Math.max(1, budgetMs - (nowMs() - gateStartedAt)), onProgress },
        ),
        {
          label,
          waitMs: budgetMs,
        },
      );
      warmOk = true;
      return result;
    } finally {
      warmReadinessDone(warmOk);
    }
  } catch (err) {
    // Propagate kill/abort/timeout AND infrastructure failures (the conductor
    // thread died / transport gone) rather than masking them as a stub success.
    // Only a genuine in-warm error falls through to the stub-or-rethrow below.
    if (err?._killReason || err?.code === "THREAD_ABORTED" || err?.name === "AbortError" || err?.code === "THREAD_TIMEOUT"
      || err?.code === "DAEMON_ABORTED" || err?.code === "DAEMON_TIMEOUT" || err?.code === "DAEMON_TRANSPORT_GONE") {
      throw err;
    }
    // The .posse runtime exists, so warming SHOULD have worked. A
    // failure here is a real bug, not "not ready" — surface it.
    const message = /** @type {any} */ (err)?.message || String(err);
    try {
      worker.emit(jobId, `${C.yellow}[atlas] warm failed: ${message}${C.reset}`);
    } catch { /* ignore */ }
    logAtlasError(`[atlas-warm] runRealWarmer threw (job #${jobId}):`, err);
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
