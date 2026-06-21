// @ts-check
//
// Rebuildable tree-derived state for ATLAS view DBs. This cache is a stable
// containment map over repo paths and symbol parentage. It deliberately stores
// raw aggregate facts only; ranking, pruning, and summaries belong to the
// projection layer.

import { sha256Hex } from "./hash.js";
import { isGeneratedPath } from "./path-hygiene.js";

const TREE_RUN_KIND = "tree-derived";
const ROOT_NODE_ID = "root";
const ROOT_STABLE_REF = "root";

/**
 * @typedef {Object} TreeNode
 * @property {string} nodeId
 * @property {string | null} parentNodeId
 * @property {string} kind
 * @property {string} label
 * @property {string} stableRef
 * @property {string | null} repoRelPath
 * @property {string | null} symbolRef
 * @property {number | null} symbolGlobalId
 * @property {number} depth
 * @property {number} sortOrder
 * @property {Set<string>} children
 * @property {Set<string>} terms
 * @property {Record<string, number>} direct
 * @property {Record<string, unknown>} aggregates
 */

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

    CREATE TABLE IF NOT EXISTS atlas_tree_scope_terms (
      term        TEXT NOT NULL,
      node_id     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      direct      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (term, node_id, direct),
      FOREIGN KEY (node_id) REFERENCES atlas_tree_scope_nodes(node_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_terms_term_kind
      ON atlas_tree_scope_terms(term, kind, direct);

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
                s.repo_rel_path AS repoRelPath,
                sc.cluster_id AS clusterId, sc.membership_score AS membershipScore
         FROM symbol_clusters sc
         JOIN symbols s ON s.global_id = sc.symbol_global_id
         ORDER BY s.repo_rel_path, s.content_hash, s.local_id, sc.cluster_id`,
      ).all()
      : [];
    const processes = tableExists(db, "process_steps")
      ? db.prepare(
        `SELECT s.content_hash AS contentHash, s.local_id AS localId,
                s.repo_rel_path AS repoRelPath,
                ps.process_id AS processId, ps.depth
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
    const symbols = readSymbols(db);
    const paths = readPaths(db, symbols);
    const centrality = readCentrality(db);
    const clusterRefs = readClusterRefs(db);
    const processRefs = readProcessRefs(db);
    const tree = buildTree({ paths, symbols, centrality, clusterRefs, processRefs });
    validateTree(tree, { symbolCount: symbols.length });
    const counts = writeTree(db, tree);
    const scopeCounts = writeScopeSidecar(db, tree);
    const durationMs = Date.now() - started;
    recordRun(db, TREE_RUN_KIND, "ok", durationMs, {
      nodes: counts.nodes,
      refs: counts.refs,
      scopeNodes: scopeCounts.nodes,
      scopeTerms: scopeCounts.terms,
      scopeSymbols: scopeCounts.symbols,
      files: paths.length,
      symbols: symbols.length,
    });
    db.exec("RELEASE tree_derived_refresh");
    return {
      ok: true,
      durationMs,
      nodes: counts.nodes,
      refs: counts.refs,
      files: paths.length,
      symbols: symbols.length,
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
 * @param {import("better-sqlite3").Database} db
 * @param {number} [limit]
 */
export function readTreeOverview(db, limit = 25) {
  if (!hasTreeDerivedTables(db)) {
    return { available: false, reason: "tree_derived_tables_missing", nodes: [], latestRun: null };
  }
  const nodes = db.prepare(
    `SELECT node_id AS nodeId, parent_node_id AS parentNodeId, kind, label,
            stable_ref AS stableRef, repo_rel_path AS repoRelPath,
            symbol_ref AS symbolRef, depth, child_count AS childCount,
            descendant_symbol_count AS descendantSymbolCount,
            descendant_file_count AS descendantFileCount,
            aggregates_json AS aggregatesJson, terms_json AS termsJson
     FROM atlas_tree_nodes
     ORDER BY depth ASC, sort_order ASC, node_id ASC
     LIMIT ?`,
  ).all(limit).map((row) => ({
    nodeId: row.nodeId,
    parentNodeId: row.parentNodeId || null,
    kind: row.kind,
    label: row.label,
    stableRef: row.stableRef,
    repoRelPath: row.repoRelPath || null,
    symbolRef: row.symbolRef || null,
    depth: Number(row.depth || 0),
    childCount: Number(row.childCount || 0),
    descendantSymbolCount: Number(row.descendantSymbolCount || 0),
    descendantFileCount: Number(row.descendantFileCount || 0),
    aggregates: parseJsonObject(row.aggregatesJson),
    terms: parseJsonArray(row.termsJson),
  }));
  const latestRun = db.prepare(
    "SELECT built_at AS builtAt, status, duration_ms AS durationMs, details_json AS detailsJson FROM derived_state_runs WHERE kind = ? ORDER BY id DESC LIMIT 1",
  ).get(TREE_RUN_KIND);
  return {
    available: true,
    nodes,
    latestRun: latestRun ? {
      builtAt: latestRun.builtAt,
      status: latestRun.status,
      durationMs: Number(latestRun.durationMs || 0),
      details: parseJsonObject(latestRun.detailsJson),
    } : null,
  };
}

/**
 * @param {{ paths: string[], symbols: any[], centrality: Map<number, any>, clusterRefs: Map<number, any[]>, processRefs: Map<number, any[]> }} args
 */
function buildTree({ paths, symbols, centrality, clusterRefs, processRefs }) {
  /** @type {Map<string, TreeNode>} */
  const nodes = new Map();
  /** @type {Array<{ nodeId: string, refType: string, refId: string, weight: number }>} */
  const refs = [];
  const symbolsByGlobalId = new Map(symbols.map((symbol) => [Number(symbol.globalId), symbol]));
  const symbolNodeIdByGlobalId = new Map();

  addNode(nodes, {
    nodeId: ROOT_NODE_ID,
    parentNodeId: null,
    kind: "root",
    label: "repo",
    stableRef: ROOT_STABLE_REF,
    repoRelPath: null,
    symbolRef: null,
    symbolGlobalId: null,
  });

  for (const repoRelPath of paths) {
    addPathNodes(nodes, repoRelPath);
  }

  for (const symbol of symbols) {
    const symbolRef = symbolRefOf(symbol);
    const nodeId = symbolNodeId(symbol);
    symbolNodeIdByGlobalId.set(Number(symbol.globalId), nodeId);
    addNode(nodes, {
      nodeId,
      parentNodeId: fileNodeId(symbol.repoRelPath),
      kind: normalizeSymbolKind(symbol.kind),
      label: String(symbol.name || symbol.qualifiedName || symbolRef),
      stableRef: nodeId,
      repoRelPath: symbol.repoRelPath,
      symbolRef,
      symbolGlobalId: Number(symbol.globalId),
    });
    const node = nodes.get(nodeId);
    if (node) {
      node.direct = directAggregateForSymbol(symbol, centrality.get(Number(symbol.globalId)));
      addTerms(node, [
        symbol.name,
        symbol.qualifiedName,
        symbol.kind,
        symbol.lang,
        symbol.repoRelPath,
      ]);
    }
  }

  for (const symbol of symbols) {
    const nodeId = symbolNodeIdByGlobalId.get(Number(symbol.globalId));
    const node = nodeId ? nodes.get(nodeId) : null;
    if (!node) continue;
    const parentGlobalId = Number(symbol.parentGlobalId);
    const parentSymbol = Number.isFinite(parentGlobalId) ? symbolsByGlobalId.get(parentGlobalId) : null;
    const parentNodeId = parentSymbol ? symbolNodeIdByGlobalId.get(parentGlobalId) : null;
    if (parentNodeId && nodes.has(parentNodeId)) {
      setParent(nodes, node.nodeId, parentNodeId);
    }
  }

  for (const symbol of symbols) {
    const nodeId = symbolNodeIdByGlobalId.get(Number(symbol.globalId));
    if (!nodeId) continue;
    for (const ref of clusterRefs.get(Number(symbol.globalId)) || []) {
      refs.push({ nodeId, refType: "cluster", refId: String(ref.clusterId), weight: numberOr(ref.membershipScore, 1) });
    }
    for (const ref of processRefs.get(Number(symbol.globalId)) || []) {
      refs.push({ nodeId, refType: "process", refId: String(ref.processId), weight: 1 });
    }
  }

  assignDepthsAndSort(nodes);
  aggregateTree(nodes, refs);
  return { nodes, refs };
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @param {string} repoRelPath
 */
function addPathNodes(nodes, repoRelPath) {
  const cleanPath = normalizeRepoPath(repoRelPath);
  if (!cleanPath) return;
  const parts = cleanPath.split("/");
  let parentNodeId = ROOT_NODE_ID;
  let currentPath = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
    const nodeId = dirNodeId(currentPath);
    addNode(nodes, {
      nodeId,
      parentNodeId,
      kind: "dir",
      label: parts[i],
      stableRef: nodeId,
      repoRelPath: currentPath,
      symbolRef: null,
      symbolGlobalId: null,
    });
    parentNodeId = nodeId;
  }
  const label = parts[parts.length - 1];
  addNode(nodes, {
    nodeId: fileNodeId(cleanPath),
    parentNodeId,
    kind: "file",
    label,
    stableRef: fileNodeId(cleanPath),
    repoRelPath: cleanPath,
    symbolRef: null,
    symbolGlobalId: null,
  });
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @param {Omit<TreeNode, "depth" | "sortOrder" | "children" | "terms" | "direct" | "aggregates">} spec
 */
function addNode(nodes, spec) {
  const existing = nodes.get(spec.nodeId);
  if (existing) return existing;
  /** @type {TreeNode} */
  const node = {
    ...spec,
    depth: 0,
    sortOrder: 0,
    children: new Set(),
    terms: new Set(),
    direct: zeroAggregate(),
    aggregates: zeroAggregate(),
  };
  addTerms(node, [spec.label, spec.repoRelPath, spec.stableRef]);
  nodes.set(spec.nodeId, node);
  if (spec.parentNodeId && nodes.has(spec.parentNodeId)) {
    nodes.get(spec.parentNodeId).children.add(spec.nodeId);
  }
  return node;
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @param {string} nodeId
 * @param {string} parentNodeId
 */
function setParent(nodes, nodeId, parentNodeId) {
  const node = nodes.get(nodeId);
  const parent = nodes.get(parentNodeId);
  if (!node || !parent || node.parentNodeId === parentNodeId) return;
  if (node.parentNodeId) nodes.get(node.parentNodeId)?.children.delete(node.nodeId);
  node.parentNodeId = parentNodeId;
  parent.children.add(node.nodeId);
}

/**
 * @param {Map<string, TreeNode>} nodes
 */
function assignDepthsAndSort(nodes) {
  const root = nodes.get(ROOT_NODE_ID);
  if (!root) return;
  const queue = [root];
  root.depth = 0;
  while (queue.length > 0) {
    const node = queue.shift();
    const children = [...node.children]
      .map((id) => nodes.get(id))
      .filter(Boolean)
      .sort(compareNodes);
    node.children = new Set(children.map((child) => child.nodeId));
    children.forEach((child, index) => {
      child.depth = node.depth + 1;
      child.sortOrder = index;
      queue.push(child);
    });
  }
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @param {Array<{ nodeId: string, refType: string, refId: string, weight: number }>} refs
 */
function aggregateTree(nodes, refs) {
  const refCountsByNode = new Map();
  for (const ref of refs) {
    const key = `${ref.refType}:${ref.refId}`;
    const counts = refCountsByNode.get(ref.nodeId) || {};
    counts[key] = (counts[key] || 0) + ref.weight;
    refCountsByNode.set(ref.nodeId, counts);
  }
  const ordered = [...nodes.values()].sort((a, b) => b.depth - a.depth || compareNodes(a, b));
  for (const node of ordered) {
    const aggregate = { ...zeroAggregate(), ...node.direct };
    const refCounts = { ...(refCountsByNode.get(node.nodeId) || {}) };
    for (const childId of node.children) {
      const child = nodes.get(childId);
      if (!child) continue;
      addAggregateInto(aggregate, child.aggregates);
      mergeCounts(refCounts, /** @type {any} */ (child.aggregates).refs || {});
    }
    if (node.kind === "file") aggregate.descendantFileCount += 1;
    if (node.symbolRef) aggregate.descendantSymbolCount += 1;
    node.aggregates = {
      ...aggregate,
      refs: refCounts,
    };
  }
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @param {{ nodes: Map<string, TreeNode>, refs: Array<{ nodeId: string, refType: string, refId: string, weight: number }> }} tree
 * @returns {{ nodes: number, refs: number }}
 */
function writeTree(db, tree) {
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
  let nodeCount = 0;
  for (const node of [...tree.nodes.values()].sort((a, b) => a.depth - b.depth || compareNodes(a, b))) {
    nodeInsert.run(
      node.nodeId,
      node.parentNodeId,
      node.kind,
      node.label,
      node.stableRef,
      node.repoRelPath,
      node.symbolRef,
      node.symbolGlobalId,
      node.depth,
      node.sortOrder,
      node.children.size,
      numberOr(/** @type {any} */ (node.aggregates).descendantSymbolCount, 0),
      numberOr(/** @type {any} */ (node.aggregates).descendantFileCount, 0),
      JSON.stringify(node.aggregates),
      JSON.stringify([...node.terms].sort()),
    );
    nodeCount += 1;
  }
  let refCount = 0;
  for (const ref of tree.refs) {
    refInsert.run(ref.nodeId, ref.refType, ref.refId, ref.weight);
    refCount += 1;
  }
  return { nodes: nodeCount, refs: refCount };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ nodes: Map<string, TreeNode>, refs: Array<{ nodeId: string, refType: string, refId: string, weight: number }> }} tree
 * @returns {{ nodes: number, terms: number, termStats: number, symbols: number }}
 */
function writeScopeSidecar(db, tree) {
  const projectedTerms = projectedTermsByNode(tree.nodes);
  const nodeInsert = db.prepare(
    `INSERT INTO atlas_tree_scope_nodes
       (node_id, parent_node_id, kind, label, repo_rel_path, depth, sort_order,
        descendant_symbol_count, descendant_file_count, generated, test, config,
        aggregates_json, terms_json, projected_terms_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const termInsert = db.prepare(
    `INSERT OR REPLACE INTO atlas_tree_scope_terms(term, node_id, kind, direct)
     VALUES (?, ?, ?, ?)`,
  );
  const statInsert = db.prepare(
    `INSERT OR REPLACE INTO atlas_tree_scope_term_stats(term, direct_file_count, projected_file_count)
     VALUES (?, ?, ?)`,
  );
  const symbolInsert = db.prepare(
    `INSERT OR REPLACE INTO atlas_tree_scope_symbol_files(symbol_ref, symbol_node_id, file_node_id, repo_rel_path)
     VALUES (?, ?, ?, ?)`,
  );
  const directFileCounts = new Map();
  const projectedFileCounts = new Map();
  let nodeCount = 0;
  let symbolCount = 0;

  for (const node of [...tree.nodes.values()].sort((a, b) => a.depth - b.depth || compareNodes(a, b))) {
    if (node.kind !== "file" && node.kind !== "dir") continue;
    const repoRelPath = normalizeRepoPath(node.repoRelPath);
    if (!repoRelPath) continue;
    const directTerms = [...node.terms].sort();
    const projected = [...(projectedTerms.get(node.nodeId) || node.terms)].sort();
    nodeInsert.run(
      node.nodeId,
      scopeParentNodeId(tree.nodes, node),
      node.kind,
      node.label,
      repoRelPath,
      node.depth,
      node.sortOrder,
      numberOr(/** @type {any} */ (node.aggregates).descendantSymbolCount, 0),
      numberOr(/** @type {any} */ (node.aggregates).descendantFileCount, 0),
      isGeneratedPath(repoRelPath) ? 1 : 0,
      isTestPath(repoRelPath) ? 1 : 0,
      isConfigPath(repoRelPath) ? 1 : 0,
      JSON.stringify(node.aggregates),
      JSON.stringify(directTerms),
      JSON.stringify(projected),
    );
    nodeCount += 1;
    for (const term of directTerms) {
      termInsert.run(term, node.nodeId, node.kind, 1);
      if (node.kind === "file") directFileCounts.set(term, (directFileCounts.get(term) || 0) + 1);
    }
    for (const term of projected) {
      termInsert.run(term, node.nodeId, node.kind, 0);
      if (node.kind === "file") projectedFileCounts.set(term, (projectedFileCounts.get(term) || 0) + 1);
    }
  }

  for (const term of new Set([...directFileCounts.keys(), ...projectedFileCounts.keys()])) {
    statInsert.run(term, directFileCounts.get(term) || 0, projectedFileCounts.get(term) || 0);
  }

  for (const node of tree.nodes.values()) {
    if (!node.symbolRef) continue;
    const file = fileNodeForSymbol(tree.nodes, node);
    if (!file?.repoRelPath) continue;
    symbolInsert.run(node.symbolRef, node.nodeId, file.nodeId, normalizeRepoPath(file.repoRelPath));
    symbolCount += 1;
  }

  return {
    nodes: nodeCount,
    terms: Number(db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_terms").get()?.cnt || 0),
    termStats: new Set([...directFileCounts.keys(), ...projectedFileCounts.keys()]).size,
    symbols: symbolCount,
  };
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @returns {Map<string, Set<string>>}
 */
function projectedTermsByNode(nodes) {
  const projected = new Map();
  for (const node of nodes.values()) projected.set(node.nodeId, new Set(node.terms));
  for (const node of [...nodes.values()].sort((a, b) => b.depth - a.depth || compareNodes(a, b))) {
    if (!node.parentNodeId || !nodes.has(node.parentNodeId)) continue;
    const parentTerms = projected.get(node.parentNodeId);
    const childTerms = projected.get(node.nodeId);
    if (!parentTerms || !childTerms) continue;
    for (const term of childTerms) parentTerms.add(term);
  }
  return projected;
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @param {TreeNode} node
 */
function scopeParentNodeId(nodes, node) {
  let current = node.parentNodeId ? nodes.get(node.parentNodeId) : null;
  while (current && current.kind !== "dir" && current.kind !== "file" && current.kind !== "root") {
    current = current.parentNodeId ? nodes.get(current.parentNodeId) : null;
  }
  return current && current.kind !== "root" ? current.nodeId : null;
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @param {TreeNode} symbolNode
 */
function fileNodeForSymbol(nodes, symbolNode) {
  let current = symbolNode;
  while (current) {
    if (current.kind === "file") return current;
    current = current.parentNodeId ? nodes.get(current.parentNodeId) : null;
  }
  return null;
}

/**
 * @param {{ nodes: Map<string, TreeNode>, refs: Array<{ nodeId: string, refType: string, refId: string, weight: number }> }} tree
 * @param {{ symbolCount: number }} expected
 */
function validateTree(tree, expected) {
  if (!tree.nodes.has(ROOT_NODE_ID)) throw new Error("tree-derived: missing root node");
  let rootCount = 0;
  let symbolCount = 0;
  for (const node of tree.nodes.values()) {
    if (!node.parentNodeId) rootCount += 1;
    if (node.symbolRef) symbolCount += 1;
    if (node.nodeId !== ROOT_NODE_ID && !node.parentNodeId) {
      throw new Error(`tree-derived: non-root node has no parent: ${node.nodeId}`);
    }
    if (node.parentNodeId && !tree.nodes.has(node.parentNodeId)) {
      throw new Error(`tree-derived: missing parent ${node.parentNodeId} for ${node.nodeId}`);
    }
    assertAcyclic(tree.nodes, node.nodeId);
  }
  if (rootCount !== 1) throw new Error(`tree-derived: expected one root, got ${rootCount}`);
  if (symbolCount !== expected.symbolCount) {
    throw new Error(`tree-derived: expected ${expected.symbolCount} symbol nodes, got ${symbolCount}`);
  }
  for (const ref of tree.refs) {
    if (!tree.nodes.has(ref.nodeId)) throw new Error(`tree-derived: ref target missing: ${ref.nodeId}`);
  }
}

/**
 * @param {Map<string, TreeNode>} nodes
 * @param {string} startNodeId
 */
function assertAcyclic(nodes, startNodeId) {
  const seen = new Set();
  let current = nodes.get(startNodeId);
  while (current) {
    if (seen.has(current.nodeId)) throw new Error(`tree-derived: cycle at ${current.nodeId}`);
    seen.add(current.nodeId);
    current = current.parentNodeId ? nodes.get(current.parentNodeId) : null;
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function clearTreeTables(db) {
  db.prepare("DELETE FROM atlas_tree_scope_symbol_files").run();
  db.prepare("DELETE FROM atlas_tree_scope_term_stats").run();
  db.prepare("DELETE FROM atlas_tree_scope_terms").run();
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
  return [...paths].sort();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readCentrality(db) {
  const out = new Map();
  if (!tableExists(db, "symbol_centrality")) return out;
  try {
    for (const row of db.prepare(
      `SELECT symbol_global_id AS symbolGlobalId, fan_in AS fanIn, fan_out AS fanOut,
              call_fan_in AS callFanIn, call_fan_out AS callFanOut, score
       FROM symbol_centrality`,
    ).all()) {
      out.set(Number(row.symbolGlobalId), {
        fanIn: numberOr(row.fanIn, 0),
        fanOut: numberOr(row.fanOut, 0),
        callFanIn: numberOr(row.callFanIn, 0),
        callFanOut: numberOr(row.callFanOut, 0),
        centralityScore: numberOr(row.score, 0),
      });
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readClusterRefs(db) {
  const out = new Map();
  if (!tableExists(db, "symbol_clusters")) return out;
  try {
    for (const row of db.prepare(
      `SELECT symbol_global_id AS symbolGlobalId, cluster_id AS clusterId,
              membership_score AS membershipScore
       FROM symbol_clusters
       ORDER BY symbol_global_id, cluster_id`,
    ).all()) {
      const key = Number(row.symbolGlobalId);
      const refs = out.get(key) || [];
      refs.push({ clusterId: row.clusterId, membershipScore: row.membershipScore });
      out.set(key, refs);
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readProcessRefs(db) {
  const out = new Map();
  if (!tableExists(db, "process_steps")) return out;
  try {
    for (const row of db.prepare(
      `SELECT symbol_global_id AS symbolGlobalId, process_id AS processId, depth
       FROM process_steps
       ORDER BY symbol_global_id, process_id`,
    ).all()) {
      const key = Number(row.symbolGlobalId);
      const refs = out.get(key) || [];
      refs.push({ processId: row.processId, depth: row.depth });
      out.set(key, refs);
    }
  } catch {
    return new Map();
  }
  return out;
}

function directAggregateForSymbol(symbol, centrality) {
  return {
    ...zeroAggregate(),
    symbolsSelf: 1,
    fanInTotal: centrality?.fanIn || 0,
    fanOutTotal: centrality?.fanOut || 0,
    callFanInTotal: centrality?.callFanIn || 0,
    callFanOutTotal: centrality?.callFanOut || 0,
    centralitySum: centrality?.centralityScore || 0,
    centralityMax: centrality?.centralityScore || 0,
    symbolKinds: { [String(symbol.kind || "unknown")]: 1 },
  };
}

function zeroAggregate() {
  return {
    symbolsSelf: 0,
    descendantSymbolCount: 0,
    descendantFileCount: 0,
    fanInTotal: 0,
    fanOutTotal: 0,
    callFanInTotal: 0,
    callFanOutTotal: 0,
    centralitySum: 0,
    centralityMax: 0,
    symbolKinds: {},
  };
}

function addAggregateInto(target, source) {
  target.symbolsSelf += numberOr(source.symbolsSelf, 0);
  target.descendantSymbolCount += numberOr(source.descendantSymbolCount, 0);
  target.descendantFileCount += numberOr(source.descendantFileCount, 0);
  target.fanInTotal += numberOr(source.fanInTotal, 0);
  target.fanOutTotal += numberOr(source.fanOutTotal, 0);
  target.callFanInTotal += numberOr(source.callFanInTotal, 0);
  target.callFanOutTotal += numberOr(source.callFanOutTotal, 0);
  target.centralitySum += numberOr(source.centralitySum, 0);
  target.centralityMax = Math.max(numberOr(target.centralityMax, 0), numberOr(source.centralityMax, 0));
  mergeCounts(target.symbolKinds, source.symbolKinds || {});
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + numberOr(value, 0);
  }
}

function compareNodes(a, b) {
  const kindDelta = kindOrder(a.kind) - kindOrder(b.kind);
  if (kindDelta !== 0) return kindDelta;
  const pathDelta = String(a.repoRelPath || "").localeCompare(String(b.repoRelPath || ""));
  if (pathDelta !== 0) return pathDelta;
  const labelDelta = String(a.label || "").localeCompare(String(b.label || ""));
  if (labelDelta !== 0) return labelDelta;
  return String(a.nodeId).localeCompare(String(b.nodeId));
}

function kindOrder(kind) {
  switch (kind) {
    case "root": return 0;
    case "dir": return 1;
    case "file": return 2;
    case "class": return 3;
    case "interface": return 4;
    case "function": return 5;
    case "method": return 6;
    default: return 10;
  }
}

function normalizeSymbolKind(kind) {
  const text = String(kind || "symbol").trim().toLowerCase();
  return text || "symbol";
}

function symbolRefOf(symbol) {
  return `${symbol.contentHash}:${Number(symbol.localId)}`;
}

function symbolNodeId(symbol) {
  return `symbol:${normalizeRepoPath(symbol.repoRelPath)}:${symbolRefOf(symbol)}`;
}

function dirNodeId(repoRelPath) {
  return `dir:${normalizeRepoPath(repoRelPath)}`;
}

function fileNodeId(repoRelPath) {
  return `file:${normalizeRepoPath(repoRelPath)}`;
}

function normalizeRepoPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function isTestPath(value) {
  const text = String(value || "").replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(text)
    || /\.(test|spec)\.[^.]+$/.test(text);
}

function isConfigPath(value) {
  const text = String(value || "").replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(config|configs|settings)(\/|$)/.test(text)
    || /(^|\/)(package\.json|tsconfig\.json|vite\.config\.[jt]s|webpack\.config\.[jt]s|composer\.json)$/.test(text)
    || /(^|\/)[^.]*config\.[^.]+$/.test(text);
}

/**
 * @param {TreeNode} node
 * @param {unknown[]} values
 */
function addTerms(node, values) {
  for (const value of values) {
    for (const term of splitTerms(value)) node.terms.add(term);
  }
}

function splitTerms(value) {
  return String(value || "")
    .split(/[^A-Za-z0-9_]+|(?=[A-Z][a-z])|(?<=[a-z0-9])(?=[A-Z])/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 2);
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

/**
 * @param {import("better-sqlite3").Database} db
 */
function hasTreeDerivedTables(db) {
  try {
    const rows = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('atlas_tree_nodes', 'atlas_tree_refs', 'derived_state_runs')`,
    ).all();
    return rows.length === 3;
  } catch {
    return false;
  }
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
