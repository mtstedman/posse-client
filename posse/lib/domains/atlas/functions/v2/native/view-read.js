// @ts-check

import { runAtlasNativeMethodAsync } from "./invoke.js";
import { patchViewMetaNativeAsync } from "./storage.js";
import { openViewDbReadOnly } from "../view-database.js";

const CONTRACT_VERSION = 1;
const UNIT_QUERIES = new Set(["meta", "stats", "edge_stats", "symbol_metrics", "edge_taxonomy_input"]);
const RESULT_BY_QUERY = Object.freeze({
  meta: "meta",
  stats: "stats",
  edge_stats: "edge_stats",
  symbol_metrics: "symbol_metrics",
  edge_taxonomy_input: "edge_taxonomy_input",
  find_symbol: "symbols",
  get_symbol: "symbol",
  symbols_in_file: "symbols",
  callers: "edges",
  callees: "edges",
  symbol_neighborhood: "symbol_neighborhood",
  unresolved_references_to: "edges",
  slice: "slice",
  blast_radius: "ranked_symbols",
  get_by_content_local: "symbol",
  has_content_hash: "boolean",
  content_hash_for_path: "string",
  has_snapshot_content_hash: "boolean",
  indexed_paths: "paths",
  indexed_paths_with_symbols: "paths",
  all_symbols: "symbols",
});

/**
 * Execute one bounded Rust-owned view read through the persistent worker and
 * return its tagged result value. Node intentionally does not inspect or
 * query the SQLite database here.
 *
 * @param {string} viewPath
 * @param {string} query
 * @param {Record<string, unknown>} [params]
 * @returns {Promise<any>}
 */
export async function runNativeViewRead(viewPath, query, params = {}) {
  const payload = {
    contract_version: CONTRACT_VERSION,
    view_path: viewPath,
    query,
    ...(!UNIT_QUERIES.has(query) ? { params } : {}),
  };
  let response;
  try {
    response = /** @type {any} */ (await runAtlasNativeMethodAsync("view-read", payload));
  } catch (error) {
    if (!await repairNativeViewMigration(viewPath, error)) throw error;
    response = /** @type {any} */ (await runAtlasNativeMethodAsync("view-read", payload));
  }
  if (!response || response.contract_version !== CONTRACT_VERSION || typeof response.result !== "string") {
    throw new Error(`ATLAS view-read returned an invalid ${query} contract`);
  }
  if (RESULT_BY_QUERY[query] !== response.result || typeof response.truncated !== "boolean") {
    throw new Error(`ATLAS view-read returned ${response.result} for ${query}`);
  }
  return response;
}

/** @param {unknown} error */
export function nativeViewMigrationRequired(error) {
  return /ATLAS view database requires a write-mode migration from schema version \d+/u
    .test(String(/** @type {any} */ (error)?.message || error || ""));
}

/**
 * Repair the one read-time failure that is deterministic and uniquely safe to
 * recover: an older compatible view schema whose authoritative metadata can
 * be preserved while the native writer applies its idempotent migration.
 * Native-complete tools use this helper too because they bypass view-read.
 *
 * @param {string | null | undefined} viewPath
 * @param {unknown} error
 * @returns {Promise<boolean>} true when a migration was applied
 */
export async function repairNativeViewMigration(viewPath, error) {
  if (!viewPath || !nativeViewMigrationRequired(error)) return false;
  await patchViewMetaNativeAsync(viewPath, readViewMetaForNativeMigration(viewPath));
  return true;
}

/** @param {string} viewPath */
function readViewMetaForNativeMigration(viewPath) {
  const db = openViewDbReadOnly(viewPath);
  try {
    const rows = /** @type {Array<{ key: string, value: string | null }>} */ (
      db.prepare("SELECT key, value FROM meta").all()
    );
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const branch = String(values.branch || "");
    const parentBranch = values.parent_branch == null || values.parent_branch === ""
      ? null
      : String(values.parent_branch);
    const parentSeq = values.parent_seq == null || values.parent_seq === ""
      ? null
      : Number(values.parent_seq);
    const ledgerSeq = values.ledger_seq == null || values.ledger_seq === ""
      ? Number.NaN
      : Number(values.ledger_seq);
    const builtAt = values.built_at == null ? "" : String(values.built_at);
    if (!branch || branch.trim() !== branch || !Number.isInteger(ledgerSeq) || ledgerSeq < 0 || !builtAt.trim()) {
      throw new Error("ATLAS view migration recovery found invalid view metadata");
    }
    if (
      (parentBranch == null) !== (parentSeq == null)
      || (parentBranch != null && (!parentBranch.trim() || parentBranch.trim() !== parentBranch || parentBranch === branch))
      || (parentSeq != null && (!Number.isInteger(parentSeq) || parentSeq < 0))
    ) {
      throw new Error("ATLAS view migration recovery found invalid parent metadata");
    }
    return {
      branch,
      parent_branch: parentBranch,
      parent_seq: parentSeq,
      ledger_seq: ledgerSeq,
      built_at: builtAt,
    };
  } finally {
    db.close();
  }
}

/** @param {Array<{ symbol: any, score: number }>} entries @param {string} property */
export function restoreRankedSymbols(entries, property) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const symbol = entry?.symbol;
    if (!symbol || typeof symbol !== "object") return null;
    Object.defineProperty(symbol, property, {
      value: Number(entry.score) || 0,
      enumerable: false,
      configurable: true,
    });
    return symbol;
  }).filter(Boolean);
}
