// Idempotent SQLite trigger installers. These are deliberately separate from
// schema definitions so both fresh databases and repaired legacy databases
// receive the same runtime invariants.

import { TERMINAL_JOB_STATUSES_SQL } from "../../../catalog/job.js";

const JSON_VALIDITY_COLUMNS = [
  ["work_items", "metadata_json"], ["jobs", "payload_json"], ["jobs", "result_json"],
  ["job_attempts", "metadata_json"], ["artifacts", "content_json"], ["events", "event_json"],
  ["scheduler_locks", "metadata_json"], ["work_item_file_locks", "metadata_json"],
  ["job_file_locks", "metadata_json"], ["run_insights", "evidence"], ["run_insights", "file_paths"],
  ["job_observations", "detail_json"], ["work_item_hash_refs", "descriptor_json"],
  ["work_item_hash_refs", "fingerprint_json"], ["work_item_hash_refs", "metadata_json"],
  ["job_hash_refs", "descriptor_json"], ["job_hash_refs", "fingerprint_json"],
  ["job_hash_refs", "metadata_json"], ["agent_run_hash_refs", "descriptor_json"],
  ["agent_run_hash_refs", "fingerprint_json"], ["agent_run_hash_refs", "metadata_json"],
  ["posse_test_suites", "metadata_json"], ["posse_tests", "last_run_json"],
  ["posse_test_runs", "failure_json"],
];

const BRIDGE_CHANGE_TRACKED_TABLES = ["work_items", "jobs"];

