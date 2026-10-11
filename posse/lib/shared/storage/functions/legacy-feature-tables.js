import { needsRunInsightsPromotionSchemaRepair, needsWorkItemsGovernanceTierRepair, repairRunInsightsPromotionSchema, repairWorkItemsGovernanceTierSchema, runHostMigration } from "./migrations.js";
import { JOB_STATUS_LIST_SQL } from "../../../catalog/job.js";
import { PROJECT_DB_CONFIG_TABLE, PROJECT_DB_TYPE_LIST_SQL } from "../../../catalog/project-db.js";
import { WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL } from "../../../catalog/work-item.js";
import { withForeignKeysDisabled, quoteIdent, createRunInsightsIndexes } from "./table-definitions.js";
import { copyCompatibleColumns } from "./table-copy.js";

export function installLegacyFeatureTables(_db) {
  // ── Migration: governance_tier column on work_items ─────────────────────
  runHostMigration(_db, {
    version: 3,
    name: "work_items_governance_tier",
    needs: needsWorkItemsGovernanceTierRepair,
    migrate: repairWorkItemsGovernanceTierSchema,
  });

  // Migration: project_db_config table (opt-in project database access tool).
  // Single-row store of the per-repo project DB connection + granular grants.
  const hasProjectDbConfig = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${PROJECT_DB_CONFIG_TABLE}'`
  ).get();
  if (!hasProjectDbConfig) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS ${PROJECT_DB_CONFIG_TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        db_type TEXT CHECK (db_type IS NULL OR db_type IN (${PROJECT_DB_TYPE_LIST_SQL})),
        host TEXT,
        port INTEGER,
        database TEXT,
        username TEXT,
        password TEXT,
        permissions TEXT NOT NULL DEFAULT '',
        permissions_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }
  // Migration: grant scheme version. Existing rows stay on version 1 (the
  // per-verb scheme they were saved under) so their mutating grants are
  // suspended, not widened, until the operator re-saves permissions.
  const projectDbConfigColumns = new Set(_db.pragma(`table_info(${PROJECT_DB_CONFIG_TABLE})`).map((col) => col.name));
  if (!projectDbConfigColumns.has("permissions_version")) {
    _db.exec(`ALTER TABLE ${PROJECT_DB_CONFIG_TABLE} ADD COLUMN permissions_version INTEGER NOT NULL DEFAULT 1`);
  }

  // Migration: project_db_receipts (durable, attempt-bound record of the
  // statements a job ran against the project database).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS project_db_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER,
      job_id INTEGER NOT NULL,
      attempt_id INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('write', 'read')),
      verb TEXT NOT NULL,
      tables_json TEXT NOT NULL DEFAULT '[]',
      affected_rows INTEGER,
      statement TEXT NOT NULL,
      db_type TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_project_db_receipts_job
      ON project_db_receipts(job_id, attempt_id, id);
  `);

  // Migration: research skip fields on work_items.
  const workItemColumns = new Set(_db.pragma("table_info(work_items)").map((col) => col.name));
  if (!workItemColumns.has("research_skipped")) {
    _db.exec(`ALTER TABLE work_items ADD COLUMN research_skipped INTEGER NOT NULL DEFAULT 0`);
  }
  if (!workItemColumns.has("research_skip_reason")) {
    _db.exec(`ALTER TABLE work_items ADD COLUMN research_skip_reason TEXT`);
  }

  // Migration: run_insights table (Kaizen feedback loop).
  const hasRunInsights = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='run_insights'`
  ).get();
  if (!hasRunInsights) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS run_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER,
        job_id INTEGER,
        insight_type TEXT NOT NULL CHECK (
          insight_type IN ('decision','pattern','failure','human_override','scope_issue','performance','information_request')
        ),
        summary TEXT NOT NULL,
        detail TEXT,
        insight_kind TEXT,
        action TEXT,
        confidence TEXT,
        source TEXT,
        evidence TEXT,
        expires_at TEXT,
        memory_type TEXT,
        promotion_status TEXT,
        promotion_reason TEXT,
        promoted_memory_id TEXT,
        rejection_reason TEXT,
        file_paths TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
      );
    `);
    createRunInsightsIndexes(_db);
  }
  if (hasRunInsights) {
    const runInsightsSql = _db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='run_insights'`
    ).get()?.sql || "";
    if (!runInsightsSql.includes("'information_request'")) {
      withForeignKeysDisabled(_db, () => _db.transaction(() => {
          _db.exec(`
            CREATE TABLE run_insights_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              work_item_id INTEGER,
              job_id INTEGER,
              insight_type TEXT NOT NULL CHECK (
                insight_type IN ('decision','pattern','failure','human_override','scope_issue','performance','information_request')
              ),
              summary TEXT NOT NULL,
              detail TEXT,
              insight_kind TEXT,
              action TEXT,
              confidence TEXT,
              source TEXT,
              evidence TEXT,
              expires_at TEXT,
              memory_type TEXT,
              promotion_status TEXT,
              promotion_reason TEXT,
              promoted_memory_id TEXT,
              rejection_reason TEXT,
              file_paths TEXT,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
              FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
            );
            INSERT INTO run_insights_new (id, work_item_id, job_id, insight_type, summary, detail, file_paths, created_at)
              SELECT id, work_item_id, job_id, insight_type, summary, detail, file_paths, created_at FROM run_insights;
            DROP TABLE run_insights;
            ALTER TABLE run_insights_new RENAME TO run_insights;
          `);
          createRunInsightsIndexes(_db);
      })());
    }

    const insightColumns = new Set(_db.prepare(`PRAGMA table_info('run_insights')`).all().map((col) => col.name));
    const optionalColumns = [
      ["insight_kind", "TEXT"],
      ["action", "TEXT"],
      ["confidence", "TEXT"],
      ["source", "TEXT"],
      ["evidence", "TEXT"],
      ["expires_at", "TEXT"],
    ];
    for (const [name, type] of optionalColumns) {
      if (!insightColumns.has(name)) {
        _db.exec(`ALTER TABLE run_insights ADD COLUMN ${name} ${type}`);
      }
    }
  }
  runHostMigration(_db, {
    version: 4,
    name: "run_insights_promotion_columns",
    needs: needsRunInsightsPromotionSchemaRepair,
    migrate: repairRunInsightsPromotionSchema,
  });

  // ── Migration: unify chain_read observation_type naming ────────────────
  // Old: observation_type='chain.read' (sibling "chain.%" namespace so the
  //      counted "tool.%" bucket didn't accidentally include it).
  // New: observation_type='tool.chain_read' (same "tool.*" bucket as every
  //      other deterministic tool; getToolInvocationCountsByJob now excludes
  //      it explicitly to preserve the 1-count-per-pair invariant).
  // Idempotent: UPDATE is a no-op once all rows are already renamed.
  try {
    _db.prepare(`
      UPDATE job_observations
      SET observation_type = 'tool.chain_read'
      WHERE observation_type = 'chain.read'
    `).run();
  } catch {
    // job_observations table may not exist on very old DBs; migrations below
    // create it so subsequent boots will backfill this update as needed.
  }

  // ── Migration: plan approval gate columns on work_items ───────────────
  const hasPlanApproval = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('work_items') WHERE name='plan_approval_state'`
  ).get();
  if (hasPlanApproval.cnt === 0) {
    _db.exec(`ALTER TABLE work_items ADD COLUMN plan_approval_state TEXT NOT NULL DEFAULT 'not_required' CHECK (plan_approval_state IN (${WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL}))`);
    _db.exec(`ALTER TABLE work_items ADD COLUMN plan_rejection_feedback TEXT`);
  }

  // ── Migration: provider_pricing table for cost attribution ─────────────
  const hasProviderPricing = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='provider_pricing'`
  ).get();
  if (!hasProviderPricing) {
    _db.exec(`
      CREATE TABLE provider_pricing (
        provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_tier TEXT,
        input_per_million_usd REAL NOT NULL,
        cached_input_per_million_usd REAL,
        output_per_million_usd REAL NOT NULL,
        note TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (provider, model_name)
      );
    `);
  }

  // ── Migration: cached-input rate on provider_pricing ────────────────────
  // NULL means "no override known" — pricing falls back to the uncached input
  // rate rather than silently charging cache reads at zero.
  const hasCachedInputRate = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('provider_pricing') WHERE name='cached_input_per_million_usd'`
  ).get();
  if (hasCachedInputRate.cnt === 0) {
    _db.exec(`ALTER TABLE provider_pricing ADD COLUMN cached_input_per_million_usd REAL`);
  }

  // ── Migration: rendered per-job context snapshot ───────────────────────
  const hasJobContextText = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('jobs') WHERE name='context_text'`
  ).get();
  if (hasJobContextText.cnt === 0) {
    _db.exec(`ALTER TABLE jobs ADD COLUMN context_text TEXT`);
  }

  // ── Migration: runtime_status for bridge instance feedback ─────────────
  // Tiny key/value rows (boot, scheduler, shutdown) written by the run
  // process and polled read-only by the bridge ChangeStream so the phone
  // can see boot progress and scheduler liveness.
  const hasRuntimeStatus = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_status'`
  ).get();
  if (!hasRuntimeStatus) {
    _db.exec(`
      CREATE TABLE runtime_status (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  // ── Migration: planner-selected skills on jobs ───────────────────────────
  const hasJobSkills = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('jobs') WHERE name='skills'`
  ).get();
  if (hasJobSkills.cnt === 0) {
    _db.exec(`ALTER TABLE jobs ADD COLUMN skills TEXT`);
  }

  // ── Migration: add 'preflight' to job_type, worker_type, actor_type CHECKs ──
  const jobsTableSqlPreflight = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get();
  const attemptsTableSqlPreflight = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='job_attempts'`
  ).get();
  const eventsTableSqlPreflight = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`
  ).get();
  const needsPreflightJobType = jobsTableSqlPreflight && !jobsTableSqlPreflight.sql.includes("'preflight'");
  const needsPreflightWorkerType = attemptsTableSqlPreflight && !attemptsTableSqlPreflight.sql.includes("'preflight'");
  const needsPreflightActorType = eventsTableSqlPreflight && !eventsTableSqlPreflight.sql.includes("'preflight'");

  if (needsPreflightJobType || needsPreflightWorkerType || needsPreflightActorType) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      function migrateTable(name, createSql, indexSqls) {
        const tmpName = `_${name}_preflightmig`;
        const tmpCreate = createSql.replace(new RegExp(`\\b${name}\\b`), tmpName);
        _db.exec(tmpCreate);
        copyCompatibleColumns(_db, name, tmpName);
        _db.exec(`DROP TABLE ${quoteIdent(name)}`);
        _db.exec(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent(name)}`);
        for (const idx of indexSqls) _db.exec(idx);
      }

      if (needsPreflightJobType) {
        migrateTable("jobs", `
          CREATE TABLE jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            work_item_id INTEGER NOT NULL,
            parent_job_id INTEGER,
            job_type TEXT NOT NULL CHECK (
              job_type IN ('research','plan','delegate','dev','assess','fix','summarize','human_input','artificer','promote','preflight')
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
      }

      if (needsPreflightWorkerType) {
        migrateTable("job_attempts", `
          CREATE TABLE job_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            attempt_number INTEGER NOT NULL,
            worker_type TEXT NOT NULL CHECK (worker_type IN ('researcher','planner','delegator','dev','assessor','system','human','artificer','preflight')),
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
      }

      if (needsPreflightActorType) {
        migrateTable("events", `
          CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            work_item_id INTEGER,
            job_id INTEGER,
            attempt_id INTEGER,
            event_type TEXT NOT NULL,
            actor_type TEXT NOT NULL CHECK (
              actor_type IN ('system','scheduler','planner','researcher','dev','assessor','human','worker','delegator','artificer','preflight')
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
      }
    })());
  }

}
