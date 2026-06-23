// lib/domains/git/functions/worktree-internal.js
//
// Shared low-level helpers used across the worktree submodules: random token
// generation, sleeps (sync + async), git-gate pressure introspection, GC timing
// instrumentation, and git error classification. Kept dependency-free of the
// other worktree submodules so nothing has to import the worktree barrel.

import path from "path";
import { randomBytes } from "crypto";
import { throwIfAborted, signalAbortError } from "../../runtime/functions/yield.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { gitGateSnapshot } from "./utils.js";
import { parsePositiveIntSetting } from "./worktree-snapshots.js";

const DEFAULT_GC_TIMING_SLOW_MS = 1000;
const GC_TIMING_SUMMARY_LIMIT = 5;
export const WORKTREE_REMOVE_RETRY_DELAYS_MS = Object.freeze(process.platform === "win32"
  ? [250, 750, 1500, 3000]
  : [100]);

export function randomToken(bytes = 4) {
  return randomBytes(bytes).toString("hex");
}

export function formatGcDuration(ms) {
  const rounded = Math.max(0, Math.round(Number(ms) || 0));
  if (rounded < 1000) return `${rounded}ms`;
  const seconds = rounded / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

export function sleepSyncMs(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, delay);
}

export function sleepMs(ms, { signal = null } = {}) {
  const delay = Math.max(0, Number(ms) || 0);
  throwIfAborted(signal);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signalAbortError(signal));
    };
    function done() {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function normalizeGitGateKey(cwd) {
  const normalized = path.resolve(String(cwd || process.cwd())).replace(/\\/g, "/");
  return `git:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

export function gitGatePressureSummary(cwd) {
  let state = null;
  try {
    const key = normalizeGitGateKey(cwd);
    state = gitGateSnapshot().keys.find((entry) => entry.key === key) || null;
  } catch {
    state = null;
  }
  if (!state) return null;
  const activeReaders = Number(state.activeReaders) || 0;
  const pendingReaders = Number(state.pendingReaders) || 0;
  const pendingWriters = Number(state.pendingWriters) || 0;
  const activeWriter = Boolean(state.activeWriter);
  if (!activeWriter && activeReaders === 0 && pendingReaders === 0 && pendingWriters === 0) return null;
  return [
    `readers=${activeReaders}`,
    `writer=${activeWriter ? 1 : 0}`,
    `pendingReaders=${pendingReaders}`,
    `pendingWriters=${pendingWriters}`,
  ].join(" ");
}

export function resolveGcTimingSlowMs(value) {
  if (value != null) {
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return parsePositiveIntSetting("worktree_gc_timing_slow_ms", DEFAULT_GC_TIMING_SLOW_MS);
}

export function createGcTiming(onMsg, { slowMs = null, now = null } = {}) {
  const startedAt = typeof now === "function" ? now() : Date.now();
  const nowFn = typeof now === "function" ? now : () => Date.now();
  const thresholdMs = resolveGcTimingSlowMs(slowMs);
  const entries = [];
  const notify = typeof onMsg === "function" ? onMsg : () => {};

  function emit(message) {
    try { notify(message); } catch { /* instrumentation must not affect cleanup */ }
  }

  function detailSuffix(detail = {}) {
    const parts = [];
    if (detail.gitGateBefore) parts.push(`git gate before: ${detail.gitGateBefore}`);
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
  }

  function record(label, startMs, detail = {}) {
    const durationMs = Math.max(0, Math.round(nowFn() - startMs));
    const entry = { label, durationMs, detail };
    entries.push(entry);
    if (durationMs >= thresholdMs) {
      emit(`GC timing: ${label} took ${formatGcDuration(durationMs)}${detailSuffix(detail)}`);
      try {
        log.warn("git", "Worktree GC step was slow", {
          label,
          durationMs,
          thresholdMs,
          ...(detail.gitGateBefore ? { gitGateBefore: detail.gitGateBefore } : {}),
        });
      } catch { /* instrumentation must not affect cleanup */ }
    }
  }

  async function step(label, fn, { gitCwd = null } = {}) {
    const startMs = nowFn();
    const detail = {};
    if (gitCwd) {
      const gitGateBefore = gitGatePressureSummary(gitCwd);
      if (gitGateBefore) detail.gitGateBefore = gitGateBefore;
    }
    try {
      return await fn();
    } finally {
      record(label, startMs, detail);
    }
  }

  function finish() {
    if (entries.length === 0) return;
    const totalDurationMs = Math.max(0, Math.round(nowFn() - startedAt));
    const slowEntries = entries.filter((entry) => entry.durationMs >= thresholdMs);
    if (totalDurationMs < thresholdMs && slowEntries.length === 0) return;
    const slowest = [...entries]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, GC_TIMING_SUMMARY_LIMIT)
      .map((entry) => `${entry.label} ${formatGcDuration(entry.durationMs)}`)
      .join(", ");
    emit(`GC timing: total ${formatGcDuration(totalDurationMs)}; slowest: ${slowest}`);
    try {
      log.info("git", "Worktree GC timing summary", {
        totalDurationMs,
        thresholdMs,
        slowest: [...entries]
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, GC_TIMING_SUMMARY_LIMIT)
          .map((entry) => ({ label: entry.label, durationMs: entry.durationMs })),
      });
    } catch { /* instrumentation must not affect cleanup */ }
  }

  return { step, finish };
}

export function gitErrorExitCode(err) {
  if (Number.isInteger(err?.status)) return err.status;
  if (Number.isInteger(err?.code)) return err.code;
  return null;
}

export function gitErrorSummary(err) {
  return String(err?.stderr || err?.message || err || "unknown git error")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
    ?.slice(0, 500) || "unknown git error";
}

export function isExpectedGitPredicateMiss(err) {
  return gitErrorExitCode(err) === 1;
}

export function logSuppressedGitFailure(operation, err, detail = {}) {
  log.debug("git", `${operation} failed; preserving legacy fallback`, {
    ...detail,
    exitCode: gitErrorExitCode(err),
    error: gitErrorSummary(err),
  });
}
