// Shared host-table DDL and index installers. Legacy schema repairs use these
// constructors, and database initialization uses the same definitions.

import {
  ASSESSMENT_LIFECYCLE,
  ASSESSMENT_LIFECYCLE_STATE_LIST_SQL,
  JOB_ATTEMPT_WORKER_TYPE_LIST_SQL,
  JOB_ASSESSOR_CONFIDENCE_LIST_SQL,
  JOB_ASSESSOR_VERDICT_LIST_SQL,
  JOB_MODEL_TIER_LIST_SQL,
  JOB_REASONING_EFFORT_LIST_SQL,
  JOB_STATUS_LIST_SQL,
  JOB_TYPE_LIST_SQL,
} from "../../../catalog/job.js";
import {
  WORK_ITEM_GOVERNANCE_TIER_LIST_SQL,
  WORK_ITEM_MERGE_STATE_LIST_SQL,
  WORK_ITEM_MODE_LIST_SQL,
  WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL,
  WORK_ITEM_PRIORITY_LIST_SQL,
  WORK_ITEM_SESSION_RECYCLE_LIST_SQL,
  WORK_ITEM_STATUS_LIST_SQL,
} from "../../../catalog/work-item.js";
import {
  ARTIFACT_TYPE_LIST_SQL,
} from "../../../catalog/artifact.js";
import {
  EVENT_ACTOR_TYPE_LIST_SQL,
} from "../../../catalog/event.js";
import {
  HASH_REF_ENTRY_KIND_LIST_SQL,
} from "../../../catalog/hash-store.js";
import {
  WAITING_LANE_DEMAND_REASON_LIST_SQL,
  WAITING_LANE_STATE_LIST_SQL,
} from "../../../catalog/waiting-lane.js";
import {
  AGENT_CALL_CHILD_KIND_LIST_SQL,
} from "../../../catalog/agent-call.js";


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
          assessment_state TEXT NOT NULL DEFAULT '${ASSESSMENT_LIFECYCLE.NOT_STARTED}' CHECK (
            assessment_state IN (${ASSESSMENT_LIFECYCLE_STATE_LIST_SQL})
          ),
          assessment_attempt_count INTEGER NOT NULL DEFAULT 0,
          assessment_max_attempts INTEGER NOT NULL DEFAULT 3,
          assessment_last_error TEXT,
          assessment_completed_at TEXT,
          state_version INTEGER NOT NULL DEFAULT 0,
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

export function waitingLanePreparationsCreateSql(tableName = "waiting_lane_preparations") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
          work_item_id INTEGER PRIMARY KEY,
          state TEXT NOT NULL DEFAULT 'requested' CHECK (
            state IN (${WAITING_LANE_STATE_LIST_SQL})
          ),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          demand_reason TEXT NOT NULL CHECK (
            demand_reason IN (${WAITING_LANE_DEMAND_REASON_LIST_SQL})
          ),
          target_branch TEXT NOT NULL,
          worktree_root TEXT,
          project_cwd TEXT,
          ownership_record_id TEXT,
          desired_git_oid TEXT,
          desired_atlas_seq INTEGER CHECK (desired_atlas_seq IS NULL OR desired_atlas_seq >= 0),
          desired_atlas_layer_revision INTEGER CHECK (
            desired_atlas_layer_revision IS NULL OR desired_atlas_layer_revision >= 0
          ),
          desired_atlas_layer_row_count INTEGER CHECK (
            desired_atlas_layer_row_count IS NULL OR desired_atlas_layer_row_count >= 0
          ),
          desired_view_fingerprint TEXT,
          applied_git_oid TEXT,
          applied_atlas_seq INTEGER CHECK (applied_atlas_seq IS NULL OR applied_atlas_seq >= 0),
          applied_atlas_layer_revision INTEGER CHECK (
            applied_atlas_layer_revision IS NULL OR applied_atlas_layer_revision >= 0
          ),
          applied_atlas_layer_row_count INTEGER CHECK (
            applied_atlas_layer_row_count IS NULL OR applied_atlas_layer_row_count >= 0
          ),
          applied_view_fingerprint TEXT,
          git_job_id INTEGER,
          atlas_job_id INTEGER,
          successor_needed INTEGER NOT NULL DEFAULT 0 CHECK (successor_needed IN (0, 1)),
          hot_paths_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hot_paths_json)),
          poisoned_reason TEXT,
          requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          activated_at TEXT,
          retired_at TEXT,
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (git_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
          FOREIGN KEY (atlas_job_id) REFERENCES jobs(id) ON DELETE SET NULL
        )
      `;
}

export function createWaitingLanePreparationIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_waiting_lane_state_updated ON waiting_lane_preparations(state, updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_waiting_lane_demand ON waiting_lane_preparations(target_branch, state, updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_waiting_lane_git_job ON waiting_lane_preparations(git_job_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_waiting_lane_atlas_job ON waiting_lane_preparations(atlas_job_id)`);
}

