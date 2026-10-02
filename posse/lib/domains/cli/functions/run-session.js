// Runtime session orchestration for the run command.
// Keeps the CLI entry point thin while preserving the existing command behavior.

import readline from "readline";
import { displayRoleForJobType } from "../../providers/functions/roles.js";
import { ensureRemoteCatalogLoaded, getRemoteCatalog } from "../../providers/functions/model-catalog-store.js";
import { describeModelCatalogWarning, validateConfiguredModels } from "../../providers/functions/model-catalog-validate.js";
import { maybeRefreshModelCatalog } from "../../remote/functions/model-catalog-refresh.js";
import { cancelOpenPushOfferGates } from "../../queue/functions/push-offer.js";
import {
  RUNTIME_STATUS_KEYS,
  clearRuntimeStatus,
  markCleanShutdown,
  markForcedShutdown,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import { createBootPanel } from "./boot-panel.js";
import { resolveScipStagePlans } from "../../atlas/functions/v2/scip/indexers.js";
import { setConductorKeepWarm, closeSharedConductor } from "../../atlas/functions/v2/parse/conductor.js";
import { renderNeuralNetworkBanner } from "../../ui/functions/display/neural-network-banner.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { isPushOfferJob } from "../../queue/functions/common.js";
import { activeWorkItemDispositionGates } from "../../queue/functions/work-item-dispositions.js";
import { mergeVerificationReviewGateState } from "../../queue/functions/merge-verification-review.js";
import { resolveGateReviewDiffTarget } from "../../queue/functions/gate-review-target.js";
import {
  CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE,
  MERGE_VERIFICATION_REVIEW_TYPE,
  WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
  humanGateStateAllowsAnswer,
  humanInputChoicesForPayload,
} from "../../../catalog/human-input.js";
import { getHumanGate, listJobs } from "../../queue/functions/index.js";
import { closeDb } from "../../../shared/storage/functions/index.js";
import { flushEventsNow } from "../../queue/functions/events.js";
import { closeLog, log } from "../../../shared/telemetry/functions/logging/logger.js";
import { closeOutputLog } from "../../../shared/telemetry/functions/logging/output-log.js";
import { closePromptLog } from "../../../shared/telemetry/functions/logging/prompt-log.js";
import { closeObservationLog } from "../../observability/functions/observations.js";
import { recordRunDiagnostic } from "../../../shared/telemetry/functions/run-diagnostics.js";
import { ensureBootDependenciesInWorker, formatBootDependencySync } from "../../system/functions/dependency-sync.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { ACTIVE_LEASE_STATUSES, LOCK_HOLDING_JOB_STATUSES } from "../../../catalog/job.js";
import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { fit as fitAnsi } from "../../../shared/format/functions/ansi.js";
import { nativeBinaries as defaultNativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { daemonSupervisor as defaultDaemonSupervisor } from "../../../shared/tools/classes/daemon/index.js";
import { persistentMcpOwner } from "../../../shared/tools/classes/PersistentMcpOwner.js";

export const PROVIDER_AUTH_WARMUP_TIMEOUT_MS = 30_000;
export const PROVIDER_USAGE_WARMUP_SOFT_TIMEOUT_MS = 1_200;

export const TUI_SNAPSHOT_WORKER_URL = new URL("./tui-snapshot-worker.js", import.meta.url);
export const TUI_SNAPSHOT_THREAD_MANAGER = new ThreadManager();
export const EMPTY_TOOL_SNAPSHOT = { jobs: [], recent: [], activeLocks: { work_items: [], jobs: [] } };

export function operationalRunJobs(jobs = []) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => !isPushOfferJob(job));
}

export function firstLine(value, fallback = "unknown") {
  return String(value || fallback).trim().split(/\r?\n/)[0] || fallback;
}

/**
 * The open operator gate that holds a work item, or null: a cross-WI upstream
 * disposition or failure disposition gate, or a merge verification review
 * that has not passed. A completed work item held this way does not merge
 * until the operator answers.
 *
 * @param {number} workItemId
 * @returns {{ gate_job_id: number, review_type: string } | null}
 */
export function openParkingGateForWorkItem(workItemId) {
  for (const reviewType of [CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE, WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE]) {
    const [gate] = activeWorkItemDispositionGates(workItemId, reviewType);
    if (gate) return { gate_job_id: Number(gate.id), review_type: reviewType };
  }
  const review = mergeVerificationReviewGateState(workItemId);
  if (review?.holds) return { gate_job_id: Number(review.gate_job_id), review_type: MERGE_VERIFICATION_REVIEW_TYPE };
  return null;
}

