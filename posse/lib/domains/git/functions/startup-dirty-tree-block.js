// lib/domains/git/functions/startup-dirty-tree-block.js
// Durable record of a run the startup dirty-tree guard blocked.
//
// A blocked boot used to leave only a "Boot step started" runtime line and a
// manifest with clean_exit:false / exit_code:2, which reads as a crash
// (fiscal-wizard run 2026-10-01T16-54-02). This records why: an event and a
// runtime line with the policy, block reason and dirty porcelain lines, and
// the manifest's exit_reason.

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { updateRunTelemetryManifest } from "../../../shared/telemetry/functions/run-telemetry.js";

/**
 * @param {object} result the guard's blocked result (policy, blockReason, dirtyCount, dirtyLines)
 * @param {object} [options]
 * @param {string} [options.reason] what was blocked, e.g. "run start"
 * @param {Function|null} [options.logEvent] queue logEvent
 * @param {object|null} [options.log] runtime logger
 * @param {Function} [options.updateManifest] run telemetry manifest patcher
 */
export function recordStartupDirtyTreeBlock(result = {}, {
  reason = "run start",
  logEvent = null,
  log = null,
  updateManifest = updateRunTelemetryManifest,
} = {}) {
  const dirtyLines = Array.isArray(result?.dirtyLines) ? result.dirtyLines.map(String) : [];
  const dirtyCount = Number.isSafeInteger(result?.dirtyCount) ? result.dirtyCount : dirtyLines.length;
  const detail = {
    reason,
    policy: result?.policy ?? null,
    block_reason: result?.blockReason ?? null,
    dirty_count: dirtyCount,
    dirty_lines: dirtyLines,
  };
  try {
    logEvent?.({
      event_type: EVENT_TYPES.GIT_STARTUP_DIRTY_TREE_BLOCKED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Startup dirty tree guard blocked ${reason}: ${dirtyCount} uncommitted change(s) (policy ${detail.policy}, ${detail.block_reason})`,
      event_json: JSON.stringify(detail),
    });
  } catch { /* the console message still reports the block */ }
  try {
    log?.warn?.("run", "Startup dirty tree guard blocked the run", detail);
  } catch { /* observational */ }
  try {
    updateManifest?.({ exit_reason: EVENT_TYPES.GIT_STARTUP_DIRTY_TREE_BLOCKED });
  } catch { /* observational */ }
  return detail;
}
