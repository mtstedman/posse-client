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
import { Ledger } from "../../classes/v2/Ledger.js";
import { View as AtlasView } from "../../classes/v2/View.js";
import { openViewWithMeta, viewFreshness } from "./view-health.js";

/** @param {Record<string, unknown>} message */
function post(message) {
  try { parentPort?.postMessage(message); } catch { /* parent is gone */ }
}

/**
 * @param {{ viewPath?: string, branch?: string, ledgerDbPath?: string | null, layerMerge?: boolean | null }} [args]
 */
function inspect({ viewPath, branch, ledgerDbPath = null, layerMerge = null } = {}) {
  const status = { exists: false, readable: false, branchMatches: false, current: false, error: null };
  const probe = openViewWithMeta(viewPath, AtlasView);
  try {
    status.exists = !!probe.exists;
    if (!probe.ok) {
      status.error = probe.error?.message || String(probe.error || "view_unreadable");
      return status;
    }
    status.readable = true;
    status.branchMatches = probe.meta?.branch === branch;
    if (!status.branchMatches) return status;
    if (!ledgerDbPath) {
      status.current = true;
      return status;
    }
    let ledger = null;
    try {
      ledger = Ledger.openReadOnly({ dbPath: ledgerDbPath });
      status.current = viewFreshness(probe.meta, ledger, { layerMerge }).current === true;
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