/**
 * Open human gates a finished run leaves behind. Nothing asks them again
 * until the next run, the phone or `posse gate answer`; a push offer is never
 * re-prompted on its own (fiscal-wizard 2026-10-01: push offer #15 sat open
 * for 9 hours without being asked).
 */
export function listOpenHumanGatesAtExit({ listJobsFn = listJobs, getHumanGateFn = getHumanGate } = {}) {
  return listJobsFn(["queued", "waiting_on_human"])
    .filter((job) => job?.job_type === "human_input")
    .filter((job) => humanGateStateAllowsAnswer(getHumanGateFn(job.id)?.gate_state));
}

/**
 * Exit-summary lines naming each open gate and how to answer it, leaving out
 * gates the completion summary already names (excludeGateIds). A verdict on
 * code also names `posse gate show`, which prints the diff it judges.
 */
export function describeOpenGatesAtExit(gates = [], {
  excludeGateIds = [],
  getHumanGateFn = getHumanGate,
  reviewDiffTargetFn = resolveGateReviewDiffTarget,
  limit = 8,
} = {}) {
  const excluded = new Set(excludeGateIds.map(Number));
  const open = gates.filter((gate) => gate && !excluded.has(Number(gate.id)));
  const lines = open.slice(0, limit).map((gate) => {
    const payload = parseJobPayload(gate);
    const wi = gate.work_item_id == null ? "" : ` for WI#${gate.work_item_id}`;
    if (payload.subtype === "push_offer") {
      return `#${gate.id} push offer (${firstLine(gate.title, "push to remote")}): push or decline it from the phone or at the next run's wrap-up`;
    }
    if (payload.subtype === "plan_approval") {
      return `#${gate.id} plan approval${wi}: posse plan approve|reject ${gate.work_item_id ?? "<wiId>"}`;
    }
    let kind = null;
    try { kind = getHumanGateFn(gate.id)?.gate_kind || null; } catch { kind = null; }
    const choices = humanInputChoicesForPayload(payload);
    let reviewsCode = false;
    try { reviewsCode = Boolean(reviewDiffTargetFn(gate, { payload })); } catch { reviewsCode = false; }
    return `#${gate.id} ${kind || payload.review_type || "question"}${wi}: posse gate answer ${gate.id} ${choices.length > 0 ? choices.join("|") : "<answer>"}${reviewsCode ? ` (diff: posse gate show ${gate.id})` : ""}`;
  });
  if (open.length > lines.length) lines.push(`+${open.length - lines.length} more open gate(s)`);
  return lines;
}

/**
 * Derive the shell outcome from the final aggregate state of the work items
 * handled by this run. Individual failed jobs are not sufficient: a failed
 * parent followed by a successful fix child is a recovered work item and must
 * still exit successfully. Failed/canceled work exits 1; operator-gated work
 * exits 2 so headless callers can distinguish "needs action" from failure.
 * Operator-gated work includes a completed, unmerged work item that an open
 * gate holds (`parkingGateFor`, e.g. openParkingGateForWorkItem; finding 11,
 * run 1250b), and work the scheduler left queued behind such work items when
 * it finished as needs-action (`needsAction`, the scheduler's
 * needsActionReport).
 *
 * @param {Array<{ id?: number, status?: string, merge_state?: string | null }>} [workItems]
 * @param {{
 *   parkingGateFor?: ((workItemId: number) => ({ gate_job_id: number, review_type: string } | null)) | null,
 *   needsAction?: { waiting_work_item_ids?: number[], holders?: Array<{ work_item_id: number }> } | null,
 * }} [options]
 */
