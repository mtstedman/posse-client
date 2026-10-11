import { parseJsonArray, parseJsonObject } from "./derived-state-helpers.js";

// The caller supplies its existing path policy. Compression and tree import
// intentionally normalize stored paths differently.
export function readTreeScopeNodes(db, { normalizePath, hasTable = (_database, _name) => true }) {
  if (!hasTable(db, "atlas_tree_scope_nodes")) return [];
  return db.prepare(
    `SELECT node_id AS nodeId, parent_node_id AS parentNodeId, kind, label,
            repo_rel_path AS repoRelPath, depth, sort_order AS sortOrder,
            descendant_symbol_count AS descendantSymbolCount,
            descendant_file_count AS descendantFileCount,
            generated, test, config,
            aggregates_json AS aggregatesJson, terms_json AS termsJson,
            projected_terms_json AS projectedTermsJson
     FROM atlas_tree_scope_nodes
     ORDER BY depth ASC, sort_order ASC, node_id ASC`,
  ).all().map((row) => ({
    nodeId: String(row.nodeId || ""),
    parentNodeId: row.parentNodeId ? String(row.parentNodeId) : null,
    kind: String(row.kind || ""),
    label: String(row.label || ""),
    repoRelPath: normalizePath(row.repoRelPath),
    depth: Number(row.depth || 0),
    sortOrder: Number(row.sortOrder || 0),
    descendantSymbolCount: Number(row.descendantSymbolCount || 0),
    descendantFileCount: Number(row.descendantFileCount || 0),
    generated: Number(row.generated || 0) > 0,
    test: Number(row.test || 0) > 0,
    config: Number(row.config || 0) > 0,
    aggregates: parseJsonObject(row.aggregatesJson),
    terms: parseJsonArray(row.termsJson).map(String),
    projectedTerms: parseJsonArray(row.projectedTermsJson).map(String),
  }));
}

export function readTreeScopeSymbolFiles(db, { normalizePath, hasTable = (_database, _name) => true }) {
  if (!hasTable(db, "atlas_tree_scope_symbol_files")) return [];
  return db.prepare(
    `SELECT symbol_ref AS symbolRef, symbol_node_id AS symbolNodeId,
            file_node_id AS fileNodeId, repo_rel_path AS repoRelPath
     FROM atlas_tree_scope_symbol_files
     ORDER BY repo_rel_path ASC, symbol_ref ASC, symbol_node_id ASC`,
  ).all().map((row) => ({
    symbolRef: String(row.symbolRef || ""),
    symbolNodeId: String(row.symbolNodeId || ""),
    fileNodeId: String(row.fileNodeId || ""),
    repoRelPath: normalizePath(row.repoRelPath),
  }));
}
