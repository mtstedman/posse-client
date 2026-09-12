// Compact queue evidence survives telemetry pruning. One row per decision key;
// deleting its owning job/WI also deletes the evidence.
import { EVENT_TYPES, QUEUE_STATE_EVENT_TYPES } from "../../../catalog/event.js";

export function installEventState(db) {
  const types = QUEUE_STATE_EVENT_TYPES.map((type) => `'${type}'`).join(",");
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_event_state (
      id INTEGER NOT NULL,
      work_item_id INTEGER REFERENCES work_items(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      message TEXT,
      event_json TEXT,
      scope_key TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      PRIMARY KEY (event_type, scope_key, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_queue_event_state_wi ON queue_event_state(work_item_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_queue_event_state_job ON queue_event_state(job_id, event_type);
  `);
  const projection = (prefix) => `
    ${prefix}id, ${prefix}work_item_id, ${prefix}job_id, ${prefix}event_type,
    ${prefix}message, ${prefix}event_json,
    CASE WHEN ${prefix}job_id IS NOT NULL THEN 'job:' || ${prefix}job_id
      ELSE 'wi:' || ${prefix}work_item_id END,
    CASE WHEN ${prefix}event_type = '${EVENT_TYPES.WORK_ITEM_CROSS_WI_MERGE_DEPENDENCY_STALE}'
      THEN COALESCE(json_extract(${prefix}event_json, '$.dedupe_key'), '') ELSE '' END`;
  const upsert = `ON CONFLICT(event_type, scope_key, dedupe_key) DO UPDATE SET
    id = excluded.id, message = excluded.message, event_json = excluded.event_json
    WHERE excluded.id > queue_event_state.id`;
  db.exec(`
    INSERT INTO queue_event_state SELECT ${projection("")} FROM events
      WHERE event_type IN (${types}) AND (job_id IS NOT NULL OR work_item_id IS NOT NULL)
      ${upsert};
    CREATE TRIGGER IF NOT EXISTS project_queue_event_state AFTER INSERT ON events
      WHEN NEW.event_type IN (${types}) AND (NEW.job_id IS NOT NULL OR NEW.work_item_id IS NOT NULL)
    BEGIN
      INSERT INTO queue_event_state VALUES (${projection("NEW.")}) ${upsert};
    END;
  `);
}
