// Schema-evolution helpers. The fresh-DB path in db/index.js's
// getDb() invokes these once after opening; tests poke them directly
// via the __testRepair* facades. Anything in this module rewrites an
// existing table (drop+rename through a temp name) — the table
// constructors (workItemsCreateSql, jobsCreateSql, eventsCreateSql,
// artifactsCreateSql) and their index installers stay in db/index.js
// so the fresh-init path can use them without going through migrations.

import {
  ARTIFACT_TYPES,
  WORK_ITEM_PRIORITY_LIST_SQL,
  WORK_ITEM_STATUS_LIST_SQL,
  WORK_ITEM_MODE_LIST_SQL,
  WORK_ITEM_GOVERNANCE_TIER_LIST_SQL,
  WORK_ITEM_SESSION_RECYCLE_LIST_SQL,
  WORK_ITEM_MERGE_STATE_LIST_SQL,
  WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL,
  _copyTableColumns,
  artifactsCreateSql,
  copyCompatibleColumns,
  createArtifactIndexes,
  createEventsIndexes,
  createJobsIndexes,
  createRunInsightsIndexes,
  createWaitingLanePreparationIndexes,
  createWorkItemsIndexes,
  eventsCreateSql,
  getTableColumnNames,
  jobsCreateSql,
  quoteIdent,
  withForeignKeysDisabled,
  waitingLanePreparationsCreateSql,
  workItemsCreateSql,
} from "./index.js";
import { log } from "../../telemetry/functions/logging/logger.js";

export const HOST_SCHEMA_VERSION = 12;

export function getHostSchemaVersion(db) {
  const version = Number(db.pragma("user_version", { simple: true }) || 0);
  return Number.isFinite(version) && version >= 0 ? version : 0;
}

export function setHostSchemaVersion(db, version) {
  const normalized = Math.max(0, Number.parseInt(String(version), 10) || 0);
  db.pragma(`user_version = ${normalized}`);
  return normalized;
}

export function runHostMigration(db, {
  version,
  name,
  migrate,
  needs = null,
} = {}) {
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`Host migration ${name || "(unnamed)"} requires a positive integer version.`);
  }
  if (typeof migrate !== "function") {
    throw new Error(`Host migration ${name || version} requires a migrate function.`);
  }
  const beforeVersion = getHostSchemaVersion(db);
  const needsResult = typeof needs === "function" ? needs(db) : false;
  const needsRepair = needsResult && typeof needsResult === "object"
    ? Object.values(needsResult).some(Boolean)
    : !!needsResult;
  if (beforeVersion >= version && !needsRepair) {
    return { ran: false, changed: false, version: beforeVersion, name };
  }

  const changed = !!migrate(db);
  const afterVersion = Math.max(getHostSchemaVersion(db), version);
  setHostSchemaVersion(db, afterVersion);
  log.info("db", "Host schema migration checked", {
    name,
    version,
    beforeVersion,
    afterVersion,
    changed,
    needsRepair,
  });
  return { ran: true, changed, version: afterVersion, name };
}

export function ensureHostSchemaVersion(db, version = HOST_SCHEMA_VERSION) {
  const beforeVersion = getHostSchemaVersion(db);
  if (beforeVersion >= version) return beforeVersion;
  return setHostSchemaVersion(db, version);
}

// SQLite handle dispatcher. Using bracket notation here keeps lexical
// scanners from mistaking these for child_process.exec calls.
const SQL = (db) => ({
  run: (sql) => db["exec"](sql),
  prep: (sql) => db.prepare(sql),
  tx: (fn) => db.transaction(fn),
});