export function summarizeRunCompletion(workItems = [], { parkingGateFor = null, needsAction = null } = {}) {
  const openGateFor = (item) => {
    if (typeof parkingGateFor !== "function") return null;
    try { return parkingGateFor(Number(item.id)); } catch { return null; }
  };
  const failures = workItems
    .filter((item) => item && (item.status === "failed" || item.status === "canceled"))
    .map((item) => {
      // A failed work item's open recovery gate is named at exit: the run
      // ends while it waits parked (wowiekowie 2026-10-01: gate #2252 was
      // never mentioned when the run exited).
      const gate = item.status === "failed" ? openGateFor(item) : null;
      return {
        id: Number(item.id) || null,
        status: item.status,
        ...(gate ? { gate_job_id: gate.gate_job_id, review_type: gate.review_type } : {}),
      };
    });
  const incomplete = workItems
    .filter((item) => item && (
      item.status === "blocked"
      || item.status === "waiting_on_human"
      || item.status === "waiting_on_review"
    ))
    .map((item) => ({ id: Number(item.id) || null, status: item.status }));
  for (const item of workItems) {
    if (!item || item.status !== "complete" || item.merge_state === "merged") continue;
    const gate = openGateFor(item);
    if (gate) {
      incomplete.push({
        id: Number(item.id) || null,
        status: item.status,
        gate_job_id: gate.gate_job_id,
        review_type: gate.review_type,
      });
    } else if (item.merge_state === "merge_failed") {
      // A merge failure is unresolved work even if gate lookup is unavailable
      // (for example during late shutdown after the DB has closed).
      incomplete.push({
        id: Number(item.id) || null,
        status: item.status,
        merge_state: item.merge_state,
      });
    }
  }
  const waitingIds = new Set((needsAction?.waiting_work_item_ids || []).map(Number));
  if (waitingIds.size > 0) {
    const holderIds = (needsAction?.holders || []).map((holder) => Number(holder.work_item_id));
    for (const item of workItems) {
      if (!item || !waitingIds.has(Number(item.id))) continue;
      if (["complete", "failed", "canceled"].includes(item.status)) continue;
      if (incomplete.some((entry) => entry.id === Number(item.id))) continue;
      incomplete.push({
        id: Number(item.id) || null,
        status: item.status,
        waiting_on_work_item_ids: holderIds.filter((id) => id !== Number(item.id)),
      });
    }
  }
  const exitCode = failures.length > 0 ? 1 : (incomplete.length > 0 ? 2 : 0);
  return {
    ok: exitCode === 0,
    exitCode,
    failures,
    incomplete,
  };
}

/**
 * @param {{ stdout?: any, stderr?: any }} [input]
 */
