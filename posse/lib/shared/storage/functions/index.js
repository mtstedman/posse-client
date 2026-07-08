// lib/db.js — SQLite connection singleton
//
// Opens the orchestrator database (better-sqlite3, synchronous).
// Runs schema from sql.sql on first use if tables are missing.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../../telemetry/functions/logging/logger.js";
import { getRuntimeDbPath } from "../../../domains/runtime/functions/paths.js";
import { bumpRunTelemetryEpoch } from "../../telemetry/functions/run-telemetry.js";
import {
  HOST_SCHEMA_VERSION,
  ensureHostSchemaVersion,
  needsArtifactsSchemaRepair,
  needsRunInsightsPromotionSchemaRepair,
  needsAtlasV2HostSchemaRepair,
  needsWorkItemsGovernanceTierRepair,
  rebuildArtifactsTable,
  repairRunInsightsPromotionSchema,
  repairAtlasV2HostSchema,
  repairWorkItemsGovernanceTierSchema,
  runHostMigration,
} from "./migrations.js";

// Re-export the test-facing migration helpers so external callers
// (and the test harness) continue to import them from "./db".
export {
  HOST_SCHEMA_VERSION,
  __testRepairArtifactsTableSchema,
  __testRepairRunInsightsPromotionSchema,
  __testRepairAtlasV2HostSchema,
  __testRepairWorkItemsGovernanceTierSchema,
  getHostSchemaVersion as __testGetHostSchemaVersion,
  runHostMigration as __testRunHostMigration,
} from "./migrations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Portable defaults:
//   DB:     ./.posse/db/orchestrator.db  (relative to project root, auto-created)
//   Schema: ../../../../schema.sql (ships with the project)
// DB path is resolved by runtime-paths.js.
const SCHEMA_PATH = path.resolve(__dirname, "..", "..", "..", "..", "schema.sql");

// Domain enums and their SQL forms now live in `lib/catalog/`. They are
// re-exported here so existing `import { JOB_TYPES } from "./index.js"`
// call sites keep working, and the schema-building code below continues to
// reference them by name.
import {
  JOB_ATTEMPT_WORKER_TYPES,
  JOB_ATTEMPT_WORKER_TYPE_LIST_SQL,
  JOB_ASSESSOR_CONFIDENCE,
  JOB_ASSESSOR_CONFIDENCE_LIST_SQL,
  JOB_ASSESSOR_VERDICTS,
  JOB_ASSESSOR_VERDICT_LIST_SQL,
  JOB_MODEL_TIERS,
  JOB_MODEL_TIER_LIST_SQL,
  JOB_REASONING_EFFORTS,
  JOB_REASONING_EFFORT_LIST_SQL,
  JOB_STATUSES,
  JOB_STATUS_LIST_SQL,
  JOB_TYPES,
  JOB_TYPE_LIST_SQL,
} from "../../../catalog/job.js";
import {
  WORK_ITEM_GOVERNANCE_TIERS,
  WORK_ITEM_GOVERNANCE_TIER_LIST_SQL,
  WORK_ITEM_MERGE_STATES,
  WORK_ITEM_MERGE_STATE_LIST_SQL,
  WORK_ITEM_MODES,
  WORK_ITEM_MODE_LIST_SQL,
  WORK_ITEM_PLAN_APPROVAL_STATES,
  WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_PRIORITY_LIST_SQL,
  WORK_ITEM_SESSION_RECYCLE_VALUES,
  WORK_ITEM_SESSION_RECYCLE_LIST_SQL,
  WORK_ITEM_STATUSES,
  WORK_ITEM_STATUS_LIST_SQL,
} from "../../../catalog/work-item.js";
import {
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_LIST_SQL,
} from "../../../catalog/artifact.js";
import {
  EVENT_ACTOR_TYPES,
  EVENT_ACTOR_TYPE_LIST_SQL,
} from "../../../catalog/event.js";
import {
  HASH_REF_ENTRY_KIND_LIST_SQL,
} from "../../../catalog/hash-store.js";