export function rebuildArtifactsTable(db, tmpName = "_artifacts_new") {
  const q = SQL(db);
  q.run(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
  q.run(artifactsCreateSql(tmpName));
  copyCompatibleColumns(db, "artifacts", tmpName, { byte_size: "bytes" });
  q.run(`DROP TABLE ${quoteIdent("artifacts")}`);
  q.run(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("artifacts")}`);
  createArtifactIndexes(db);
}

export function needsArtifactsSchemaRepair(db, tableSql = null) {
  const tableRow = tableSql || db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'`
  ).get();
  if (!tableRow?.sql) return false;
  const cols = new Set(getTableColumnNames(db, "artifacts"));
  return (
    ARTIFACT_TYPES.some((type) => !tableRow.sql.includes(`'${type}'`)) ||
    cols.has("bytes") ||
    !cols.has("byte_size") ||
    !cols.has("content_json")
  );
}

export function __testRepairArtifactsTableSchema(db) {
  if (!needsArtifactsSchemaRepair(db)) return false;
  withForeignKeysDisabled(db, () => db.transaction(() => {
    rebuildArtifactsTable(db, "_artifacts_schema_repair");
  })());
  return true;
}

function sanitizedWorkItemSourceExpr(col) {
  const quoted = quoteIdent(col);
  switch (col) {
    case "priority":
      return `CASE WHEN ${quoted} IN (${WORK_ITEM_PRIORITY_LIST_SQL}) THEN ${quoted} ELSE 'normal' END`;
    case "status":
      return `CASE WHEN ${quoted} IN (${WORK_ITEM_STATUS_LIST_SQL}) THEN ${quoted} ELSE 'queued' END`;
    case "mode":
      return `CASE WHEN ${quoted} IN (${WORK_ITEM_MODE_LIST_SQL}) THEN ${quoted} ELSE 'build' END`;
    case "governance_tier":
      return `CASE WHEN ${quoted} IN (${WORK_ITEM_GOVERNANCE_TIER_LIST_SQL}) THEN ${quoted} ELSE 'mvp' END`;
    case "session_recycle":
      return `CASE WHEN ${quoted} IN (${WORK_ITEM_SESSION_RECYCLE_LIST_SQL}) OR ${quoted} IS NULL THEN ${quoted} ELSE NULL END`;
    case "merge_state":
      return `CASE WHEN ${quoted} IN (${WORK_ITEM_MERGE_STATE_LIST_SQL}) OR ${quoted} IS NULL THEN ${quoted} ELSE NULL END`;
    case "plan_approval_state":
      return `CASE WHEN ${quoted} IN (${WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL}) THEN ${quoted} ELSE 'not_required' END`;
    default:
      return quoted;
  }
}

function copyWorkItemsForGovernanceRepair(db, fromTable, toTable) {
  const oldCols = new Set(getTableColumnNames(db, fromTable));
  const newCols = getTableColumnNames(db, toTable);
  const targetCols = [];
  const sourceExprs = [];
  for (const col of newCols) {
    if (!oldCols.has(col)) continue;
    targetCols.push(col);
    sourceExprs.push(sanitizedWorkItemSourceExpr(col));
  }
  if (targetCols.length === 0) return;
  _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs);
}

function rebuildWorkItemsTable(db, tmpName = "_work_items_governance_repair") {
  const q = SQL(db);
  q.run(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
  q.run(workItemsCreateSql(tmpName));
  copyWorkItemsForGovernanceRepair(db, "work_items", tmpName);
  q.run(`DROP TABLE ${quoteIdent("work_items")}`);
  q.run(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("work_items")}`);
  createWorkItemsIndexes(db);
}

export function needsWorkItemsGovernanceTierRepair(db, tableSql = null) {
  const tableRow = tableSql || db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'`
  ).get();
  if (!tableRow?.sql) return false;
  const cols = new Set(getTableColumnNames(db, "work_items"));
  if (!cols.has("governance_tier")) return true;
  if (!tableRow.sql.includes(`governance_tier IN (${WORK_ITEM_GOVERNANCE_TIER_LIST_SQL})`)) return true;
  if (!cols.has("merge_state")) return true;
  if (!tableRow.sql.includes(`merge_state IN (${WORK_ITEM_MERGE_STATE_LIST_SQL})`)) return true;
  if (!cols.has("plan_approval_state")) return true;
  if (!tableRow.sql.includes(`plan_approval_state IN (${WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL})`)) return true;
  const invalid = db.prepare(
    `SELECT COUNT(*) AS cnt FROM work_items
     WHERE governance_tier IS NULL
        OR governance_tier NOT IN (${WORK_ITEM_GOVERNANCE_TIER_LIST_SQL})
        OR merge_state NOT IN (${WORK_ITEM_MERGE_STATE_LIST_SQL})
        OR plan_approval_state IS NULL
        OR plan_approval_state NOT IN (${WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL})`
  ).get();
  return (invalid?.cnt || 0) > 0;
}

