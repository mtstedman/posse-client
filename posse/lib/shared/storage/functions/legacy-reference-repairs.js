import { needsArtifactsSchemaRepair, rebuildArtifactsTable } from "./migrations.js";
import { ARTIFACT_TYPE_LIST_SQL } from "../../../catalog/artifact.js";
import { withForeignKeysDisabled, agentCallsCreateSql, agentInteractionsCreateSql, agentInteractionApplicationsCreateSql } from "./table-definitions.js";

export function repairLegacyReferences(_db) {
  // ── Migration: project_context snapshot table ─────────────────────────────
  const hasProjectContext = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='project_context'`
  ).get();
  if (!hasProjectContext) {
    _db.exec(`
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
      )
    `);
  }

  // ── Migration: deterministic job observations ─────────────────────────────
  const hasJobObservations = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='job_observations'`
  ).get();
  if (!hasJobObservations) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS job_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER,
        job_id INTEGER,
        attempt_id INTEGER,
        observation_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_observations_job ON job_observations(job_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_job_observations_work_item ON job_observations(work_item_id, created_at);
    `);
  }
  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_observations_attempt_type
      ON job_observations(attempt_id, observation_type, id);
  `);
  // Final-review authority must survive observation-tail pruning. Backfill
  // existing review events once; subsequent writes mirror transactionally.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS final_review_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER UNIQUE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      attempt_id INTEGER REFERENCES job_attempts(id) ON DELETE SET NULL,
      agent_call_id INTEGER NOT NULL,
      observation_type TEXT NOT NULL CHECK (observation_type IN ('final_review.issued', 'final_review.result')),
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_final_review_records_job ON final_review_records(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_final_review_records_attempt ON final_review_records(attempt_id, id);
    CREATE TABLE IF NOT EXISTS final_review_continuations (
      work_item_id INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL,
      attempt_id INTEGER NOT NULL,
      candidate_identity TEXT NOT NULL,
      source_review_identity TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
      reserved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (job_id, attempt_id)
    );
    CREATE INDEX IF NOT EXISTS idx_final_review_continuations_work_item
      ON final_review_continuations(work_item_id, reserved_at);
    INSERT OR IGNORE INTO final_review_records
      (observation_id, job_id, attempt_id, agent_call_id, observation_type, detail_json, created_at)
    SELECT id, job_id, attempt_id, CAST(json_extract(detail_json, '$.agent_call_id') AS INTEGER),
      observation_type, detail_json, created_at
    FROM job_observations
    WHERE job_id IS NOT NULL
      AND observation_type IN ('final_review.issued', 'final_review.result')
      AND json_valid(detail_json)
      AND CAST(json_extract(detail_json, '$.agent_call_id') AS INTEGER) > 0;
  `);

  // ── Migration: add 'delegator' to job_attempts worker_type CHECK ────────
  const artifactsTableSql = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'`
  ).get();
  const needsArtifactsRebuild = needsArtifactsSchemaRepair(_db, artifactsTableSql);

  if (needsArtifactsRebuild) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      rebuildArtifactsTable(_db, "_artifacts_new");
    })());
  }

  const attemptsTableSql = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='job_attempts'`
  ).get();
  const needsDelegatorType = attemptsTableSql && !attemptsTableSql.sql.includes("'delegator'");

  if (needsDelegatorType) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      _db.exec(`
        CREATE TABLE _job_attempts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          attempt_number INTEGER NOT NULL,
          worker_type TEXT NOT NULL CHECK (worker_type IN ('researcher','planner','delegator','dev','assessor','system','human')),
          model_name TEXT,
          reasoning_effort TEXT CHECK (reasoning_effort IN ('low','medium','high')),
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          finished_at TEXT,
          duration_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','blocked','canceled')),
          prompt_chars INTEGER,
          output_chars INTEGER,
          estimated_input_tokens INTEGER,
          estimated_output_tokens INTEGER,
          prompt_artifact_id INTEGER,
          output_artifact_id INTEGER,
          error_text TEXT,
          notes TEXT,
          metadata_json TEXT,
          commit_hash TEXT,
          commit_base_hash TEXT,
          session_id INTEGER,
          session_lease_token TEXT,
          session_hop_count INTEGER,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          UNIQUE (job_id, attempt_number)
        )
      `);
      const oldCols = _db.pragma(`table_info(job_attempts)`).map(c => c.name);
      const newCols = _db.pragma(`table_info(_job_attempts_new)`).map(c => c.name);
      const common = oldCols.filter(c => newCols.includes(c)).join(", ");
      _db.exec(`INSERT INTO _job_attempts_new (${common}) SELECT ${common} FROM job_attempts`);
      _db.exec(`DROP TABLE job_attempts`);
      _db.exec(`ALTER TABLE _job_attempts_new RENAME TO job_attempts`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, started_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_job_attempts_status ON job_attempts(status, started_at)`);
    })());
  }

  // ── Migration: add 'interrupted' to job_attempts status CHECK ──────────
  const attemptsTableSql2 = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='job_attempts'`
  ).get();
  const needsInterruptedStatus = attemptsTableSql2 && !attemptsTableSql2.sql.includes("'interrupted'");

  if (needsInterruptedStatus) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      _db.exec(`
        CREATE TABLE _job_attempts_new2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          attempt_number INTEGER NOT NULL,
          worker_type TEXT NOT NULL CHECK (worker_type IN ('researcher','planner','delegator','dev','assessor','system','human')),
          model_name TEXT,
          reasoning_effort TEXT CHECK (reasoning_effort IN ('low','medium','high')),
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          finished_at TEXT,
          duration_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','interrupted','blocked','canceled')),
          prompt_chars INTEGER,
          output_chars INTEGER,
          estimated_input_tokens INTEGER,
          estimated_output_tokens INTEGER,
          prompt_artifact_id INTEGER,
          output_artifact_id INTEGER,
          error_text TEXT,
          notes TEXT,
          metadata_json TEXT,
          commit_hash TEXT,
          commit_base_hash TEXT,
          session_id INTEGER,
          session_lease_token TEXT,
          session_hop_count INTEGER,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          UNIQUE (job_id, attempt_number)
        )
      `);
      const oldCols = _db.pragma(`table_info(job_attempts)`).map(c => c.name);
      const newCols = _db.pragma(`table_info(_job_attempts_new2)`).map(c => c.name);
      const common = oldCols.filter(c => newCols.includes(c)).join(", ");
      _db.exec(`INSERT INTO _job_attempts_new2 (${common}) SELECT ${common} FROM job_attempts`);
      _db.exec(`DROP TABLE job_attempts`);
      _db.exec(`ALTER TABLE _job_attempts_new2 RENAME TO job_attempts`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, started_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_job_attempts_status ON job_attempts(status, started_at)`);
    })());
  }

  // ── Migration: add 'worker'+'delegator' to events.actor_type CHECK ──────
  const eventsTableSql = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`
  ).get();
  const needsWorkerActorType = eventsTableSql && !eventsTableSql.sql.includes("'worker'");

  if (needsWorkerActorType) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      _db.exec(`
        CREATE TABLE _events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (
            actor_type IN ('system','scheduler','planner','researcher','dev','assessor','human','worker','delegator')
          ),
          actor_id TEXT,
          message TEXT,
          event_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
        )
      `);
      const oldCols = _db.pragma("table_info(events)").map(c => c.name);
      const newCols = _db.pragma("table_info(_events_new)").map(c => c.name);
      const common = oldCols.filter(c => newCols.includes(c)).join(", ");
      _db.exec(`INSERT INTO _events_new (${common}) SELECT ${common} FROM events`);
      _db.exec(`DROP TABLE events`);
      _db.exec(`ALTER TABLE _events_new RENAME TO events`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_events_job_created ON events(job_id, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_events_work_item_created ON events(work_item_id, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at)`);
    })());
  }

  // ── Migration: fix stale FK references from earlier RENAME migrations ──
  // SQLite ALTER TABLE RENAME rewrites FK references in ALL other tables.
  // Earlier migrations that used RENAME TO _X_old poisoned FK text in
  // dependent tables. Fix by recreating affected tables with correct FKs
  // using the safe pattern: create-new → copy → drop-old → rename-new.
  const staleFk = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND (sql LIKE '%"_jobs_old"%' OR sql LIKE '%"_work_items_old"%' OR sql LIKE '%"_jobs_old2"%' OR sql LIKE '%"_job_attempts_old"%')`
  ).all();

  if (staleFk.length > 0) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {

      // Helper: recreate a table with correct FK references
      function fixTable(name, createSql, indexSqls) {
        const tmpName = `_${name}_fkfix`;
        const tmpCreate = createSql.replace(name, tmpName);
        _db.exec(tmpCreate);
        const oldCols = _db.pragma(`table_info(${name})`).map(c => c.name);
        const newCols = _db.pragma(`table_info(${tmpName})`).map(c => c.name);
        const common = oldCols.filter(c => newCols.includes(c)).join(", ");
        _db.exec(`INSERT INTO "${tmpName}" (${common}) SELECT ${common} FROM "${name}"`);
        _db.exec(`DROP TABLE "${name}"`);
        _db.exec(`ALTER TABLE "${tmpName}" RENAME TO "${name}"`);
        for (const idx of indexSqls) _db.exec(idx);
      }

      // 1. job_attempts (FKs to jobs only)
      fixTable("job_attempts", `
        CREATE TABLE job_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          attempt_number INTEGER NOT NULL,
          worker_type TEXT NOT NULL CHECK (worker_type IN ('researcher','planner','delegator','dev','assessor','system','human','artificer')),
          model_name TEXT,
          reasoning_effort TEXT CHECK (reasoning_effort IN ('low','medium','high')),
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          finished_at TEXT,
          duration_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','blocked','canceled','interrupted')),
          prompt_chars INTEGER,
          output_chars INTEGER,
          estimated_input_tokens INTEGER,
          estimated_output_tokens INTEGER,
          prompt_artifact_id INTEGER,
          output_artifact_id INTEGER,
          error_text TEXT,
          notes TEXT,
          metadata_json TEXT,
          commit_hash TEXT,
          commit_base_hash TEXT,
          session_id INTEGER,
          session_lease_token TEXT,
          session_hop_count INTEGER,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          UNIQUE (job_id, attempt_number)
        )
      `, [
        `CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, started_at)`,
        `CREATE INDEX IF NOT EXISTS idx_job_attempts_status ON job_attempts(status, started_at)`,
      ]);

      // 2. job_dependencies (FKs to jobs only)
      fixTable("job_dependencies", `
        CREATE TABLE job_dependencies (
          job_id INTEGER NOT NULL,
          depends_on_job_id INTEGER NOT NULL,
          dependency_kind TEXT NOT NULL DEFAULT 'hard' CHECK (dependency_kind IN ('hard','soft')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (job_id, depends_on_job_id),
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (depends_on_job_id) REFERENCES jobs(id) ON DELETE CASCADE
        )
      `, [
        `CREATE INDEX IF NOT EXISTS idx_job_deps_depends_on ON job_dependencies(depends_on_job_id)`,
        `CREATE INDEX IF NOT EXISTS idx_job_deps_job_kind ON job_dependencies(job_id, dependency_kind)`,
      ]);

      // 3. artifacts (FKs to work_items, jobs, job_attempts)
      fixTable("artifacts", `
        CREATE TABLE artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN (${ARTIFACT_TYPE_LIST_SQL})),
          storage_kind TEXT NOT NULL DEFAULT 'inline' CHECK (storage_kind IN ('inline','file_path','url')),
          mime_type TEXT,
          file_path TEXT,
          url TEXT,
          content_long TEXT,
          content_json TEXT,
          sha256 TEXT,
          byte_size INTEGER,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
        )
      `, [
        `CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id, artifact_type, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON artifacts(attempt_id)`,
        `CREATE INDEX IF NOT EXISTS idx_artifacts_work_item ON artifacts(work_item_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON artifacts(sha256)`,
      ]);

      // 4. events (FKs to work_items, jobs, job_attempts)
      fixTable("events", `
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('system','scheduler','planner','researcher','dev','assessor','human','worker','delegator','artificer')),
          actor_id TEXT,
          message TEXT,
          event_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
        )
      `, [
        `CREATE INDEX IF NOT EXISTS idx_events_job_created ON events(job_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_events_work_item_created ON events(work_item_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at)`,
      ]);

      // 5. agent_calls (FKs to work_items, jobs, job_attempts)
      fixTable("agent_calls", agentCallsCreateSql("agent_calls"), [
        `CREATE INDEX IF NOT EXISTS idx_agent_calls_job ON agent_calls(job_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_calls_role ON agent_calls(role, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_calls_work_item ON agent_calls(work_item_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_calls_atlas_prefetch ON agent_calls(role, atlas_prefetch_status)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_calls_parent ON agent_calls(parent_agent_call_id, created_at)`,
      ]);

      fixTable("agent_interactions", agentInteractionsCreateSql("agent_interactions"), [
        `CREATE INDEX IF NOT EXISTS idx_agent_interactions_job_status ON agent_interactions(job_id, status, blocking_policy)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_interactions_work_item_created ON agent_interactions(work_item_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_interactions_agent_call_created ON agent_interactions(agent_call_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_interactions_parent ON agent_interactions(parent_id)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_interactions_kind_status ON agent_interactions(kind, status, created_at)`,
      ]);

      fixTable("agent_interaction_applications", agentInteractionApplicationsCreateSql("agent_interaction_applications"), [
        `CREATE INDEX IF NOT EXISTS idx_agent_interaction_applications_attempt ON agent_interaction_applications(attempt_id, applied_at)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_interaction_applications_interaction ON agent_interaction_applications(interaction_id, applied_at)`,
      ]);

    })());
  }


}
