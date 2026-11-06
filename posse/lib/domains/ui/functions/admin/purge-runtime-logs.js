import fs from "fs";
import path from "path";

import { isProcessAlive } from "../../../../shared/platform/functions/process-liveness.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { closeLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { closeOutputLog } from "../../../../shared/telemetry/functions/logging/output-log.js";
import { closePromptLog } from "../../../../shared/telemetry/functions/logging/prompt-log.js";
import { closeObservationLog } from "../../../observability/functions/observations.js";
import { TERMINAL_WORK_ITEM_STATUSES_SQL } from "../../../queue/functions/common.js";
import { flushEventsNow } from "../../../queue/functions/events.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";
import { getRuntimeLogDir, getRuntimeRoot } from "../../../runtime/functions/paths.js";

// Heartbeats land every 30s; a run silent for longer than this is not live.
const LIVE_RUN_WINDOW_MS = 120_000;

function newestMtimeMs(dir) {
  let newest = fs.statSync(dir).mtimeMs;
  for (const name of fs.readdirSync(dir)) {
    try { newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs); } catch { /* raced away */ }
  }
  return newest;
}

// Only the clean exit hook writes ended_at, so a SIGKILL, OOM kill, reboot or
// SIGHUP leaves it unset for good. A run is live while its owner process is
// alive or its heartbeat is fresh. Without a readable manifest (an inherited-run
// child, or a writer between mkdir and the manifest rename) only recent writes
// keep it.
function runDirIsLive(runDir, now = Date.now()) {
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")); } catch { /* missing or unreadable */ }
  if (manifest && typeof manifest === "object") {
    if (now - Date.parse(manifest.last_heartbeat_at || "") < LIVE_RUN_WINDOW_MS) return true;
    return !manifest.ended_at && isProcessAlive(manifest.pid) === true;
  }
  try {
    return now - newestMtimeMs(runDir) < LIVE_RUN_WINDOW_MS;
  } catch {
    return false;
  }
}