export {
  JOB_ATTEMPT_WORKER_TYPES,
  JOB_ATTEMPT_WORKER_TYPE_LIST_SQL,
  JOB_TYPES,
  JOB_TYPE_LIST_SQL,
  WORK_ITEM_GOVERNANCE_TIER_LIST_SQL,
  WORK_ITEM_MERGE_STATES,
  WORK_ITEM_MERGE_STATE_LIST_SQL,
  WORK_ITEM_MODE_LIST_SQL,
  WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL,
  WORK_ITEM_PRIORITY_LIST_SQL,
  WORK_ITEM_SESSION_RECYCLE_LIST_SQL,
  WORK_ITEM_STATUS_LIST_SQL,
  ARTIFACT_TYPES,
};
const JSON_VALIDITY_COLUMNS = [
  ["work_items", "metadata_json"],
  ["jobs", "payload_json"],
  ["jobs", "result_json"],
  ["job_attempts", "metadata_json"],
  ["artifacts", "content_json"],
  ["events", "event_json"],
  ["scheduler_locks", "metadata_json"],
  ["work_item_file_locks", "metadata_json"],
  ["job_file_locks", "metadata_json"],
  ["run_insights", "evidence"],
  ["run_insights", "file_paths"],
  ["job_observations", "detail_json"],
  ["work_item_hash_refs", "descriptor_json"],
  ["work_item_hash_refs", "fingerprint_json"],
  ["work_item_hash_refs", "metadata_json"],
  ["job_hash_refs", "descriptor_json"],
  ["job_hash_refs", "fingerprint_json"],
  ["job_hash_refs", "metadata_json"],
  ["agent_run_hash_refs", "descriptor_json"],
  ["agent_run_hash_refs", "fingerprint_json"],
  ["agent_run_hash_refs", "metadata_json"],
  ["posse_test_suites", "metadata_json"],
  ["posse_tests", "last_run_json"],
  ["posse_test_runs", "failure_json"],
];
const JSON_VALIDITY_COLUMN_KEYS = new Set(
  JSON_VALIDITY_COLUMNS.map(([tableName, columnName]) => `${tableName}.${columnName}`),
);

let _db = null;
let _dbPath = null;

function isRecoverableDbError(err) {
  const msg = err?.message || String(err || "");
  return /disk I\/O error|database disk image is malformed|file is not a database|SQLITE_IOERR|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(msg);
}

