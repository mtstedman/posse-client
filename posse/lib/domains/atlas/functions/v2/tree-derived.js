// @ts-check
//
// Rebuildable tree-derived state for ATLAS view DBs. Tree construction is owned
// by the posse-atlas binary; this module reads the view rows it needs and
// persists the returned tree tables.

import { sha256Hex } from "./hash.js";
import { normalizeRepoPath } from "./paths.js";
import { runAtlasNativeMethod } from "./native/invoke.js";

const TREE_RUN_KIND = "tree-derived";

/**
 * @param {import("better-sqlite3").Database} db
 */
export function ensureTreeDerivedTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS atlas_tree_nodes (
      node_id                 TEXT PRIMARY KEY,
      parent_node_id          TEXT,
      kind                    TEXT NOT NULL,
      label                   TEXT NOT NULL,
      stable_ref              TEXT NOT NULL,
      repo_rel_path           TEXT,
      symbol_ref              TEXT,
      -- Convenience FK; view-local. Use symbol_ref / node_id for stable identity.
      symbol_global_id        INTEGER,
      depth                   INTEGER NOT NULL DEFAULT 0,
      sort_order              INTEGER NOT NULL DEFAULT 0,
      child_count             INTEGER NOT NULL DEFAULT 0,
      descendant_symbol_count INTEGER NOT NULL DEFAULT 0,
      descendant_file_count   INTEGER NOT NULL DEFAULT 0,
      aggregates_json         TEXT NOT NULL DEFAULT '{}',
      terms_json              TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (parent_node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_nodes_parent
      ON atlas_tree_nodes(parent_node_id);
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_nodes_path
      ON atlas_tree_nodes(repo_rel_path)
      WHERE repo_rel_path IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_nodes_symbol
      ON atlas_tree_nodes(symbol_global_id)
      WHERE symbol_global_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_nodes_symbol_ref
      ON atlas_tree_nodes(symbol_ref)
      WHERE symbol_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_nodes_kind
      ON atlas_tree_nodes(kind);

    CREATE TABLE IF NOT EXISTS atlas_tree_refs (
      node_id  TEXT NOT NULL,
      ref_type TEXT NOT NULL,
      ref_id   TEXT NOT NULL,
      weight   REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (node_id, ref_type, ref_id),
      FOREIGN KEY (node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_refs_ref
      ON atlas_tree_refs(ref_type, ref_id);

    CREATE TABLE IF NOT EXISTS atlas_tree_scope_nodes (
      node_id                 TEXT PRIMARY KEY,
      parent_node_id          TEXT,
      kind                    TEXT NOT NULL,
      label                   TEXT NOT NULL,
      repo_rel_path           TEXT NOT NULL,
      depth                   INTEGER NOT NULL DEFAULT 0,
      sort_order              INTEGER NOT NULL DEFAULT 0,
      descendant_symbol_count INTEGER NOT NULL DEFAULT 0,
      descendant_file_count   INTEGER NOT NULL DEFAULT 0,
      generated               INTEGER NOT NULL DEFAULT 0,
      test                    INTEGER NOT NULL DEFAULT 0,
      config                  INTEGER NOT NULL DEFAULT 0,
      aggregates_json         TEXT NOT NULL DEFAULT '{}',
      terms_json              TEXT NOT NULL DEFAULT '[]',
      projected_terms_json    TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (parent_node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_nodes_path
      ON atlas_tree_scope_nodes(repo_rel_path);
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_nodes_parent
      ON atlas_tree_scope_nodes(parent_node_id);
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_nodes_kind
      ON atlas_tree_scope_nodes(kind);

    CREATE TABLE IF NOT EXISTS atlas_tree_scope_term_stats (
      term                 TEXT PRIMARY KEY,
      direct_file_count    INTEGER NOT NULL DEFAULT 0,
      projected_file_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS atlas_tree_scope_symbol_files (
      symbol_ref     TEXT NOT NULL,
      symbol_node_id TEXT NOT NULL,
      file_node_id   TEXT NOT NULL,
      repo_rel_path  TEXT NOT NULL,
      PRIMARY KEY (symbol_ref, symbol_node_id),
      FOREIGN KEY (symbol_node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (file_node_id) REFERENCES atlas_tree_scope_nodes(node_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_symbol_files_node
      ON atlas_tree_scope_symbol_files(symbol_node_id);

    CREATE TABLE IF NOT EXISTS derived_state_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      built_at     TEXT NOT NULL,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
}

/**
 * Hash only the rows used by the tree-derived cache. The signature is stable
 * across rebuilds because it uses path + content_hash/local_id refs rather
 * than view-local global_id values.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {string | null}
 */
export function treeDerivedInputSignature(db) {
  try {
    const symbols = db.prepare(
      `SELECT s.content_hash AS contentHash, s.local_id AS localId, s.kind, s.name,
              s.qualified_name AS qualifiedName, s.repo_rel_path AS repoRelPath,
              parent.content_hash AS parentContentHash, parent.local_id AS parentLocalId,
              parent.repo_rel_path AS parentRepoRelPath
       FROM symbols s
       LEFT JOIN symbols parent ON parent.global_id = s.parent_global_id
       ORDER BY s.repo_rel_path, s.content_hash, s.local_id`,
    ).all();
    const paths = db.prepare(
      `SELECT repo_rel_path AS repoRelPath, content_hash AS contentHash
       FROM path_to_blob
       ORDER BY repo_rel_path`,
    ).all();
    const centrality = tableExists(db, "symbol_centrality")
      ? db.prepare(
        `SELECT s.content_hash AS contentHash, s.local_id AS localId,
                s.repo_rel_path AS repoRelPath,
                c.fan_in AS fanIn, c.fan_out AS fanOut,
                c.call_fan_in AS callFanIn, c.call_fan_out AS callFanOut, c.score
         FROM symbol_centrality c
         JOIN symbols s ON s.global_id = c.symbol_global_id
         ORDER BY s.repo_rel_path, s.content_hash, s.local_id`,
      ).all()
      : [];
    const clusters = tableExists(db, "symbol_clusters")
      ? db.prepare(
        `SELECT s.content_hash AS contentHash, s.local_id AS localId,
                s.repo_rel_path AS repoRelPath, sc.cluster_id AS clusterId, sc.membership_score AS membershipScore
         FROM symbol_clusters sc
         JOIN symbols s ON s.global_id = sc.symbol_global_id
         ORDER BY s.repo_rel_path, s.content_hash, s.local_id, sc.cluster_id`,
      ).all()
      : [];
    const processes = tableExists(db, "process_steps")
      ? db.prepare(
        `SELECT s.content_hash AS contentHash, s.local_id AS localId,
                s.repo_rel_path AS repoRelPath, ps.process_id AS processId, ps.depth
         FROM process_steps ps
         JOIN symbols s ON s.global_id = ps.symbol_global_id
         ORDER BY s.repo_rel_path, s.content_hash, s.local_id, ps.process_id`,
      ).all()
      : [];
    return sha256Hex(JSON.stringify({ symbols, paths, centrality, clusters, processes }));
  } catch {
    return null;
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @returns {{ ok: boolean, durationMs: number, nodes: number, refs: number, files: number, symbols: number, error?: string }}
 */
export function refreshTreeDerivedState(db) {
  ensureTreeDerivedTables(db);
  const started = Date.now();
  db.exec("SAVEPOINT tree_derived_refresh");
  try {
    clearTreeTables(db);
    const request = readTreeBuildRequest(db);
    const tree = /** @type {any} */ (runAtlasNativeMethod("tree-build", request));
    validateNativeTree(tree, { symbolCount: request.symbols.length });
    const counts = writeTreeBuildResult(db, tree);
    const durationMs = Date.now() - started;
    recordRun(db, TREE_RUN_KIND, "ok", durationMs, {
      nodes: counts.nodes,
      refs: counts.refs,
      scopeNodes: counts.scopeNodes,
      scopeTermStats: counts.termStats,
      scopeSymbols: counts.symbolFiles,
      files: request.paths.length,
      symbols: request.symbols.length,
    });
    db.exec("RELEASE tree_derived_refresh");
    return {
      ok: true,
      durationMs,
      nodes: counts.nodes,
      refs: counts.refs,
      files: request.paths.length,
      symbols: request.symbols.length,
    };
  } catch (err) {
    rollbackSavepoint(db, "tree_derived_refresh");
    const durationMs = Date.now() - started;
    recordRun(db, TREE_RUN_KIND, "error", durationMs, { error: err?.message || String(err) });
    return {
      ok: false,
      durationMs,
      nodes: 0,
      refs: 0,
      files: 0,
      symbols: 0,
      error: err?.message || String(err),
    };
  }
}

/**
 * Sanity-check the native tree-build result before persisting it: a malformed
 * tree (missing root, dangling parents, wrong symbol node count, refs pointing
 * at unknown nodes) fails the refresh loudly instead of poisoning the tables.
 *
 * @param {any} tree
 * @param {{ symbolCount: number }} expected
 */
function validateNativeTree(tree, expected) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const byId = new Map(nodes.map((node) => [String(node.nodeId || ""), node]));
  if (!byId.has("root")) throw new Error("tree-derived: missing root node");
  let rootCount = 0;
  let symbolCount = 0;
  for (const node of nodes) {
    if (!node.parentNodeId) rootCount += 1;
    if (node.symbolRef) symbolCount += 1;
    if (node.nodeId !== "root" && !node.parentNodeId) {
      throw new Error(`tree-derived: non-root node has no parent: ${node.nodeId}`);
    }
    if (node.parentNodeId && !byId.has(node.parentNodeId)) {
      throw new Error(`tree-derived: missing parent ${node.parentNodeId} for ${node.nodeId}`);
    }
  }
  if (rootCount !== 1) throw new Error(`tree-derived: expected one root, got ${rootCount}`);
  if (symbolCount !== expected.symbolCount) {
    throw new Error(`tree-derived: expected ${expected.symbolCount} symbol nodes, got ${symbolCount}`);
  }
  for (const ref of Array.isArray(tree?.refs) ? tree.refs : []) {
    if (!byId.has(ref.nodeId)) throw new Error(`tree-derived: ref target missing: ${ref.nodeId}`);
  }
}

/**
 * Read the persisted tree tables into the Rust TreeBuildResult shape.
 *
 * `opts.for` trims the payload to what the native route actually reads —
 * every call pipes this whole object into a spawned process, so unused
 * sections are pure serialization cost:
 * - "traversal": tree-overview/tree-walk touch only nodes + refs.
 * - "scope": tree-scope touches the scope sidecar + refs; full nodes are only
 *   needed for its hot fallback, i.e. when the sidecar is empty.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ for?: "traversal" | "scope" | "full" }} [opts]
 */
export function readTreeBuildResult(db, opts = {}) {
  const kind = opts.for || "full";
  if (kind === "traversal") {
    return {
      nodes: readTreeNodes(db),
      refs: readTreeRefs(db),
      scopeNodes: [],
      termStats: [],
      symbolFiles: [],
    };
  }
  if (kind === "scope") {
    const scopeNodes = readTreeScopeNodes(db);
    return {
      nodes: scopeNodes.length > 0 ? [] : readTreeNodes(db),
      refs: readTreeRefs(db),
      scopeNodes,
      termStats: readTreeScopeTermStats(db),
      symbolFiles: readTreeScopeSymbolFiles(db),
    };
  }
  return {
    nodes: readTreeNodes(db),
    refs: readTreeRefs(db),
    scopeNodes: readTreeScopeNodes(db),
    termStats: readTreeScopeTermStats(db),
    symbolFiles: readTreeScopeSymbolFiles(db),
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readTreeBuildRequest(db) {
  const symbols = readSymbols(db);
  return {
    paths: readPaths(db, symbols),
    symbols,
    centrality: readCentrality(db),
    clusterRefs: readClusterRefs(db),
    processRefs: readProcessRefs(db),
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {any} tree
 * @returns {{ nodes: number, refs: number, scopeNodes: number, termStats: number, symbolFiles: number }}
 */
function writeTreeBuildResult(db, tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const refs = Array.isArray(tree?.refs) ? tree.refs : [];
  const scopeNodes = Array.isArray(tree?.scopeNodes) ? tree.scopeNodes : [];
  const termStats = Array.isArray(tree?.termStats) ? tree.termStats : [];
  const symbolFiles = Array.isArray(tree?.symbolFiles) ? tree.symbolFiles : [];
  const nodeInsert = db.prepare(
    `INSERT INTO atlas_tree_nodes
       (node_id, parent_node_id, kind, label, stable_ref, repo_rel_path,
        symbol_ref, symbol_global_id, depth, sort_order, child_count,
        descendant_symbol_count, descendant_file_count, aggregates_json, terms_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const refInsert = db.prepare(
    `INSERT OR REPLACE INTO atlas_tree_refs(node_id, ref_type, ref_id, weight)
     VALUES (?, ?, ?, ?)`,
  );
  const scopeInsert = db.prepare(
    `INSERT INTO atlas_tree_scope_nodes
       (node_id, parent_node_id, kind, label, repo_rel_path, depth, sort_order,
        descendant_symbol_count, descendant_file_count, generated, test, config,
        aggregates_json, terms_json, projected_terms_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const statInsert = db.prepare(
    `INSERT OR REPLACE INTO atlas_tree_scope_term_stats(term, direct_file_count, projected_file_count)
     VALUES (?, ?, ?)`,
  );
  const symbolInsert = db.prepare(
    `INSERT OR REPLACE INTO atlas_tree_scope_symbol_files(symbol_ref, symbol_node_id, file_node_id, repo_rel_path)
     VALUES (?, ?, ?, ?)`,
  );

  for (const node of nodes) {
    nodeInsert.run(
      String(node.nodeId || ""),
      node.parentNodeId ? String(node.parentNodeId) : null,
      String(node.kind || ""),
      String(node.label || ""),
      String(node.stableRef || node.nodeId || ""),
      node.repoRelPath ? normalizeRepoPath(node.repoRelPath) : null,
      node.symbolRef ? String(node.symbolRef) : null,
      node.symbolGlobalId == null ? null : Number(node.symbolGlobalId),
      numberOr(node.depth, 0),
      numberOr(node.sortOrder, 0),
      numberOr(node.childCount, Array.isArray(node.children) ? node.children.length : 0),
      numberOr(node.aggregates?.descendantSymbolCount, 0),
      numberOr(node.aggregates?.descendantFileCount, 0),
      JSON.stringify(objectOr(node.aggregates)),
      JSON.stringify(arrayOr(node.terms).map(String)),
    );
  }
  for (const ref of refs) {
    refInsert.run(
      String(ref.nodeId || ""),
      String(ref.refType || ""),
      String(ref.refId || ""),
      numberOr(ref.weight, 1),
    );
  }
  for (const node of scopeNodes) {
    scopeInsert.run(
      String(node.nodeId || ""),
      node.parentNodeId ? String(node.parentNodeId) : null,
      String(node.kind || ""),
      String(node.label || ""),
      normalizeRepoPath(node.repoRelPath),
      numberOr(node.depth, 0),
      numberOr(node.sortOrder, 0),
      numberOr(node.descendantSymbolCount, 0),
      numberOr(node.descendantFileCount, 0),
      node.generated ? 1 : 0,
      node.test ? 1 : 0,
      node.config ? 1 : 0,
      JSON.stringify(objectOr(node.aggregates)),
      JSON.stringify(arrayOr(node.terms).map(String)),
      JSON.stringify(arrayOr(node.projectedTerms).map(String)),
    );
  }
  for (const stat of termStats) {
    statInsert.run(
      String(stat.term || ""),
      numberOr(stat.directFileCount, 0),
      numberOr(stat.projectedFileCount, 0),
    );
  }
  for (const row of symbolFiles) {
    symbolInsert.run(
      String(row.symbolRef || ""),
      String(row.symbolNodeId || ""),
      String(row.fileNodeId || ""),
      normalizeRepoPath(row.repoRelPath),
    );
  }

  return {
    nodes: nodes.length,
    refs: refs.length,
    scopeNodes: scopeNodes.length,
    termStats: termStats.length,
    symbolFiles: symbolFiles.length,
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function clearTreeTables(db) {
  db.prepare("DELETE FROM atlas_tree_scope_symbol_files").run();
  db.prepare("DELETE FROM atlas_tree_scope_term_stats").run();
  db.prepare("DELETE FROM atlas_tree_scope_nodes").run();
  db.prepare("DELETE FROM atlas_tree_refs").run();
  db.prepare("DELETE FROM atlas_tree_nodes").run();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readSymbols(db) {
  return db.prepare(
    `SELECT global_id AS globalId, content_hash AS contentHash, local_id AS localId,
            kind, name, qualified_name AS qualifiedName, parent_global_id AS parentGlobalId,
            repo_rel_path AS repoRelPath, lang
     FROM symbols
     ORDER BY repo_rel_path, range_start, global_id`,
  ).all().map((row) => ({
    ...row,
    globalId: Number(row.globalId),
    localId: Number(row.localId),
    parentGlobalId: row.parentGlobalId == null ? null : Number(row.parentGlobalId),
    repoRelPath: normalizeRepoPath(row.repoRelPath),
  }));
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {any[]} symbols
 */
function readPaths(db, symbols) {
  const paths = new Set(symbols.map((symbol) => normalizeRepoPath(symbol.repoRelPath)).filter(Boolean));
  try {
    for (const row of db.prepare("SELECT repo_rel_path AS repoRelPath FROM path_to_blob ORDER BY repo_rel_path").all()) {
      const repoRelPath = normalizeRepoPath(row.repoRelPath);
      if (repoRelPath) paths.add(repoRelPath);
    }
  } catch {
    // Fresh unit-test views can seed symbols directly without path rows.
  }
  return [...paths].sort(compareStrings);
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readCentrality(db) {
  if (!tableExists(db, "symbol_centrality")) return [];
  try {
    return db.prepare(
      `SELECT symbol_global_id AS symbolGlobalId, fan_in AS fanIn, fan_out AS fanOut,
              call_fan_in AS callFanIn, call_fan_out AS callFanOut, score
       FROM symbol_centrality
       ORDER BY symbol_global_id`,
    ).all().map((row) => ({
      symbolGlobalId: Number(row.symbolGlobalId),
      fanIn: numberOr(row.fanIn, 0),
      fanOut: numberOr(row.fanOut, 0),
      callFanIn: numberOr(row.callFanIn, 0),
      callFanOut: numberOr(row.callFanOut, 0),
      centralityScore: numberOr(row.score, 0),
    }));
  } catch {
    return [];
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readClusterRefs(db) {
  if (!tableExists(db, "symbol_clusters")) return [];
  try {
    return db.prepare(
      `SELECT symbol_global_id AS symbolGlobalId, cluster_id AS clusterId,
              membership_score AS membershipScore
       FROM symbol_clusters
       ORDER BY symbol_global_id, cluster_id`,
    ).all().map((row) => ({
      symbolGlobalId: Number(row.symbolGlobalId),
      clusterId: String(row.clusterId || ""),
      membershipScore: row.membershipScore == null ? null : numberOr(row.membershipScore, 1),
    }));
  } catch {
    return [];
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readProcessRefs(db) {
  if (!tableExists(db, "process_steps")) return [];
  try {
    return db.prepare(
      `SELECT symbol_global_id AS symbolGlobalId, process_id AS processId, depth
       FROM process_steps
       ORDER BY symbol_global_id, process_id`,
    ).all().map((row) => ({
      symbolGlobalId: Number(row.symbolGlobalId),
      processId: String(row.processId || ""),
      depth: row.depth == null ? null : Number(row.depth),
    }));
  } catch {
    return [];
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readTreeNodes(db) {
  if (!tableExists(db, "atlas_tree_nodes")) return [];
  return db.prepare(
    `SELECT node_id AS nodeId, parent_node_id AS parentNodeId, kind, label,
            stable_ref AS stableRef, repo_rel_path AS repoRelPath, symbol_ref AS symbolRef,
            symbol_global_id AS symbolGlobalId, depth, sort_order AS sortOrder,
            child_count AS childCount, descendant_symbol_count AS descendantSymbolCount,
            descendant_file_count AS descendantFileCount, aggregates_json AS aggregatesJson,
            terms_json AS termsJson
     FROM atlas_tree_nodes
     ORDER BY depth ASC, sort_order ASC, node_id ASC`,
  ).all().map((row) => ({
    nodeId: String(row.nodeId || ""),
    parentNodeId: row.parentNodeId ? String(row.parentNodeId) : null,
    kind: String(row.kind || ""),
    label: String(row.label || ""),
    stableRef: String(row.stableRef || row.nodeId || ""),
    repoRelPath: row.repoRelPath ? normalizeRepoPath(row.repoRelPath) : null,
    symbolRef: row.symbolRef ? String(row.symbolRef) : null,
    symbolGlobalId: row.symbolGlobalId == null ? null : Number(row.symbolGlobalId),
    depth: Number(row.depth || 0),
    sortOrder: Number(row.sortOrder || 0),
    childCount: Number(row.childCount || 0),
    aggregates: parseJsonObject(row.aggregatesJson),
    terms: parseJsonArray(row.termsJson).map(String),
  }));
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readTreeRefs(db) {
  if (!tableExists(db, "atlas_tree_refs")) return [];
  return db.prepare(
    `SELECT node_id AS nodeId, ref_type AS refType, ref_id AS refId, weight
     FROM atlas_tree_refs
     ORDER BY node_id ASC, ref_type ASC, ref_id ASC`,
  ).all().map((row) => ({
    nodeId: String(row.nodeId || ""),
    refType: String(row.refType || ""),
    refId: String(row.refId || ""),
    weight: numberOr(row.weight, 1),
  }));
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readTreeScopeNodes(db) {
  if (!tableExists(db, "atlas_tree_scope_nodes")) return [];
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
    repoRelPath: normalizeRepoPath(row.repoRelPath),
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

/**
 * @param {import("better-sqlite3").Database} db
 */
function readTreeScopeTermStats(db) {
  if (!tableExists(db, "atlas_tree_scope_term_stats")) return [];
  return db.prepare(
    `SELECT term, direct_file_count AS directFileCount,
            projected_file_count AS projectedFileCount
     FROM atlas_tree_scope_term_stats
     ORDER BY term ASC`,
  ).all().map((row) => ({
    term: String(row.term || ""),
    directFileCount: Number(row.directFileCount || 0),
    projectedFileCount: Number(row.projectedFileCount || 0),
  }));
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readTreeScopeSymbolFiles(db) {
  if (!tableExists(db, "atlas_tree_scope_symbol_files")) return [];
  return db.prepare(
    `SELECT symbol_ref AS symbolRef, symbol_node_id AS symbolNodeId,
            file_node_id AS fileNodeId, repo_rel_path AS repoRelPath
     FROM atlas_tree_scope_symbol_files
     ORDER BY repo_rel_path ASC, symbol_ref ASC, symbol_node_id ASC`,
  ).all().map((row) => ({
    symbolRef: String(row.symbolRef || ""),
    symbolNodeId: String(row.symbolNodeId || ""),
    fileNodeId: String(row.fileNodeId || ""),
    repoRelPath: normalizeRepoPath(row.repoRelPath),
  }));
}

function compareStrings(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 */
function tableExists(db, name) {
  try {
    const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name);
    return !!row;
  } catch {
    return false;
  }
}

function arrayOr(value) {
  return Array.isArray(value) ? value : [];
}

function objectOr(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function recordRun(db, kind, status, durationMs, details) {
  try {
    db.prepare(
      "INSERT INTO derived_state_runs(built_at, kind, status, duration_ms, details_json) VALUES (?, ?, ?, ?, ?)",
    ).run(new Date().toISOString(), kind, status, Math.max(0, Math.round(durationMs)), JSON.stringify(details || {}));
  } catch {
    // Derived-state run telemetry must never break retrieval.
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 */
function rollbackSavepoint(db, name) {
  try {
    db.exec(`ROLLBACK TO ${name}`);
  } catch {
    // Preserve the original writer failure.
  }
  try {
    db.exec(`RELEASE ${name}`);
  } catch {
    // Ignore cleanup failures.
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
