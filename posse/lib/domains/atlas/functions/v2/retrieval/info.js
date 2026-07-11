// @ts-check
//
// Native ATLAS v2 diagnostics. This intentionally reports the local v2 runtime
// shape rather than delegating to the original ATLAS sidecar.

import fs from "fs";
import path from "path";
import { okEnvelope } from "./envelope.js";
import { ledgerDbPath, mainViewPath, worktreeViewPath } from "../runtime-paths.js";
import { viewFreshness } from "../view-health.js";
import { getEffectivePolicy } from "./policy.js";
import { branchFromVersion } from "./version.js";

/**
 * @param {{
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").InfoParams,
 *   view?: import("../contracts/api.js").View,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoRoot?: string,
 *   repoId?: string | null,
 *   viewPath?: string | null,
 * }} args
 */
export async function info({ versionId, params = {}, view, ledger, repoRoot, repoId, viewPath }) {
  const root = repoRoot ? path.resolve(repoRoot) : null;
  const liveLedgerPath = ledgerPathOf(ledger);
  const ledgerPath = liveLedgerPath || (root ? ledgerDbPath(root) : null);
  const mainPath = root ? mainViewPath(root) : null;
  const worktreePath = root ? worktreeViewPath(root) : null;
  const meta = await safeViewMeta(view);
  const branch = meta?.branch || branchFromVersion(versionId);
  const ledgerHead = branch && ledger && typeof /** @type {any} */ (ledger).headSeq === "function"
    ? safeHeadSeq(ledger, branch)
    : null;
  const freshness = view && meta && ledger
    ? viewFreshness(meta, ledger)
    : {
        current: !!view && !!meta,
        branch,
        ledgerSeq: meta?.ledger_seq ?? null,
        headSeq: ledgerHead,
        reason: view ? null : "view_unavailable",
      };
  const warnings = [];
  if (!root) warnings.push("Repository root is not available in the ATLAS v2 context.");
  if (!ledger && ledgerPath && !fs.existsSync(ledgerPath)) warnings.push("ATLAS v2 ledger file is missing.");
  if (viewPath && !fs.existsSync(viewPath)) warnings.push("Selected ATLAS v2 view file is missing.");
  if (freshness.reason) warnings.push(String(freshness.reason));
  if (params.includePolicy && !ledger) warnings.push("Policy report is using defaults because no ledger is open.");

  const data = {
    version: "atlas-v2",
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    repo: {
      repoId: String(repoId || params.repoId || "default"),
      repoRoot: root,
    },
    storage: {
      ledgerPath,
      ledgerExists: !!(ledgerPath && fs.existsSync(ledgerPath)),
      viewPath: viewPath || null,
      viewExists: !!(viewPath && fs.existsSync(viewPath)),
      mainViewPath: mainPath,
      mainViewExists: !!(mainPath && fs.existsSync(mainPath)),
      worktreeViewPath: worktreePath,
      worktreeViewExists: !!(worktreePath && fs.existsSync(worktreePath)),
    },
    view: {
      available: !!view,
      branch,
      ledgerSeq: meta?.ledger_seq ?? null,
      builtAt: meta?.built_at ?? null,
      current: !!freshness.current,
      headSeq: freshness.headSeq ?? ledgerHead,
      reason: freshness.reason || null,
    },
    ledger: {
      available: !!ledger,
      branch,
      headSeq: ledgerHead,
      counts: params.includeCounts && ledger ? ledgerCounts(ledger) : undefined,
    },
    policy: params.includePolicy
      ? getEffectivePolicy(ledger, repoId || params.repoId || "default")
      : undefined,
    warnings,
  };
  return okEnvelope({ action: "info", versionId, data });
}

function ledgerPathOf(ledger) {
  try {
    return typeof /** @type {any} */ (ledger)?._dbPath === "function"
      ? /** @type {any} */ (ledger)._dbPath()
      : null;
  } catch {
    return null;
  }
}

async function safeViewMeta(view) {
  try {
    return typeof /** @type {any} */ (view)?.meta === "function"
      ? await /** @type {any} */ (view).meta()
      : null;
  } catch {
    return null;
  }
}

function safeHeadSeq(ledger, branch) {
  try {
    return Number(/** @type {any} */ (ledger).headSeq(branch));
  } catch {
    return null;
  }
}

function ledgerCounts(ledger) {
  const db = typeof /** @type {any} */ (ledger)?._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
  if (!db) return null;
  return {
    branches: count(db, "branches"),
    symbolDeltas: count(db, "symbol_deltas"),
    feedbackSignals: count(db, "feedback_signals"),
    memories: count(db, "memories"),
    usageEvents: count(db, "usage_events"),
    policies: count(db, "atlas_policy"),
  };
}

function count(db, table) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return Number(row?.count || 0);
  } catch {
    return 0;
  }
}
