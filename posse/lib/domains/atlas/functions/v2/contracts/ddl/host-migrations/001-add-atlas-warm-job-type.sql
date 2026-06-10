-- ATLAS v2 host migration 001
--
-- Adds 'atlas_warm' to the jobs.job_type CHECK constraint AND makes
-- work_item_id nullable so main-purpose atlas_warm jobs (main-incremental
-- and main-full) can exist without a synthetic system WI.
--
-- SQLite does not support ALTER TABLE ... ALTER CHECK, so this migration
-- uses the rename-dance: build a new table with the updated constraint,
-- copy rows, drop the old table, rename the new one into place.
--
-- DECISIONS (locked):
--   * `work_item_id` becomes NULLABLE. The ON DELETE CASCADE FK still
--     applies for non-null rows. Existing pipeline code always supplies
--     work_item_id, so behavior is unchanged for non-atlas_warm jobs.
--   * `model_tier` and `reasoning_effort` become NULLABLE so deterministic
--     atlas_warm jobs can explicitly avoid provider/model routing.
--   * `atlas_warm` joins the job_type enum. No other enums change here.
--
-- INTEGRATION NOTE: posse currently uses CREATE TABLE IF NOT EXISTS for
-- schema bootstrap, with no formal migration runner. Workstream A
-- coordinates with the user on application mechanism — options are:
--   (a) Embed this migration's end-state schema into schema.sql directly
--       and bump a schema version sentinel in the settings table.
--   (b) Add a one-shot migration runner that detects the old CHECK by
--       inspecting sqlite_master and runs this script idempotently.
--   (c) Document a manual one-time fixup for existing posse installs.
--
-- The contract here is the END-STATE schema, not the migration mechanism.

BEGIN TRANSACTION;

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS jobs_new;

CREATE TABLE jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,                                       -- now nullable (was NOT NULL)
  parent_job_id INTEGER,

  job_type TEXT NOT NULL CHECK (
    job_type IN (
      'research',
      'plan',
      'delegate',
      'dev',
      'assess',
      'fix',
      'summarize',
      'human_input',
      'artificer',
      'promote',
      'preflight',
      'atlas_warm'                                              -- <-- added
    )
  ),

  title TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued',
      'leased',
      'running',
      'awaiting_assessment',
      'blocked',
      'waiting_on_human',
      'waiting_on_review',
      'succeeded',
      'failed',
      'dead_letter',
      'canceled'
    )
  ),

  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),

  planner_complexity_score INTEGER,
  planner_risk_score INTEGER,
  planner_context_score INTEGER,
  planner_failure_cost_score INTEGER,

  model_tier TEXT DEFAULT 'standard' CHECK (model_tier IN ('cheap','standard','strong') OR model_tier IS NULL),
  model_name TEXT,
  provider TEXT,
  reasoning_effort TEXT DEFAULT 'medium' CHECK (reasoning_effort IN ('low','medium','high') OR reasoning_effort IS NULL),
  token_budget_input INTEGER,
  token_budget_output INTEGER,
  context_budget_chars INTEGER,

  max_attempts INTEGER NOT NULL DEFAULT 3,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  human_escalation_count INTEGER NOT NULL DEFAULT 0,

  lease_owner TEXT,
  lease_token TEXT UNIQUE,
  lease_expires_at TEXT,

  ready_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT,

  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  context_text TEXT,
  skills TEXT,
  last_error TEXT,

  assessor_verdict TEXT NOT NULL DEFAULT 'not_assessed' CHECK (
    assessor_verdict IN ('pass','fail','blocked','needs_replan','needs_review','not_assessed')
  ),
  assessor_confidence TEXT CHECK (assessor_confidence IN ('low','medium','high')),

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL
);

INSERT INTO events (event_type, actor_type, message, event_json)
SELECT
  'system.schema_json_repaired',
  'system',
  'Repaired invalid JSON while applying ATLAS warm job migration',
  json_object(
    'migration', '001-add-atlas-warm-job-type',
    'table', 'jobs',
    'payload_json', SUM(CASE WHEN payload_json IS NOT NULL AND json_valid(payload_json) = 0 THEN 1 ELSE 0 END),
    'result_json', SUM(CASE WHEN result_json IS NOT NULL AND json_valid(result_json) = 0 THEN 1 ELSE 0 END)
  )
FROM jobs
HAVING
  SUM(CASE WHEN payload_json IS NOT NULL AND json_valid(payload_json) = 0 THEN 1 ELSE 0 END) > 0
  OR SUM(CASE WHEN result_json IS NOT NULL AND json_valid(result_json) = 0 THEN 1 ELSE 0 END) > 0;

INSERT INTO jobs_new
SELECT
  id,
  work_item_id,
  parent_job_id,
  CASE WHEN job_type = 'sdl_warm' THEN 'atlas_warm' ELSE job_type END,
  title,
  status,
  priority,
  planner_complexity_score,
  planner_risk_score,
  planner_context_score,
  planner_failure_cost_score,
  model_tier,
  model_name,
  provider,
  reasoning_effort,
  token_budget_input,
  token_budget_output,
  context_budget_chars,
  max_attempts,
  attempt_count,
  human_escalation_count,
  lease_owner,
  lease_token,
  lease_expires_at,
  ready_at,
  queued_at,
  started_at,
  finished_at,
  CASE WHEN payload_json IS NULL OR json_valid(payload_json) THEN payload_json ELSE json_quote(payload_json) END,
  CASE WHEN result_json IS NULL OR json_valid(result_json) THEN result_json ELSE json_quote(result_json) END,
  context_text,
  skills,
  last_error,
  assessor_verdict,
  assessor_confidence,
  created_at,
  updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

-- Recreate indexes from the live schema.sql. Keep this list in sync.
CREATE INDEX IF NOT EXISTS idx_jobs_runnable
  ON jobs(status, ready_at, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_work_item
  ON jobs(work_item_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_work_item_created
  ON jobs(work_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_job_type_status
  ON jobs(job_type, status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status_updated
  ON jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease
  ON jobs(lease_expires_at, status);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_owner
  ON jobs(lease_owner, status);
CREATE INDEX IF NOT EXISTS idx_jobs_parent_job
  ON jobs(parent_job_id);

PRAGMA foreign_keys = ON;

COMMIT;
