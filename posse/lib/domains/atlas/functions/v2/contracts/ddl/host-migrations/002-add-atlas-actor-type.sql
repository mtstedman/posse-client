-- ATLAS v2 host migration 002
--
-- Adds 'atlas' to the events.actor_type CHECK constraint so the
-- transactional outbox can record pipeline events without coercing them
-- into actor_type='system'. Same rename-dance pattern as migration 001.
--
-- See ddl/host-migrations/001-add-atlas-warm-job-type.sql for application
-- mechanism notes. The contract is the end-state schema.

BEGIN TRANSACTION;

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS events_new;

CREATE TABLE events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,
  job_id INTEGER,
  attempt_id INTEGER,

  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (
    actor_type IN (
      'system',
      'scheduler',
      'planner',
      'researcher',
      'dev',
      'assessor',
      'human',
      'worker',
      'delegator',
      'artificer',
      'preflight',
      'atlas'                                                   -- <-- added
    )
  ),
  actor_id TEXT,

  message TEXT,
  event_json TEXT CHECK (event_json IS NULL OR json_valid(event_json)),

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id)       REFERENCES jobs(id)       ON DELETE CASCADE,
  FOREIGN KEY (attempt_id)   REFERENCES job_attempts(id) ON DELETE SET NULL
);

INSERT INTO events_new
SELECT
  id,
  work_item_id,
  job_id,
  attempt_id,
  event_type,
  CASE WHEN actor_type = 'sdl' THEN 'atlas' ELSE actor_type END,
  actor_id,
  message,
  CASE WHEN event_json IS NULL OR json_valid(event_json) THEN event_json ELSE json_quote(event_json) END,
  created_at
FROM events;

INSERT INTO events_new (event_type, actor_type, message, event_json)
SELECT
  'system.schema_json_repaired',
  'system',
  'Repaired invalid JSON while applying ATLAS actor migration',
  json_object(
    'migration', '002-add-atlas-actor-type',
    'table', 'events',
    'event_json', SUM(CASE WHEN event_json IS NOT NULL AND json_valid(event_json) = 0 THEN 1 ELSE 0 END)
  )
FROM events
HAVING SUM(CASE WHEN event_json IS NOT NULL AND json_valid(event_json) = 0 THEN 1 ELSE 0 END) > 0;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX IF NOT EXISTS idx_events_job_created
  ON events(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_work_item_created
  ON events(work_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type_created
  ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created_at
  ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_work_item_type
  ON events(work_item_id, event_type);

PRAGMA foreign_keys = ON;

COMMIT;
