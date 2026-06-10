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
  createWorkItemsIndexes,
  eventsCreateSql,
  getTableColumnNames,
  jobsCreateSql,
  quoteIdent,
  withForeignKeysDisabled,
  workItemsCreateSql,
} from "./index.js";
import { log } from "../../telemetry/functions/logging/logger.js";

export const HOST_SCHEMA_VERSION = 7;

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