export function jobAttemptsCreateSql(tableName = "job_attempts") {
  return `
        CREATE TABLE ${quoteIdent(tableName)} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          attempt_number INTEGER NOT NULL,
          attempt_kind TEXT NOT NULL DEFAULT 'implementation' CHECK (
            attempt_kind IN ('implementation','assessment','human')
          ),
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
          commit_base_hash TEXT,
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
          parent_agent_call_id INTEGER,
          child_kind TEXT CHECK (
            child_kind IS NULL OR child_kind IN (${AGENT_CALL_CHILD_KIND_LIST_SQL})
          ),
          role TEXT NOT NULL,
          model_tier TEXT NOT NULL,
          model_name TEXT,
          activity TEXT,
          prompt_chars INTEGER,
          output_chars INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_output_tokens INTEGER,
          cached_input_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          max_turns_configured INTEGER,
          turn_limit_mode TEXT,
          turns_used INTEGER,
          max_output_tokens_configured INTEGER,
          output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0,1)),
          output_limit_reason TEXT,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          finished_at TEXT,
          duration_ms INTEGER,
          exit_code INTEGER,
          status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','timeout','interrupted')),
          error_text TEXT,
          provider TEXT DEFAULT 'claude',
          prior_session_handle TEXT,
          session_handle TEXT,
          atlas_method TEXT,
          atlas_prefetch_status TEXT,
          skills TEXT,
          cost_estimate_usd REAL,
          provider_usage_status TEXT,
          billing_precision TEXT,
          exact_billable_input_tokens REAL,
          long_context_tier_input_tokens INTEGER,
          provider_request_duration_ms INTEGER,
          usage_segment_count INTEGER,
          originator_instance_id TEXT,
          executor_instance_id TEXT,
          reasoning_effort TEXT DEFAULT 'medium',
          extended_thinking INTEGER NOT NULL DEFAULT 0 CHECK (extended_thinking IN (0,1)),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL,
          FOREIGN KEY (parent_agent_call_id) REFERENCES ${quoteIdent(tableName)}(id) ON DELETE CASCADE,
          CHECK (
            (parent_agent_call_id IS NULL AND child_kind IS NULL)
            OR (parent_agent_call_id IS NOT NULL AND child_kind IS NOT NULL)
          )
        )
      `;
}

