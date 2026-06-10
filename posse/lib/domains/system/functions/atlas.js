// @ts-check
//
// System-owned Atlas Parse mutation surface. Agent-facing ATLAS tools should
// call retrieval/status handlers only; boot, write, handoff, merge, and admin
// code can import this module directly.

import process from "process";
import path from "path";
import { Ledger } from "../../atlas/classes/v2/Ledger.js";
import { ParseEngine } from "../../atlas/classes/v2/ParseEngine.js";
import { ViewBuilder } from "../../atlas/classes/v2/ViewBuilder.js";
import { ledgerDbPath, mainViewPath, warmedViewPath } from "../../atlas/functions/v2/runtime-paths.js";
import { sharedParserAdapter } from "../../atlas/functions/v2/parser/adapter.js";
import { ingestScipFile } from "../../atlas/functions/v2/scip/ingester.js";
import { resolveTargetBranch } from "../../git/functions/target-branch.js";

/**
 * @typedef {Object} AtlasSystemBase
 * @property {string} reason
 * @property {string} [repoRoot]
 * @property {string} [branch]
 * @property {unknown} [ledger]
 * @property {Record<string, unknown>} [config]
 * @property {(event: Record<string, unknown>) => void} [onProgress]
 */

function resolveRepoRoot(repoRoot) {
  return path.resolve(String(repoRoot || process.cwd()));
}

function defaultBranchFor(repoRoot, branch) {
  const explicit = String(branch || "").trim();
  if (explicit) return explicit;
  try {
    return resolveTargetBranch(repoRoot);
  } catch {
    return "main";
  }
}

/**
 * @param {AtlasSystemBase} opts
 * @returns {{ repoRoot: string, branch: string, ledger: Ledger, engine: ParseEngine, closeLedger: () => void }}
 */
function openEngine(opts) {
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const branch = defaultBranchFor(repoRoot, opts.branch);
  const ownsLedger = !opts.ledger;
  const ledger = /** @type {Ledger} */ (opts.ledger || Ledger.open({ dbPath: ledgerDbPath(repoRoot) }));
  if (typeof ledger.ensureRootBranch === "function" && !ledger.getBranch(branch)) {
    ledger.ensureRootBranch(branch);
  }
  const engine = new ParseEngine({
    ledger,
    viewBuilder: new ViewBuilder(),
    parserAdapter: sharedParserAdapter,
    repoRoot,
    defaultBranch: branch,
    config: opts.config || {},
    onProgress: opts.onProgress,
  });
  return {
    repoRoot,
    branch,
    ledger,
    engine,
    closeLedger: () => {
      if (ownsLedger) ledger.close();
    },
  };
}

/**
 * Refresh Atlas parse storage and the query view for a repo.
 *
 * @param {AtlasSystemBase & {
 *   mode?: "smart" | "incremental" | "full",
 *   paths?: string[],
 *   wait?: boolean,
 * }} opts
 */
export async function refresh(opts) {
  const paths = Array.isArray(opts?.paths) ? opts.paths.map((p) => String(p)) : [];
  const requestedMode = opts?.mode || "smart";
  const mode = requestedMode === "incremental" || (requestedMode === "smart" && paths.length > 0)
    ? "incremental"
    : "full";
  const { repoRoot, branch, ledger, engine, closeLedger } = openEngine(opts);
  try {
    const warmResult = await engine.handleWarmJob({
      purpose: mode === "incremental" ? "main-incremental" : "main-full",
      branch,
      paths,
      trigger_event: `system.atlas.refresh:${opts.reason || "unspecified"}`,
      out_view_path: mainViewPath(repoRoot),
    });
    return {
      ok: true,
      operation: "refresh",
      reason: String(opts.reason || "unspecified"),
      repoRoot,
      branch,
      mode,
      paths,
      wait: opts.wait !== false,
      detached: false,
      versionId: `${branch}@${ledger.headSeq(branch)}`,
      viewPath: warmResult.view_written || mainViewPath(repoRoot),
      warmResult,
    };
  } finally {
    closeLedger();
  }
}

/**
 * Parse a handoff or scoped branch. WI parses produce the warmed WI view.
 *
 * @param {AtlasSystemBase & {
 *   scope?: { paths?: string[] } | string[] | null,
 *   workItemId?: number | string | null,
 *   waitFor?: "indexed" | "enriched" | "semantic_current",
 * }} opts
 */
