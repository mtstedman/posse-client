// @ts-check
//
// Worker-thread entry point for the boot main-view freshness check. Opening the
// view + ledger with better-sqlite3 is synchronous/native and can monopolize
// the CLI event loop (and may busy-wait on a concurrent writer's lock), which
// starves the scheduler's lock-renew heartbeat. Running it here keeps the main
// thread responsive. Logic mirrors inspectMainViewForBoot in
// integrations/atlas.js; the result is the cloneable subset the boot callers
// read (branchMatches + current). Uses the ThreadManager {type,result,error}
// message protocol.

import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { Ledger } from "../../classes/v2/Ledger.js";
import { View as AtlasView } from "../../classes/v2/View.js";
import { LEDGER_SCHEMA_VERSION } from "./contracts/index.js";
import { isSqliteCorruptionError, ledgerNeedsFormatReset } from "./ledger/schema.js";
import { openViewWithMeta, viewFreshness } from "./view-health.js";

/** @param {Record<string, unknown>} message */
function post(message) {
  try { parentPort?.postMessage(message); } catch { /* parent is gone */ }
}

/**
 * @param {string | null | undefined} ledgerDbPath
 */
function inspectLedgerFormat(ledgerDbPath) {
  const status = {
    exists: false,
    readable: false,
    resetNeeded: false,
    schemaVersion: null,
    expectedSchemaVersion: LEDGER_SCHEMA_VERSION,
    error: null,
  };
  if (!ledgerDbPath) return status;
  let db = null;
  try {
    db = new Database(ledgerDbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    status.exists = true;
    status.readable = true;
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
      status.schemaVersion = row?.value == null ? null : Number(row.value);
    } catch {
      status.schemaVersion = null;
    }
    status.resetNeeded = ledgerNeedsFormatReset(db);
    return status;
  } catch (err) {
    status.error = err?.message || String(err);
    status.resetNeeded = isSqliteCorruptionError(err);
    return status;
  } finally {
    try { db?.close?.(); } catch { /* ignore */ }
  }
}

/**
 * @param {{ viewPath?: string, branch?: string, ledgerDbPath?: string | null, layerMerge?: boolean | null }} [args]
 */
function inspect({ viewPath, branch, ledgerDbPath = null, layerMerge = null } = {}) {
  const status = {
    exists: false,
    readable: false,
    branchMatches: false,
    current: false,
    meta: null,
    freshness: null,
    ledgerFormat: inspectLedgerFormat(ledgerDbPath),
    error: null,
  };
  const probe = openViewWithMeta(viewPath, AtlasView);
  try {
    status.exists = !!probe.exists;
    if (!probe.ok) {
      status.error = probe.error?.message || String(probe.error || "view_unreadable");
      return status;
    }
    status.readable = true;
    status.meta = probe.meta || null;
    status.branchMatches = probe.meta?.branch === branch;
    if (!status.branchMatches) return status;
    if (status.ledgerFormat?.resetNeeded) {
      status.error = status.ledgerFormat.error || "ledger format reset required";
      return status;
    }
    if (!ledgerDbPath) {
      status.current = true;
      return status;
    }
    let ledger = null;
    try {
      ledger = Ledger.openReadOnly({ dbPath: ledgerDbPath });
      status.freshness = viewFreshness(probe.meta, ledger, { layerMerge });
      status.current = status.freshness.current === true;
    } catch (err) {
      status.error = err?.message || String(err);
      status.current = false;
    } finally {
      try { ledger?.close?.(); } catch { /* ignore */ }
    }
    return status;
  } finally {
    try { if (probe.ok) probe.view.close(); } catch { /* ignore */ }
  }
}

try {
  const result = inspect(workerData || {});
  post({ type: "result", result });
} catch (err) {
  post({
    type: "error",
    error: {
      name: err?.name || "Error",
      message: err?.message || String(err),
      stack: err?.stack || null,
      code: err?.code || null,
    },
  });
}
