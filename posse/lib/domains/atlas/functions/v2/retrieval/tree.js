// @ts-check
//
// tree.overview handler. Reads the materialized tree-derived cache without
// pulling it into retrieval ranking yet.

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { isGeneratedPath } from "./hygiene.js";
import { readLatestTreeCompressionSnapshot } from "../tree-compression.js";
import { normalizeRepoPath } from "../paths.js";

const TREE_RUN_KIND = "tree-derived";
const INVALID_PATH_WARNING = "path must be a canonical repo-relative path.";
const FOCUS_MATCH_LIMIT = 50;
const DEFAULT_SCOPE_FILE_LIMIT = 40;
const DEFAULT_SCOPE_BRANCH_LIMIT = 12;
const DEFAULT_SCOPE_BRANCH_FILE_CAP = 40;
const DEFAULT_REF_SCOPE_LIMIT = 50;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "your", "you",
  "are", "was", "were", "has", "have", "had", "not", "but", "fix", "bug", "bugs",
  "task", "work", "item", "make", "add", "new", "old", "use", "using", "used", "all",
  "any", "page", "file", "files", "line", "lines", "component", "components", "src",
  "app", "apps", "web", "www", "lib", "api", "route", "routes",
]);
const NODE_COLUMNS = `
  n.node_id AS nodeId,
  n.parent_node_id AS parentNodeId,
  n.kind,
  n.label,
  n.stable_ref AS stableRef,
  n.repo_rel_path AS repoRelPath,
  n.symbol_ref AS symbolRef,
  n.symbol_global_id AS symbolGlobalId,
  n.depth,
  n.sort_order AS sortOrder,
  n.child_count AS childCount,
  n.descendant_symbol_count AS descendantSymbolCount,
  n.descendant_file_count AS descendantFileCount,
  n.aggregates_json AS aggregatesJson,
  n.terms_json AS termsJson
`;
const TREE_TABLES = Object.freeze(["atlas_tree_nodes", "atlas_tree_refs", "derived_state_runs"]);
const TREE_SCOPE_TABLES = Object.freeze([
  "atlas_tree_scope_nodes",
  "atlas_tree_scope_terms",
  "atlas_tree_scope_term_stats",
  "atlas_tree_scope_symbol_files",
]);
const REF_TYPES = new Set(["cluster", "process"]);

function treeFocusRequested(params = {}) {
  return !!(params.path || params.nodeId || params.symbolId || params.refId || params.refType);
}

/**
 * Top-level tree orientation: the root view of the containment tree plus the
 * compressed-tree area map. Focused traversal belongs to tree.branch — a legacy
 * focus param still works here (served by the same traversal) but earns a
 * pointer warning.
 *
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeOverviewParams,
 * }} args
 */
export function treeOverview({ view, versionId, params = {} }) {
  return treeTraversal({ view, versionId, params, action: "tree.overview" });
}

/**
 * Walk a branch of the containment tree: focus a path/node/symbol/ref and
 * page through its descendants. The drill-down counterpart to tree.overview.
 *
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeOverviewParams,
 * }} args
 */
export function treeWalk({ view, versionId, params = {} }) {
  if (!treeFocusRequested(params)) {
    return errorEnvelope({
      action: "tree.branch",
      versionId,
      code: "invalid_params",
      message: "tree.branch requires a focus: pass path, nodeId, symbolId, or refType+refId. Use tree.overview for the top-level view.",
    });
  }
  return treeTraversal({ view, versionId, params, action: "tree.branch" });
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeOverviewParams,
 *   action: "tree.overview" | "tree.branch",
 * }} args
 */
function treeTraversal({ view, versionId, params = {}, action }) {
  const db = typeof /** @type {any} */ (view)._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  if (!db) {
    return errorEnvelope({
      action,
      versionId,
      code: "view_unavailable",
      message: `${action} requires an open ATLAS view database.`,
    });
  }
  const missing = missingTreeTables(db);
  if (missing.length > 0) {
    return okEnvelope({
      action,
      versionId,
      data: {
        available: false,
        reason: "tree_derived_tables_missing",
        missingTables: missing,
        focus: focusDescriptor(params),
        root: null,
        matches: [],
        matchTotal: 0,
        focusTruncated: false,
        nodes: [],
        total: 0,
        truncated: false,
        latestRun: null,
      },
    });
  }

  const includeAggregates = params.includeAggregates !== false;
  const includeTerms = params.includeTerms === true;
  const includeRefs = params.includeRefs === true;
  const includeLatestRun = params.includeLatestRun !== false;
  const maxDepth = clampInt(params.maxDepth, 0, 8, 1);
  const limit = clampInt(params.limit, 1, 500, 100);
  const offset = clampInt(params.offset, 0, 100_000, 0);
  const focus = resolveFocus(db, params);
  const matchTotal = Number(focus.matchTotal ?? focus.roots.length);
  const focusTruncated = matchTotal > focus.roots.length;
  const rootIds = focus.roots.map((node) => node.nodeId);
  const page = rootIds.length > 0
    ? readTreePage(db, rootIds, { maxDepth, limit, offset, includeAggregates, includeTerms })
    : { nodes: [], total: 0 };
  if (includeRefs) attachRefs(db, page.nodes);
  attachCompressionLabels(db, page.nodes);
  const latestRun = includeLatestRun ? readLatestRun(db) : null;

  const warnings = [...focus.warnings];
  const focused = treeFocusRequested(params);
  if (action === "tree.overview" && focused) {
    warnings.push("tree.overview is the top-level orientation view; use tree.branch for focused branch traversal.");
  }
  // The top-level view doubles as repo orientation: include the compressed
  // tree's labeled area map alongside the root page.
  let areaMap;
  if (action === "tree.overview" && !focused) {
    try {
      const snapshot = readLatestTreeCompressionSnapshot(db, { seedLimit: COMPRESSION_SEED_READ_LIMIT, withStaleness: true });
      if (snapshot?.available) areaMap = compressionAreaMap(snapshot.seeds);
    } catch { /* compression tables are optional */ }
  }

  return okEnvelope({
    action,
    versionId,
    data: {
      available: true,
      focus: focus.focus,
      root: focus.roots[0] || null,
      matches: focus.roots,
      matchTotal,
      focusTruncated,
      nodes: page.nodes,
      total: page.total,
      offset,
      limit,
      maxDepth,
      truncated: focusTruncated || offset + page.nodes.length < page.total,
      nextOffset: offset + page.nodes.length < page.total ? offset + page.nodes.length : null,
      latestRun,
      ...(areaMap ? { areaMap } : {}),
      warnings,
    },
  });
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeScopeParams,
 * }} args
 */
export function treeScope({ view, versionId, params = {} }) {
  return runTreeScope({ view, versionId, params, action: "tree.scope" });
}

function treeGrowSeedsRequested(params = {}) {
  const has = (value) => (Array.isArray(value) ? value.length > 0 : !!value);
  return has(params.paths) || has(params.editedFiles) || has(params.path)
    || has(params.symbolIds) || has(params.symbolId)
    || has(params.nodeIds) || has(params.refs) || !!(params.refType && params.refId);
}

/**
 * Grow the candidate scope outward from VALIDATED seeds (files/areas the
 * brief or the agent already confirmed matter): surrounding branches,
 * siblings, tests, and entrypoints. The agent-facing counterpart of
 * tree.scope, which is task-text driven and prefetch-only. No taskText —
 * the contract is "you already know these matter".
 *
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeScopeParams,
 * }} args
 */
export function treeGrow({ view, versionId, params = {} }) {
  if (!treeGrowSeedsRequested(params)) {
    return errorEnvelope({
      action: "tree.expand",
      versionId,
      code: "invalid_params",
      message: "tree.expand requires at least one seed: paths, editedFiles, symbolIds, nodeIds, or refType+refId.",
    });
  }
  const { taskText, taskType, ...seedParams } = /** @type {any} */ (params);
  void taskText; void taskType;
  return runTreeScope({ view, versionId, params: seedParams, action: "tree.expand" });
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeScopeParams,
 *   action: "tree.scope" | "tree.expand",
 * }} args
 */
