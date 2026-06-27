PRAGMA foreign_keys = ON;

-- Schema version sentinel. Bumped when host-schema changes ship.
-- Existing installs that read a lower value should run HOST_MIGRATIONS
-- from lib/functions/atlas/v2/contracts/ddl/host-migrations/index.js to
-- upgrade in place. Fresh installs created from this file pick up the
-- end-state directly.
--   1 = pre-ATLAS-v2 schema (implicit; older DBs return 0 by default).
--   7 = + bridge change tracking for read-only stream cursors.
PRAGMA user_version = 7;

CREATE TABLE IF NOT EXISTS work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued','planning','planned','running','blocked','waiting_on_human','waiting_on_review','complete','failed','canceled')
  ),
  source TEXT,
  requested_by TEXT,
  mode TEXT NOT NULL DEFAULT 'build' CHECK (mode IN ('build','image','report')),
  governance_tier TEXT NOT NULL DEFAULT 'mvp' CHECK (governance_tier IN ('prototype','mvp','production')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  session_recycle TEXT CHECK (session_recycle IN ('on','off') OR session_recycle IS NULL),
  research_skipped INTEGER NOT NULL DEFAULT 0,
  research_skip_reason TEXT,
  branch_name TEXT,
  merge_base_hash TEXT,
  merge_state TEXT CHECK (merge_state IN ('pending_review','merged','merge_failed') OR merge_state IS NULL),
  plan_approval_state TEXT NOT NULL DEFAULT 'not_required' CHECK (
    plan_approval_state IN ('not_required','pending','approved','rejected')
  ),
  plan_rejection_feedback TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  bridge_change_seq INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_items_status_priority
  ON work_items(status, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_work_items_created_at
  ON work_items(created_at);

CREATE INDEX IF NOT EXISTS idx_work_items_status_created
  ON work_items(status, created_at);

CREATE INDEX IF NOT EXISTS idx_work_items_updated_id
  ON work_items(updated_at, id);

CREATE INDEX IF NOT EXISTS idx_work_items_bridge_change_seq
  ON work_items(bridge_change_seq);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,
  parent_job_id INTEGER,

  job_type TEXT NOT NULL CHECK (
    job_type IN ('research','plan','delegate','dev','assess','fix','summarize','human_input','artificer','promote','preflight','atlas_warm')
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
  bridge_change_seq INTEGER NOT NULL DEFAULT 0,

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL
);

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

CREATE INDEX IF NOT EXISTS idx_jobs_updated_id
  ON jobs(updated_at, id);

CREATE INDEX IF NOT EXISTS idx_jobs_bridge_change_seq
  ON jobs(bridge_change_seq);

CREATE INDEX IF NOT EXISTS idx_jobs_lease
  ON jobs(lease_expires_at, status);

CREATE INDEX IF NOT EXISTS idx_jobs_lease_owner
  ON jobs(lease_owner, status);

CREATE INDEX IF NOT EXISTS idx_jobs_parent_job
  ON jobs(parent_job_id);

CREATE TABLE IF NOT EXISTS bridge_change_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO bridge_change_sequence (id, seq) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS posse_bridge_change_work_items_insert
AFTER INSERT ON work_items
FOR EACH ROW
BEGIN
  UPDATE bridge_change_sequence SET seq = seq + 1 WHERE id = 1;
  UPDATE work_items
  SET bridge_change_seq = (SELECT seq FROM bridge_change_sequence WHERE id = 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS posse_bridge_change_work_items_update
AFTER UPDATE ON work_items
FOR EACH ROW
WHEN NEW.bridge_change_seq <= OLD.bridge_change_seq
BEGIN
  UPDATE bridge_change_sequence SET seq = seq + 1 WHERE id = 1;
  UPDATE work_items
  SET bridge_change_seq = (SELECT seq FROM bridge_change_sequence WHERE id = 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS posse_bridge_change_jobs_insert
AFTER INSERT ON jobs
FOR EACH ROW
BEGIN
  UPDATE bridge_change_sequence SET seq = seq + 1 WHERE id = 1;
  UPDATE jobs
  SET bridge_change_seq = (SELECT seq FROM bridge_change_sequence WHERE id = 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS posse_bridge_change_jobs_update
AFTER UPDATE ON jobs
FOR EACH ROW
WHEN NEW.bridge_change_seq <= OLD.bridge_change_seq
BEGIN
  UPDATE bridge_change_sequence SET seq = seq + 1 WHERE id = 1;
  UPDATE jobs
  SET bridge_change_seq = (SELECT seq FROM bridge_change_sequence WHERE id = 1)
  WHERE id = NEW.id;
END;


CREATE TABLE IF NOT EXISTS job_dependencies (
  job_id INTEGER NOT NULL,
  depends_on_job_id INTEGER NOT NULL,
  dependency_kind TEXT NOT NULL DEFAULT 'hard' CHECK (dependency_kind IN ('hard','soft')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (job_id, depends_on_job_id),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_deps_depends_on
  ON job_dependencies(depends_on_job_id);

CREATE INDEX IF NOT EXISTS idx_job_deps_job_kind
  ON job_dependencies(job_id, dependency_kind);


CREATE TABLE IF NOT EXISTS job_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  worker_type TEXT NOT NULL CHECK (worker_type IN ('researcher','planner','delegator','dev','assessor','system','human','artificer','preflight')),
  model_name TEXT,
  reasoning_effort TEXT CHECK (reasoning_effort IN ('low','medium','high')),

  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  duration_ms INTEGER,

  status TEXT NOT NULL DEFAULT 'running' CHECK (
    status IN ('running','succeeded','failed','interrupted','blocked','canceled')
  ),

  prompt_chars INTEGER,
  output_chars INTEGER,
  estimated_input_tokens INTEGER,
  estimated_output_tokens INTEGER,

  prompt_artifact_id INTEGER,
  output_artifact_id INTEGER,

  error_text TEXT,
  notes TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  commit_hash TEXT,
  session_id INTEGER,
  session_lease_token TEXT,
  session_hop_count INTEGER,

  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES job_sessions(id) ON DELETE SET NULL,
  UNIQUE (job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job
  ON job_attempts(job_id, started_at);

CREATE INDEX IF NOT EXISTS idx_job_attempts_status
  ON job_attempts(status, started_at);


CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,
  job_id INTEGER,
  attempt_id INTEGER,

  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN ('prompt','response','task_spec','review','summary','diff','log','human_answer','report','nudge','plan_primary','plan_redteam','plan_synthesis','web_fetch_cache','other')
  ),

  storage_kind TEXT NOT NULL DEFAULT 'inline' CHECK (
    storage_kind IN ('inline','file_path','url')
  ),

  mime_type TEXT,
  file_path TEXT,
  url TEXT,

  content_long TEXT,
  content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  sha256 TEXT,
  byte_size INTEGER,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_job
  ON artifacts(job_id, artifact_type, created_at);

CREATE INDEX IF NOT EXISTS idx_artifacts_attempt
  ON artifacts(attempt_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_work_item
  ON artifacts(work_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_artifacts_sha256
  ON artifacts(sha256);


CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,
  job_id INTEGER,
  attempt_id INTEGER,

  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('system','scheduler','planner','researcher','dev','assessor','human','worker','delegator','artificer','preflight','atlas')
  ),
  actor_id TEXT,

  message TEXT,
  event_json TEXT CHECK (event_json IS NULL OR json_valid(event_json)),

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
);

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

CREATE TABLE IF NOT EXISTS session_lanes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL,
  lane TEXT NOT NULL,
  provider TEXT NOT NULL,
  skill_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalidated','expired','failed')),
  reset_generation INTEGER NOT NULL DEFAULT 0,
  lock_reason TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  invalidated_at TEXT,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_lanes_lookup
  ON session_lanes(work_item_id, lane, skill_key, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_lanes_unique_active
  ON session_lanes(work_item_id, lane, skill_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS job_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_id INTEGER NOT NULL,
  work_item_id INTEGER NOT NULL,
  lane TEXT NOT NULL,
  provider TEXT NOT NULL,
  skill_key TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL,
  parent_job_id INTEGER,
  hop_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','invalidated','failed')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  leased_by INTEGER,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_agent_call_id INTEGER,
  FOREIGN KEY (lane_id) REFERENCES session_lanes(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (leased_by) REFERENCES jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (last_agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_job_sessions_lookup
  ON job_sessions(work_item_id, lane, provider, skill_key, status);

CREATE INDEX IF NOT EXISTS idx_job_sessions_lane_status
  ON job_sessions(lane_id, status, last_used_at);

CREATE INDEX IF NOT EXISTS idx_job_sessions_lease
  ON job_sessions(leased_by, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_job_sessions_status_lease
  ON job_sessions(status, lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_sessions_unique_active
  ON job_sessions(lane_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS session_recycle_savings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  work_item_id INTEGER NOT NULL,
  lane_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  skill_key TEXT NOT NULL DEFAULT '',
  hop_count INTEGER NOT NULL,
  tokens_resume INTEGER NOT NULL,
  tokens_fresh_estimate INTEGER NOT NULL,
  tokens_saved INTEGER NOT NULL,
  estimate_method TEXT NOT NULL DEFAULT 'unknown',
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (lane_id) REFERENCES session_lanes(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES job_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_recycle_savings_work_item
  ON session_recycle_savings(work_item_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_session_recycle_savings_provider
  ON session_recycle_savings(provider, role, recorded_at);

CREATE TABLE IF NOT EXISTS scheduler_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

CREATE INDEX IF NOT EXISTS idx_scheduler_locks_expires_at
  ON scheduler_locks(expires_at);

CREATE TABLE IF NOT EXISTS work_item_file_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  lock_kind TEXT NOT NULL CHECK (lock_kind IN ('file','root')),
  source_job_id INTEGER,
  acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at TEXT,
  release_reason TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_job_id) REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_wi_file_locks_active_path
  ON work_item_file_locks(path, lock_kind, released_at);

CREATE INDEX IF NOT EXISTS idx_wi_file_locks_wi_active
  ON work_item_file_locks(work_item_id, released_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_file_locks_unique_active
  ON work_item_file_locks(work_item_id, path, lock_kind)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS job_file_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  work_item_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  lock_kind TEXT NOT NULL CHECK (lock_kind IN ('file','root')),
  acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at TEXT,
  release_reason TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),

  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_file_locks_active_path
  ON job_file_locks(path, lock_kind, released_at);

CREATE INDEX IF NOT EXISTS idx_job_file_locks_job_active
  ON job_file_locks(job_id, released_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_file_locks_unique_active
  ON job_file_locks(job_id, path, lock_kind)
  WHERE released_at IS NULL;


CREATE TABLE IF NOT EXISTS agent_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,
  job_id INTEGER,
  attempt_id INTEGER,

  role TEXT NOT NULL,
  model_tier TEXT NOT NULL,
  model_name TEXT,
  activity TEXT,

  prompt_chars INTEGER,
  output_chars INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,

  max_turns_configured INTEGER,

  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  duration_ms INTEGER,

  exit_code INTEGER,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','timeout')),
  error_text TEXT,

  provider TEXT DEFAULT 'claude',
  prior_session_handle TEXT,
  session_handle TEXT,
  atlas_method TEXT,
  atlas_prefetch_status TEXT,
  skills TEXT,
  cost_estimate_usd REAL,
  reasoning_effort TEXT DEFAULT 'medium',
  extended_thinking INTEGER NOT NULL DEFAULT 0 CHECK (extended_thinking IN (0,1)),

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_calls_job
  ON agent_calls(job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_calls_role
  ON agent_calls(role, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_calls_work_item
  ON agent_calls(work_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_calls_atlas_prefetch
  ON agent_calls(role, atlas_prefetch_status);

CREATE TABLE IF NOT EXISTS agent_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,
  job_id INTEGER,
  attempt_id INTEGER,
  agent_call_id INTEGER,
  parent_id INTEGER,

  direction TEXT NOT NULL CHECK (direction IN ('user_to_agent','agent_to_user','system_to_agent')),
  kind TEXT NOT NULL CHECK (kind IN ('nudge','question','answer','activity','status_request','scope_request','approval')),
  blocking_policy TEXT NOT NULL DEFAULT 'none' CHECK (blocking_policy IN ('none','checkpoint','wait')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','applied','answered','canceled','expired','superseded')),
  source TEXT,
  author TEXT,
  body TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  ack_state TEXT NOT NULL DEFAULT 'pending' CHECK (ack_state IN ('pending','acknowledged','not_applicable')),
  ack_decision TEXT CHECK (ack_decision IS NULL OR ack_decision IN ('accepted','rejected','deferred')),
  ack_reason TEXT,
  acknowledged_at TEXT,

  first_applied_at TEXT,
  last_applied_at TEXT,
  answered_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_id) REFERENCES agent_interactions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_interactions_job_status
  ON agent_interactions(job_id, status, blocking_policy);

CREATE INDEX IF NOT EXISTS idx_agent_interactions_work_item_created
  ON agent_interactions(work_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_interactions_agent_call_created
  ON agent_interactions(agent_call_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_interactions_parent
  ON agent_interactions(parent_id);

CREATE INDEX IF NOT EXISTS idx_agent_interactions_kind_status
  ON agent_interactions(kind, status, created_at);

CREATE TABLE IF NOT EXISTS agent_interaction_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interaction_id INTEGER NOT NULL,
  work_item_id INTEGER,
  job_id INTEGER,
  attempt_id INTEGER,
  agent_call_id INTEGER,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  result TEXT NOT NULL DEFAULT 'included' CHECK (result IN ('included','skipped','expired')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),

  FOREIGN KEY (interaction_id) REFERENCES agent_interactions(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL,
  UNIQUE(interaction_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_interaction_applications_attempt
  ON agent_interaction_applications(attempt_id, applied_at);

CREATE INDEX IF NOT EXISTS idx_agent_interaction_applications_interaction
  ON agent_interaction_applications(interaction_id, applied_at);


-- ═════════════════════════════════════════════════════════════════════════════
-- RUN INSIGHTS — Kaizen feedback loop (cross-run learning)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS run_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,
  job_id INTEGER,

  insight_type TEXT NOT NULL CHECK (
    insight_type IN ('decision','pattern','failure','human_override','scope_issue','performance','information_request')
  ),

  summary TEXT NOT NULL,
  detail TEXT,
  insight_kind TEXT,         -- risk|convention|dependency|test_coupling|user_preference|architecture
  action TEXT,               -- compact reusable guidance distilled from evidence
  confidence TEXT,           -- low|medium|high
  source TEXT,               -- human|kaizen|loopback|test_failure|postmortem
  evidence TEXT CHECK (evidence IS NULL OR json_valid(evidence)),             -- JSON array of historical facts behind the insight
  expires_at TEXT,
  memory_type TEXT,          -- lesson|pattern|enforcement when promoted to durable memory
  promotion_status TEXT,     -- pending|rejected|shadow|promoted|failed|duplicate
  promotion_reason TEXT,
  promoted_memory_id TEXT,
  rejection_reason TEXT,
  file_paths TEXT CHECK (file_paths IS NULL OR json_valid(file_paths)),          -- JSON array of affected file paths (for scope-based retrieval)

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_run_insights_type
  ON run_insights(insight_type, created_at);

CREATE INDEX IF NOT EXISTS idx_run_insights_work_item
  ON run_insights(work_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_run_insights_promotion_status
  ON run_insights(promotion_status)
  WHERE promotion_status IN ('promoted', 'duplicate');

CREATE INDEX IF NOT EXISTS idx_run_insights_promoted_memory_id
  ON run_insights(promoted_memory_id)
  WHERE promoted_memory_id IS NOT NULL AND trim(promoted_memory_id) != '';


-- Project-wide denormalized context snapshot for startup/admin views
CREATE TABLE IF NOT EXISTS project_context (
  project_key TEXT PRIMARY KEY,
  current_status_summary TEXT,
  blocked_summary TEXT,
  pending_merge_summary TEXT,
  dirty_snapshot_summary TEXT,
  recent_human_summary TEXT,
  recent_failure_summary TEXT,
  startup_digest_path TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);


-- Provider pricing table for cost attribution. Keyed by (provider, model_name)
-- with per-million-token rates in USD. Seed via lib/functions/billing/pricing.js defaults on
-- first lookup; editable by operator via admin/CLI.
CREATE TABLE IF NOT EXISTS provider_pricing (
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_tier TEXT,
  input_per_million_usd REAL NOT NULL,
  output_per_million_usd REAL NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (provider, model_name)
);


-- Deterministic per-job observations for post-mortem debugging
CREATE TABLE IF NOT EXISTS job_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER,
  job_id INTEGER,
  attempt_id INTEGER,
  observation_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_job_observations_job
  ON job_observations(job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_job_observations_work_item
  ON job_observations(work_item_id, created_at);


-- DB-backed Posse test suites registered through deterministic MCP tools.
-- Test source is private runtime metadata; generated runners execute from a
-- temporary directory and are deleted after each run.
CREATE TABLE IF NOT EXISTS posse_test_suites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  explanation TEXT NOT NULL DEFAULT '',
  created_by_role TEXT,
  created_by_job_id INTEGER,
  created_by_work_item_id INTEGER,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (created_by_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS posse_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL CHECK (language IN ('javascript','python')),
  function_name TEXT,
  source TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  target_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_files_json)),
  target_symbols_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_symbols_json)),
  target_imports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_imports_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_run_json TEXT CHECK (last_run_json IS NULL OR json_valid(last_run_json)),
  created_by_role TEXT,
  created_by_job_id INTEGER,
  created_by_work_item_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (suite_id) REFERENCES posse_test_suites(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL,
  UNIQUE (suite_id, slug)
);

CREATE TABLE IF NOT EXISTS posse_test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER NOT NULL,
  test_id INTEGER,
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  created_by_role TEXT,
  created_by_job_id INTEGER,
  created_by_work_item_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (suite_id) REFERENCES posse_test_suites(id) ON DELETE CASCADE,
  FOREIGN KEY (test_id) REFERENCES posse_tests(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_posse_tests_suite_status
  ON posse_tests(suite_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_posse_test_runs_suite
  ON posse_test_runs(suite_id, created_at);

CREATE INDEX IF NOT EXISTS idx_posse_test_runs_test
  ON posse_test_runs(test_id, created_at);

-- Opt-in "project database" access tool: per-repo connection + granular grants
-- for the developer's OWN application DB (sqlite/postgres/mysql). Single row.
-- The password is stored here by deliberate operator choice; it is scrubbed
-- from observations/telemetry/logs and never rendered in the settings UI.
CREATE TABLE IF NOT EXISTS project_db_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  db_type TEXT CHECK (db_type IS NULL OR db_type IN ('sqlite', 'postgres', 'mysql')),
  host TEXT,
  port INTEGER,
  database TEXT,
  username TEXT,
  password TEXT,
  permissions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