function applyDbPragmas(db, dbPath) {
  let walEnabled = false;
  try {
    db.pragma("journal_mode = WAL");
    walEnabled = true;
  } catch (err) {
    // Some Windows/sandboxed environments reject WAL on fresh DBs with a
    // generic disk I/O error. Fall back to the default journal mode so startup
    // still succeeds instead of crashing on first run.
    try {
      db.pragma("journal_mode = DELETE");
    } catch {
      throw err;
    }
    try {
      const stamp = new Date().toISOString();
      console.warn(`[posse][db] WAL unavailable for ${dbPath}; using DELETE journal mode (${stamp})`);
    } catch {
      // Best effort logging only.
    }
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  // Throughput-focused defaults for concurrent writer workloads.
  // Best-effort: unsupported pragmas should not block startup.
  try { db.pragma("synchronous = NORMAL"); } catch { /* best effort */ }
  try { db.pragma("temp_store = MEMORY"); } catch { /* best effort */ }
  try { db.pragma("mmap_size = 268435456"); } catch { /* best effort */ } // 256 MiB
  return { walEnabled };
}

export function withForeignKeysDisabled(db, fn) {
  db.pragma("foreign_keys = OFF");
  try {
    return fn();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function getTableColumnNames(db, tableName) {
  return db.pragma(`table_info(${quoteIdent(tableName)})`).map((c) => c.name);
}

function jsonValidityTriggerName(tableName, columnName, op) {
  return `posse_json_valid_${tableName}_${columnName}_${op}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function installJsonValidityTriggers(db) {
  const tables = new Set(db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'`
  ).all().map((row) => row.name));
  for (const [tableName, columnName] of JSON_VALIDITY_COLUMNS) {
    if (!tables.has(tableName)) continue;
    const cols = new Set(getTableColumnNames(db, tableName));
    if (!cols.has(columnName)) continue;
    const table = quoteIdent(tableName);
    const column = quoteIdent(columnName);
    const label = `${tableName}.${columnName}`;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(jsonValidityTriggerName(tableName, columnName, "insert"))}
      BEFORE INSERT ON ${table}
      FOR EACH ROW
      WHEN NEW.${column} IS NOT NULL AND json_valid(NEW.${column}) = 0
      BEGIN
        SELECT RAISE(ABORT, 'invalid JSON in ${label}');
      END;

      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(jsonValidityTriggerName(tableName, columnName, "update"))}
      BEFORE UPDATE OF ${column} ON ${table}
      FOR EACH ROW
      WHEN NEW.${column} IS NOT NULL AND json_valid(NEW.${column}) = 0
      BEGIN
        SELECT RAISE(ABORT, 'invalid JSON in ${label}');
      END;
    `);
  }
}

const BRIDGE_CHANGE_TRACKED_TABLES = ["work_items", "jobs"];

function bridgeChangeTriggerName(tableName, op) {
  return `posse_bridge_change_${tableName}_${op}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function installBridgeChangeTracking(db) {
  const tables = new Set(db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'`
  ).all().map((row) => row.name));
  if (!BRIDGE_CHANGE_TRACKED_TABLES.some((tableName) => tables.has(tableName))) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_change_sequence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seq INTEGER NOT NULL DEFAULT 0
    )
  `);

  let changed = false;
  let maxSeq = 0;
  for (const tableName of BRIDGE_CHANGE_TRACKED_TABLES) {
    if (!tables.has(tableName)) continue;
    let cols = new Set(getTableColumnNames(db, tableName));
    if (!cols.has("bridge_change_seq")) {
      db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN bridge_change_seq INTEGER NOT NULL DEFAULT 0`);
      cols = new Set(getTableColumnNames(db, tableName));
      changed = true;
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${tableName}_bridge_change_seq`)} ON ${quoteIdent(tableName)}(bridge_change_seq)`);
    const row = db.prepare(`SELECT COALESCE(MAX(bridge_change_seq), 0) AS seq FROM ${quoteIdent(tableName)}`).get();
    maxSeq = Math.max(maxSeq, Number(row?.seq || 0));
  }

  db.prepare(`
    INSERT INTO bridge_change_sequence (id, seq)
    VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET seq = max(bridge_change_sequence.seq, excluded.seq)
  `).run(maxSeq);

  for (const tableName of BRIDGE_CHANGE_TRACKED_TABLES) {
    if (!tables.has(tableName)) continue;
    const cols = new Set(getTableColumnNames(db, tableName));
    if (!cols.has("bridge_change_seq")) continue;
    const table = quoteIdent(tableName);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(bridgeChangeTriggerName(tableName, "insert"))}
      AFTER INSERT ON ${table}
      FOR EACH ROW
      BEGIN
        UPDATE bridge_change_sequence SET seq = seq + 1 WHERE id = 1;
        UPDATE ${table}
        SET bridge_change_seq = (SELECT seq FROM bridge_change_sequence WHERE id = 1)
        WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(bridgeChangeTriggerName(tableName, "update"))}
      AFTER UPDATE ON ${table}
      FOR EACH ROW
      WHEN NEW.bridge_change_seq <= OLD.bridge_change_seq
      BEGIN
        UPDATE bridge_change_sequence SET seq = seq + 1 WHERE id = 1;
        UPDATE ${table}
        SET bridge_change_seq = (SELECT seq FROM bridge_change_sequence WHERE id = 1)
        WHERE id = NEW.id;
      END;
    `);
  }

  return changed;
}

export function artifactsCreateSql(tableName = "artifacts") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
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
      `;
}

