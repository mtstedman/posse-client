import fs from "fs";
import path from "path";

import { getDb } from "../../../../shared/storage/functions/index.js";
import { closeLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { closeOutputLog } from "../../../../shared/telemetry/functions/logging/output-log.js";
import { closePromptLog } from "../../../../shared/telemetry/functions/logging/prompt-log.js";
import { closeObservationLog } from "../../../observability/functions/observations.js";
import { TERMINAL_WORK_ITEM_STATUSES_SQL } from "../../../queue/functions/common.js";
import { flushEventsNow } from "../../../queue/functions/events.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";
import { getRuntimeLogDir, getRuntimeRoot } from "../../../runtime/functions/paths.js";
import { closeRunTelemetry } from "../../../../shared/telemetry/functions/run-telemetry.js";

export function purgeRuntimeLogs({ projectDir = null } = {}) {
  closePromptLog();
  closeOutputLog();
  closeObservationLog();
  closeLog();
  closeRunTelemetry({ cleanExit: true });

  const resolvedLogDir = path.resolve(getRuntimeLogDir(projectDir));
  const runtimeRoot = path.resolve(getRuntimeRoot(projectDir));
  if (!resolvedLogDir || resolvedLogDir === path.parse(resolvedLogDir).root) {
    throw new Error(`Refusing to purge unsafe log directory: ${resolvedLogDir}`);
  }
  if (!isInsideRoot(resolvedLogDir, runtimeRoot, { allowEqual: false })) {
    throw new Error(`Refusing to purge log directory outside runtime root: ${resolvedLogDir}`);
  }

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
    return { logDir: resolvedLogDir, files, dirs, bytes, atlasAgentCalls, atlasObservations, dbAgentCalls, dbObservations, dbEvents, dbAttempts, historyWorkItems };
  }

  for (const entry of fs.readdirSync(resolvedLogDir, { withFileTypes: true })) {
    const fullPath = path.join(resolvedLogDir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) dirs += 1;
      else files += 1;
      bytes += stat.size || 0;
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // Best effort: keep going so one locked/stale entry does not block cleanup.
    }
  }
  return { logDir: resolvedLogDir, files, dirs, bytes, atlasAgentCalls, atlasObservations, dbAgentCalls, dbObservations, dbEvents, dbAttempts, historyWorkItems };
}