export function purgeRuntimeLogs({ projectDir = null } = {}) {
  closePromptLog();
  closeOutputLog();
  closeObservationLog();
  closeLog();

  const resolvedLogDir = path.resolve(getRuntimeLogDir(projectDir));
  const runtimeRoot = path.resolve(getRuntimeRoot(projectDir));
  if (!resolvedLogDir || resolvedLogDir === path.parse(resolvedLogDir).root) {
    throw new Error(`Refusing to purge unsafe log directory: ${resolvedLogDir}`);
  }
  if (!isInsideRoot(resolvedLogDir, runtimeRoot, { allowEqual: false })) {
    throw new Error(`Refusing to purge log directory outside runtime root: ${resolvedLogDir}`);
  }

  const skippedLiveRuns = [];
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let atlasAgentCalls = 0;
  let atlasObservations = 0;
  let dbAgentCalls = 0;
  let dbObservations = 0;
  let dbEvents = 0;
  let dbAttempts = 0;
  let historyWorkItems = 0;

  try {
    flushEventsNow();
    const db = getDb();
    db.transaction(() => {
      atlasObservations = db.prepare(`
        SELECT COUNT(*) AS count
        FROM job_observations
        WHERE observation_type LIKE 'tool.atlas%'
          AND (
            work_item_id IN (SELECT id FROM work_items WHERE status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL}))
            OR job_id IN (
              SELECT j.id
              FROM jobs j
              JOIN work_items wi ON wi.id = j.work_item_id
              WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
            )
            OR attempt_id IN (
              SELECT ja.id
              FROM job_attempts ja
              JOIN jobs j ON j.id = ja.job_id
              JOIN work_items wi ON wi.id = j.work_item_id
              WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
            )
          )
      `).get().count || 0;
      atlasAgentCalls = db.prepare(`
        SELECT COUNT(*) AS count
        FROM agent_calls
        WHERE (atlas_method IS NOT NULL OR atlas_prefetch_status IS NOT NULL)
          AND (
            work_item_id IN (SELECT id FROM work_items WHERE status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL}))
            OR job_id IN (
              SELECT j.id
              FROM jobs j
              JOIN work_items wi ON wi.id = j.work_item_id
              WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
            )
            OR attempt_id IN (
              SELECT ja.id
              FROM job_attempts ja
              JOIN jobs j ON j.id = ja.job_id
              JOIN work_items wi ON wi.id = j.work_item_id
              WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
            )
          )
      `).get().count || 0;

      // Treat completed/canceled WIs as history. Preserve active queue rows so
      // a purge cannot accidentally erase work that may still be runnable.
      dbEvents = db.prepare(`
        DELETE FROM events
        WHERE work_item_id IN (SELECT id FROM work_items WHERE status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL}))
           OR job_id IN (
             SELECT j.id
             FROM jobs j
             JOIN work_items wi ON wi.id = j.work_item_id
             WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
           )
           OR attempt_id IN (
             SELECT ja.id
             FROM job_attempts ja
             JOIN jobs j ON j.id = ja.job_id
             JOIN work_items wi ON wi.id = j.work_item_id
             WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
           )
      `).run().changes;
      dbObservations = db.prepare(`
        DELETE FROM job_observations
        WHERE work_item_id IN (SELECT id FROM work_items WHERE status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL}))
           OR job_id IN (
             SELECT j.id
             FROM jobs j
             JOIN work_items wi ON wi.id = j.work_item_id
             WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
           )
           OR attempt_id IN (
             SELECT ja.id
             FROM job_attempts ja
             JOIN jobs j ON j.id = ja.job_id
             JOIN work_items wi ON wi.id = j.work_item_id
             WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
           )
      `).run().changes;
      dbAgentCalls = db.prepare(`
        DELETE FROM agent_calls
        WHERE work_item_id IN (SELECT id FROM work_items WHERE status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL}))
           OR job_id IN (
             SELECT j.id
             FROM jobs j
             JOIN work_items wi ON wi.id = j.work_item_id
             WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
           )
           OR attempt_id IN (
             SELECT ja.id
             FROM job_attempts ja
             JOIN jobs j ON j.id = ja.job_id
             JOIN work_items wi ON wi.id = j.work_item_id
             WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
           )
      `).run().changes;
      dbAttempts = db.prepare(`
        SELECT COUNT(*) AS count
        FROM job_attempts ja
        JOIN jobs j ON j.id = ja.job_id
        JOIN work_items wi ON wi.id = j.work_item_id
        WHERE wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
      `).get().count || 0;
      historyWorkItems = db.prepare(`
        DELETE FROM work_items
        WHERE status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
      `).run().changes;
    })();
  } catch {
    // DB telemetry cleanup is best effort; disk log purge can still proceed.
  }

  if (!fs.existsSync(resolvedLogDir)) {
    return { logDir: resolvedLogDir, skippedLiveRuns, files, dirs, bytes, atlasAgentCalls, atlasObservations, dbAgentCalls, dbObservations, dbEvents, dbAttempts, historyWorkItems };
  }

  for (const entry of fs.readdirSync(resolvedLogDir, { withFileTypes: true })) {
    const fullPath = path.join(resolvedLogDir, entry.name);
    try {
      if (entry.name === "runs" && entry.isDirectory()) {
        for (const run of fs.readdirSync(fullPath, { withFileTypes: true })) {
          const runDir = path.join(fullPath, run.name);
          if (run.isDirectory() && runDirIsLive(runDir)) {
            skippedLiveRuns.push(run.name);
            continue;
          }
          fs.rmSync(runDir, { recursive: true, force: true });
          dirs += 1;
        }
        continue;
      }
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) dirs += 1;
      else files += 1;
      bytes += stat.size || 0;
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // Best effort: keep going so one locked/stale entry does not block cleanup.
    }
  }
  return { logDir: resolvedLogDir, skippedLiveRuns, files, dirs, bytes, atlasAgentCalls, atlasObservations, dbAgentCalls, dbObservations, dbEvents, dbAttempts, historyWorkItems };
}