export function createArtifactIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id, artifact_type, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON artifacts(attempt_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_work_item ON artifacts(work_item_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON artifacts(sha256)`);
}

export function workItemsCreateSql(tableName = "work_items") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          external_id TEXT UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN (${WORK_ITEM_PRIORITY_LIST_SQL})),
          status TEXT NOT NULL DEFAULT 'queued' CHECK (
            status IN (${WORK_ITEM_STATUS_LIST_SQL})
          ),
          source TEXT,
          requested_by TEXT,
          mode TEXT NOT NULL DEFAULT 'build' CHECK (mode IN (${WORK_ITEM_MODE_LIST_SQL})),
          governance_tier TEXT NOT NULL DEFAULT 'mvp' CHECK (governance_tier IN (${WORK_ITEM_GOVERNANCE_TIER_LIST_SQL})),
          metadata_json TEXT,
          session_recycle TEXT CHECK (session_recycle IN (${WORK_ITEM_SESSION_RECYCLE_LIST_SQL}) OR session_recycle IS NULL),
          research_skipped INTEGER NOT NULL DEFAULT 0,
          research_skip_reason TEXT,
          branch_name TEXT,
          merge_base_hash TEXT,
          merge_state TEXT CHECK (merge_state IN (${WORK_ITEM_MERGE_STATE_LIST_SQL}) OR merge_state IS NULL),
          plan_approval_state TEXT NOT NULL DEFAULT 'not_required' CHECK (
            plan_approval_state IN (${WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL})
          ),
          plan_rejection_feedback TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          bridge_change_seq INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          completed_at TEXT
        )
      `;
}

export function createWorkItemsIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_status_priority ON work_items(status, priority, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_created_at ON work_items(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_status_created ON work_items(status, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_updated_id ON work_items(updated_at, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_bridge_change_seq ON work_items(bridge_change_seq)`);
}

export function jobsCreateSql(tableName = "jobs") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          parent_job_id INTEGER,
          job_type TEXT NOT NULL CHECK (job_type IN (${JOB_TYPE_LIST_SQL})),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (
            status IN (${JOB_STATUS_LIST_SQL})
          ),
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN (${WORK_ITEM_PRIORITY_LIST_SQL})),
          planner_complexity_score INTEGER,
          planner_risk_score INTEGER,
          planner_context_score INTEGER,
          planner_failure_cost_score INTEGER,
          model_tier TEXT DEFAULT 'standard' CHECK (model_tier IN (${JOB_MODEL_TIER_LIST_SQL}) OR model_tier IS NULL),
          model_name TEXT,
          provider TEXT,
          reasoning_effort TEXT DEFAULT 'medium' CHECK (reasoning_effort IN (${JOB_REASONING_EFFORT_LIST_SQL}) OR reasoning_effort IS NULL),
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
            assessor_verdict IN (${JOB_ASSESSOR_VERDICT_LIST_SQL})
          ),
          assessor_confidence TEXT CHECK (assessor_confidence IN (${JOB_ASSESSOR_CONFIDENCE_LIST_SQL})),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          bridge_change_seq INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL
        )
      `;
}

export function createJobsIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs(status, ready_at, priority, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_work_item ON jobs(work_item_id, status, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_work_item_created ON jobs(work_item_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_job_type_status ON jobs(job_type, status, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_updated_id ON jobs(updated_at, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_bridge_change_seq ON jobs(bridge_change_seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_lease_owner ON jobs(lease_owner, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_parent_job ON jobs(parent_job_id)`);
}

export function jobAttemptsCreateSql(tableName = "job_attempts") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          attempt_number INTEGER NOT NULL,
          worker_type TEXT NOT NULL CHECK (worker_type IN (${JOB_ATTEMPT_WORKER_TYPE_LIST_SQL})),
          model_name TEXT,
          reasoning_effort TEXT CHECK (reasoning_effort IN (${JOB_REASONING_EFFORT_LIST_SQL})),
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
        )
      `;
}

export function createJobAttemptsIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_attempts_status ON job_attempts(status, started_at)`);
}

export function eventsCreateSql(tableName = "events") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN (${EVENT_ACTOR_TYPE_LIST_SQL})),
          actor_id TEXT,
          message TEXT,
          event_json TEXT CHECK (event_json IS NULL OR json_valid(event_json)),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
        )
      `;
}

export function createEventsIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_job_created ON events(job_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_work_item_created ON events(work_item_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_work_item_type ON events(work_item_id, event_type)`);
}

export function agentCallsCreateSql(tableName = "agent_calls") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
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
          turns_used INTEGER,
          max_output_tokens_configured INTEGER,
          output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0,1)),
          output_limit_reason TEXT,
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
        )
      `;
}

export function createAgentCallsIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_job ON agent_calls(job_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_role ON agent_calls(role, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_work_item ON agent_calls(work_item_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_atlas_prefetch ON agent_calls(role, atlas_prefetch_status)`);
}

export function agentInteractionsCreateSql(tableName = "agent_interactions") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
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
        )
      `;
}

export function agentInteractionApplicationsCreateSql(tableName = "agent_interaction_applications") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
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
        )
      `;
}

export function createAgentInteractionIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_interactions_job_status ON agent_interactions(job_id, status, blocking_policy)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_interactions_work_item_created ON agent_interactions(work_item_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_interactions_agent_call_created ON agent_interactions(agent_call_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_interactions_parent ON agent_interactions(parent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_interactions_kind_status ON agent_interactions(kind, status, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_interaction_applications_attempt ON agent_interaction_applications(attempt_id, applied_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_interaction_applications_interaction ON agent_interaction_applications(interaction_id, applied_at)`);
}

export function createRunInsightsIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_insights_type ON run_insights(insight_type, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_insights_work_item ON run_insights(work_item_id, created_at)`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_run_insights_promotion_status
      ON run_insights(promotion_status)
      WHERE promotion_status IN ('promoted', 'duplicate')
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_run_insights_promoted_memory_id
      ON run_insights(promoted_memory_id)
      WHERE promoted_memory_id IS NOT NULL AND trim(promoted_memory_id) != ''
  `);
}

function hashRefObjectTableSql({
  tableName,
  workItemRequired = false,
  jobRequired = false,
  attemptRequired = false,
} = {}) {
  return `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER ${workItemRequired ? "NOT NULL" : ""},
      job_id INTEGER ${jobRequired ? "NOT NULL" : ""},
      attempt_id INTEGER ${attemptRequired ? "NOT NULL" : ""},
      agent_call_id INTEGER,
      ref TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      object_type TEXT NOT NULL DEFAULT 'text',
      source TEXT,
      entry_kind TEXT NOT NULL DEFAULT 'materialized' CHECK (entry_kind IN (${HASH_REF_ENTRY_KIND_LIST_SQL})),
      payload_text TEXT,
      descriptor_json TEXT CHECK (descriptor_json IS NULL OR json_valid(descriptor_json)),
      fingerprint_json TEXT CHECK (fingerprint_json IS NULL OR json_valid(fingerprint_json)),
      note TEXT,
      size_chars INTEGER NOT NULL DEFAULT 0,
      version_id TEXT,
      recomputable INTEGER NOT NULL DEFAULT 0 CHECK (recomputable IN (0, 1)),
      degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
      metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL,
      FOREIGN KEY (ref) REFERENCES hash_ref_aliases(ref) ON DELETE CASCADE
    )
  `;
}

function hashRefAliasTableSql({
  tableName,
  workItemRequired = false,
  jobRequired = false,
  attemptRequired = false,
} = {}) {
  return `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER ${workItemRequired ? "NOT NULL" : ""},
      job_id INTEGER ${jobRequired ? "NOT NULL" : ""},
      attempt_id INTEGER ${attemptRequired ? "NOT NULL" : ""},
      agent_call_id INTEGER,
      ref TEXT NOT NULL UNIQUE,
      target_ref TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL,
      FOREIGN KEY (ref) REFERENCES hash_ref_aliases(ref) ON DELETE CASCADE,
      FOREIGN KEY (target_ref) REFERENCES hash_ref_aliases(ref) ON DELETE CASCADE
    )
  `;
}

export function createHashRefStoreTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hash_ref_aliases (
      ref TEXT PRIMARY KEY,
      width INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hash_ref_aliases_width
      ON hash_ref_aliases(width, created_at);
  `);

  db.exec(hashRefObjectTableSql({
    tableName: "work_item_hash_refs",
    workItemRequired: true,
  }));
  db.exec(hashRefAliasTableSql({
    tableName: "work_item_hash_ref_aliases",
    workItemRequired: true,
  }));
  db.exec(hashRefObjectTableSql({
    tableName: "job_hash_refs",
    workItemRequired: true,
    jobRequired: true,
  }));
  db.exec(hashRefAliasTableSql({
    tableName: "job_hash_ref_aliases",
    workItemRequired: true,
    jobRequired: true,
  }));
  db.exec(hashRefObjectTableSql({
    tableName: "agent_run_hash_refs",
    attemptRequired: true,
  }));
  db.exec(hashRefAliasTableSql({
    tableName: "agent_run_hash_ref_aliases",
    attemptRequired: true,
  }));

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_item_hash_refs_ref ON work_item_hash_refs(ref);
    CREATE INDEX IF NOT EXISTS idx_work_item_hash_refs_content ON work_item_hash_refs(work_item_id, content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_hash_refs_owner_content_unique
      ON work_item_hash_refs(work_item_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_work_item_hash_ref_aliases_ref ON work_item_hash_ref_aliases(ref);
    CREATE INDEX IF NOT EXISTS idx_work_item_hash_ref_aliases_target
      ON work_item_hash_ref_aliases(work_item_id, target_ref);

    CREATE INDEX IF NOT EXISTS idx_job_hash_refs_ref ON job_hash_refs(ref);
    CREATE INDEX IF NOT EXISTS idx_job_hash_refs_content ON job_hash_refs(job_id, content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_hash_refs_owner_content_unique
      ON job_hash_refs(job_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_job_hash_ref_aliases_ref ON job_hash_ref_aliases(ref);
    CREATE INDEX IF NOT EXISTS idx_job_hash_ref_aliases_target
      ON job_hash_ref_aliases(job_id, target_ref);

    CREATE INDEX IF NOT EXISTS idx_agent_run_hash_refs_ref ON agent_run_hash_refs(ref);
    CREATE INDEX IF NOT EXISTS idx_agent_run_hash_refs_content ON agent_run_hash_refs(attempt_id, content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_hash_refs_owner_content_unique
      ON agent_run_hash_refs(attempt_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_run_hash_ref_aliases_ref ON agent_run_hash_ref_aliases(ref);
    CREATE INDEX IF NOT EXISTS idx_agent_run_hash_ref_aliases_target
      ON agent_run_hash_ref_aliases(attempt_id, target_ref);
  `);
}

export function copyCompatibleColumns(db, fromTable, toTable, aliases = {}) {
  const oldCols = new Set(getTableColumnNames(db, fromTable));
  const newCols = getTableColumnNames(db, toTable);
  const targetCols = [];
  const sourceExprs = [];
  const repairedJsonColumns = [];
  for (const col of newCols) {
    if (oldCols.has(col)) {
      targetCols.push(col);
      recordJsonRepairCount(db, fromTable, col, col, repairedJsonColumns);
      sourceExprs.push(copySourceExpr(fromTable, col, col));
      continue;
    }
    const alias = aliases[col];
    if (alias && oldCols.has(alias)) {
      targetCols.push(col);
      recordJsonRepairCount(db, fromTable, alias, col, repairedJsonColumns);
      sourceExprs.push(copySourceExpr(fromTable, alias, col));
    }
  }
  if (repairedJsonColumns.length > 0) {
    log.warn("db", "Repairing legacy invalid JSON while copying compatible columns", {
      fromTable,
      toTable,
      columns: repairedJsonColumns,
      repaired: repairedJsonColumns.reduce((sum, entry) => sum + entry.count, 0),
    });
  }
  if (targetCols.length === 0) return;
  _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs);
}

function isJsonValidityColumn(fromTable, sourceCol, targetCol) {
  return (
    JSON_VALIDITY_COLUMN_KEYS.has(`${fromTable}.${targetCol}`) ||
    JSON_VALIDITY_COLUMN_KEYS.has(`${fromTable}.${sourceCol}`)
  );
}

function recordJsonRepairCount(db, fromTable, sourceCol, targetCol, out) {
  if (!isJsonValidityColumn(fromTable, sourceCol, targetCol)) return;
  const quoted = quoteIdent(sourceCol);
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM ${quoteIdent(fromTable)}
     WHERE ${quoted} IS NOT NULL
       AND json_valid(${quoted}) = 0`
  ).get();
  const count = Number(row?.cnt || 0);
  if (count > 0) out.push({ sourceColumn: sourceCol, targetColumn: targetCol, count });
}

function copySourceExpr(fromTable, sourceCol, targetCol) {
  const quoted = quoteIdent(sourceCol);
  if (!isJsonValidityColumn(fromTable, sourceCol, targetCol)) {
    return quoted;
  }
  return `CASE WHEN ${quoted} IS NULL OR json_valid(${quoted}) THEN ${quoted} ELSE json_quote(${quoted}) END`;
}

export function _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs) {
  const targets = targetCols.map(quoteIdent).join(", ");
  db.exec(
    `INSERT INTO ${quoteIdent(toTable)} (${targets}) SELECT ${sourceExprs.join(", ")} FROM ${quoteIdent(fromTable)}`
  );
}

function copyAgentCallsForExtendedThinkingRepair(db, fromTable, toTable) {
  const oldCols = new Set(getTableColumnNames(db, fromTable));
  const newCols = getTableColumnNames(db, toTable);
  const targetCols = [];
  const sourceExprs = [];
  for (const col of newCols) {
    if (!oldCols.has(col)) continue;
    targetCols.push(col);
    if (col === "extended_thinking") {
      sourceExprs.push(`CASE WHEN COALESCE(${quoteIdent(col)}, 0) = 0 THEN 0 ELSE 1 END`);
    } else {
      sourceExprs.push(copySourceExpr(fromTable, col, col));
    }
  }
  if (targetCols.length === 0) return;
  _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs);
}

function agentCallsExtendedThinkingCheckIsCurrent(tableSql = "") {
  return /extended_thinking\s+INTEGER\b[\s\S]*?CHECK\s*\(\s*extended_thinking\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(tableSql);
}

function needsAgentCallsExtendedThinkingRepair(db) {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_calls'`
  ).get();
  if (!row?.sql) return false;
  const cols = new Set(getTableColumnNames(db, "agent_calls"));
  if (!cols.has("extended_thinking")) return true;
  if (!agentCallsExtendedThinkingCheckIsCurrent(row.sql)) return true;
  const invalid = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM agent_calls
    WHERE extended_thinking IS NULL
       OR extended_thinking NOT IN (0,1)
  `).get();
  return (invalid?.cnt || 0) > 0;
}

function repairAgentCallsExtendedThinkingSchema(db) {
  if (!needsAgentCallsExtendedThinkingRepair(db)) return false;
  withForeignKeysDisabled(db, () => db.transaction(() => {
    const tmpName = "_agent_calls_extended_thinking_repair";
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
    db.exec(agentCallsCreateSql(tmpName));
    copyAgentCallsForExtendedThinkingRepair(db, "agent_calls", tmpName);
    db.exec(`DROP TABLE ${quoteIdent("agent_calls")}`);
    db.exec(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("agent_calls")}`);
    createAgentCallsIndexes(db);
  })());
  return true;
}

export function __testRepairAgentCallsExtendedThinkingSchema(db) {
  return repairAgentCallsExtendedThinkingSchema(db);
}


function quarantineStaleIncompleteDb(dbPath, { force = false, ignoreAge = false } = {}) {
  if (!fs.existsSync(dbPath)) return;

  let stat;
  try { stat = fs.statSync(dbPath); } catch { return false; }
  if (!force && stat.size !== 0) return false;

  const siblings = [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter((p) => fs.existsSync(p));
  if (siblings.length <= 1) return false;

  const newestSiblingMs = Math.max(...siblings.map((p) => {
    try { return fs.statSync(p).mtimeMs; } catch { return 0; }
  }));
  if (!ignoreAge && Date.now() - newestSiblingMs < 5000) return false;

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  let quarantined = false;
  for (const filePath of siblings) {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${stamp}`);
      quarantined = true;
    } catch {
      // Best effort: if another process owns it, leave it alone and let SQLite report the error.
    }
  }
  return quarantined;
}

function ensureRuntimeDbDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows/best-effort */ }
}

export function getDb() {
  const dbPath = path.resolve(getRuntimeDbPath());
  if (_db) {
    if (_dbPath === dbPath) return _db;
    closeDb();
  }

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  ensureRuntimeDbDir(dir);

  quarantineStaleIncompleteDb(dbPath);

  _db = new Database(dbPath);
  _dbPath = dbPath;

  // Performance pragmas
  try {
    applyDbPragmas(_db, dbPath);
  } catch (err) {
    try { _db.close(); } catch {}
    _db = null;
    _dbPath = null;
    if (!quarantineStaleIncompleteDb(dbPath, { force: true, ignoreAge: true })) throw err;
    _db = new Database(dbPath);
    _dbPath = dbPath;
    applyDbPragmas(_db, dbPath);
  }

  // Some corrupted SQLite files still "open" successfully and only explode on
  // the first schema read. Probe immediately so we can quarantine/rebuild once
  // instead of letting later status/stream rendering fail with disk I/O errors.
  try {
    _db.prepare(`SELECT name FROM sqlite_master WHERE type='table' LIMIT 1`).get();
  } catch (err) {
    try { _db.close(); } catch {}
    _db = null;
    _dbPath = null;
    if (!isRecoverableDbError(err) || !quarantineStaleIncompleteDb(dbPath, { force: true, ignoreAge: true })) {
      throw err;
    }
    _db = new Database(dbPath);
    _dbPath = dbPath;
    applyDbPragmas(_db, dbPath);
  }

  // Bootstrap schema if tables don't exist
  const hasJobs = _db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get();

  if (!hasJobs) {
    if (fs.existsSync(SCHEMA_PATH)) {
      const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
      _db.exec(schema);
    } else {
      throw new Error(
        `Database has no tables and schema file not found at ${SCHEMA_PATH}. ` +
        `Create the database first or check the configured runtime database path.`
      );
    }
  }

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
  `);

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
      const currentJobsCols = _db.pragma("table_info(jobs)").map(c => c.name);

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
    `SELECT name FROM sqlite_master WHERE type='table' AND name='project_db_config'`
  ).get();
  if (!hasProjectDbConfig) {
    _db.exec(`
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
    `);
  }

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

  // ── Migration: ATLAS v2 host outbox support ───────────────────────────────
  runHostMigration(_db, {
    version: 5,
    name: "atlas_v2_host_schema",
    needs: needsAtlasV2HostSchemaRepair,
    migrate: repairAtlasV2HostSchema,
  });
  runHostMigration(_db, {
    version: 6,
    name: "agent_calls_extended_thinking",
    needs: needsAgentCallsExtendedThinkingRepair,
    migrate: repairAgentCallsExtendedThinkingSchema,
  });
  installBridgeChangeTracking(_db);
  ensureHostSchemaVersion(_db, HOST_SCHEMA_VERSION);

  createHashRefStoreTables(_db);
  installJsonValidityTriggers(_db);

  return _db;
}

export function __testInstallJsonValidityTriggers(db) {
  installJsonValidityTriggers(db);
}

export function __testInstallBridgeChangeTracking(db) {
  return installBridgeChangeTracking(db);
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
  _dbPath = null;
  bumpRunTelemetryEpoch();
}