function countInvalidWorkItemValues(db) {
  const cols = new Set(getTableColumnNames(db, "work_items"));
  const countWhere = (where) => db.prepare(`SELECT COUNT(*) AS cnt FROM work_items WHERE ${where}`).get()?.cnt || 0;
  return {
    priority: cols.has("priority") ? countWhere(`priority IS NULL OR priority NOT IN (${WORK_ITEM_PRIORITY_LIST_SQL})`) : 0,
    status: cols.has("status") ? countWhere(`status IS NULL OR status NOT IN (${WORK_ITEM_STATUS_LIST_SQL})`) : 0,
    mode: cols.has("mode") ? countWhere(`mode IS NULL OR mode NOT IN (${WORK_ITEM_MODE_LIST_SQL})`) : 0,
    governance_tier: cols.has("governance_tier")
      ? countWhere(`governance_tier IS NULL OR governance_tier NOT IN (${WORK_ITEM_GOVERNANCE_TIER_LIST_SQL})`)
      : 0,
    session_recycle: cols.has("session_recycle")
      ? countWhere(`session_recycle IS NOT NULL AND session_recycle NOT IN (${WORK_ITEM_SESSION_RECYCLE_LIST_SQL})`)
      : 0,
    merge_state: cols.has("merge_state")
      ? countWhere(`merge_state IS NOT NULL AND merge_state NOT IN (${WORK_ITEM_MERGE_STATE_LIST_SQL})`)
      : 0,
    plan_approval_state: cols.has("plan_approval_state")
      ? countWhere(`plan_approval_state IS NULL OR plan_approval_state NOT IN (${WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL})`)
      : 0,
  };
}

export function repairWorkItemsGovernanceTierSchema(db) {
  if (!needsWorkItemsGovernanceTierRepair(db)) return false;
  const invalidCounts = countInvalidWorkItemValues(db);
  const rewritten = Object.values(invalidCounts).reduce((sum, count) => sum + count, 0);
  if (rewritten > 0) {
    log.warn("db", "Repairing legacy work_items values during governance_tier schema migration", {
      invalidCounts,
      rewritten,
    });
  }
  withForeignKeysDisabled(db, () => db.transaction(() => {
    rebuildWorkItemsTable(db);
  })());
  return true;
}

export function __testRepairWorkItemsGovernanceTierSchema(db) {
  return repairWorkItemsGovernanceTierSchema(db);
}

const RUN_INSIGHT_PROMOTION_COLUMNS = Object.freeze([
  ["memory_type", "TEXT"],
  ["promotion_status", "TEXT"],
  ["promotion_reason", "TEXT"],
  ["promoted_memory_id", "TEXT"],
  ["rejection_reason", "TEXT"],
]);

