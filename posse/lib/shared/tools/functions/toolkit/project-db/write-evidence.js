// Durable receipts for what a job actually did to the project database.
//
// The generic tool ledger cannot answer that: project_db_query reports refusals
// and engine errors as result text, so its invocation row is recorded ok even
// when nothing ran, and observation rows are a pruned telemetry tail that queue
// decisions must not depend on. A receipt is written only after the engine
// accepted the statement, into its own table, bound to the job AND attempt that
// ran it. The planner's direct completion of database-only work (plan-compiler)
// and its retry reconciliation (planner role) gate on these receipts.
//
// A receipt is written AFTER the application database committed, and the two
// databases cannot share a transaction. If the orchestrator database refuses
// the row, the receipt falls back to an append-only file beside it; only if
// that also fails is the write reported as unrecorded, which the tool surfaces
// to the agent as committed-but-unreceipted so it is never blindly re-run.

import fs from "fs";
import path from "path";
import { getDb } from "../../../../storage/functions/index.js";
import { getRuntimeDbPath } from "../../../../../domains/runtime/functions/paths.js";
import { getObservationContext } from "../../../../../domains/observability/functions/observations.js";

export const PROJECT_DB_RECEIPTS_TABLE = "project_db_receipts";
export const PROJECT_DB_RECEIPTS_DDL = `
  CREATE TABLE IF NOT EXISTS ${PROJECT_DB_RECEIPTS_TABLE} (
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
    ON ${PROJECT_DB_RECEIPTS_TABLE}(job_id, attempt_id, id);
`;

const FALLBACK_FILE = "project-db-receipts.jsonl";
const MAX_STATEMENT_CHARS = 2000;

let receiptWriterForTests = null;
/** Test seam: replace the primary (database) receipt writer to inject failures. */
export function __setProjectDbReceiptWriterForTests(fn = null) {
  receiptWriterForTests = typeof fn === "function" ? fn : null;
}

// Beside the orchestrator database this process actually has open, so the
// reader (orchestrator) and writer (tool subprocess) agree on the location.
function fallbackPath() {
  let dbFile = null;
  try { dbFile = getDb()?.name || null; } catch { dbFile = null; }
  return path.join(path.dirname(dbFile || getRuntimeDbPath()), FALLBACK_FILE);
}

function insertReceipt(receipt) {
  if (receiptWriterForTests) return receiptWriterForTests(receipt);
  const db = getDb();
  db.exec(PROJECT_DB_RECEIPTS_DDL);
  db.prepare(`
    INSERT INTO ${PROJECT_DB_RECEIPTS_TABLE}
      (work_item_id, job_id, attempt_id, kind, verb, tables_json, affected_rows, statement, db_type, created_at)
    VALUES
      (@work_item_id, @job_id, @attempt_id, @kind, @verb, @tables_json, @affected_rows, @statement, @db_type, @created_at)
  `).run(receipt);
  return true;
}

/**
 * Persist one receipt. Returns "recorded", "no_context" (no job to bind it to,
 * e.g. a bare tool call outside a job), or "unrecorded" (the statement ran but
 * no durable receipt could be written anywhere).
 */
function recordProjectDbReceipt(kind, { verb, tables = [], affectedRows = null, statement = "", dbType = null } = {}, observationContext = null) {
  let context;
  try {
    context = { ...(getObservationContext() || {}), ...(observationContext || {}) };
  } catch {
    context = { ...(observationContext || {}) };
  }
  if (context.job_id == null) return "no_context";
  const receipt = {
    work_item_id: context.work_item_id ?? null,
    job_id: Number(context.job_id),
    attempt_id: context.attempt_id ?? null,
    kind,
    verb: String(verb || ""),
    tables_json: JSON.stringify(Array.isArray(tables) ? tables : []),
    affected_rows: affectedRows == null ? null : Number(affectedRows),
    statement: String(statement).slice(0, MAX_STATEMENT_CHARS),
    db_type: dbType,
    created_at: new Date().toISOString(),
  };
  try {
    insertReceipt(receipt);
    return "recorded";
  } catch {
    try {
      fs.appendFileSync(fallbackPath(), `${JSON.stringify(receipt)}\n`);
      return "recorded";
    } catch {
      return "unrecorded";
    }
  }
}

export function recordProjectDbWrite(write = {}, observationContext = null) {
  return recordProjectDbReceipt("write", write, observationContext);
}

/** A successful read on the write lane: the verification half of a receipt trail. */
export function recordProjectDbRead(read = {}, observationContext = null) {
  return recordProjectDbReceipt("read", read, observationContext);
}

function readFallbackReceipts(jobId) {
  try {
    return fs.readFileSync(fallbackPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((row) => row && Number(row.job_id) === Number(jobId));
  } catch {
    return [];
  }
}

function toReceipt(row) {
  let tables = [];
  try { tables = JSON.parse(row.tables_json || "[]"); } catch { tables = []; }
  return {
    kind: row.kind,
    verb: String(row.verb || ""),
    tables: Array.isArray(tables) ? tables : [],
    affectedRows: row.affected_rows ?? null,
    statement: String(row.statement || ""),
    attemptId: row.attempt_id ?? null,
    at: row.created_at || null,
  };
}

/**
 * A job's receipts in execution order. `attemptId` narrows to one attempt;
 * receipts with no attempt never match a requested attempt.
 */
export function listProjectDbReceipts(jobId, { attemptId = undefined } = {}) {
  if (jobId == null) return [];
  let rows = [];
  try {
    const db = getDb();
    db.exec(PROJECT_DB_RECEIPTS_DDL);
    rows = db.prepare(`SELECT * FROM ${PROJECT_DB_RECEIPTS_TABLE} WHERE job_id = ? ORDER BY id`).all(Number(jobId));
  } catch {
    rows = [];
  }
  const all = [...rows, ...readFallbackReceipts(jobId)]
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return all
    .filter((row) => attemptId === undefined || (row.attempt_id != null && Number(row.attempt_id) === Number(attemptId)))
    .map(toReceipt);
}

/** The mutating statements a job (or one attempt of it) successfully executed. */
export function listProjectDbWrites(jobId, opts = {}) {
  return listProjectDbReceipts(jobId, opts).filter((receipt) => receipt.kind === "write");
}

/**
 * Whether one attempt's receipts prove it changed the database and then looked:
 * at least one write that did something (DDL, or DML touching a row), followed
 * by a successful read. Returns the writes when it does.
 */
export function verifiedProjectDbExecution(jobId, attemptId) {
  if (jobId == null || attemptId == null) return { ok: false, reason: "no_attempt", writes: [] };
  const receipts = listProjectDbReceipts(jobId, { attemptId });
  const writes = receipts.filter((receipt) => receipt.kind === "write");
  if (writes.length === 0) return { ok: false, reason: "no_write_receipt", writes };
  if (!writes.some((write) => write.affectedRows == null || write.affectedRows > 0)) {
    return { ok: false, reason: "no_rows_changed", writes };
  }
  const lastWrite = receipts.lastIndexOf(writes[writes.length - 1]);
  if (!receipts.slice(lastWrite + 1).some((receipt) => receipt.kind === "read")) {
    return { ok: false, reason: "not_verified_by_read", writes };
  }
  return { ok: true, reason: null, writes };
}
