// @ts-check
//
// Public native `scip.ingest` action. The actual compiler-index ingestion
// pipeline already lives in ../scip; this file makes it available through the
// ATLAS v2 dispatcher without going through the original ATLAS server.

import fs from "fs";
import path from "path";
import { View } from "../../../classes/v2/View.js";
import { ViewBuilder } from "../../../classes/v2/ViewBuilder.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { decodeScipIndex } from "../scip/decode.js";
import { buildScipIndexCache } from "../scip/cache.js";
import { ingestScipFile } from "../scip/ingester.js";
import { mainViewPath } from "../runtime-paths.js";
import { openViewWithMeta, removeSqliteFile } from "../view-health.js";
import { cleanBranchName } from "./version.js";
import { runSqliteWrite } from "../../../../../shared/concurrency/functions/sqlite-gate.js";
import { invalidateStorageCacheNativeAsync } from "../native/storage.js";

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").ScipIngestParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoRoot?: string,
 * }} args
 */
export async function scipIngest({ versionId, params, ledger, repoRoot }) {
  if (!ledger) {
    return errorEnvelope({
      action: "scip.ingest",
      versionId,
      code: "ledger_unavailable",
      message: "scip.ingest requires a ledger-backed ATLAS context",
    });
  }
  const root = repoRoot ? path.resolve(repoRoot) : "";
  if (!root) {
    return errorEnvelope({
      action: "scip.ingest",
      versionId,
      code: "missing_repo_root",
      message: "scip.ingest requires dispatch context repoRoot",
    });
  }
  const scipPath = resolveScipPath(root, params.indexPath);
  if (!scipPath) {
    return errorEnvelope({
      action: "scip.ingest",
      versionId,
      code: "invalid_path",
      message: "scip.ingest indexPath must be absolute or relative to the repository root and must not escape the repository",
    });
  }
  if (!fs.existsSync(scipPath)) {
    return errorEnvelope({
      action: "scip.ingest",
      versionId,
      code: "not_found",
      message: `SCIP index not found: ${params.indexPath}`,
    });
  }

  const dryRun = params.dryRun === true;
  if (dryRun) {
    try {
      const bytes = await fs.promises.readFile(scipPath);
      const index = decodeScipIndex(bytes);
      const cache = buildScipIndexCache(index);
      return okEnvelope({
        action: "scip.ingest",
        versionId,
        data: {
          dryRun: true,
          indexPath: scipPath,
          documents: index.documents.length,
          occurrences: countOccurrences(index),
          externalSymbols: index.external_symbols.length,
          filesetHash: cache.filesetHash(),
          toolName: index.metadata.tool_info.name || null,
          indexerVersion: index.metadata.tool_info.version || null,
        },
      });
    } catch (err) {
      return errorEnvelope({
        action: "scip.ingest",
        versionId,
        code: "decode_failed",
        message: err?.message || String(err),
      });
    }
  }

  const branch = resolveScipIngestBranch({
    explicitBranch: params.branch,
    ledger,
    repoRoot: root,
  });
  try {
    if (typeof /** @type {any} */ (ledger).ensureRootBranch === "function" && !ledger.getBranch(branch)) {
      await /** @type {any} */ (ledger).ensureRootBranch(branch);
    }
    const events = [];
    const result = await ingestScipFile({
      ledger: /** @type {any} */ (ledger),
      scipPath,
      repoRoot: root,
      branch,
      appendLedgerEntries: true,
      force: params.force === true,
      layerOnly: true,
      onEvent: (event) => events.push(event),
    });
    const headSeq = typeof /** @type {any} */ (ledger).headSeq === "function"
      ? /** @type {any} */ (ledger).headSeq(branch)
      : null;
    let viewPath = null;
    const rebuiltView = result.skipped !== true && headSeq != null;
    if (rebuiltView) {
      viewPath = mainViewPath(root);
      await runSqliteWrite(viewPath, async () => {
        await invalidateStorageCacheNativeAsync([viewPath]);
        removeSqliteFile(viewPath);
        return await new ViewBuilder().buildFrom({
          ledger: /** @type {any} */ (ledger),
          branch,
          atSeq: headSeq,
          outPath: viewPath,
          options: { repoRoot: root, layerMerge: true },
        });
      }, { label: "scip.ingest.rebuildView" });
    }
    return okEnvelope({
      action: "scip.ingest",
      versionId: headSeq == null ? versionId : `${branch}@${headSeq}`,
      data: {
        ...result,
        branch,
        versionId: headSeq == null ? versionId : `${branch}@${headSeq}`,
        indexPath: scipPath,
        viewPath,
        events,
        rebuiltView,
      },
    });
  } catch (err) {
    return errorEnvelope({
      action: "scip.ingest",
      versionId,
      code: "ingest_failed",
      message: err?.message || String(err),
    });
  }
}

function resolveScipPath(repoRoot, indexPath) {
  const raw = String(indexPath || "").trim();
  if (!raw) return "";
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw);
  const root = path.resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) return "";
  return abs;
}

function countOccurrences(index) {
  return (index.documents || []).reduce((sum, doc) => sum + (Array.isArray(doc.occurrences) ? doc.occurrences.length : 0), 0);
}

/**
 * scip.ingest historically accepted any dispatch versionId and rebuilt the
 * main view on that branch. A stale bootstrap context such as init@0 could
 * therefore replace a populated view with an empty one. Keep implicit ingest
 * targeting anchored to the current view (when usable) or main; callers that
 * need another branch must pass params.branch explicitly.
 *
 * @param {{ explicitBranch?: string, ledger: any, repoRoot: string }} args
 */
function resolveScipIngestBranch({ explicitBranch, ledger, repoRoot }) {
  const explicit = cleanBranchName(explicitBranch);
  if (explicit) return explicit;

  const viewBranch = currentViewBranch({ repoRoot, ledger });
  if (viewBranch) return viewBranch;

  return "main";
}

/**
 * @param {{ repoRoot: string, ledger: any }} args
 * @returns {string | null}
 */
function currentViewBranch({ repoRoot, ledger }) {
  const probe = openViewWithMeta(mainViewPath(repoRoot), View);
  if (!probe.ok) return null;
  try {
    const branch = cleanBranchName(probe.meta?.branch);
    const ledgerSeq = Number(probe.meta?.ledger_seq);
    if (!branch || ledgerSeq <= 0) return null;
    const ledgerAny = /** @type {any} */ (ledger);
    if (typeof ledgerAny.getBranch === "function" && !ledgerAny.getBranch(branch)) {
      return null;
    }
    return branch;
  } finally {
    try { probe.view?.close?.(); } catch { /* ignore probe cleanup */ }
  }
}
