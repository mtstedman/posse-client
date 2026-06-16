import { isMainThread, parentPort, workerData } from "worker_threads";
import { gitCommitAll } from "./commit-scope.js";
import { nativeBinaries } from "../../../classes/tools/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";

function post(message) {
  try { parentPort?.postMessage(message); } catch { /* worker is closing */ }
}

function runCommit() {
  try {
    if (workerData?.nativeAuth?.envelope && typeof workerData.nativeAuth.envelope === "object") {
      nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(workerData.nativeAuth, { keyless: false }));
    }
    const { message, cwd, scope, opts } = workerData || {};
    const result = gitCommitAll(message, cwd, scope, opts);
    post({ ok: true, result });
  } catch (err) {
    post({
      ok: false,
      error: err?.message || String(err),
      stack: err?.stack || null,
      code: err?.code || null,
      errno: err?.errno ?? null,
      syscall: err?.syscall || null,
      path: err?.path || null,
      spawnargs: Array.isArray(err?.spawnargs) ? err.spawnargs : null,
      status: err?.status ?? null,
      signal: err?.signal || null,
      killed: Boolean(err?.killed),
      gitCommitTimedOut: Boolean(err?.gitCommitTimedOut),
      gitCommitTimeoutBudget: err?.gitCommitTimeoutBudget || null,
      stderr: err?.stderr ? String(err.stderr) : null,
      stdout: err?.stdout ? String(err.stdout) : null,
      hookOutput: err?.hookOutput || null,
      createdOutOfScope: Array.isArray(err?.createdOutOfScope) ? err.createdOutOfScope : null,
      gitAddWarnings: Array.isArray(err?.gitAddWarnings) ? err.gitAddWarnings : null,
    });
  }
}

// This module is a worker-thread entrypoint, not a library: importing it runs
// the commit. The guard keeps an accidental main-thread import (e.g. via a
// barrel re-export) from executing a junk in-thread commit attempt.
if (!isMainThread) runCommit();