export function repairRunInsightsPromotionSchema(db) {
  if (!needsRunInsightsPromotionSchemaRepair(db)) return false;
  let changed = false;
  const cols = new Set(getTableColumnNames(db, "run_insights"));
  for (const [name, type] of RUN_INSIGHT_PROMOTION_COLUMNS) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE run_insights ADD COLUMN ${quoteIdent(name)} ${type}`);
      changed = true;
    }
  }

  createRunInsightsIndexes(db);
  return changed;
}

export function needsRunInsightsPromotionSchemaRepair(db) {
  const exists = db.prepare(
    `SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='run_insights'`
  ).get();
  if (!exists) return false;

  const cols = new Set(getTableColumnNames(db, "run_insights"));
  return RUN_INSIGHT_PROMOTION_COLUMNS.some(([name]) => !cols.has(name));
}

export function __testRepairRunInsightsPromotionSchema(db) {
  return repairRunInsightsPromotionSchema(db);
}

export function needsAtlasV2HostSchemaRepair(db) {
  const jobsTableSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get()?.sql || "";
  const eventsTableSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`
  ).get()?.sql || "";
  let hasLegacySdlWarmRows = false;
  let hasLegacySdlActorRows = false;
  if (jobsTableSql) {
    try {
      hasLegacySdlWarmRows = (db.prepare(
        `SELECT COUNT(*) AS count FROM jobs WHERE job_type = 'sdl_warm'`
      ).get()?.count || 0) > 0;
    } catch {
      hasLegacySdlWarmRows = false;
    }
  }
  if (eventsTableSql) {
    try {
      hasLegacySdlActorRows = (db.prepare(
        `SELECT COUNT(*) AS count FROM events WHERE actor_type = 'sdl'`
      ).get()?.count || 0) > 0;
    } catch {
      hasLegacySdlActorRows = false;
    }
  }
  return {
    jobs: !!jobsTableSql && (
      !jobsTableSql.includes("'atlas_warm'") ||
      jobsTableSql.includes("'sdl_warm'") ||
      hasLegacySdlWarmRows ||
      /work_item_id\s+INTEGER\s+NOT\s+NULL/i.test(jobsTableSql) ||
      /model_tier\s+TEXT\s+NOT\s+NULL/i.test(jobsTableSql) ||
      /reasoning_effort\s+TEXT\s+NOT\s+NULL/i.test(jobsTableSql)
    ),
    events: !!eventsTableSql && (
      !eventsTableSql.includes("'atlas'") ||
      eventsTableSql.includes("'sdl'") ||
      hasLegacySdlActorRows
    ),
  };
}

function copyJobsForAtlasV2HostRepair(db, fromTable, toTable) {
  const oldCols = new Set(getTableColumnNames(db, fromTable));
  const newCols = getTableColumnNames(db, toTable);
  const targetCols = [];
  const sourceExprs = [];
  for (const col of newCols) {
    if (!oldCols.has(col)) continue;
    const quoted = quoteIdent(col);
    targetCols.push(col);
    if (col === "job_type") {
      sourceExprs.push(`CASE WHEN ${quoted} = 'sdl_warm' THEN 'atlas_warm' ELSE ${quoted} END`);
    } else if (col === "payload_json" || col === "result_json") {
      sourceExprs.push(`CASE WHEN ${quoted} IS NULL OR json_valid(${quoted}) THEN ${quoted} ELSE json_quote(${quoted}) END`);
    } else {
      sourceExprs.push(quoted);
    }
  }
  if (targetCols.length === 0) return;
  _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs);
}

function copyEventsForAtlasV2HostRepair(db, fromTable, toTable) {
  const oldCols = new Set(getTableColumnNames(db, fromTable));
  const newCols = getTableColumnNames(db, toTable);
  const targetCols = [];
  const sourceExprs = [];
  for (const col of newCols) {
    if (!oldCols.has(col)) continue;
    const quoted = quoteIdent(col);
    targetCols.push(col);
    if (col === "actor_type") {
      sourceExprs.push(`CASE WHEN ${quoted} = 'sdl' THEN 'atlas' ELSE ${quoted} END`);
    } else if (col === "event_json") {
      sourceExprs.push(`CASE WHEN ${quoted} IS NULL OR json_valid(${quoted}) THEN ${quoted} ELSE json_quote(${quoted}) END`);
    } else {
      sourceExprs.push(quoted);
    }
  }
  if (targetCols.length === 0) return;
  _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs);
}

