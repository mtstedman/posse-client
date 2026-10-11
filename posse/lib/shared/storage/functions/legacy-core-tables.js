import { bootstrapFreshDatabase } from "./fresh-bootstrap.js";
import { agentCallsCreateSql, createAgentCallsIndexes, agentInteractionsCreateSql, agentInteractionApplicationsCreateSql, createAgentInteractionIndexes } from "./table-definitions.js";

export function installLegacyCoreTables(_db) {
  // Bootstrap schema if tables don't exist
  const hasJobs = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get();

  if (!hasJobs) bootstrapFreshDatabase(_db);

  // ── Migrations for existing databases ──────────────────────────────────────

  const hasAgentCalls = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_calls'`
  ).get();

  if (!hasAgentCalls) {
    _db.exec(agentCallsCreateSql("agent_calls"));
    createAgentCallsIndexes(_db);
  }

  const hasAgentInteractions = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_interactions'`
  ).get();
  if (!hasAgentInteractions) {
    _db.exec(agentInteractionsCreateSql("agent_interactions"));
  }
  const agentInteractionColumns = new Set(_db.pragma("table_info(agent_interactions)").map((col) => col.name));
  if (!agentInteractionColumns.has("ack_decision")) {
    _db.exec(`ALTER TABLE agent_interactions ADD COLUMN ack_decision TEXT CHECK (ack_decision IS NULL OR ack_decision IN ('accepted','rejected','deferred'))`);
  }
  if (!agentInteractionColumns.has("ack_reason")) {
    _db.exec(`ALTER TABLE agent_interactions ADD COLUMN ack_reason TEXT`);
  }
  if (!agentInteractionColumns.has("acknowledged_at")) {
    _db.exec(`ALTER TABLE agent_interactions ADD COLUMN acknowledged_at TEXT`);
  }
  const hasAgentInteractionApplications = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_interaction_applications'`
  ).get();
  if (!hasAgentInteractionApplications) {
    _db.exec(agentInteractionApplicationsCreateSql("agent_interaction_applications"));
  }
  createAgentInteractionIndexes(_db);
  try {
    _db.exec(`
      INSERT INTO agent_interactions (
        work_item_id, job_id, direction, kind, blocking_policy, status,
        source, author, body, metadata_json, created_at, updated_at
      )
      SELECT
        a.work_item_id,
        a.job_id,
        'user_to_agent',
        'nudge',
        'checkpoint',
        'active',
        'legacy_artifact',
        'operator',
        a.content_long,
        json_object('legacy_artifact_id', a.id),
        COALESCE(a.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM artifacts a
      WHERE a.artifact_type = 'nudge'
        AND a.content_long IS NOT NULL
        AND trim(a.content_long) != ''
        AND NOT EXISTS (
          SELECT 1
          FROM agent_interactions ai
          WHERE ai.source = 'legacy_artifact'
            AND json_valid(COALESCE(ai.metadata_json, '{}')) = 1
            AND json_extract(ai.metadata_json, '$.legacy_artifact_id') = a.id
        )
    `);
  } catch {
    // Best-effort compatibility migration; the live path no longer depends on artifacts.
  }

  // Legacy per-repo settings are deprecated in favor of global account settings.
  // Drop the table entirely so provider/model routing cannot drift per project.
  try {
    _db.exec(`DROP TABLE IF EXISTS queue_settings`);
  } catch {
    // Best-effort cleanup only; malformed old DBs will fail on normal probes.
  }

  // Supplemental indexes for common query patterns.
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_status_created ON work_items(status, created_at)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_work_item_created ON jobs(work_item_id, created_at)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_lease_owner ON jobs(lease_owner, status)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_events_work_item_type ON events(work_item_id, event_type)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_job_deps_job_kind ON job_dependencies(job_id, dependency_kind)`);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_wakeups (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      generation INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      job_id INTEGER,
      work_item_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS session_lanes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      lane TEXT NOT NULL,
      provider TEXT NOT NULL,
      skill_key TEXT NOT NULL DEFAULT '',
      contract_fingerprint TEXT NOT NULL DEFAULT '',
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
  `);

  const sessionLaneColumns = new Set(_db.pragma("table_info(session_lanes)").map((col) => col.name));
  if (!sessionLaneColumns.has("contract_fingerprint")) {
    _db.exec(`ALTER TABLE session_lanes ADD COLUMN contract_fingerprint TEXT NOT NULL DEFAULT ''`);
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_file_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      lock_kind TEXT NOT NULL CHECK (lock_kind IN ('file','root')),
      source_job_id INTEGER,
      acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      released_at TEXT,
      release_reason TEXT,
      metadata_json TEXT,
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
      metadata_json TEXT,
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

    CREATE TABLE IF NOT EXISTS file_lane_waits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane_id TEXT NOT NULL,
      waiter_job_id INTEGER NOT NULL,
      waiter_work_item_id INTEGER NOT NULL,
      holder_type TEXT NOT NULL CHECK (holder_type IN ('job','work_item','active_worker')),
      holder_key TEXT NOT NULL,
      holder_job_id INTEGER,
      holder_work_item_id INTEGER,
      path TEXT NOT NULL,
      lock_kind TEXT NOT NULL CHECK (lock_kind IN ('file','root')),
      state_fingerprint TEXT NOT NULL DEFAULT '',
      detail_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (waiter_job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (waiter_work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      FOREIGN KEY (holder_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
      FOREIGN KEY (holder_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL,
      UNIQUE(waiter_job_id, lane_id, holder_key)
    );
    CREATE INDEX IF NOT EXISTS idx_file_lane_waits_waiter
      ON file_lane_waits(waiter_job_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_file_lane_waits_work_item
      ON file_lane_waits(waiter_work_item_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_file_lane_waits_holder
      ON file_lane_waits(holder_job_id, holder_work_item_id, updated_at);

    CREATE TABLE IF NOT EXISTS work_item_terminal_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('completed','failed','canceled')),
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('owner_transition','legacy_current')),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      UNIQUE(work_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_terminal_transitions_window
      ON work_item_terminal_transitions(occurred_at, outcome, work_item_id);

    CREATE TABLE IF NOT EXISTS job_terminal_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','canceled')),
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('owner_transition','legacy_current')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      UNIQUE(job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_job_terminal_transitions_window
      ON job_terminal_transitions(occurred_at, outcome, job_id);

  `);

  const fileLaneWaitColumns = new Set(_db.pragma("table_info(file_lane_waits)").map((col) => col.name));
  if (!fileLaneWaitColumns.has("state_fingerprint")) {
    _db.exec(`ALTER TABLE file_lane_waits ADD COLUMN state_fingerprint TEXT NOT NULL DEFAULT ''`);
  }
  if (!fileLaneWaitColumns.has("detail_json")) {
    _db.exec(`ALTER TABLE file_lane_waits ADD COLUMN detail_json TEXT`);
  }


}