export function createAgentCallsIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_job ON agent_calls(job_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_role ON agent_calls(role, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_work_item ON agent_calls(work_item_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_atlas_prefetch ON agent_calls(role, atlas_prefetch_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_calls_parent ON agent_calls(parent_agent_call_id, created_at)`);
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
      reuse_excluded INTEGER NOT NULL DEFAULT 0 CHECK (reuse_excluded IN (0, 1)),
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

function hashRefCapabilityTableSql(tableName, { evidence = false } = {}) {
  return `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      selector_json TEXT CHECK (selector_json IS NULL OR json_valid(selector_json)),
      work_item_id INTEGER,
      job_id INTEGER,
      attempt_id INTEGER,
      agent_call_id INTEGER,
      source_content_hash TEXT CHECK (source_content_hash IS NULL OR length(source_content_hash) = 64),
      view_sha256 TEXT ${evidence ? "CHECK (view_sha256 IS NULL OR length(view_sha256) = 64)" : ""},
      view_chars INTEGER,
      view_lines INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (ref, scope_key),
      FOREIGN KEY (ref) REFERENCES hash_ref_aliases(ref) ON DELETE CASCADE,
      FOREIGN KEY (source_ref) REFERENCES hash_ref_aliases(ref) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE ${evidence ? "SET NULL" : "CASCADE"}
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
  db.exec(hashRefCapabilityTableSql("hash_ref_traversal_refs"));
  db.exec(hashRefCapabilityTableSql("hash_ref_evidence_refs", { evidence: true }));

  for (const tableName of ["work_item_hash_refs", "job_hash_refs", "agent_run_hash_refs"]) {
    const columns = new Set(db.pragma(`table_info(${quoteIdent(tableName)})`).map((column) => column.name));
    if (!columns.has("reuse_excluded")) {
      db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN reuse_excluded INTEGER NOT NULL DEFAULT 0 CHECK (reuse_excluded IN (0, 1))`);
      db.prepare(`
        UPDATE ${quoteIdent(tableName)}
        SET reuse_excluded = 1
        WHERE json_extract(metadata_json, '$.protocol') = 'posse.sub_agent.v1'
          AND json_type(metadata_json, '$.batch_id') IS NOT NULL
          AND json_type(metadata_json, '$.dispatch_id') IS NOT NULL
          AND json_type(metadata_json, '$.input_id') IS NOT NULL
      `).run();
    }
  }

  // Content reuse is selected transactionally by HashRefStore. Distinct
  // delegation identities may intentionally carry identical bytes.
  db.exec(`
    DROP INDEX IF EXISTS idx_work_item_hash_refs_owner_content_unique;
    DROP INDEX IF EXISTS idx_job_hash_refs_owner_content_unique;
    DROP INDEX IF EXISTS idx_agent_run_hash_refs_owner_content_unique;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_item_hash_refs_ref ON work_item_hash_refs(ref);
    CREATE INDEX IF NOT EXISTS idx_work_item_hash_refs_content ON work_item_hash_refs(work_item_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_work_item_hash_ref_aliases_ref ON work_item_hash_ref_aliases(ref);
    CREATE INDEX IF NOT EXISTS idx_work_item_hash_ref_aliases_target
      ON work_item_hash_ref_aliases(work_item_id, target_ref);

    CREATE INDEX IF NOT EXISTS idx_job_hash_refs_ref ON job_hash_refs(ref);
    CREATE INDEX IF NOT EXISTS idx_job_hash_refs_content ON job_hash_refs(job_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_job_hash_ref_aliases_ref ON job_hash_ref_aliases(ref);
    CREATE INDEX IF NOT EXISTS idx_job_hash_ref_aliases_target
      ON job_hash_ref_aliases(job_id, target_ref);

    CREATE INDEX IF NOT EXISTS idx_agent_run_hash_refs_ref ON agent_run_hash_refs(ref);
    CREATE INDEX IF NOT EXISTS idx_agent_run_hash_refs_content ON agent_run_hash_refs(attempt_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_run_hash_ref_aliases_ref ON agent_run_hash_ref_aliases(ref);
    CREATE INDEX IF NOT EXISTS idx_agent_run_hash_ref_aliases_target
      ON agent_run_hash_ref_aliases(attempt_id, target_ref);

    CREATE INDEX IF NOT EXISTS idx_hash_ref_traversal_refs_scope
      ON hash_ref_traversal_refs(scope_key, ref);
    CREATE INDEX IF NOT EXISTS idx_hash_ref_traversal_refs_source
      ON hash_ref_traversal_refs(source_ref);
    CREATE INDEX IF NOT EXISTS idx_hash_ref_evidence_refs_scope
      ON hash_ref_evidence_refs(scope_key, ref);
    CREATE INDEX IF NOT EXISTS idx_hash_ref_evidence_refs_source
      ON hash_ref_evidence_refs(source_ref);
  `);
}

export function createAgentHandoffPacketTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_handoff_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_call_id INTEGER NOT NULL,
      work_item_id INTEGER,
      job_id INTEGER,
      attempt_id INTEGER,
      role TEXT NOT NULL,
      code TEXT NOT NULL,
      input_chars INTEGER CHECK (input_chars IS NULL OR input_chars >= 0),
      detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE SET NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL,
      FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_handoff_rejections_call
      ON agent_handoff_rejections(agent_call_id, id);
    CREATE TABLE IF NOT EXISTS agent_handoff_packets (
      agent_call_id INTEGER PRIMARY KEY,
      work_item_id INTEGER,
      job_id INTEGER,
      attempt_id INTEGER,
      role TEXT NOT NULL,
      profile TEXT NOT NULL,
      outcome TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('staged','committed','rejected')),
      materialized_packet_json TEXT NOT NULL CHECK (json_valid(materialized_packet_json)),
      packet_digest TEXT NOT NULL CHECK (length(packet_digest) = 64),
      evidence_chars INTEGER NOT NULL DEFAULT 0,
      stage_count INTEGER NOT NULL DEFAULT 1,
      continuation_prose_chars INTEGER NOT NULL DEFAULT 0,
      rejection_code TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      committed_at TEXT,
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_handoff_packets_job
      ON agent_handoff_packets(job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_handoff_packets_status
      ON agent_handoff_packets(status, created_at);
  `);
  const hasStageCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM pragma_table_info('agent_handoff_packets')
    WHERE name = 'stage_count'
  `).get();
  if (Number(hasStageCount?.count || 0) === 0) {
    db.exec(`ALTER TABLE agent_handoff_packets ADD COLUMN stage_count INTEGER NOT NULL DEFAULT 1`);
  }
}

export function createResearchReportClaimDraftTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_report_claim_drafts (
      agent_call_id INTEGER NOT NULL,
      claim_id TEXT NOT NULL,
      attempt_id INTEGER,
      position INTEGER NOT NULL,
      claim_json TEXT NOT NULL CHECK (json_valid(claim_json)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (agent_call_id, claim_id),
      FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_report_claim_drafts_attempt
      ON research_report_claim_drafts(attempt_id, agent_call_id, position);
  `);
}