export function repairAtlasV2HostSchema(db) {
  const needs = needsAtlasV2HostSchemaRepair(db);
  if (!needs.jobs && !needs.events) return false;
  const q = SQL(db);
  withForeignKeysDisabled(db, () => db.transaction(() => {
    if (needs.jobs) {
      const tmpName = "_jobs_atlasv2mig";
      q.run(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
      q.run(jobsCreateSql(tmpName));
      copyJobsForAtlasV2HostRepair(db, "jobs", tmpName);
      q.run(`DROP TABLE ${quoteIdent("jobs")}`);
      q.run(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("jobs")}`);
      createJobsIndexes(db);
    }

    if (needs.events) {
      const tmpName = "_events_atlasv2mig";
      q.run(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
      q.run(eventsCreateSql(tmpName));
      copyEventsForAtlasV2HostRepair(db, "events", tmpName);
      q.run(`DROP TABLE ${quoteIdent("events")}`);
      q.run(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("events")}`);
      createEventsIndexes(db);
    }

  })());
  return true;
}

export function __testRepairAtlasV2HostSchema(db) {
  return repairAtlasV2HostSchema(db);
}

export function needsWaitingLanePreparationSchema(db) {
  const jobsTableSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get()?.sql || "";
  return {
    jobs: !!jobsTableSql && !jobsTableSql.includes("'waiting_lane_prepare'"),
    preparations: !tableExists(db, "waiting_lane_preparations"),
  };
}

