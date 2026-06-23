// @ts-check
//
// ATLAS v2 runtime path helpers. Single source of truth for where the
// ledger DB, view files, and worktree-mounted views live. Consumers in
// other modules should call these helpers rather than hardcoding paths.
//
// Layout (under a given repo root):
//
//   <repoRoot>/.posse/atlas/
//     ledger.db                                  -- single source of truth
//     memory.db                                  -- durable ATLAS memories
//     views/
//       main.view.db                             -- always-warm main view
//       warmed/
//         wi-{id}.view.db                        -- pre-warmed for upcoming dev jobs
//
//   <worktreePath>/.posse/atlas/
//     view.db                                    -- the view the worker mounts

import path from "path";

const ATLAS_DIR = ".posse/atlas";

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function atlasDir(repoRoot) {
  return path.join(repoRoot, ATLAS_DIR);
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function ledgerDbPath(repoRoot) {
  return path.join(atlasDir(repoRoot), "ledger.db");
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function memoryDbPath(repoRoot) {
  return path.join(atlasDir(repoRoot), "memory.db");
}

/**
 * @param {string} ledgerPath
 * @returns {string}
 */
export function memoryDbPathForLedgerDb(ledgerPath) {
  return ledgerPath ? path.join(path.dirname(ledgerPath), "memory.db") : "";
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function viewsDir(repoRoot) {
  return path.join(atlasDir(repoRoot), "views");
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function mainViewPath(repoRoot) {
  return path.join(viewsDir(repoRoot), "main.view.db");
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function warmedViewsDir(repoRoot) {
  return path.join(viewsDir(repoRoot), "warmed");
}

/**
 * @param {string} repoRoot
 * @param {number | string} workItemId
 * @returns {string}
 */
export function warmedViewPath(repoRoot, workItemId) {
  return path.join(warmedViewsDir(repoRoot), `wi-${workItemId}.view.db`);
}

/**
 * @param {string} worktreePath
 * @returns {string}
 */
export function worktreeViewPath(worktreePath) {
  return path.join(worktreePath, ATLAS_DIR, "view.db");
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function embeddingsRoot(repoRoot) {
  return path.join(atlasDir(repoRoot), "embeddings");
}

/**
 * Convention for the ledger branch name that posse's WI branches map to.
 * Mirrors the posse branch name `posse/wi-{id}-{slug}` but the ledger
 * doesn't care about slugs — only WI identity. Workstream E uses this
 * helper at fork time so the ledger branch and the git branch can be
 * cross-referenced.
 *
 * @param {number | string} workItemId
 * @returns {string}
 */
export function ledgerBranchForWi(workItemId) {
  return `wi-${workItemId}`;
}
