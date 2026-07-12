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
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import { createBootPanel } from "./boot-panel.js";
import { resolveScipStagePlans } from "../../atlas/functions/v2/scip/indexers.js";
import { setConductorKeepWarm, closeSharedConductor } from "../../atlas/functions/v2/parse/conductor.js";
import { renderNeuralNetworkBanner } from "../../ui/functions/display/neural-network-banner.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { closeDb } from "../../../shared/storage/functions/index.js";
import { flushEventsNow } from "../../queue/functions/events.js";
import { closeLog } from "../../../shared/telemetry/functions/logging/logger.js";
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

export function firstLine(value, fallback = "unknown") {
  return String(value || fallback).trim().split(/\r?\n/)[0] || fallback;
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
        if (next !== undefined) {
          value = next;
          if (typeof onUpdate === "function") onUpdate(value);
        }
        return value;
      })
      .catch((err) => {
        if (typeof onError === "function") onError(err);
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

export function closeRuntimeStateForExit() {
  // Record the clean shutdown FIRST (needs the DB open) so the bridge
  // derives `offline` instead of `stalled` once the heartbeat ages out.
  try { markCleanShutdown(); } catch { /* best effort */ }
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
  closeRuntimeState = closeRuntimeStateForExit,
  exit = process.exit,
} = {}) {
  if (display) display.stop();
  const code = signal === "SIGTERM" ? 143 : 130;
  process.exitCode = code;
  const finish = () => {
    closeRuntimeState?.();
    exit(code);
  };
  try {
    const stopResult = cleanupAtlasForSession?.({ label: "Interrupted wrap-up" });
    if (stopResult && typeof stopResult.then === "function") {
      return stopResult.finally(finish);
    }
  } catch {
    // Best-effort shutdown still needs to close local state and exit.
  }
  finish();
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