export async function parse(opts) {
  const scopePaths = Array.isArray(opts?.scope)
    ? opts.scope
    : Array.isArray(opts?.scope?.paths)
      ? opts.scope.paths
      : [];
  const paths = scopePaths.map((p) => String(p));
  const { repoRoot, branch, ledger, engine, closeLedger } = openEngine(opts);
  try {
    const workItemId = opts.workItemId == null ? null : Number(opts.workItemId);
    const warmResult = await engine.handleWarmJob({
      purpose: workItemId != null && Number.isFinite(workItemId) ? "wi" : (paths.length > 0 ? "main-incremental" : "main-full"),
      branch,
      paths,
      work_item_id: workItemId,
      trigger_event: `system.atlas.parse:${opts.reason || "unspecified"}`,
      ...(workItemId != null && Number.isFinite(workItemId)
        ? { out_view_path: warmedViewPath(repoRoot, workItemId) }
        : { out_view_path: mainViewPath(repoRoot) }),
    });
    return {
      ok: true,
      operation: "parse",
      reason: String(opts.reason || "unspecified"),
      repoRoot,
      branch,
      paths,
      waitFor: opts.waitFor || "indexed",
      versionId: `${branch}@${ledger.headSeq(branch)}`,
      viewPath: warmResult.view_written || null,
      warmResult,
    };
  } finally {
    closeLedger();
  }
}

/**
 * @param {AtlasSystemBase & { lang?: string, wait?: boolean, force?: boolean }} opts
 */
export async function stageScip(opts) {
  const { repoRoot, branch, ledger, engine, closeLedger } = openEngine(opts);
  try {
    const warmResult = await engine.handleWarmJob({
      purpose: "scip-restage",
      branch,
      language: opts.lang,
      force: opts.force === true,
      trigger_event: `system.atlas.stageScip:${opts.reason || "unspecified"}`,
    });
    return {
      ok: true,
      operation: "stageScip",
      reason: String(opts.reason || "unspecified"),
      repoRoot,
      branch,
      lang: opts.lang || null,
      wait: opts.wait !== false,
      detached: false,
      versionId: `${branch}@${ledger.headSeq(branch)}`,
      warmResult,
    };
  } finally {
    closeLedger();
  }
}

/**
 * @param {AtlasSystemBase & { stagedPath?: string, lang?: string }} opts
 */
export async function ingestScip(opts) {
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const stagedPath = opts.stagedPath
    ? path.resolve(repoRoot, String(opts.stagedPath))
    : "";
  if (!stagedPath) throw new TypeError("system.atlas.ingestScip: stagedPath is required");
  const { branch, ledger, closeLedger } = openEngine({ ...opts, repoRoot });
  try {
    const result = await ingestScipFile({
      ledger,
      scipPath: stagedPath,
      repoRoot,
      branch,
      onEvent: opts.onProgress,
    });
    return {
      ok: true,
      operation: "ingestScip",
      reason: String(opts.reason || "unspecified"),
      repoRoot,
      branch,
      lang: opts.lang || null,
      stagedPath,
      versionId: `${branch}@${ledger.headSeq(branch)}`,
      result,
    };
  } finally {
    closeLedger();
  }
}

/**
 * @param {AtlasSystemBase & { workItemId?: number | string, ontoBranch?: string }} opts
 */
export async function merge(opts) {
  const { repoRoot, branch, ledger, engine, closeLedger } = openEngine(opts);
  try {
    const warmResult = await engine.handleWarmJob({
      purpose: "main-merge",
      branch,
      work_item_id: opts.workItemId == null ? null : Number(opts.workItemId),
      onto_branch: opts.ontoBranch || defaultBranchFor(repoRoot, null),
      trigger_event: `system.atlas.merge:${opts.reason || "unspecified"}`,
      out_view_path: mainViewPath(repoRoot),
    });
    return {
      ok: true,
      operation: "merge",
      reason: String(opts.reason || "unspecified"),
      repoRoot,
      branch,
      versionId: `${branch}@${ledger.headSeq(branch)}`,
      warmResult,
    };
  } finally {
    closeLedger();
  }
}

/**
 * ONNX indexing is wired in later phases; expose the system contract now so
 * callers can depend on the ownership boundary without gaining an agent tool.
 *
 * @param {AtlasSystemBase & { mode?: string, symbols?: string[], wait?: boolean }} opts
 */
export async function onnxRefresh(opts) {
  return {
    ok: true,
    operation: "onnxRefresh",
    reason: String(opts.reason || "unspecified"),
    repoRoot: resolveRepoRoot(opts.repoRoot),
    branch: defaultBranchFor(resolveRepoRoot(opts.repoRoot), opts.branch),
    mode: opts.mode || "changed",
    symbols: Array.isArray(opts.symbols) ? opts.symbols : [],
    wait: opts.wait === true,
    queued: true,
    status: "background_pending",
  };
}

/**
 * @param {AtlasSystemBase & { target?: string, workItemId?: number | string }} opts
 */
export async function rebuild(opts) {
  return refresh({
    ...opts,
    mode: "full",
    reason: opts.reason || `rebuild:${opts.target || "atlas"}`,
    wait: true,
  });
}

/**
 * @param {AtlasSystemBase & { target?: string }} opts
 */
export async function purge(opts) {
  throw new Error(`system.atlas.purge is not implemented for target '${opts.target || "unknown"}'`);
}
