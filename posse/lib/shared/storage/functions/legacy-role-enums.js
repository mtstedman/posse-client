import { JOB_STATUS_LIST_SQL } from "../../../catalog/job.js";
import { withForeignKeysDisabled } from "./table-definitions.js";

export function repairLegacyRoleEnums(_db) {
  // ── Migration: add 'artificer' to job_type, worker_type, actor_type CHECKs ──
  const jobsTableSqlArt = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get();
  const needsArtificerType = jobsTableSqlArt && !jobsTableSqlArt.sql.includes("'artificer'");

  if (needsArtificerType) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      // Helper: recreate a table (same pattern as staleFk migration)
      function migrateTable(name, createSql, indexSqls) {
        const tmpName = `_${name}_artmig`;
        const tmpCreate = createSql.replace(new RegExp(`\\b${name}\\b`), tmpName);
        _db.exec(tmpCreate);
        const oldCols = _db.pragma(`table_info(${name})`).map(c => c.name);
        const newCols = _db.pragma(`table_info(${tmpName})`).map(c => c.name);
        const common = oldCols.filter(c => newCols.includes(c)).join(", ");
        _db.exec(`INSERT INTO "${tmpName}" (${common}) SELECT ${common} FROM "${name}"`);
        _db.exec(`DROP TABLE "${name}"`);
        _db.exec(`ALTER TABLE "${tmpName}" RENAME TO "${name}"`);
        for (const idx of indexSqls) _db.exec(idx);
      }

      // Read current jobs schema to preserve all columns dynamically
      (_db.pragma("table_info(jobs)").map(c => c.name));

      // jobs: add 'artificer' to job_type CHECK
      migrateTable("jobs", `
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER NOT NULL,
          parent_job_id INTEGER,
          job_type TEXT NOT NULL CHECK (
            job_type IN ('research','plan','delegate','dev','assess','fix','summarize','human_input','artificer')
          ),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (${JOB_STATUS_LIST_SQL})),
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
          planner_complexity_score INTEGER,
          planner_risk_score INTEGER,
          planner_context_score INTEGER,
          planner_failure_cost_score INTEGER,
          model_tier TEXT NOT NULL DEFAULT 'standard' CHECK (model_tier IN ('cheap','standard','strong')),
          model_name TEXT,
          provider TEXT,
          reasoning_effort TEXT NOT NULL DEFAULT 'medium' CHECK (reasoning_effort IN ('low','medium','high')),
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
          payload_json TEXT,
          result_json TEXT,
          last_error TEXT,
          assessor_verdict TEXT NOT NULL DEFAULT 'not_assessed' CHECK (
            assessor_verdict IN ('pass','fail','blocked','needs_replan','needs_review','not_assessed')
          ),
          assessor_confidence TEXT CHECK (assessor_confidence IN ('low','medium','high')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL
        )
      `, [
        `CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs(status, ready_at, priority, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_work_item ON jobs(work_item_id, status, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_work_item_created ON jobs(work_item_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_job_type_status ON jobs(job_type, status, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at, status)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_lease_owner ON jobs(lease_owner, status)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_parent_job ON jobs(parent_job_id)`,
      ]);

      // job_attempts: add 'artificer' to worker_type CHECK
      migrateTable("job_attempts", `
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
      `, [
        `CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, started_at)`,
        `CREATE INDEX IF NOT EXISTS idx_job_attempts_status ON job_attempts(status, started_at)`,
      ]);

      // events: add 'artificer' to actor_type CHECK
      migrateTable("events", `
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (
            actor_type IN ('system','scheduler','planner','researcher','dev','assessor','human','worker','delegator','artificer')
          ),
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
    })());
  }

  // ── Migration: add 'promote' to job_type CHECK ──
  const jobsTableSqlProm = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get();
  const needsPromoteType = jobsTableSqlProm && !jobsTableSqlProm.sql.includes("'promote'");

  if (needsPromoteType) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      function migrateTable(name, createSql, indexSqls) {
        const tmpName = `_${name}_promomig`;
        const tmpCreate = createSql.replace(new RegExp(`\\b${name}\\b`), tmpName);
        _db.exec(tmpCreate);
        const oldCols = _db.pragma(`table_info(${name})`).map(c => c.name);
        const newCols = _db.pragma(`table_info(${tmpName})`).map(c => c.name);
        const common = oldCols.filter(c => newCols.includes(c)).join(", ");
        _db.exec(`INSERT INTO "${tmpName}" (${common}) SELECT ${common} FROM "${name}"`);
        _db.exec(`DROP TABLE "${name}"`);
        _db.exec(`ALTER TABLE "${tmpName}" RENAME TO "${name}"`);
        for (const idx of indexSqls) _db.exec(idx);
      }

      migrateTable("jobs", `
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER NOT NULL,
          parent_job_id INTEGER,
          job_type TEXT NOT NULL CHECK (
            job_type IN ('research','plan','delegate','dev','assess','fix','summarize','human_input','artificer','promote')
          ),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (${JOB_STATUS_LIST_SQL})),
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
          planner_complexity_score INTEGER,
          planner_risk_score INTEGER,
          planner_context_score INTEGER,
          planner_failure_cost_score INTEGER,
          model_tier TEXT NOT NULL DEFAULT 'standard' CHECK (model_tier IN ('cheap','standard','strong')),
          model_name TEXT,
          provider TEXT,
          reasoning_effort TEXT NOT NULL DEFAULT 'medium' CHECK (reasoning_effort IN ('low','medium','high')),
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
          payload_json TEXT,
          result_json TEXT,
          last_error TEXT,
          assessor_verdict TEXT NOT NULL DEFAULT 'not_assessed' CHECK (
            assessor_verdict IN ('pass','fail','blocked','needs_replan','needs_review','not_assessed')
          ),
          assessor_confidence TEXT CHECK (assessor_confidence IN ('low','medium','high')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL
        )
      `, [
        `CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs(status, ready_at, priority, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_work_item ON jobs(work_item_id, status, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_work_item_created ON jobs(work_item_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_job_type_status ON jobs(job_type, status, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at, status)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_lease_owner ON jobs(lease_owner, status)`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_parent_job ON jobs(parent_job_id)`,
      ]);
    })());
  }


}