export function isJsonValidityColumn(tableName, columnName) {
  return JSON_VALIDITY_COLUMNS.some(([knownTable, knownColumn]) => (
    knownTable === tableName && knownColumn === columnName
  ));
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableColumns(db, tableName) {
  return new Set(db.pragma(`table_info(${quoteIdent(tableName)})`).map((column) => column.name));
}

function triggerName(prefix, tableName, columnName, op) {
  return [prefix, tableName, columnName, op]
    .filter(Boolean)
    .join("_")
    .replace(/[^A-Za-z0-9_]/g, "_");
}

export function installJsonValidityTriggers(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const [tableName, columnName] of JSON_VALIDITY_COLUMNS) {
    if (!tables.has(tableName) || !tableColumns(db, tableName).has(columnName)) continue;
    const table = quoteIdent(tableName);
    const column = quoteIdent(columnName);
    const label = `${tableName}.${columnName}`;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName("posse_json_valid", tableName, columnName, "insert"))}
      BEFORE INSERT ON ${table} FOR EACH ROW
      WHEN NEW.${column} IS NOT NULL AND json_valid(NEW.${column}) = 0
      BEGIN SELECT RAISE(ABORT, 'invalid JSON in ${label}'); END;
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName("posse_json_valid", tableName, columnName, "update"))}
      BEFORE UPDATE OF ${column} ON ${table} FOR EACH ROW
      WHEN NEW.${column} IS NOT NULL AND json_valid(NEW.${column}) = 0
      BEGIN SELECT RAISE(ABORT, 'invalid JSON in ${label}'); END;
    `);
  }
}

export function installBridgeChangeTracking(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  if (!BRIDGE_CHANGE_TRACKED_TABLES.some((tableName) => tables.has(tableName))) return false;
  db.exec("CREATE TABLE IF NOT EXISTS bridge_change_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL DEFAULT 0)");
  let changed = false;
  let maxSeq = 0;
  for (const tableName of BRIDGE_CHANGE_TRACKED_TABLES) {
    if (!tables.has(tableName)) continue;
    if (!tableColumns(db, tableName).has("bridge_change_seq")) {
      db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN bridge_change_seq INTEGER NOT NULL DEFAULT 0`);
      changed = true;
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${tableName}_bridge_change_seq`)} ON ${quoteIdent(tableName)}(bridge_change_seq)`);
    maxSeq = Math.max(maxSeq, Number(db.prepare(`SELECT COALESCE(MAX(bridge_change_seq), 0) AS seq FROM ${quoteIdent(tableName)}`).get()?.seq || 0));
  }
  db.prepare("INSERT INTO bridge_change_sequence (id, seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET seq = max(bridge_change_sequence.seq, excluded.seq)").run(maxSeq);
  for (const tableName of BRIDGE_CHANGE_TRACKED_TABLES) {
    if (!tables.has(tableName) || !tableColumns(db, tableName).has("bridge_change_seq")) continue;
    const table = quoteIdent(tableName);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName("posse_bridge_change", tableName, null, "insert"))}
      AFTER INSERT ON ${table} FOR EACH ROW BEGIN
        UPDATE bridge_change_sequence SET seq = seq + 1 WHERE id = 1;
        UPDATE ${table} SET bridge_change_seq = (SELECT seq FROM bridge_change_sequence WHERE id = 1) WHERE id = NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName("posse_bridge_change", tableName, null, "update"))}
      AFTER UPDATE ON ${table} FOR EACH ROW WHEN NEW.bridge_change_seq <= OLD.bridge_change_seq BEGIN
        UPDATE bridge_change_sequence SET seq = seq + 1 WHERE id = 1;
        UPDATE ${table} SET bridge_change_seq = (SELECT seq FROM bridge_change_sequence WHERE id = 1) WHERE id = NEW.id;
      END;
    `);
  }
  return changed;
}

export function installTerminalTransitionTracking(db) {
  db.exec(`
    INSERT OR IGNORE INTO work_item_terminal_transitions (work_item_id, outcome, occurred_at, source)
    SELECT id, CASE status WHEN 'complete' THEN 'completed' ELSE status END, completed_at, 'legacy_current'
    FROM work_items WHERE status IN ('complete','failed','canceled') AND completed_at IS NOT NULL;
    INSERT OR IGNORE INTO job_terminal_transitions (job_id, outcome, occurred_at, source)
    SELECT id, CASE WHEN status = 'dead_letter' THEN 'failed' ELSE status END, finished_at, 'legacy_current'
    FROM jobs WHERE status IN (${TERMINAL_JOB_STATUSES_SQL}) AND finished_at IS NOT NULL;
    DROP TRIGGER IF EXISTS trg_work_item_terminal_transition_insert;
    DROP TRIGGER IF EXISTS trg_work_item_terminal_transition_update;
    DROP TRIGGER IF EXISTS trg_job_terminal_transition_insert;
    DROP TRIGGER IF EXISTS trg_job_terminal_transition_update;
    CREATE TRIGGER trg_work_item_terminal_transition_insert AFTER INSERT ON work_items
    WHEN NEW.status IN ('complete','failed','canceled') AND NEW.completed_at IS NOT NULL BEGIN
      INSERT OR IGNORE INTO work_item_terminal_transitions (work_item_id, outcome, occurred_at, source)
      VALUES (NEW.id, CASE NEW.status WHEN 'complete' THEN 'completed' ELSE NEW.status END, NEW.completed_at, 'owner_transition'); END;
    CREATE TRIGGER trg_work_item_terminal_transition_update AFTER UPDATE OF status, completed_at ON work_items
    WHEN NEW.status IN ('complete','failed','canceled') AND NEW.completed_at IS NOT NULL BEGIN
      INSERT OR IGNORE INTO work_item_terminal_transitions (work_item_id, outcome, occurred_at, source)
      VALUES (NEW.id, CASE NEW.status WHEN 'complete' THEN 'completed' ELSE NEW.status END, NEW.completed_at, 'owner_transition'); END;
    CREATE TRIGGER trg_job_terminal_transition_insert AFTER INSERT ON jobs
    WHEN NEW.status IN (${TERMINAL_JOB_STATUSES_SQL}) AND NEW.finished_at IS NOT NULL BEGIN
      INSERT OR IGNORE INTO job_terminal_transitions (job_id, outcome, occurred_at, source)
      VALUES (NEW.id, CASE WHEN NEW.status = 'dead_letter' THEN 'failed' ELSE NEW.status END, NEW.finished_at, 'owner_transition'); END;
    CREATE TRIGGER trg_job_terminal_transition_update AFTER UPDATE OF status, finished_at ON jobs
    WHEN NEW.status IN (${TERMINAL_JOB_STATUSES_SQL}) AND NEW.finished_at IS NOT NULL BEGIN
      INSERT OR IGNORE INTO job_terminal_transitions (job_id, outcome, occurred_at, source)
      VALUES (NEW.id, CASE WHEN NEW.status = 'dead_letter' THEN 'failed' ELSE NEW.status END, NEW.finished_at, 'owner_transition'); END;
  `);
}
