import { isMainThread, parentPort, workerData } from "worker_threads";
import { gitCommitAll } from "./commit-scope.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { GIT_MUTATE_ROUTE } from "../../../catalog/binary.js";

function post(message) {
  try { parentPort?.postMessage(message); } catch { /* worker is closing */ }
}

function errorPayload(err) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err || "git commit worker failed"),
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
    outOfScopeDirtySkipped: Array.isArray(err?.outOfScopeDirtySkipped) ? err.outOfScopeDirtySkipped : null,
    outOfScopeStagingSkipped: Array.isArray(err?.outOfScopeStagingSkipped) ? err.outOfScopeStagingSkipped : null,
    retryable: err?.retryable === true,
    assessmentRetryable: err?.assessmentRetryable === true,
    gitAddWarnings: Array.isArray(err?.gitAddWarnings) ? err.gitAddWarnings : null,
    nativeFailure: err?.nativeFailure || null,
    rollbackStatus: err?.rollbackStatus || null,
    rollbackSucceeded: err?.rollbackSucceeded ?? null,
    nativeDiagnostics: Array.isArray(err?.nativeDiagnostics) ? err.nativeDiagnostics : null,
    headBefore: err?.headBefore || null,
    headAfter: err?.headAfter || null,
  };
}

async function runCommit() {
  let outcome;
  try {
    if (workerData?.nativeAuth?.envelope && typeof workerData.nativeAuth.envelope === "object") {
      nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(workerData.nativeAuth));
    }
    nativeBinaries.installWorkerRuntime(workerData?.nativeRuntime);
    const { message, cwd, scope, opts } = workerData || {};
    if (workerData?.teamSessionContext) {
      const pins = opts?.verifiedTeamWorkItemContext;
      if (!pins || !workerData.teamSessionContext.instanceId
          || !workerData.teamSessionContext.sessionId) {
        throw Object.assign(new Error("Team commit worker lacks its WI grant pins"), {
          code: "TEAM_WI_GRANT_REQUIRED",
        });
      }
      nativeBinaries.pulseManager.setSessionContext(workerData.teamSessionContext);
      nativeBinaries.pulseManager.confirmNativeScopeEnforcement(true);
      const pulse = await nativeBinaries.binary("git").primeWorkItemPulse(pins);
      if (!pulse || pulse.route !== GIT_MUTATE_ROUTE) {
        throw Object.assign(new Error("Team commit worker could not prime its WI-scoped Git pulse"), {
          code: "TEAM_WI_PULSE_UNAVAILABLE",
        });
      }
    }
    const result = gitCommitAll(message, cwd, scope, opts);
    outcome = { type: "result", result };
  } catch (err) {
    outcome = { type: "error", error: errorPayload(err) };
  }
  // The parent may terminate the worker immediately after its terminal frame,
  // so child-process teardown must finish before that frame is observable.
  try { await nativeBinaries.disposeAll(); } catch { /* teardown is best effort */ }
  post(outcome);
}

// This module is a worker-thread entrypoint, not a library: importing it runs
// the commit. The guard keeps an accidental main-thread import (e.g. via a
// barrel re-export) from executing a junk in-thread commit attempt.
if (!isMainThread) void runCommit();