function runTreeScope({ view, versionId, params = {}, action }) {
  const db = typeof /** @type {any} */ (view)._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  if (!db) {
    return errorEnvelope({
      action,
      versionId,
      code: "view_unavailable",
      message: `${action} requires an open ATLAS view database.`,
    });
  }
  const missing = missingTreeTables(db);
  if (missing.length > 0) {
    return okEnvelope({
      action,
      versionId,
      data: {
        available: false,
        reason: "tree_derived_tables_missing",
        missingTables: missing,
        queryTerms: [],
        seeds: emptyScopeSeedSummary(),
        candidateFiles: [],
        candidateDirs: [],
        refinementCandidates: [],
        rejectedBroadDirs: [],
        rejectedBroadRefs: [],
        metrics: emptyScopeMetrics(),
        compression: { available: false, reason: "tree_derived_tables_missing", matchedSeeds: [] },
        sidecar: { used: false, reason: "tree_derived_tables_missing" },
        warnings: ["Run index.refresh first if tree-derived state is missing or stale."],
      },
    });
  }

  /** @type {string[]} */
  const warnings = [];
  const model = readScopeModel(db, warnings);
  const opts = {
    maxFiles: clampInt(params.maxFiles, 1, 500, DEFAULT_SCOPE_FILE_LIMIT),
    maxBranches: clampInt(params.maxBranches, 1, 100, DEFAULT_SCOPE_BRANCH_LIMIT),
    branchFileCap: clampInt(params.branchFileCap, 1, 500, DEFAULT_SCOPE_BRANCH_FILE_CAP),
    refMatchLimit: clampInt(params.refMatchLimit, 1, 500, DEFAULT_REF_SCOPE_LIMIT),
  };
  const queryTerms = splitTerms(params.taskText || "");
  /** @type {Map<string, { file: any, score: number, reasons: Map<string, number>, exactSeed: boolean }>} */
  const fileScores = new Map();
  /** @type {Map<string, { node: any, score: number, reasons: Set<string> }>} */
  const branchScores = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const refinementCandidateMap = new Map();
  /** @type {Array<Record<string, unknown>>} */
  const rejectedBroadDirs = [];
  /** @type {Array<Record<string, unknown>>} */
  const rejectedBroadRefs = [];
  const traversalCache = createScopeTraversalCache();
  const seedSummary = collectScopeSeeds({
    db,
    model,
    params,
    opts,
    warnings,
    rejectedBroadDirs,
    rejectedBroadRefs,
    addFileScore: (file, score, reason, exactSeed = false) => addFileScore(fileScores, file, score, reason, exactSeed),
    addBranchScore: (branch, score, reason) => addBranchScore({
      model,
      fileScores,
      branchScores,
      rejectedBroadDirs,
      refinementCandidateMap,
      branch,
      score,
      reason,
      branchFileCap: opts.branchFileCap,
      traversalCache,
    }),
  });

  if (queryTerms.length > 0) {
    scoreTaskText({
      model,
      queryTerms,
      opts,
      fileScores,
      branchScores,
      rejectedBroadDirs,
      refinementCandidateMap,
      traversalCache,
    });
  }

  const compression = scoreCompressionSeeds({
    db,
    model,
    queryTerms,
    opts,
    fileScores,
    branchScores,
    rejectedBroadDirs,
    refinementCandidateMap,
    traversalCache,
  });

  const scope = selectScope({
    model,
    fileScores,
    branchScores,
    opts,
    traversalCache,
  });
  const metrics = scopeMetrics({
    model,
    candidateFiles: scope.candidateFiles,
    candidateDirs: scope.candidateDirs,
    rejectedBroadDirs,
    rejectedBroadRefs,
    queryTerms,
    seedSummary,
    taskType: params.taskType,
  });

  return okEnvelope({
    action,
    versionId,
    data: {
      available: true,
      queryTerms,
      seeds: seedSummary,
      candidateFiles: scope.candidateFiles.map(scopeFileSummary),
      candidateDirs: scope.candidateDirs.map(scopeDirSummary),
      refinementCandidates: refinementCandidateSummaries(
        refinementCandidateMap,
        new Set(scope.candidateFiles.map((entry) => String(entry.file?.repoRelPath || "")).filter(Boolean)),
      ),
      rejectedBroadDirs,
      rejectedBroadRefs,
      metrics,
      compression,
      sidecar: model.sidecar,
      warnings,
      latestRun: readLatestRun(db),
    },
  });
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {import("../contracts/tool-params.js").TreeOverviewParams} params
 */
function resolveFocus(db, params) {
  /** @type {string[]} */
  const warnings = [];
  const symbolId = stringParam(params.symbolId);
  const rawPath = stringParam(params.path);
  const path = normalizeRepoPath(rawPath);
  const hasPathParam = rawPath.length > 0;
  const invalidPathParam = hasPathParam && !path;
  const nodeId = stringParam(params.nodeId);
  const refType = stringParam(params.refType);
  const refId = stringParam(params.refId);

  if (refType || refId) {
    if (!REF_TYPES.has(refType) || !refId) {
      return {
        focus: { type: "ref", refType: refType || null, refId: refId || null },
        roots: [],
        warnings: ["ref lookup requires refType cluster|process and refId."],
      };
    }
    const matchTotal = Number(db.prepare(
      `SELECT COUNT(*) AS cnt
       FROM atlas_tree_refs
       WHERE ref_type = ? AND ref_id = ?`,
    ).get(refType, refId)?.cnt || 0);
    if (matchTotal > FOCUS_MATCH_LIMIT) {
      warnings.push(`ref lookup matched ${matchTotal} tree locations; returning first ${FOCUS_MATCH_LIMIT}.`);
    }
    return {
      focus: { type: "ref", refType, refId },
      roots: rowsToNodes(db.prepare(
        `SELECT ${NODE_COLUMNS}
         FROM atlas_tree_refs r
         JOIN atlas_tree_nodes n ON n.node_id = r.node_id
         WHERE r.ref_type = ? AND r.ref_id = ?
         ORDER BY n.depth ASC, n.sort_order ASC, n.node_id ASC
         LIMIT ?`,
      ).all(refType, refId, FOCUS_MATCH_LIMIT), { includeAggregates: true, includeTerms: false }),
      matchTotal,
      warnings,
    };
  }

  if (nodeId) {
    const rows = db.prepare(`SELECT ${NODE_COLUMNS} FROM atlas_tree_nodes n WHERE n.node_id = ?`).all(nodeId);
    return {
      focus: { type: "nodeId", value: nodeId },
      roots: rowsToNodes(rows, {
        includeAggregates: true,
        includeTerms: false,
      }),
      matchTotal: rows.length,
      warnings,
    };
  }

  if (symbolId) {
    if (invalidPathParam) {
      return {
        focus: { type: "symbolId", value: symbolId, path: rawPath },
        roots: [],
        matchTotal: 0,
        warnings: [INVALID_PATH_WARNING],
      };
    }
    const matchTotal = Number(db.prepare(
      `SELECT COUNT(*) AS cnt
       FROM atlas_tree_nodes n
       WHERE n.symbol_ref = ?
         AND (? IS NULL OR n.repo_rel_path = ?)`,
    ).get(symbolId, path || null, path || null)?.cnt || 0);
    const roots = rowsToNodes(db.prepare(
      `SELECT ${NODE_COLUMNS}
       FROM atlas_tree_nodes n
       WHERE n.symbol_ref = ?
         AND (? IS NULL OR n.repo_rel_path = ?)
       ORDER BY n.depth ASC, n.sort_order ASC, n.node_id ASC
       LIMIT ?`,
    ).all(symbolId, path || null, path || null, FOCUS_MATCH_LIMIT), { includeAggregates: true, includeTerms: false });
    if (roots.length > 1) {
      warnings.push("symbolId maps to multiple tree locations; pass path to disambiguate.");
    }
    if (matchTotal > FOCUS_MATCH_LIMIT) {
      warnings.push(`symbolId matched ${matchTotal} tree locations; returning first ${FOCUS_MATCH_LIMIT}.`);
    }
    return {
      focus: { type: "symbolId", value: symbolId, path: path || null },
      roots,
      matchTotal,
      warnings,
    };
  }

  if (hasPathParam) {
    if (invalidPathParam) {
      return {
        focus: { type: "path", value: rawPath },
        roots: [],
        matchTotal: 0,
        warnings: [INVALID_PATH_WARNING],
      };
    }
    const rows = db.prepare(
      `SELECT ${NODE_COLUMNS}
       FROM atlas_tree_nodes n
       WHERE n.node_id = ?
          OR n.repo_rel_path = ?
       ORDER BY CASE WHEN n.node_id = ? THEN 0 ELSE 1 END,
                n.depth ASC, n.sort_order ASC, n.node_id ASC
       LIMIT 50`,
    ).all(`dir:${path}`, path, `dir:${path}`);
    return {
      focus: { type: "path", value: path },
      roots: rowsToNodes(rows, { includeAggregates: true, includeTerms: false }),
      matchTotal: rows.length,
      warnings,
    };
  }

  return {
    focus: { type: "root", value: "root" },
    roots: rowsToNodes(db.prepare(`SELECT ${NODE_COLUMNS} FROM atlas_tree_nodes n WHERE n.node_id = 'root'`).all(), {
      includeAggregates: true,
      includeTerms: false,
    }),
    matchTotal: 1,
    warnings,
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string[]} rootIds
 * @param {{ maxDepth: number, limit: number, offset: number, includeAggregates: boolean, includeTerms: boolean }} opts
 */
function readTreePage(db, rootIds, opts) {
  const placeholders = rootIds.map(() => "?").join(", ");
  const baseParams = [...rootIds, opts.maxDepth];
  const countRow = db.prepare(
    `WITH RECURSIVE tree(node_id, relative_depth) AS (
       SELECT node_id, 0 FROM atlas_tree_nodes WHERE node_id IN (${placeholders})
       UNION ALL
       SELECT child.node_id, tree.relative_depth + 1
       FROM atlas_tree_nodes child
       JOIN tree ON child.parent_node_id = tree.node_id
       WHERE tree.relative_depth < ?
     )
     SELECT COUNT(*) AS cnt FROM tree`,
  ).get(...baseParams);
  const rows = db.prepare(
    `WITH RECURSIVE tree(node_id, relative_depth) AS (
       SELECT node_id, 0 FROM atlas_tree_nodes WHERE node_id IN (${placeholders})
       UNION ALL
       SELECT child.node_id, tree.relative_depth + 1
       FROM atlas_tree_nodes child
       JOIN tree ON child.parent_node_id = tree.node_id
       WHERE tree.relative_depth < ?
     )
     SELECT ${NODE_COLUMNS}, tree.relative_depth AS relativeDepth
     FROM tree
     JOIN atlas_tree_nodes n ON n.node_id = tree.node_id
     ORDER BY tree.relative_depth ASC, n.depth ASC, n.sort_order ASC, n.node_id ASC
     LIMIT ? OFFSET ?`,
  ).all(...baseParams, opts.limit, opts.offset);
  return {
    total: Number(countRow?.cnt || 0),
    nodes: rowsToNodes(rows, opts),
  };
}

/**
 * Annotate walked nodes with their compressed-tree labels, so drilling a
 * branch via tree.overview shows the labeled area map instead of bare dir
 * names. Best-effort: compression tables are optional.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Array<Record<string, unknown>>} nodes
 */
function attachCompressionLabels(db, nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return;
  let snapshot;
  try {
    snapshot = readLatestTreeCompressionSnapshot(db, { seedLimit: 500, withStaleness: true });
  } catch {
    return;
  }
  if (!snapshot?.available || snapshot.seeds.length === 0) return;
  const labelByPath = new Map();
  for (const seed of snapshot.seeds) {
    const path = String(seed?.path || "").trim();
    const label = String(seed?.label || "").trim();
    if (path && label && !labelByPath.has(path)) labelByPath.set(path, seed);
  }
  for (const node of nodes) {
    const path = typeof node.repoRelPath === "string" ? node.repoRelPath : null;
    if (!path) continue;
    const seed = labelByPath.get(path);
    if (seed) {
      node.areaLabel = String(seed.label).trim();
      if (seed.labelStale === true) node.areaLabelStale = true;
    }
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {Array<Record<string, unknown>>} nodes
 */
function attachRefs(db, nodes) {
  if (nodes.length === 0) return;
  const byId = new Map(nodes.map((node) => [String(node.nodeId), node]));
  const placeholders = nodes.map(() => "?").join(", ");
  const refs = db.prepare(
    `SELECT node_id AS nodeId, ref_type AS refType, ref_id AS refId, weight
     FROM atlas_tree_refs
     WHERE node_id IN (${placeholders})
     ORDER BY node_id ASC, ref_type ASC, ref_id ASC`,
  ).all(...nodes.map((node) => node.nodeId));
  for (const ref of refs) {
    const node = byId.get(String(ref.nodeId));
    if (!node) continue;
    if (!Array.isArray(node.refs)) node.refs = [];
    node.refs.push({
      refType: ref.refType,
      refId: ref.refId,
      weight: Number(ref.weight || 0),
    });
  }
}

/**
 * @param {unknown[]} rows
 * @param {{ includeAggregates: boolean, includeTerms: boolean }} opts
 */
function rowsToNodes(rows, opts) {
  return rows.map((row) => {
    const obj = /** @type {Record<string, unknown>} */ (row);
    /** @type {Record<string, unknown>} */
    const node = {
      nodeId: String(obj.nodeId || ""),
      parentNodeId: obj.parentNodeId ? String(obj.parentNodeId) : null,
      kind: String(obj.kind || ""),
      label: String(obj.label || ""),
      stableRef: String(obj.stableRef || ""),
      repoRelPath: obj.repoRelPath ? String(obj.repoRelPath) : null,
      symbolRef: obj.symbolRef ? String(obj.symbolRef) : null,
      symbolGlobalId: obj.symbolGlobalId == null ? null : Number(obj.symbolGlobalId),
      depth: Number(obj.depth || 0),
      relativeDepth: obj.relativeDepth == null ? 0 : Number(obj.relativeDepth || 0),
      sortOrder: Number(obj.sortOrder || 0),
      childCount: Number(obj.childCount || 0),
      descendantSymbolCount: Number(obj.descendantSymbolCount || 0),
      descendantFileCount: Number(obj.descendantFileCount || 0),
    };
    if (opts.includeAggregates) node.aggregates = parseJsonObject(obj.aggregatesJson);
    if (opts.includeTerms) node.terms = parseJsonArray(obj.termsJson);
    return node;
  });
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readLatestRun(db) {
  const row = db.prepare(
    `SELECT built_at AS builtAt, status, duration_ms AS durationMs, details_json AS detailsJson
     FROM derived_state_runs
     WHERE kind = ?
     ORDER BY id DESC
     LIMIT 1`,
  ).get(TREE_RUN_KIND);
  return row ? {
    builtAt: row.builtAt,
    status: row.status,
    durationMs: Number(row.durationMs || 0),
    details: parseJsonObject(row.detailsJson),
  } : null;
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function missingTreeTables(db) {
  return missingTables(db, TREE_TABLES);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {readonly string[]} tableNames
 */
function missingTables(db, tableNames) {
  try {
    const present = new Set(db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN (${tableNames.map(() => "?").join(", ")})`,
    ).all(...tableNames).map((row) => String(row.name || "")));
    return tableNames.filter((name) => !present.has(name));
  } catch {
    return [...tableNames];
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function scopeSidecarLooksCurrent(db) {
  try {
    const treeFiles = db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes WHERE kind = 'file'").get();
    const sidecarFiles = db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_nodes WHERE kind = 'file'").get();
    const treeSymbols = db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes WHERE symbol_ref IS NOT NULL").get();
    const sidecarSymbols = db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_symbol_files").get();
    return Number(treeFiles?.cnt || 0) === Number(sidecarFiles?.cnt || 0)
      && Number(treeSymbols?.cnt || 0) === Number(sidecarSymbols?.cnt || 0);
  } catch {
    return false;
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string[]} warnings
 */
function readScopeModel(db, warnings) {
  const sidecar = readScopeSidecarModel(db);
  if (sidecar) return sidecar;
  const missing = missingTables(db, TREE_SCOPE_TABLES);
  const reason = missing.length > 0 ? `missing ${missing.join(", ")}` : "stale or incomplete sidecar";
  warnings.push(`tree.scope sidecar unavailable (${reason}); rebuilt projection from tree nodes for this call.`);
  return readHotScopeModel(db, reason);
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readScopeSidecarModel(db) {
  const missing = missingTables(db, TREE_SCOPE_TABLES);
  if (missing.length > 0 || !scopeSidecarLooksCurrent(db)) return null;
  const rows = db.prepare(
    `SELECT node_id AS nodeId, parent_node_id AS parentNodeId, kind, label,
            repo_rel_path AS repoRelPath, depth, sort_order AS sortOrder,
            descendant_symbol_count AS descendantSymbolCount,
            descendant_file_count AS descendantFileCount,
            generated, test, config,
            aggregates_json AS aggregatesJson, terms_json AS termsJson,
            projected_terms_json AS projectedTermsJson
     FROM atlas_tree_scope_nodes
     ORDER BY depth ASC, sort_order ASC, node_id ASC`,
  ).all();
  const nodes = rows.map((row) => {
    const obj = /** @type {Record<string, unknown>} */ (row);
    const terms = new Set(parseJsonArray(obj.termsJson).map((term) => String(term).toLowerCase()).filter(Boolean));
    const projectedTerms = new Set(parseJsonArray(obj.projectedTermsJson).map((term) => String(term).toLowerCase()).filter(Boolean));
    return {
      nodeId: String(obj.nodeId || ""),
      parentNodeId: obj.parentNodeId ? String(obj.parentNodeId) : null,
      kind: String(obj.kind || ""),
      label: String(obj.label || ""),
      stableRef: String(obj.nodeId || ""),
      repoRelPath: obj.repoRelPath ? String(obj.repoRelPath) : null,
      symbolRef: null,
      symbolGlobalId: null,
      depth: Number(obj.depth || 0),
      sortOrder: Number(obj.sortOrder || 0),
      childCount: 0,
      descendantSymbolCount: Number(obj.descendantSymbolCount || 0),
      descendantFileCount: Number(obj.descendantFileCount || 0),
      aggregates: parseJsonObject(obj.aggregatesJson),
      generated: Number(obj.generated || 0) > 0,
      test: Number(obj.test || 0) > 0,
      config: Number(obj.config || 0) > 0,
      terms,
      projectedTerms: projectedTerms.size > 0 ? projectedTerms : new Set(terms),
      children: [],
    };
  });
  const model = assembleScopeModel(nodes, {
    sidecar: {
      used: true,
      source: "atlas_tree_scope_nodes",
      files: 0,
      dirs: 0,
      terms: Number(db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_term_stats").get()?.cnt || 0),
    },
    directDocFreq: readScopeTermStats(db, "direct_file_count"),
    projectedDocFreq: readScopeTermStats(db, "projected_file_count"),
  });
  attachSidecarSymbolNodes(db, model);
  model.sidecar.files = model.fileNodes.length;
  model.sidecar.dirs = model.dirNodes.length;
  return model;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} reason
 */
function readHotScopeModel(db, reason) {
  const rows = db.prepare(
    `SELECT ${NODE_COLUMNS}
     FROM atlas_tree_nodes n
     ORDER BY n.depth ASC, n.sort_order ASC, n.node_id ASC`,
  ).all();
  const nodes = rows.map((row) => {
    const obj = /** @type {Record<string, unknown>} */ (row);
    const terms = new Set(parseJsonArray(obj.termsJson).map((term) => String(term).toLowerCase()).filter(Boolean));
    for (const term of splitTerms([obj.label, obj.repoRelPath, obj.stableRef].join(" "))) terms.add(term);
    return {
      nodeId: String(obj.nodeId || ""),
      parentNodeId: obj.parentNodeId ? String(obj.parentNodeId) : null,
      kind: String(obj.kind || ""),
      label: String(obj.label || ""),
      stableRef: String(obj.stableRef || ""),
      repoRelPath: obj.repoRelPath ? String(obj.repoRelPath) : null,
      symbolRef: obj.symbolRef ? String(obj.symbolRef) : null,
      symbolGlobalId: obj.symbolGlobalId == null ? null : Number(obj.symbolGlobalId),
      depth: Number(obj.depth || 0),
      sortOrder: Number(obj.sortOrder || 0),
      childCount: Number(obj.childCount || 0),
      descendantSymbolCount: Number(obj.descendantSymbolCount || 0),
      descendantFileCount: Number(obj.descendantFileCount || 0),
      aggregates: parseJsonObject(obj.aggregatesJson),
      terms,
      projectedTerms: new Set(terms),
      children: [],
    };
  });
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  for (const node of nodes.slice().sort((a, b) => b.depth - a.depth || compareNodeLike(a, b))) {
    if (!node.parentNodeId) continue;
    const parent = byId.get(node.parentNodeId);
    if (!parent) continue;
    for (const term of node.projectedTerms) parent.projectedTerms.add(term);
  }
  return assembleScopeModel(nodes, {
    sidecar: { used: false, source: "hot", reason },
  });
}

/**
 * @param {any[]} nodes
 * @param {{ sidecar: Record<string, unknown>, directDocFreq?: Map<string, number>, projectedDocFreq?: Map<string, number> }} opts
 */
function assembleScopeModel(nodes, opts) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const fileByPath = new Map();
  const dirByPath = new Map();
  const symbolsByRef = new Map();
  for (const node of nodes) {
    if (node.parentNodeId && byId.has(node.parentNodeId)) byId.get(node.parentNodeId).children.push(node);
    if (node.kind === "file" && node.repoRelPath) fileByPath.set(node.repoRelPath, node);
    if (node.kind === "dir" && node.repoRelPath) dirByPath.set(node.repoRelPath, node);
    if (node.symbolRef) {
      if (!symbolsByRef.has(node.symbolRef)) symbolsByRef.set(node.symbolRef, []);
      symbolsByRef.get(node.symbolRef).push(node);
    }
  }
  const fileNodes = nodes.filter((node) => node.kind === "file" && node.repoRelPath);
  const dirNodes = nodes.filter((node) => node.kind === "dir" && node.repoRelPath);
  return {
    nodes,
    byId,
    fileNodes,
    dirNodes,
    fileByPath,
    dirByPath,
    symbolsByRef,
    totalFiles: fileNodes.length,
    projectedDocFreq: opts.projectedDocFreq || documentFrequency(fileNodes, "projectedTerms"),
    directDocFreq: opts.directDocFreq || documentFrequency(fileNodes, "terms"),
    sidecar: opts.sidecar,
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {ReturnType<typeof assembleScopeModel>} model
 */
function attachSidecarSymbolNodes(db, model) {
  const rows = db.prepare(
    `SELECT symbol_ref AS symbolRef, symbol_node_id AS symbolNodeId,
            file_node_id AS fileNodeId, repo_rel_path AS repoRelPath
     FROM atlas_tree_scope_symbol_files
     ORDER BY symbol_ref ASC, symbol_node_id ASC`,
  ).all();
  for (const row of rows) {
    const repoRelPath = String(row.repoRelPath || "");
    const file = model.fileByPath.get(repoRelPath);
    if (!file) continue;
    const symbolRef = String(row.symbolRef || "");
    const node = {
      nodeId: String(row.symbolNodeId || ""),
      parentNodeId: String(row.fileNodeId || file.nodeId),
      kind: "symbol",
      label: symbolRef,
      stableRef: String(row.symbolNodeId || ""),
      repoRelPath,
      symbolRef,
      symbolGlobalId: null,
      depth: Number(file.depth || 0) + 1,
      sortOrder: 0,
      childCount: 0,
      descendantSymbolCount: 1,
      descendantFileCount: 0,
      aggregates: {},
      terms: new Set([symbolRef]),
      projectedTerms: new Set([symbolRef]),
      children: [],
    };
    model.byId.set(node.nodeId, node);
    if (!model.symbolsByRef.has(symbolRef)) model.symbolsByRef.set(symbolRef, []);
    model.symbolsByRef.get(symbolRef).push(node);
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {"direct_file_count" | "projected_file_count"} column
 */
function readScopeTermStats(db, column) {
  const rows = db.prepare(`SELECT term, ${column} AS cnt FROM atlas_tree_scope_term_stats`).all();
  const out = new Map();
  for (const row of rows) out.set(String(row.term || ""), Number(row.cnt || 0));
  return out;
}

function emptyScopeSeedSummary() {
  return {
    taskText: false,
    paths: [],
    symbolIds: [],
    nodeIds: [],
    refs: [],
    exactFileSeeds: 0,
    matchedFiles: 0,
    matchedSymbols: 0,
    matchedDirs: 0,
    broadRefs: 0,
  };
}

function emptyScopeMetrics() {
  return {
    candidateFileCount: 0,
    estimatedTouchedFiles: 0,
    candidateDirCount: 0,
    areasTouched: 0,
    largestAreaFileCount: 0,
    generatedFileCount: 0,
    testFileCount: 0,
    configFileCount: 0,
    sourceFileCount: 0,
    symbolCount: 0,
    compression: 0,
    confidence: 0,
    scopeBand: "none",
    scopeRisk: "low",
    testsLikelyNeeded: false,
    generatedOrConfigTouched: false,
  };
}

/**
 * @param {{
 *   db: import("better-sqlite3").Database,
 *   model: ReturnType<typeof readScopeModel>,
 *   params: import("../contracts/tool-params.js").TreeScopeParams,
 *   opts: { maxFiles: number, maxBranches: number, branchFileCap: number, refMatchLimit: number },
 *   warnings: string[],
 *   rejectedBroadDirs: Array<Record<string, unknown>>,
 *   rejectedBroadRefs: Array<Record<string, unknown>>,
 *   addFileScore: (file: any, score: number, reason: string, exactSeed?: boolean) => void,
 *   addBranchScore: (branch: any, score: number, reason: string) => void,
 * }} args
 */
function collectScopeSeeds(args) {
  const { db, model, params, opts, warnings, addFileScore: addFile, addBranchScore: addBranch } = args;
  const paths = uniqueStrings([
    ...arrayOfStrings(params.paths),
    ...arrayOfStrings(params.editedFiles),
    ...(params.path ? [params.path] : []),
  ]);
  const symbolIds = uniqueStrings([
    ...arrayOfStrings(params.symbolIds),
    ...(params.symbolId ? [params.symbolId] : []),
  ]);
  const nodeIds = uniqueStrings(arrayOfStrings(params.nodeIds));
  const refs = normalizeScopeRefs(params);
  const summary = {
    ...emptyScopeSeedSummary(),
    taskText: !!String(params.taskText || "").trim(),
    paths: [],
    symbolIds: [],
    nodeIds: [],
    refs,
  };

  for (const rawPath of paths) {
    const path = normalizeRepoPath(rawPath);
    if (!path) {
      warnings.push(`Ignored non-canonical scope path: ${String(rawPath || "").slice(0, 160)}`);
      continue;
    }
    summary.paths.push(path);
    const file = model.fileByPath.get(path);
    if (file) {
      summary.exactFileSeeds += 1;
      summary.matchedFiles += 1;
      addFile(file, 120, `seed:path:${path}`, true);
      continue;
    }
    const dir = model.dirByPath.get(path);
    if (dir) {
      summary.matchedDirs += 1;
      addBranch(dir, 90, `seed:dir:${path}`);
      continue;
    }
    warnings.push(`Scope path was not found in the tree: ${path}`);
  }

  for (const symbolId of symbolIds) {
    summary.symbolIds.push(symbolId);
    const nodes = model.symbolsByRef.get(symbolId) || [];
    if (nodes.length === 0) {
      warnings.push(`Scope symbol was not found in the tree: ${symbolId}`);
      continue;
    }
    summary.matchedSymbols += nodes.length;
    for (const symbolNode of nodes.slice(0, opts.refMatchLimit)) {
      const file = fileForNode(model, symbolNode);
      if (file) addFile(file, 110, `seed:symbol:${symbolId}`, true);
    }
    if (nodes.length > opts.refMatchLimit) {
      warnings.push(`Scope symbol matched ${nodes.length} tree locations; scored first ${opts.refMatchLimit}.`);
    }
  }

  for (const nodeId of nodeIds) {
    summary.nodeIds.push(nodeId);
    const node = model.byId.get(nodeId);
    if (!node) {
      warnings.push(`Scope node was not found in the tree: ${nodeId}`);
      continue;
    }
    if (node.kind === "file") {
      summary.exactFileSeeds += 1;
      summary.matchedFiles += 1;
      addFile(node, 105, `seed:node:${nodeId}`, true);
    } else if (node.symbolRef) {
      const file = fileForNode(model, node);
      if (file) {
        summary.matchedSymbols += 1;
        addFile(file, 105, `seed:node:${nodeId}`, true);
      }
    } else if (node.kind === "dir") {
      summary.matchedDirs += 1;
      addBranch(node, 85, `seed:node:${nodeId}`);
    }
  }

  for (const ref of refs) {
    const count = Number(db.prepare(
      `SELECT COUNT(*) AS cnt FROM atlas_tree_refs WHERE ref_type = ? AND ref_id = ?`,
    ).get(ref.refType, ref.refId)?.cnt || 0);
    if (count === 0) {
      warnings.push(`Scope ref was not found in the tree: ${ref.refType}:${ref.refId}`);
      continue;
    }
    if (count > opts.refMatchLimit) {
      summary.broadRefs += 1;
      args.rejectedBroadRefs.push({
        refType: ref.refType,
        refId: ref.refId,
        matchCount: count,
        reason: "ref_scope_too_broad",
      });
      continue;
    }
    const rows = db.prepare(
      `SELECT n.node_id AS nodeId
       FROM atlas_tree_refs r
       JOIN atlas_tree_nodes n ON n.node_id = r.node_id
       WHERE r.ref_type = ? AND r.ref_id = ?
       ORDER BY n.depth ASC, n.sort_order ASC, n.node_id ASC
       LIMIT ?`,
    ).all(ref.refType, ref.refId, opts.refMatchLimit);
    for (const row of rows) {
      const node = model.byId.get(String(row.nodeId || ""));
      const file = node ? fileForNode(model, node) : null;
      if (file) addFile(file, 55, `seed:ref:${ref.refType}:${ref.refId}`, false);
    }
  }

  return summary;
}

function scoreTaskText({ model, queryTerms, opts, fileScores, branchScores, rejectedBroadDirs, refinementCandidateMap, traversalCache }) {
  const qtf = termFrequency(queryTerms);
  const topFiles = model.fileNodes
    .map((file) => ({ file, score: lexicalScopeFileScore(file, qtf, model) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.file.repoRelPath || "").localeCompare(String(b.file.repoRelPath || "")))
    .slice(0, Math.max(opts.maxFiles * 3, 50));
  const fileFloor = topFiles.length > 0 ? Math.max(1.5, topFiles[0].score * 0.18) : Infinity;
  for (const entry of topFiles) {
    if (entry.score < fileFloor) continue;
    addFileScore(fileScores, entry.file, entry.score, "task:file", false);
  }

  const topDirs = model.dirNodes
    .map((dir) => ({ dir, score: lexicalScopeDirScore(dir, qtf, model) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.dir.descendantFileCount || 0) - Number(b.dir.descendantFileCount || 0))
    .slice(0, Math.max(opts.maxBranches * 4, 20));
  const dirFloor = topDirs.length > 0 ? Math.max(1, topDirs[0].score * 0.3) : Infinity;
  for (const entry of topDirs) {
    if (entry.score < dirFloor) continue;
    addBranchScore({
      model,
      fileScores,
      branchScores,
      rejectedBroadDirs,
      refinementCandidateMap,
      branch: entry.dir,
      score: entry.score,
      reason: "task:dir",
      branchFileCap: opts.branchFileCap,
      traversalCache,
    });
  }
}

// Fold the compressed tree (tree-compression seed annotations) into scope
// scoring. Seeds act as a vocabulary bridge: a task phrased in domain words
// ("rating logic") can reach an area whose paths/terms never mention them via
// the seed's label/alias vocabulary, and a seed's entrypoints pin the files
// most likely to matter inside a matched area. Advisory only — seeds boost
// candidates through the same scoring rails as task-text matching; they never
// gate or replace raw tree evidence.
const COMPRESSION_SEED_READ_LIMIT = 200;
const COMPRESSION_MATCH_LIMIT = 8;

// Confidence is an internal ranking signal; surfaced output gets words, not
// numbers — an unanchored "0.83" means nothing to a model reading the result.
function confidenceBand(value) {
  const n = Math.max(0, Math.min(1, Number(value) || 0));
  if (n >= 0.75) return "high";
  if (n >= 0.45) return "medium";
  return "low";
}
function scoreCompressionSeeds({ db, model, queryTerms, opts, fileScores, branchScores, rejectedBroadDirs, refinementCandidateMap, traversalCache }) {
  let snapshot;
  try {
    snapshot = readLatestTreeCompressionSnapshot(db, { seedLimit: COMPRESSION_SEED_READ_LIMIT, withStaleness: true });
  } catch {
    return { available: false, reason: "tree_compression_read_failed", profile: null, matchedSeeds: [] };
  }
  if (!snapshot?.available) {
    return { available: false, reason: snapshot?.reason || "tree_compression_unavailable", profile: null, matchedSeeds: [] };
  }
  const profile = snapshot.snapshot?.profile || null;
  if (queryTerms.length === 0) {
    return { available: true, reason: null, profile, matchedSeeds: [] };
  }
  const querySet = new Set(queryTerms);
  // Ubiquitous-vocabulary filter: deterministic seed terms inherit extraction
  // noise (var/const/function/tsx appear in nearly every area's aliases). A
  // term carried by a large share of seeds has no discriminative power, so it
  // can't count as a hit. Absolute floor keeps tiny snapshots intact.
  const seedTermSets = snapshot.seeds.map((seed) => new Set(splitTerms([seed.label, ...(seed.aliases || [])].join(" "))));
  const termSeedCounts = new Map();
  for (const terms of seedTermSets) {
    for (const term of terms) termSeedCounts.set(term, (termSeedCounts.get(term) || 0) + 1);
  }
  const ubiquityFloor = Math.max(4, Math.ceil(snapshot.seeds.length * 0.25));
  const isUbiquitousTerm = (term) => (termSeedCounts.get(term) || 0) >= ubiquityFloor;
  const matched = [];
  for (let i = 0; i < snapshot.seeds.length; i++) {
    const seed = snapshot.seeds[i];
    const seedTerms = seedTermSets[i];
    let hits = 0;
    for (const term of querySet) {
      if (seedTerms.has(term) && !isUbiquitousTerm(term)) hits += 1;
    }
    if (hits === 0) continue;
    // The seed's own guard: when every query term sits in the avoid list, the
    // match is vocabulary noise for this area ("generic UI polish") — skip it.
    const avoidTerms = new Set(splitTerms((seed.avoidIfQueryOnlyMentions || []).join(" ")));
    if (avoidTerms.size > 0 && [...querySet].every((term) => avoidTerms.has(term))) continue;
    const confidence = Math.max(0, Math.min(1, Number(seed.confidence) || 0));
    const score = hits * (4 + 6 * confidence);
    const node = model.byId.get(seed.nodeId)
      || model.dirByPath.get(seed.path)
      || model.fileByPath.get(seed.path);
    // Broad root areas (apps, www, src) match almost any task vocabulary;
    // boosting them — or their entrypoints — floods the candidate set with
    // top-level pages. Mirror addBranchScore's own broad-dir rejection: areas
    // over the branch file cap stay advisory (label reported, no score).
    const tooBroadToBoost = node?.kind === "dir"
      && Number(node.descendantFileCount || 0) > opts.branchFileCap;
    const entrypoints = (seed.entrypoints || []).slice(0, 4);
    if (!tooBroadToBoost) {
      if (node?.kind === "file") {
        addFileScore(fileScores, node, score, `compression:${seed.path}`, false);
      } else if (node) {
        addBranchScore({
          model,
          fileScores,
          branchScores,
          rejectedBroadDirs,
          refinementCandidateMap,
          branch: node,
          score,
          reason: `compression:${seed.path}`,
          branchFileCap: opts.branchFileCap,
          traversalCache,
        });
      }
      for (const entry of entrypoints) {
        const file = model.fileByPath.get(normalizeRepoPath(entry));
        if (file) addFileScore(fileScores, file, score * 1.5, `compression:entry:${seed.path}`, false);
      }
    }
    matched.push({
      path: seed.path,
      label: seed.label,
      confidence,
      hits,
      entrypoints,
      ...(seed.labelStale === true ? { labelStale: true } : {}),
    });
  }
  matched.sort((a, b) => b.hits - a.hits
    || b.confidence - a.confidence
    || String(a.path || "").localeCompare(String(b.path || "")));
  return {
    available: true,
    reason: null,
    profile,
    matchedSeeds: matched.slice(0, COMPRESSION_MATCH_LIMIT)
      .map((seed) => ({ ...seed, confidence: confidenceBand(seed.confidence) })),
    areaMap: compressionAreaMap(snapshot.seeds),
  };
}

// Compact labeled repo orientation from the compressed tree: the most specific
// annotated areas, with ancestor chains collapsed (apps → apps/web →
// apps/web/src all carry near-identical labels; only the deepest tells the
// reader something). This is the handoff's "what lives where" map — small
// enough to inline, drilled into via tree.overview when an area matters.
const COMPRESSION_AREA_MAP_LIMIT = 16;
function compressionAreaMap(seeds) {
  const byPath = new Map();
  for (const seed of seeds) {
    const path = String(seed?.path || "").trim();
    if (!path || !String(seed?.label || "").trim()) continue;
    if (!byPath.has(path)) byPath.set(path, seed);
  }
  const paths = [...byPath.keys()];
  const hasDescendantSeed = (path) => paths.some((other) => other !== path && other.startsWith(`${path}/`));
  return paths
    .filter((path) => !hasDescendantSeed(path))
    .map((path) => {
      const seed = byPath.get(path);
      return {
        path,
        label: String(seed.label),
        confidence: Math.max(0, Math.min(1, Number(seed.confidence) || 0)),
        ...(seed.labelStale === true ? { labelStale: true } : {}),
      };
    })
    .sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path))
    .slice(0, COMPRESSION_AREA_MAP_LIMIT)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((area) => ({ ...area, confidence: confidenceBand(area.confidence) }));
  // Note: labelStale flags ride through the spread above; stale labels stay in
  // the map (an approximate label beats no label) but readers see the caveat.
}

function lexicalScopeFileScore(file, qtf, model) {
  let score = 0;
  const pathText = String(file.repoRelPath || "").toLowerCase();
  const basenameTerms = new Set(splitTerms(pathBasename(file.repoRelPath)));
  for (const [term, count] of qtf.entries()) {
    const directIdf = idf(term, model.directDocFreq, model.fileNodes.length);
    const projectedIdf = idf(term, model.projectedDocFreq, model.fileNodes.length);
    if (basenameTerms.has(term)) score += count * directIdf * 8;
    if (file.terms.has(term)) score += count * directIdf * 5;
    else if (file.projectedTerms.has(term)) score += count * projectedIdf * 3;
    else if (term.length >= 4 && hasPrefixish(file.terms, term)) score += count * directIdf * 1.3;
    else if (term.length >= 4 && hasPrefixish(file.projectedTerms, term)) score += count * projectedIdf * 0.8;
    if (term.length >= 4 && pathText.includes(term)) score += count * directIdf * 1.2;
  }
  if (isGeneratedPath(file.repoRelPath || "") && !queryMentionsGenerated(qtf)) score *= 0.45;
  if (isTestPath(file.repoRelPath || "") && !queryMentionsTests(qtf)) score *= 0.75;
  return score;
}

function lexicalScopeDirScore(dir, qtf, model) {
  let score = 0;
  const pathText = String(dir.repoRelPath || "").toLowerCase();
  for (const [term, count] of qtf.entries()) {
    const projectedIdf = idf(term, model.projectedDocFreq, model.fileNodes.length);
    if (dir.terms.has(term)) score += count * projectedIdf * 5;
    else if (dir.projectedTerms.has(term)) score += count * projectedIdf * 1.8;
    else if (term.length >= 4 && hasPrefixish(dir.projectedTerms, term)) score += count * projectedIdf * 0.7;
    if (term.length >= 4 && pathText.includes(term)) score += count * projectedIdf * 1.4;
  }
  const files = Math.max(1, Number(dir.descendantFileCount || 1));
  return score / Math.sqrt(Math.min(60, files));
}

function addFileScore(fileScores, file, score, reason, exactSeed = false) {
  if (!file?.repoRelPath || score <= 0) return;
  const existing = fileScores.get(file.repoRelPath) || {
    file,
    score: 0,
    reasons: new Map(),
    exactSeed: false,
  };
  existing.score += score;
  existing.exactSeed = existing.exactSeed || exactSeed;
  existing.reasons.set(reason, (existing.reasons.get(reason) || 0) + score);
  fileScores.set(file.repoRelPath, existing);
}

function addBranchScore({ model, fileScores, branchScores, rejectedBroadDirs, refinementCandidateMap, branch, score, reason, branchFileCap, traversalCache }) {
  if (!branch?.repoRelPath || score <= 0) return;
  const files = descendantFiles(branch, traversalCache);
  const fileCount = files.length;
  if (fileCount === 0) return;
  if (fileCount > branchFileCap) {
    if (!rejectedBroadDirs.some((item) => item.path === branch.repoRelPath && item.reason === reason)) {
      rejectedBroadDirs.push({
        path: branch.repoRelPath,
        nodeId: branch.nodeId,
        fileCount,
        symbolCount: Number(branch.descendantSymbolCount || 0),
        score: roundScore(score),
        reason,
      });
    }
    addRefinementCandidates(refinementCandidateMap, branch, score, reason, branchFileCap);
    return;
  }
  const existing = branchScores.get(branch.nodeId) || { node: branch, score: 0, reasons: new Set() };
  existing.score += score;
  existing.reasons.add(reason);
  branchScores.set(branch.nodeId, existing);
  const perFile = score / Math.sqrt(Math.max(1, fileCount));
  for (const file of files) {
    if (model.fileByPath.has(file.repoRelPath)) addFileScore(fileScores, file, perFile, `branch:${branch.repoRelPath}`, false);
  }
}

function selectScope({ model, fileScores, branchScores, opts, traversalCache }) {
  const ranked = [...fileScores.values()]
    .sort((a, b) => Number(b.exactSeed) - Number(a.exactSeed) || b.score - a.score || String(a.file.repoRelPath || "").localeCompare(String(b.file.repoRelPath || "")));
  const topNonSeed = ranked.find((entry) => !entry.exactSeed)?.score || 0;
  const scoreFloor = topNonSeed > 0 ? Math.max(1.5, topNonSeed * 0.18) : 0;
  /** @type {Map<string, { file: any, score: number, reasons: string[], exactSeed: boolean }>} */
  const selectedFiles = new Map();
  /** @type {Map<string, { node: any, score: number, reasons: string[] }>} */
  const selectedBranches = new Map();

  for (const entry of ranked) {
    if (selectedFiles.size >= opts.maxFiles) break;
    if (!entry.exactSeed && entry.score < scoreFloor) continue;
    const branch = chooseBranchForFile(entry.file, model, opts.branchFileCap, traversalCache);
    const branchEntry = branch ? branchScores.get(branch.nodeId) : null;
    const branchFiles = branch ? descendantFiles(branch, traversalCache) : [entry.file];
    const newFiles = branchFiles.filter((file) => file?.repoRelPath && !selectedFiles.has(file.repoRelPath));
    const canAddBranch = branch
      && branch.kind !== "file"
      && (entry.exactSeed || branchEntry)
      && selectedBranches.size < opts.maxBranches
      && newFiles.length > 0
      && selectedFiles.size + newFiles.length <= opts.maxFiles;
    if (canAddBranch) {
      selectedBranches.set(branch.nodeId, {
        node: branch,
        score: roundScore(Math.max(entry.score, branchEntry?.score || 0)),
        reasons: uniqueStrings([
          ...(branchEntry ? [...branchEntry.reasons] : []),
          ...topReasonKeys(entry.reasons),
        ]),
      });
      for (const file of newFiles) {
        const own = fileScores.get(file.repoRelPath);
        // A sibling admitted purely because its branch was selected is
        // structural fill, not evidence. Inheriting the triggering entry's
        // score made route/lib siblings rank EQUAL to validated seeds and
        // flood the prompt-facing top of the candidate list — fill files get
        // a fraction of the trigger score and an explicit reason instead.
        selectedFiles.set(file.repoRelPath, {
          file,
          score: roundScore(own?.score ?? entry.score * 0.05),
          reasons: own ? topReasonKeys(own.reasons) : [`branch-fill:${branch.repoRelPath}`],
          exactSeed: !!own?.exactSeed,
        });
      }
      continue;
    }
    selectedFiles.set(entry.file.repoRelPath, {
      file: entry.file,
      score: roundScore(entry.score),
      reasons: topReasonKeys(entry.reasons),
      exactSeed: entry.exactSeed,
    });
  }

  return {
    candidateFiles: [...selectedFiles.values()]
      .sort((a, b) => Number(b.exactSeed) - Number(a.exactSeed) || b.score - a.score || String(a.file.repoRelPath || "").localeCompare(String(b.file.repoRelPath || ""))),
    candidateDirs: [...selectedBranches.values()]
      .sort((a, b) => b.score - a.score || String(a.node.repoRelPath || "").localeCompare(String(b.node.repoRelPath || ""))),
  };
}

function scopeMetrics({ model, candidateFiles, candidateDirs, rejectedBroadDirs, rejectedBroadRefs, queryTerms, seedSummary, taskType }) {
  const files = candidateFiles.map((entry) => entry.file);
  const candidateFileCount = files.length;
  const generatedFileCount = files.filter((file) => isGeneratedPath(file.repoRelPath || "")).length;
  const testFileCount = files.filter((file) => isTestPath(file.repoRelPath || "")).length;
  const configFileCount = files.filter((file) => isConfigPath(file.repoRelPath || "")).length;
  const sourceFileCount = files.filter((file) => !isTestPath(file.repoRelPath || "")).length;
  const symbolCount = files.reduce((sum, file) => sum + Number(file.descendantSymbolCount || 0), 0);
  const branchCounts = candidateDirs.map((entry) => Number(entry.node.descendantFileCount || 0));
  const largestAreaFileCount = branchCounts.length ? Math.max(...branchCounts) : candidateFileCount > 0 ? 1 : 0;
  const areasTouched = candidateDirs.length || (candidateFileCount > 0 ? new Set(files.map((file) => topArea(file.repoRelPath))).size : 0);
  const generatedOrConfigTouched = generatedFileCount > 0 || configFileCount > 0;
  const exactSeedCount = Number(seedSummary.exactFileSeeds || 0) + Number(seedSummary.matchedSymbols || 0);
  const testsLikelyNeeded = testFileCount > 0
    || queryMentionsTests(termFrequency(queryTerms))
    || (sourceFileCount > 0 && ["debug", "review", "implement"].includes(String(taskType || "")));
  const scopeBand = scopeBandFor(candidateFileCount, areasTouched);
  const queryCoverage = queryTermCoverage(files, candidateDirs.map((entry) => entry.node), queryTerms);
  const scopeRisk = scopeRiskFor({
    candidateFileCount,
    areasTouched,
    largestAreaFileCount,
    generatedOrConfigTouched,
    rejectedBroadDirs,
    rejectedBroadRefs,
    queryTermCoverage: queryCoverage,
  });
  return {
    candidateFileCount,
    estimatedTouchedFiles: exactSeedCount > 0 ? exactSeedCount : candidateFileCount,
    candidateDirCount: candidateDirs.length,
    areasTouched,
    largestAreaFileCount,
    generatedFileCount,
    testFileCount,
    configFileCount,
    sourceFileCount,
    symbolCount,
    compression: model.totalFiles > 0 ? roundScore(candidateFileCount / model.totalFiles) : 0,
    queryTermCoverage: queryCoverage,
    confidence: scopeConfidence({
      candidateFileCount,
      candidateFiles,
      queryTerms,
      seedSummary,
      rejectedBroadDirs,
      rejectedBroadRefs,
      scopeRisk,
      queryTermCoverage: queryCoverage,
    }),
    scopeBand,
    scopeRisk,
    testsLikelyNeeded,
    generatedOrConfigTouched,
    exactSeedCount,
    queryTermCount: queryTerms.length,
    broadRefCount: rejectedBroadRefs.length,
    broadDirCount: rejectedBroadDirs.length,
  };
}

function scopeFileSummary(entry) {
  const file = entry.file;
  return {
    path: file.repoRelPath,
    nodeId: file.nodeId,
    score: roundScore(entry.score),
    reasons: entry.reasons,
    exactSeed: !!entry.exactSeed,
    symbolCount: Number(file.descendantSymbolCount || 0),
    generated: isGeneratedPath(file.repoRelPath || ""),
    test: isTestPath(file.repoRelPath || ""),
    config: isConfigPath(file.repoRelPath || ""),
  };
}

function scopeDirSummary(entry) {
  const node = entry.node;
  return {
    path: node.repoRelPath,
    nodeId: node.nodeId,
    score: roundScore(entry.score),
    reasons: entry.reasons,
    fileCount: Number(node.descendantFileCount || 0),
    symbolCount: Number(node.descendantSymbolCount || 0),
  };
}

function refinementCandidateSummaries(refinementCandidateMap, selectedPaths = new Set()) {
  return [...refinementCandidateMap.values()]
    .filter((candidate) => !selectedPaths.has(String(candidate.path || "")))
    .sort((a, b) => Number(b.acceptsBranchFileCap) - Number(a.acceptsBranchFileCap)
      || Number(b.score || 0) - Number(a.score || 0)
      || String(a.path || "").localeCompare(String(b.path || "")));
}

function addRefinementCandidates(refinementCandidateMap, branch, score, reason, branchFileCap) {
  if (!refinementCandidateMap || !branch) return;
  const children = Array.isArray(branch.children) ? branch.children : [];
  for (const child of children) {
    if (!child?.repoRelPath) continue;
    const fileCount = child.kind === "file" ? 1 : Number(child.descendantFileCount || 0);
    if (fileCount <= 0) continue;
    const existing = refinementCandidateMap.get(child.nodeId);
    const next = {
      path: child.repoRelPath,
      nodeId: child.nodeId,
      kind: child.kind,
      score: roundScore(refinementScore(score, fileCount)),
      sourcePath: branch.repoRelPath,
      reason,
      fileCount,
      symbolCount: Number(child.descendantSymbolCount || 0),
      childCount: Number(child.childCount || 0),
      acceptsBranchFileCap: fileCount <= branchFileCap,
      generated: isGeneratedPath(child.repoRelPath || ""),
      test: isTestPath(child.repoRelPath || ""),
      config: isConfigPath(child.repoRelPath || ""),
    };
    if (!existing || Number(next.score || 0) > Number(existing.score || 0)) {
      refinementCandidateMap.set(child.nodeId, next);
    }
  }
}

function refinementScore(score, fileCount) {
  return Number(score || 0) / Math.sqrt(Math.max(1, Math.min(25, Number(fileCount || 1))));
}

function normalizeScopeRefs(params) {
  const refs = [];
  if (params.refType || params.refId) refs.push({ refType: params.refType, refId: params.refId });
  const rawRefs = Array.isArray(params.refs) ? params.refs : [];
  for (const ref of rawRefs) refs.push({ refType: ref?.refType, refId: ref?.refId });
  return refs
    .map((ref) => ({ refType: stringParam(ref.refType), refId: stringParam(ref.refId) }))
    .filter((ref) => REF_TYPES.has(ref.refType) && ref.refId)
    .filter((ref, idx, arr) => arr.findIndex((item) => item.refType === ref.refType && item.refId === ref.refId) === idx);
}

function createScopeTraversalCache() {
  return {
    branchForFile: new Map(),
    descendantFiles: new Map(),
  };
}

function chooseBranchForFile(file, model, branchFileCap, traversalCache = null) {
  const cacheKey = file?.nodeId ? `${file.nodeId}\0${branchFileCap}` : null;
  if (cacheKey && traversalCache?.branchForFile.has(cacheKey)) {
    return traversalCache.branchForFile.get(cacheKey);
  }
  let current = file;
  let best = file;
  const visited = new Set();
  while (current?.parentNodeId) {
    if (current.nodeId && visited.has(current.nodeId)) break;
    if (current.nodeId) visited.add(current.nodeId);
    const parent = model.byId.get(current.parentNodeId);
    if (!parent || parent.kind === "root") break;
    const count = parent.kind === "file" ? 1 : Number(parent.descendantFileCount || 0);
    if (count > 0 && count <= branchFileCap) best = parent;
    current = parent;
  }
  if (cacheKey) traversalCache?.branchForFile.set(cacheKey, best);
  return best;
}

function descendantFiles(node, traversalCache = null) {
  const cacheKey = node?.nodeId || null;
  if (cacheKey && traversalCache?.descendantFiles.has(cacheKey)) {
    return traversalCache.descendantFiles.get(cacheKey);
  }
  const out = [];
  const queue = [node];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.nodeId && visited.has(current.nodeId)) continue;
    if (current.nodeId) visited.add(current.nodeId);
    if (current.kind === "file" && current.repoRelPath) out.push(current);
    for (const child of current.children || []) queue.push(child);
  }
  if (cacheKey) traversalCache?.descendantFiles.set(cacheKey, out);
  return out;
}

function fileForNode(model, node) {
  if (!node) return null;
  if (node.kind === "file" && node.repoRelPath) return node;
  if (node.repoRelPath && model.fileByPath.has(node.repoRelPath)) return model.fileByPath.get(node.repoRelPath);
  let current = node;
  const visited = new Set();
  while (current) {
    if (current.nodeId && visited.has(current.nodeId)) return null;
    if (current.nodeId) visited.add(current.nodeId);
    if (current.kind === "file" && current.repoRelPath) return current;
    current = current.parentNodeId ? model.byId.get(current.parentNodeId) : null;
  }
  return null;
}

function documentFrequency(files, key) {
  const df = new Map();
  for (const file of files) {
    for (const term of file[key] || []) df.set(term, (df.get(term) || 0) + 1);
  }
  return df;
}

function termFrequency(terms) {
  const out = new Map();
  for (const term of terms) out.set(term, (out.get(term) || 0) + 1);
  return out;
}

function idf(term, docFreq, docCount) {
  return Math.log(1 + (Number(docCount || 0) + 1) / ((docFreq.get(term) || 0) + 1));
}

function splitTerms(value) {
  return String(value || "")
    .split(/[^A-Za-z0-9_]+|(?=[A-Z][a-z])|(?<=[a-z0-9])(?=[A-Z])/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 2 && !STOPWORDS.has(part));
}

function hasPrefixish(terms, query) {
  for (const term of terms || []) {
    if (term.length >= 4 && (term.startsWith(query) || query.startsWith(term))) return true;
  }
  return false;
}

function queryMentionsTests(qtf) {
  return ["test", "tests", "spec", "regression", "assert", "unit", "e2e"].some((term) => qtf.has(term));
}

function queryMentionsGenerated(qtf) {
  return ["generated", "route", "routes", "gen"].some((term) => qtf.has(term));
}

function isTestPath(value) {
  const text = String(value || "").replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(text) || /\.(test|spec)\.[^.]+$/.test(text);
}

function isConfigPath(value) {
  const text = String(value || "").replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(config|configs|settings)(\/|$)/.test(text)
    || /(^|\/)(package\.json|tsconfig\.json|vite\.config\.[jt]s|webpack\.config\.[jt]s|composer\.json)$/.test(text)
    || /(^|\/)[^.]*config\.[^.]+$/.test(text);
}

function topArea(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] === "src" || parts[0] === "tests" || parts[0] === "test") return parts[0];
  return parts.slice(0, Math.min(2, parts.length)).join("/") || "";
}

function pathBasename(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/");
  const name = parts[parts.length - 1] || "";
  return name.replace(/\.[^.]+$/, "");
}

function scopeBandFor(fileCount, areasTouched) {
  if (fileCount <= 0) return "none";
  if (fileCount === 1) return "single_file";
  if (fileCount <= 5 && areasTouched <= 2) return "small_cluster";
  if (fileCount <= 25 && areasTouched <= 4) return "multi_area";
  return "broad";
}

function scopeRiskFor({ candidateFileCount, areasTouched, largestAreaFileCount, generatedOrConfigTouched, rejectedBroadDirs, rejectedBroadRefs, queryTermCoverage }) {
  if (candidateFileCount <= 2 && areasTouched <= 1 && !generatedOrConfigTouched && rejectedBroadDirs.length === 0 && rejectedBroadRefs.length === 0) return "low";
  if (candidateFileCount > 25 || areasTouched > 4 || largestAreaFileCount > 20 || rejectedBroadRefs.length > 0) return "high";
  if (rejectedBroadDirs.length > 0) {
    return candidateFileCount > 0 && candidateFileCount <= 5 && areasTouched <= 2 && Number(queryTermCoverage || 0) >= 0.5
      ? "medium"
      : "high";
  }
  if (generatedOrConfigTouched || candidateFileCount > 5 || areasTouched > 2) return "medium";
  return "low";
}

function scopeConfidence({ candidateFileCount, candidateFiles, queryTerms, seedSummary, rejectedBroadDirs, rejectedBroadRefs, scopeRisk, queryTermCoverage }) {
  if (candidateFileCount === 0) return 0;
  let confidence = 0.2;
  if (seedSummary.exactFileSeeds > 0) confidence += 0.35;
  if (seedSummary.matchedSymbols > 0) confidence += 0.25;
  if (seedSummary.matchedDirs > 0) confidence += 0.15;
  if (queryTerms.length > 0) confidence += 0.1 + (queryTermCoverage * 0.35);
  if (candidateFileCount <= 5) confidence += 0.12;
  else if (candidateFileCount <= 10) confidence += 0.06;
  else if (candidateFileCount > 25) confidence -= 0.1;
  if (scopeRisk === "high") confidence -= 0.08;
  else if (scopeRisk === "medium") confidence -= 0.03;
  const taskFileHit = (candidateFiles || []).some((entry) => (entry.reasons || []).includes("task:file"));
  const broadPenaltyUnit = taskFileHit && queryTermCoverage >= 0.25 ? 0.03 : 0.07;
  confidence -= Math.min(0.2, rejectedBroadDirs.length * broadPenaltyUnit + rejectedBroadRefs.length * 0.08);
  return roundScore(Math.max(0, Math.min(1, confidence)));
}

function queryTermCoverage(files, dirs, queryTerms) {
  const uniqueTerms = uniqueStrings(queryTerms);
  if (uniqueTerms.length === 0) return 0;
  const covered = new Set();
  for (const term of uniqueTerms) {
    if (scopeContainsTerm(files, dirs, term)) covered.add(term);
  }
  return roundScore(covered.size / uniqueTerms.length);
}

function scopeContainsTerm(files, dirs, term) {
  for (const node of [...(files || []), ...(dirs || [])]) {
    const pathText = String(node?.repoRelPath || "").toLowerCase();
    if (term.length >= 4 && pathText.includes(term)) return true;
    if (node?.terms?.has?.(term) || node?.projectedTerms?.has?.(term)) return true;
    if (term.length >= 4 && (hasPrefixish(node?.terms, term) || hasPrefixish(node?.projectedTerms, term))) return true;
  }
  return false;
}

function topReasonKeys(reasons) {
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([key]) => key);
}

function compareNodeLike(a, b) {
  return String(a.repoRelPath || a.nodeId || "").localeCompare(String(b.repoRelPath || b.nodeId || ""));
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

/**
 * @param {import("../contracts/tool-params.js").TreeOverviewParams} params
 */
function focusDescriptor(params) {
  if (params.refType || params.refId) return { type: "ref", refType: params.refType || null, refId: params.refId || null };
  if (params.nodeId) return { type: "nodeId", value: params.nodeId };
  if (params.symbolId) return { type: "symbolId", value: params.symbolId, path: params.path || null };
  if (params.path) return { type: "path", value: params.path };
  return { type: "root", value: "root" };
}

function stringParam(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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
