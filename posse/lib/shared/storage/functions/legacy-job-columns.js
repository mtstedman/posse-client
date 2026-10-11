import { JOB_STATUS_LIST_SQL } from "../../../catalog/job.js";
import { WORK_ITEM_STATUS_LIST_SQL } from "../../../catalog/work-item.js";
import { withForeignKeysDisabled } from "./table-definitions.js";

export function repairLegacyJobColumns(_db) {
  // ── Migration: branch lifecycle columns ──────────────────────────────────
  const hasBranchName = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('work_items') WHERE name='branch_name'`
  ).get();
  if (hasBranchName.cnt === 0) {
    _db.exec(`ALTER TABLE work_items ADD COLUMN branch_name TEXT`);
    _db.exec(`ALTER TABLE work_items ADD COLUMN merge_base_hash TEXT`);
  }

  const hasCommitHash = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('job_attempts') WHERE name='commit_hash'`
  ).get();
  if (hasCommitHash.cnt === 0) {
    _db.exec(`ALTER TABLE job_attempts ADD COLUMN commit_hash TEXT`);
  }

  const hasCommitBaseHash = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('job_attempts') WHERE name='commit_base_hash'`
  ).get();
  if (hasCommitBaseHash.cnt === 0) {
    _db.exec(`ALTER TABLE job_attempts ADD COLUMN commit_base_hash TEXT`);
  }

  const hasAttemptSessionId = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('job_attempts') WHERE name='session_id'`
  ).get();
  if (hasAttemptSessionId.cnt === 0) {
    _db.exec(`ALTER TABLE job_attempts ADD COLUMN session_id INTEGER`);
    _db.exec(`ALTER TABLE job_attempts ADD COLUMN session_lease_token TEXT`);
    _db.exec(`ALTER TABLE job_attempts ADD COLUMN session_hop_count INTEGER`);
  }

  // ── Migration: needs_review/waiting_on_review CHECK constraints ─────────
  // SQLite CHECK constraints are baked into CREATE TABLE. For existing DBs with
  // the old CHECK, inspect the CREATE TABLE SQL in sqlite_master to see if the
  // new enum values are present. (UPDATE ... WHERE id = -999999 is unreliable:
  // SQLite skips CHECK evaluation when zero rows match.)
  const jobsTableSql = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get();
  const needsCheckMigration = jobsTableSql && !jobsTableSql.sql.includes("'needs_review'");

  if (needsCheckMigration) {
    // Recreate tables with updated CHECK constraints.
    // Uses safe pattern: create-new → copy → drop-old → rename-new
    // (avoids SQLite rewriting FK refs in other tables during RENAME)
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      // ── jobs table ──
      _db.exec(`
        CREATE TABLE _jobs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER NOT NULL,
          parent_job_id INTEGER,
          job_type TEXT NOT NULL CHECK (
            job_type IN ('research','plan','dev','assess','fix','summarize','human_input')
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
          FOREIGN KEY (parent_job_id) REFERENCES _jobs_new(id) ON DELETE SET NULL
        )
      `);
      const oldJobCols = _db.pragma("table_info(jobs)").map(c => c.name);
      const newJobCols = _db.pragma("table_info(_jobs_new)").map(c => c.name);
      const commonCols = oldJobCols.filter(c => newJobCols.includes(c)).join(", ");
      _db.exec(`INSERT INTO _jobs_new (${commonCols}) SELECT ${commonCols} FROM jobs`);
      _db.exec(`DROP TABLE jobs`);
      _db.exec(`ALTER TABLE _jobs_new RENAME TO jobs`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs(status, ready_at, priority, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_work_item ON jobs(work_item_id, status, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_work_item_created ON jobs(work_item_id, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_job_type_status ON jobs(job_type, status, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at, status)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_lease_owner ON jobs(lease_owner, status)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_parent_job ON jobs(parent_job_id)`);

      // ── work_items table (add waiting_on_review to status CHECK) ──
      _db.exec(`
        CREATE TABLE _work_items_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          external_id TEXT UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (${WORK_ITEM_STATUS_LIST_SQL})),
          source TEXT,
          requested_by TEXT,
          mode TEXT NOT NULL DEFAULT 'build',
          metadata_json TEXT,
          branch_name TEXT,
          merge_base_hash TEXT,
          merge_state TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          started_at TEXT,
          completed_at TEXT
        )
      `);
      const oldCols = _db.pragma("table_info(work_items)").map(c => c.name);
      const newCols = _db.pragma("table_info(_work_items_new)").map(c => c.name);
      const commonWiCols = oldCols.filter(c => newCols.includes(c)).join(", ");
      _db.exec(`INSERT INTO _work_items_new (${commonWiCols}) SELECT ${commonWiCols} FROM work_items`);
      _db.exec(`DROP TABLE work_items`);
      _db.exec(`ALTER TABLE _work_items_new RENAME TO work_items`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_status_priority ON work_items(status, priority, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_created_at ON work_items(created_at)`);
    })());
  }

  // ── Migration: provider column on jobs + delegate job_type ─────────────
  const hasJobProvider = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('jobs') WHERE name='provider'`
  ).get();
  if (hasJobProvider.cnt === 0) {
    _db.exec(`ALTER TABLE jobs ADD COLUMN provider TEXT`);
  }

  // Add 'delegate' to job_type CHECK if not already present.
  // Inspect sqlite_master instead of test-inserting (zero-row UPDATEs skip CHECKs).
  const jobsTableSql2 = _db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get();
  const needsDelegateType = jobsTableSql2 && !jobsTableSql2.sql.includes("'delegate'");

  if (needsDelegateType) {
    withForeignKeysDisabled(_db, () => _db.transaction(() => {
      _db.exec(`
        CREATE TABLE _jobs_new2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER NOT NULL,
          parent_job_id INTEGER,
          job_type TEXT NOT NULL CHECK (
            job_type IN ('research','plan','delegate','dev','assess','fix','summarize','human_input')
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
          FOREIGN KEY (parent_job_id) REFERENCES _jobs_new2(id) ON DELETE SET NULL
        )
      `);
      const oldCols = _db.pragma("table_info(jobs)").map(c => c.name);
      const newCols = _db.pragma("table_info(_jobs_new2)").map(c => c.name);
      const commonCols = oldCols.filter(c => newCols.includes(c)).join(", ");
      _db.exec(`INSERT INTO _jobs_new2 (${commonCols}) SELECT ${commonCols} FROM jobs`);
      _db.exec(`DROP TABLE jobs`);
      _db.exec(`ALTER TABLE _jobs_new2 RENAME TO jobs`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs(status, ready_at, priority, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_work_item ON jobs(work_item_id, status, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_work_item_created ON jobs(work_item_id, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_job_type_status ON jobs(job_type, status, created_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at, status)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_lease_owner ON jobs(lease_owner, status)`);
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_parent_job ON jobs(parent_job_id)`);
    })());
  }

  // ── Migration: provider column on agent_calls ──────────────────────────
  const hasProvider = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='provider'`
  ).get();
  if (hasProvider.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN provider TEXT DEFAULT 'claude'`);
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN cost_estimate_usd REAL`);
  }

  // ── Migration: merge_state column on work_items ────────────────────────
  const hasMergeState = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('work_items') WHERE name='merge_state'`
  ).get();
  if (hasMergeState.cnt === 0) {
    _db.exec(`ALTER TABLE work_items ADD COLUMN merge_state TEXT DEFAULT NULL`);
  }

  // ── Migration: mode column on work_items ────────────────────────────────
  const hasMode = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('work_items') WHERE name='mode'`
  ).get();
  if (hasMode.cnt === 0) {
    _db.exec(`ALTER TABLE work_items ADD COLUMN mode TEXT NOT NULL DEFAULT 'build'`);
  }

  const hasSessionRecycle = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('work_items') WHERE name='session_recycle'`
  ).get();
  if (hasSessionRecycle.cnt === 0) {
    _db.exec(`ALTER TABLE work_items ADD COLUMN session_recycle TEXT DEFAULT NULL CHECK (session_recycle IN ('on','off') OR session_recycle IS NULL)`);
  }

  // ── Migration: reasoning_effort + extended_thinking on agent_calls ─────
  const hasReasoningEffort = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='reasoning_effort'`
  ).get();
  if (hasReasoningEffort.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN reasoning_effort TEXT DEFAULT 'medium'`);
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN extended_thinking INTEGER DEFAULT 0`);
  }

  // ── Migration: atlas_method on agent_calls ────────────────────────────────
  const hasAtlasMethod = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='atlas_method'`
  ).get();
  if (hasAtlasMethod.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN atlas_method TEXT`);
  }

  // ── Migration: atlas_prefetch_status on agent_calls (Plan 2) ──────────────
  // Captures whether handoff ATLAS prefetch (repo.status, review.delta,
  // review.analyze, slice.build) completed for this call. Values:
  //   'ok'      — all attached prefetches succeeded
  //   'partial' — some succeeded, some failed
  //   'failed'  — attached prefetches all failed
  //   'skipped' — no prefetches attempted (ATLAS inactive or non-prefetch role)
  //   NULL      — legacy rows before the column existed
  const hasAtlasPrefetchStatus = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='atlas_prefetch_status'`
  ).get();
  if (hasAtlasPrefetchStatus.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN atlas_prefetch_status TEXT`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_atlas_prefetch ON agent_calls(role, atlas_prefetch_status)`);
  }

  // ── Migration: actual skills attached on agent_calls ─────────────────────
  const hasAgentCallSkills = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='skills'`
  ).get();
  if (hasAgentCallSkills.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN skills TEXT`);
  }

  const hasAgentCallSessionHandle = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='session_handle'`
  ).get();
  if (hasAgentCallSessionHandle.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN prior_session_handle TEXT`);
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN session_handle TEXT`);
  }

  // ── Migration: provider_usage_status on agent_calls ──────────────────────
  // Distinguishes why token columns are null. Values:
  //   'measured'                        — provider reported complete usage
  //   'unavailable_after_terminal_stop' — terminal handoff stop before the
  //                                       provider confirmed final accounting
  //   'measured_partial_after_terminal_stop' — terminal stop without final
  //                                       accounting; tokens are the stream's
  //                                       per-message lower bound (precision
  //                                       incomplete, no cost estimate)
  //   'measured_lower_bound'            — every observed segment is exact, but
  //                                       terminal stop may have hidden later usage
  //   'unavailable'                     — provider reported no usage
  //   NULL                              — legacy rows / failed calls
  const hasAgentCallUsageStatus = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='provider_usage_status'`
  ).get();
  if (hasAgentCallUsageStatus.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN provider_usage_status TEXT`);
  }
  if (_db.prepare(`SELECT COUNT(*) AS cnt FROM pragma_table_info('agent_calls') WHERE name='turn_limit_mode'`).get().cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN turn_limit_mode TEXT`);
  }
  for (const [column, sqlType] of [
    ["billing_precision", "TEXT"],
    ["pricing_basis", "TEXT"],
    ["exact_billable_input_tokens", "REAL"],
    ["long_context_tier_input_tokens", "INTEGER"],
    ["provider_request_duration_ms", "INTEGER"],
    ["usage_segment_count", "INTEGER"],
  ]) {
    const present = _db.prepare(`SELECT COUNT(*) AS cnt FROM pragma_table_info('agent_calls') WHERE name = ?`).get(column);
    if (present.cnt === 0) _db.exec(`ALTER TABLE agent_calls ADD COLUMN ${column} ${sqlType}`);
  }

  // Canonical provider-request accounting and live context checkpoints. These
  // are additive so older databases gain exact segment pricing without a
  // destructive agent_calls rebuild.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS provider_usage_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_call_id INTEGER NOT NULL,
      request_ordinal INTEGER NOT NULL CHECK (request_ordinal > 0),
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_5m_input_tokens INTEGER,
      cache_creation_1h_input_tokens INTEGER,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      request_context_input_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      usage_source TEXT NOT NULL CHECK (usage_source IN ('live','rollout_recovered','aggregate_only')),
      precision TEXT NOT NULL CHECK (precision IN ('exact','recovered_exact','aggregate_only','incomplete')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE CASCADE,
      UNIQUE (agent_call_id, request_ordinal)
    );
    DROP INDEX IF EXISTS idx_provider_usage_segments_call;
    CREATE TABLE IF NOT EXISTS context_budget_checkpoints (
      agent_call_id INTEGER PRIMARY KEY,
      attempt_id INTEGER NOT NULL,
      provider_session_id TEXT NOT NULL,
      sequence_id INTEGER NOT NULL CHECK (sequence_id > 0),
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      request_context_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens_since_request INTEGER NOT NULL DEFAULT 0,
      precision TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS source_reaccess_authorizations (
      token_hash TEXT PRIMARY KEY,
      work_item_id INTEGER,
      job_id INTEGER NOT NULL,
      attempt_id INTEGER NOT NULL,
      agent_call_id INTEGER NOT NULL,
      evidence_ref TEXT NOT NULL,
      coverage_observation_id INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      consumed_at TEXT,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE CASCADE,
      FOREIGN KEY (coverage_observation_id) REFERENCES job_observations(id) ON DELETE SET NULL
    );
  `);
  for (const column of ["cache_creation_5m_input_tokens", "cache_creation_1h_input_tokens"]) {
    if (_db.prepare("SELECT COUNT(*) AS cnt FROM pragma_table_info('provider_usage_segments') WHERE name = ?").get(column).cnt === 0) {
      _db.exec(`ALTER TABLE provider_usage_segments ADD COLUMN ${column} INTEGER`);
    }
  }

  const hasAgentCallCachedInputTokens = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='cached_input_tokens'`
  ).get();
  if (hasAgentCallCachedInputTokens.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN cached_input_tokens INTEGER`);
  }

  const hasAgentCallCacheCreationInputTokens = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='cache_creation_input_tokens'`
  ).get();
  if (hasAgentCallCacheCreationInputTokens.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN cache_creation_input_tokens INTEGER`);
  }

  const hasAgentCallReasoningOutputTokens = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='reasoning_output_tokens'`
  ).get();
  if (hasAgentCallReasoningOutputTokens.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN reasoning_output_tokens INTEGER`);
  }

  const hasAgentCallTurnsUsed = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='turns_used'`
  ).get();
  if (hasAgentCallTurnsUsed.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN turns_used INTEGER`);
  }

  const hasAgentCallMaxOutputTokensConfigured = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='max_output_tokens_configured'`
  ).get();
  if (hasAgentCallMaxOutputTokensConfigured.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN max_output_tokens_configured INTEGER`);
  }

  const hasAgentCallOutputTruncated = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='output_truncated'`
  ).get();
  if (hasAgentCallOutputTruncated.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN output_truncated INTEGER DEFAULT 0`);
  }

  const hasAgentCallOutputLimitReason = _db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('agent_calls') WHERE name='output_limit_reason'`
  ).get();
  if (hasAgentCallOutputLimitReason.cnt === 0) {
    _db.exec(`ALTER TABLE agent_calls ADD COLUMN output_limit_reason TEXT`);
  }


}