export function createTerminalOutputIntercept({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const origStdoutWrite = stdout.write.bind(stdout);
  const origStderrWrite = stderr?.write?.bind(stderr);
  /** @type {Array<{stream: "stdout" | "stderr", data: string | Buffer, encoding?: string}>} */
  const buffer = [];
  let stdoutActive = false;
  let stderrActive = false;
  const bufferedWrite = (streamName) => (chunk, encoding, callback) => {
    const cb = typeof encoding === "function" ? encoding : callback;
    const enc = typeof encoding === "string" ? encoding : undefined;
    buffer.push({ stream: streamName, data: chunk, encoding: enc });
    if (typeof cb === "function") cb();
    return true;
  };

  const install = () => {
    if (!stdout?.isTTY) return;
    if (!stdoutActive) {
      stdoutActive = true;
      stdout.write = bufferedWrite("stdout");
    }
    if (stderr?.isTTY && origStderrWrite && !stderrActive) {
      stderrActive = true;
      stderr.write = bufferedWrite("stderr");
    }
  };

  const release = () => {
    if (!stdoutActive && !stderrActive) return;
    if (stdoutActive) {
      stdout.write = origStdoutWrite;
      stdoutActive = false;
    }
    if (stderrActive) {
      stderr.write = origStderrWrite;
      stderrActive = false;
    }
    for (const entry of buffer) {
      try {
        const write = entry.stream === "stderr" ? origStderrWrite : origStdoutWrite;
        if (!write) continue;
        if (entry.encoding) write(entry.data, entry.encoding);
        else write(entry.data);
      } catch { /* observational */ }
    }
    buffer.length = 0;
  };

  return {
    install,
    release,
    writeStdout: origStdoutWrite,
    get active() { return stdoutActive || stderrActive; },
    get bufferedCount() { return buffer.length; },
  };
}

export function runTuiSnapshotTask(task, { projectDir, dbPath }) {
  return TUI_SNAPSHOT_THREAD_MANAGER.run(TUI_SNAPSHOT_WORKER_URL, {
    label: `TUI ${task} snapshot`,
    timeoutMs: 5_000,
    workerData: {
      task,
      args: { projectDir, dbPath },
    },
  });
}

export function createAsyncSnapshotCache({
  initialValue,
  minIntervalMs = 750,
  load,
  onUpdate = null,
  onError = null,
} = {}) {
  let value = initialValue;
  let inFlight = null;
  let lastStartedAt = 0;
  let stopped = false;

  const refresh = ({ force = false } = {}) => {
    if (stopped || typeof load !== "function") return Promise.resolve(value);
    const now = Date.now();
    if (inFlight) return inFlight;
    if (!force && now - lastStartedAt < minIntervalMs) return Promise.resolve(value);
    lastStartedAt = now;
    inFlight = Promise.resolve()
      .then(load)
      .then((next) => {
        if (stopped) return value;
        if (next !== undefined) {
          value = next;
          if (typeof onUpdate === "function") onUpdate(value);
        }
        return value;
      })
      .catch((err) => {
        if (!stopped && typeof onError === "function") onError(err);
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    get: () => value,
    refresh,
    stop: () => { stopped = true; },
  };
}

export function buildImageInjectionPayload({ prompt = "", outputRoot = "" } = {}) {
  const normalizedOutputRoot = String(outputRoot || "").replace(/\\/g, "/");
  const expectedImagePath = normalizedOutputRoot ? `${normalizedOutputRoot}/image.png` : "image.png";
  return {
    task_spec: [
      "Generate an image based on this description:",
      "",
      prompt,
      "",
      "Use the generate_image tool to create the image.",
      "Save it to: image.png (your working directory is the output folder).",
      "Use quality \"high\" for best results.",
    ].join("\n"),
    task_mode: "image",
    needs_image_generation: true,
    output_root: normalizedOutputRoot,
    create_roots: normalizedOutputRoot ? [normalizedOutputRoot] : [],
    files_to_modify: [],
    files_to_create: [expectedImagePath],
    success_criteria: [
      `${expectedImagePath} exists`,
      "Image is a valid PNG/JPG/WebP",
    ],
  };
}

export function closeRuntimeStateForExit({ forced = false, reason = null } = {}) {
  // Record the shutdown FIRST (needs the DB open) so the bridge derives
  // `offline` instead of `stalled` once the heartbeat ages out. A forced exit
  // (second signal, shutdown watchdog) abandons in-flight work, so it is
  // recorded as forced rather than clean.
  try {
    if (forced) markForcedShutdown({ reason });
    else markCleanShutdown();
  } catch { /* best effort */ }
  // Last line of a run: without it a clean exit and a crash look the same.
  try {
    if (forced) log.warn("run", "Forced shutdown recorded", { exitCode: process.exitCode ?? 1, reason });
    else log.info("run", "Clean shutdown recorded", { exitCode: process.exitCode ?? 0 });
  } catch { /* best effort */ }
  try { flushEventsNow(); } catch { /* best effort */ }
  try { closePromptLog(); } catch { /* best effort */ }
  try { closeOutputLog(); } catch { /* best effort */ }
  try { closeObservationLog(); } catch { /* best effort */ }
  try { closeLog(); } catch { /* best effort */ }
  try { closeDb(); } catch { /* best effort */ }
}

export function handleWrapUpSignal({
  signal = "SIGINT",
  display = null,
  cleanupAtlasForSession = null,
  finalizeRuntimeResources = null,
  closeRuntimeState = closeRuntimeStateForExit,
  exit = process.exit,
  forceExitMs = 10000,
} = {}) {
  if (display) display.stop();
  const code = signal === "SIGTERM" ? 143 : 130;
  process.exitCode = code;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    try { closeRuntimeState?.(); } finally { exit(code); }
  };
  const forceTimer = setTimeout(finish, forceExitMs);
  forceTimer.unref?.();
  const finalize = () => {
    try {
      const result = finalizeRuntimeResources?.();
      if (result && typeof result.then === "function") return Promise.resolve(result).then(finish, finish);
    } catch {
      // Best-effort shutdown still needs to close local state and exit.
    }
    finish();
  };
  try {
    const stopResult = cleanupAtlasForSession?.({ label: "Interrupted wrap-up" });
    if (stopResult && typeof stopResult.then === "function") {
      return stopResult.then(finalize, finalize);
    }
  } catch {
    // Continue through the complete runtime finalizer.
  }
  return finalize();
}

export function bootScipLangPatchFromEvent(event = {}) {
  const kind = String(event.kind || "");
  const stage = String(event.stage || "");
  const percent = Number(event.percent ?? event.language_percent);
  const current = Number(event.language_current ?? event.current ?? event.progress_current);
  const total = Number(event.language_total ?? event.total ?? event.progress_total);
  const countPatch = {};
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    countPatch.current = current;
    countPatch.total = total;
  }
  if (Number.isFinite(percent)) countPatch.percent = percent;

  if (kind === "atlas.scip.restage_failed") {
    return {
      state: "failed",
      percent: 100,
      detail: event.text || "failed",
    };
  }
  if (kind === "atlas.scip.restage_completed") {
    return {
      state: "indexing",
      percent: 100,
      detail: "indexed",
    };
  }
  if (kind === "atlas.scip.ingest.skipped") {
    return { state: "done", percent: 100, detail: "already ingested" };
  }
  if (kind === "atlas.scip.ingest.completed") {
    const ingested = Number(event.documents_ingested || 0);
    const failed = Number(event.documents_failed || 0);
    const skipped = Number(event.documents_skipped || 0);
    const reused = Number(event.blobs_reused || 0);
    const processed = Number(event.total ?? (ingested + reused + skipped + failed));
    return {
      state: "done",
      current: Number.isFinite(processed) ? processed : ingested,
      total: Number.isFinite(processed) ? processed : ingested + failed,
      percent: 100,
      detail: processed > 0 ? `${processed} docs` : "indexed",
    };
  }
  if (kind === "atlas.scip.ingest.reading") {
    // Ingest picked the file up but hasn't decoded it yet — flip the parse
    // cell to its active phase immediately instead of leaving it at "—".
    return { state: "intaking", detail: event.text || "reading index" };
  }
  if (kind === "atlas.scip.ingest.started" || kind === "atlas.scip.ingest.progress") {
    const phase = String(event.phase || "");
    if (phase === "decode") {
      return { state: "intaking", detail: event.text || "decoding index" };
    }
    if (phase === "convert") {
      // The native rows conversion emits no counts; omit percent so the cell
      // holds at the hydrate ceiling (the merge keeps the previous value).
      return { state: "intaking", detail: event.text || "converting rows" };
    }
    if (!(Number.isFinite(total) && total > 0) && !Number.isFinite(percent)) {
      return {
        state: "indexing",
        ...countPatch,
        detail: event.text || "preparing intake",
      };
    }
    const patch = {
      state: "intaking",
      ...countPatch,
      detail: event.text || "intaking",
    };
    // One continuous sweep across the ingest phases instead of two 0→100
    // runs: hydrate owns 0-35, the ledger write loop 35-100. Display-only
    // scaling — the ingester's events keep their honest per-phase percents.
    if (Number.isFinite(patch.percent)) {
      const raw = Math.max(0, Math.min(100, patch.percent));
      patch.percent = phase === "hydrate" || kind === "atlas.scip.ingest.started"
        ? raw * 0.35
        : phase === "write"
          ? 35 + raw * 0.65
          : raw;
    }
    return patch;
  }
  if (kind === "atlas.scip.restage_started"
      || kind === "atlas.scip.restage_decided"
      || stage === "scip.indexing"
      || stage === "scip") {
    return {
      state: "indexing",
      ...countPatch,
      detail: event.text || "",
    };
  }
  return null;
}

export function scopeScipEventToSourceLanguage(event = {}, lang = "") {
  const key = String(lang || "").trim().toLowerCase();
  if (!key) return event;
  const currentByLang = event.source_language_current || event.sourceLanguageCurrent || null;
  const totalByLang = event.source_language_total || event.sourceLanguageTotal || event.source_language_totals || event.sourceLanguageTotals || null;
  const current = countForLanguage(currentByLang, key);
  const total = countForLanguage(totalByLang, key);
  const hasScopedCount = Number.isFinite(current) || Number.isFinite(total);
  const scopedCurrent = Number.isFinite(current) ? current : 0;
  const scopedTotal = Number.isFinite(total) ? total : 0;
  return {
    ...event,
    language: key,
    indexer_language: event.indexer_language || event.indexer || event.language || languageFromScipScheme(event.scheme),
    ...(hasScopedCount
      ? {
          current: scopedCurrent,
          total: scopedTotal,
          language_current: scopedCurrent,
          language_total: scopedTotal,
          percent: scopedTotal > 0 ? (scopedCurrent / scopedTotal) * 100 : event.percent,
        }
      : {}),
  };
}

export function languageFromScipScheme(scheme) {
  return String(scheme || "").trim().toLowerCase().replace(/^scip-/, "");
}

export function countForLanguage(counts, lang) {
  if (!counts) return NaN;
  if (counts instanceof Map) return Number(counts.get(lang));
  if (typeof counts === "object") return Number(counts[lang]);
  return NaN;
}