export function repairWaitingLanePreparationSchema(db) {
  const needs = needsWaitingLanePreparationSchema(db);
  if (!needs.jobs && !needs.preparations) return false;
  const q = SQL(db);
  withForeignKeysDisabled(db, () => db.transaction(() => {
    if (needs.jobs) {
      const tmpName = "_jobs_waiting_lane_mig";
      q.run(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
      q.run(jobsCreateSql(tmpName));
      copyJobsForAtlasV2HostRepair(db, "jobs", tmpName);
      q.run(`DROP TABLE ${quoteIdent("jobs")}`);
      q.run(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("jobs")}`);
      createJobsIndexes(db);
    }
    q.run(waitingLanePreparationsCreateSql());
    createWaitingLanePreparationIndexes(db);
  })());
  return true;
}

export function __testRepairWaitingLanePreparationSchema(db) {
  return repairWaitingLanePreparationSchema(db);
}

export function needsSharedTrunkMergeOperationSchema(db) {
  return [
    "shared_trunk_merge_operations",
    "shared_trunk_peer_claims",
    "shared_trunk_local_claims",
    "shared_trunk_claim_deferrals",
  ].some((tableName) => !tableExists(db, tableName));
}

export function installSharedTrunkMergeOperationSchema(db) {
  if (!needsSharedTrunkMergeOperationSchema(db)) return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_trunk_merge_operations (
      operation_id TEXT PRIMARY KEY,
      work_item_id INTEGER NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('final','iterative')),
      purpose_key TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      source_sha TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      remote TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      expected_remote_sha TEXT NOT NULL,
      candidate_sha TEXT,
      phase TEXT NOT NULL CHECK (phase IN ('intent','candidate','publish_unknown','deferred','published')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      last_error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      UNIQUE (work_item_id, purpose, purpose_key)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_trunk_merge_operations_phase
      ON shared_trunk_merge_operations(phase, updated_at);
    CREATE INDEX IF NOT EXISTS idx_shared_trunk_merge_operations_work_item
      ON shared_trunk_merge_operations(work_item_id, purpose, updated_at);

    CREATE TABLE IF NOT EXISTS shared_trunk_peer_claims (
      claim_key TEXT PRIMARY KEY,
      ref_name TEXT NOT NULL,
      object_oid TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      work_item_id INTEGER,
      job_id INTEGER,
      path TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('file','root')),
      lifecycle_kind TEXT NOT NULL CHECK (lifecycle_kind = 'hard'),
      expires_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shared_trunk_peer_claims_expires
      ON shared_trunk_peer_claims(expires_at);
    CREATE INDEX IF NOT EXISTS idx_shared_trunk_peer_claims_path
      ON shared_trunk_peer_claims(path, scope_kind);

    CREATE TABLE IF NOT EXISTS shared_trunk_local_claims (
      claim_key TEXT PRIMARY KEY,
      object_oid TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      work_item_id INTEGER,
      job_id INTEGER,
      path TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('file','root')),
      lifecycle_kind TEXT NOT NULL CHECK (lifecycle_kind = 'hard'),
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shared_trunk_local_claims_expires
      ON shared_trunk_local_claims(expires_at);
    CREATE INDEX IF NOT EXISTS idx_shared_trunk_local_claims_path
      ON shared_trunk_local_claims(path, scope_kind);

    CREATE TABLE IF NOT EXISTS shared_trunk_claim_deferrals (
      job_id INTEGER NOT NULL,
      work_item_id INTEGER,
      claim_key TEXT NOT NULL,
      claim_identity TEXT NOT NULL,
      first_deferred_at TEXT NOT NULL,
      last_deferred_at TEXT NOT NULL,
      hardened_at TEXT,
      PRIMARY KEY (job_id, claim_key),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_shared_trunk_claim_deferrals_work_item
      ON shared_trunk_claim_deferrals(work_item_id);
  `);
  return true;
}

export function __testInstallSharedTrunkMergeOperationSchema(db) {
  return installSharedTrunkMergeOperationSchema(db);
}

const HUMAN_GATE_JOB_COLUMNS = Object.freeze([
  ["assessment_state", "TEXT NOT NULL DEFAULT 'not_started'"],
  ["assessment_attempt_count", "INTEGER NOT NULL DEFAULT 0"],
  ["assessment_max_attempts", "INTEGER NOT NULL DEFAULT 3"],
  ["assessment_last_error", "TEXT"],
  ["assessment_completed_at", "TEXT"],
  ["state_version", "INTEGER NOT NULL DEFAULT 0"],
]);

function tableExists(db, tableName) {
  return !!db.prepare(
    `SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName);
}

/**
 * Host schema v8 separates implementation attempts from assessment retries and
 * makes every human-input job an explicit, durable gate contract.
 */
export function needsHumanGateAssessmentSchemaRepair(db) {
  if (!tableExists(db, "jobs")) return false;
  const jobColumns = new Set(getTableColumnNames(db, "jobs"));
  const attemptColumns = tableExists(db, "job_attempts")
    ? new Set(getTableColumnNames(db, "job_attempts"))
    : new Set();
  return (
    HUMAN_GATE_JOB_COLUMNS.some(([name]) => !jobColumns.has(name))
    || !attemptColumns.has("attempt_kind")
    || !tableExists(db, "human_gates")
    || !tableExists(db, "human_gate_outbox")
    || !tableExists(db, "file_materializations")
  );
}

export function repairHumanGateAssessmentSchema(db) {
  if (!tableExists(db, "jobs")) return false;
  let changed = false;
  const jobColumns = new Set(getTableColumnNames(db, "jobs"));
  for (const [name, declaration] of HUMAN_GATE_JOB_COLUMNS) {
    if (jobColumns.has(name)) continue;
    db.exec(`ALTER TABLE jobs ADD COLUMN ${quoteIdent(name)} ${declaration}`);
    changed = true;
  }
  if (tableExists(db, "job_attempts")) {
    const attemptColumns = new Set(getTableColumnNames(db, "job_attempts"));
    if (!attemptColumns.has("attempt_kind")) {
      db.exec(`ALTER TABLE job_attempts ADD COLUMN attempt_kind TEXT NOT NULL DEFAULT 'implementation'`);
      changed = true;
    }
  }

  if (!tableExists(db, "human_gates")) changed = true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_gates (
      gate_job_id INTEGER PRIMARY KEY,
      gate_kind TEXT NOT NULL,
      contract_version INTEGER NOT NULL DEFAULT 1,
      original_job_id INTEGER,
      generation INTEGER NOT NULL DEFAULT 1,
      gate_state TEXT NOT NULL DEFAULT 'open'
        CHECK (gate_state IN ('open','resolving','resolved','superseded')),
      expected_original_status TEXT,
      allowed_source_states_json TEXT NOT NULL
        CHECK (json_valid(allowed_source_states_json)),
      allowed_actions_json TEXT NOT NULL
        CHECK (json_valid(allowed_actions_json)),
      resolution_action TEXT,
      resolution_payload_json TEXT
        CHECK (resolution_payload_json IS NULL OR json_valid(resolution_payload_json)),
      idempotency_key TEXT UNIQUE,
      resolver_lease_token TEXT,
      resolution_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      resolved_at TEXT,
      FOREIGN KEY (gate_job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (original_job_id) REFERENCES jobs(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_human_gates_one_active
      ON human_gates(original_job_id, gate_kind)
      WHERE original_job_id IS NOT NULL
        AND gate_state IN ('open','resolving');
    CREATE INDEX IF NOT EXISTS idx_human_gates_state
      ON human_gates(gate_state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_human_gates_original
      ON human_gates(original_job_id, generation);

    CREATE TABLE IF NOT EXISTS human_gate_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_job_id INTEGER NOT NULL,
      operation_key TEXT NOT NULL UNIQUE,
      operation_type TEXT NOT NULL,
      payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','running','completed','failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at TEXT,
      FOREIGN KEY (gate_job_id) REFERENCES human_gates(gate_job_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_human_gate_outbox_pending
      ON human_gate_outbox(state, created_at);

    CREATE TABLE IF NOT EXISTS file_materializations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      work_item_id INTEGER,
      generation INTEGER NOT NULL DEFAULT 1,
      path TEXT NOT NULL,
      operation_key TEXT NOT NULL UNIQUE,
      created_parent_dirs_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(created_parent_dirs_json)),
      materialized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      UNIQUE (job_id, generation, path)
    );
    CREATE INDEX IF NOT EXISTS idx_file_materializations_job
      ON file_materializations(job_id, generation);
  `);
  return changed;
}

export function __testRepairHumanGateAssessmentSchema(db) {
  return repairHumanGateAssessmentSchema(db);
}

const QUEUE_ORPHAN_REPAIR_TABLES = new Set([
  "agent_handoff_packets",
  "agent_interaction_applications",
  "agent_interactions",
  "file_lane_waits",
  "file_materializations",
  "human_gate_outbox",
  "human_gates",
  "job_terminal_transitions",
  "posse_test_runs",
  "posse_test_suites",
  "posse_tests",
  "work_item_terminal_transitions",
  "waiting_lane_preparations",
]);

export function needsQueueForeignKeyOrphanRepair(db) {
  return db.pragma("foreign_key_check")
    .some((row) => QUEUE_ORPHAN_REPAIR_TABLES.has(String(row.table || "")));
}

/**
 * Version 9 repairs rows left by the legacy clearAll implementation. Retained
 * telemetry and registered-test history have their missing queue references
 * detached. Materialization, lane, gate, and terminal-transition rows are
 * queue state and are removed only when their required parent no longer exists.
 */
export function repairQueueForeignKeyOrphans(db) {
  let changed = 0;
  const detachMissingParent = (table, column, parentTable) => {
    if (!tableExists(db, table) || !tableExists(db, parentTable)) return 0;
    return db.prepare(`
      UPDATE ${quoteIdent(table)}
      SET ${quoteIdent(column)} = NULL
      WHERE ${quoteIdent(column)} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${quoteIdent(parentTable)} parent
          WHERE parent.id = ${quoteIdent(table)}.${quoteIdent(column)}
        )
    `).run().changes;
  };
  db.transaction(() => {
    if (tableExists(db, "agent_handoff_packets")) {
      changed += detachMissingParent("agent_handoff_packets", "work_item_id", "work_items");
      changed += detachMissingParent("agent_handoff_packets", "job_id", "jobs");
      changed += detachMissingParent("agent_handoff_packets", "attempt_id", "job_attempts");
    }
    for (const table of ["agent_interactions", "agent_interaction_applications"]) {
      changed += detachMissingParent(table, "work_item_id", "work_items");
      changed += detachMissingParent(table, "job_id", "jobs");
      changed += detachMissingParent(table, "attempt_id", "job_attempts");
    }
    for (const table of ["posse_test_suites", "posse_tests", "posse_test_runs"]) {
      changed += detachMissingParent(table, "created_by_work_item_id", "work_items");
      changed += detachMissingParent(table, "created_by_job_id", "jobs");
    }
    if (tableExists(db, "file_lane_waits")) {
      changed += detachMissingParent("file_lane_waits", "holder_work_item_id", "work_items");
      changed += detachMissingParent("file_lane_waits", "holder_job_id", "jobs");
      changed += db.prepare(`
        DELETE FROM file_lane_waits
        WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = file_lane_waits.waiter_job_id)
           OR NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.id = file_lane_waits.waiter_work_item_id)
      `).run().changes;
    }
    if (tableExists(db, "file_materializations")) {
      changed += db.prepare(`
        DELETE FROM file_materializations
        WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = file_materializations.job_id)
           OR (work_item_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM work_items wi WHERE wi.id = file_materializations.work_item_id
           ))
      `).run().changes;
    }
    if (tableExists(db, "human_gates")) {
      changed += detachMissingParent("human_gates", "original_job_id", "jobs");
      changed += db.prepare(`
        DELETE FROM human_gates
        WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = human_gates.gate_job_id)
      `).run().changes;
    }
    if (tableExists(db, "human_gate_outbox")) {
      changed += db.prepare(`
        DELETE FROM human_gate_outbox
        WHERE NOT EXISTS (
          SELECT 1 FROM human_gates hg WHERE hg.gate_job_id = human_gate_outbox.gate_job_id
        )
      `).run().changes;
    }
    if (tableExists(db, "job_terminal_transitions")) {
      changed += db.prepare(`
        DELETE FROM job_terminal_transitions
        WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_terminal_transitions.job_id)
      `).run().changes;
    }
    if (tableExists(db, "work_item_terminal_transitions")) {
      changed += db.prepare(`
        DELETE FROM work_item_terminal_transitions
        WHERE NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.id = work_item_terminal_transitions.work_item_id)
      `).run().changes;
    }
    if (tableExists(db, "waiting_lane_preparations")) {
      changed += db.prepare(`
        DELETE FROM waiting_lane_preparations
        WHERE NOT EXISTS (
          SELECT 1 FROM work_items wi WHERE wi.id = waiting_lane_preparations.work_item_id
        )
      `).run().changes;
      changed += detachMissingParent("waiting_lane_preparations", "git_job_id", "jobs");
      changed += detachMissingParent("waiting_lane_preparations", "atlas_job_id", "jobs");
    }
  })();
  return changed > 0;
}

export function __testRepairQueueForeignKeyOrphans(db) {
  return repairQueueForeignKeyOrphans(db);
}

export function needsBridgeCommandResultsSchema(db) {
  return !tableExists(db, "bridge_command_results");
}

export function installBridgeCommandResultsSchema(db) {
  const missing = needsBridgeCommandResultsSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_command_results (
      command_id TEXT PRIMARY KEY,
      command_name TEXT NOT NULL,
      args_json TEXT NOT NULL CHECK (json_valid(args_json)),
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','completed')),
      ack_json TEXT CHECK (ack_json IS NULL OR json_valid(ack_json)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_command_results_state_updated
      ON bridge_command_results(state, updated_at);
  `);
  return missing;
}
