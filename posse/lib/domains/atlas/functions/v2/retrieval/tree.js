// @ts-check
//
// Tree retrieval shims. Rust owns tree traversal, scope scoring, and expansion;
// Node only reads the materialized view rows and wraps native results in the
// retrieval envelope.

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { readTreeBuildResult } from "../tree-derived.js";
import { readLatestTreeCompressionSnapshot } from "../tree-compression.js";
import { runAtlasNativeMethod } from "../native/invoke.js";

const TREE_RUN_KIND = "tree-derived";
const TREE_TABLES = Object.freeze(["atlas_tree_nodes", "atlas_tree_refs", "derived_state_runs"]);

function treeFocusRequested(params = {}) {
  return !!(params.path || params.nodeId || params.symbolId || params.refId || params.refType);
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeOverviewParams,
 * }} args
 */
export function treeOverview({ view, versionId, params = {} }) {
  return runTreeTraversal({ view, versionId, params, action: "tree.overview", method: "tree-overview" });
}

/**
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
  return runTreeTraversal({ view, versionId, params, action: "tree.branch", method: "tree-walk" });
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeOverviewParams,
 *   action: "tree.overview" | "tree.branch",
 *   method: "tree-overview" | "tree-walk",
 * }} args
 */
function runTreeTraversal({ view, versionId, params = {}, action, method }) {
  const db = unsafeDb(view);
  if (!db) return viewUnavailable(action, versionId);
  const missing = missingTreeTables(db);
  if (missing.length > 0 || !treeRowsAvailable(db)) {
    return okEnvelope({
      action,
      versionId,
      data: {
        available: false,
        reason: missing.length > 0 ? "tree_derived_tables_missing" : "tree_derived_state_missing",
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
  const result = /** @type {Record<string, unknown>} */ (runAtlasNativeMethod(method, {
    tree: readTreeBuildResult(db, { for: "traversal" }),
    path: params.path,
    nodeId: params.nodeId,
    symbolId: params.symbolId,
    refType: params.refType,
    refId: params.refId,
    maxDepth: params.maxDepth,
    limit: params.limit,
    offset: params.offset,
    includeAggregates: params.includeAggregates,
    includeTerms: params.includeTerms === true,
    includeRefs: params.includeRefs === true,
    latestRun: params.includeLatestRun === false ? null : readLatestRun(db),
    compressionSnapshot: readOptionalCompressionSnapshot(db),
  }));
  return okEnvelope({ action, versionId, data: result });
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
  const db = unsafeDb(view);
  if (!db) return viewUnavailable(action, versionId);
  const missing = missingTreeTables(db);
  if (missing.length > 0 || !treeRowsAvailable(db)) {
    const reason = missing.length > 0 ? "tree_derived_tables_missing" : "tree_derived_state_missing";
    return okEnvelope({
      action,
      versionId,
      data: {
        available: false,
        reason,
        missingTables: missing,
        queryTerms: [],
        seeds: emptyScopeSeedSummary(),
        candidateFiles: [],
        candidateDirs: [],
        refinementCandidates: [],
        rejectedBroadDirs: [],
        rejectedBroadRefs: [],
        metrics: emptyScopeMetrics(),
        compression: { available: false, reason, matchedSeeds: [], areaMap: [] },
        sidecar: { used: false, reason },
        warnings: ["Run index.refresh first if tree-derived state is missing or stale."],
      },
    });
  }
  const result = /** @type {Record<string, unknown>} */ (runAtlasNativeMethod("tree-scope", {
    tree: readTreeBuildResult(db, { for: "scope" }),
    taskText: params.taskText,
    paths: params.paths,
    editedFiles: params.editedFiles,
    path: params.path,
    symbolIds: params.symbolIds,
    symbolId: params.symbolId,
    nodeIds: params.nodeIds,
    refs: normalizeScopeRefs(params),
    maxFiles: params.maxFiles,
    maxBranches: params.maxBranches,
    branchFileCap: params.branchFileCap,
    refMatchLimit: params.refMatchLimit,
    taskType: params.taskType,
    compressionSnapshot: readOptionalCompressionSnapshot(db),
  }));
  result.latestRun = readLatestRun(db);
  return okEnvelope({ action, versionId, data: result });
}

function unsafeDb(view) {
  return typeof /** @type {any} */ (view)._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
}

function viewUnavailable(action, versionId) {
  return errorEnvelope({
    action,
    versionId,
    code: "view_unavailable",
    message: `${action} requires an open ATLAS view database.`,
  });
}

// Seed pool for scope folding and the overview areaMap. Matches the pre-native
// read limit: it feeds the ubiquity floor (max(4, ceil(seeds * 0.25))), so
// raising it changes which query terms count as discriminative.
const COMPRESSION_SEED_READ_LIMIT = 200;

/**
 * Compression folding is advisory, so unavailability degrades softly — but the
 * specific reason rides along so scope output can report WHY it was skipped.
 *
 * @param {import("better-sqlite3").Database} db
 */
function readOptionalCompressionSnapshot(db) {
  // Full skeleton (not just {available, reason}) so binaries without
  // serde-default snapshot fields still deserialize the request.
  const unavailable = (reason) => ({
    available: false,
    reason,
    profile: "",
    builtAt: "",
    summary: {},
    details: {},
    seeds: [],
  });
  try {
    const latest = readLatestTreeCompressionSnapshot(db, {
      seedLimit: COMPRESSION_SEED_READ_LIMIT,
      withStaleness: true,
    });
    if (!latest?.available) {
      return unavailable(latest?.reason || "tree_compression_snapshot_missing");
    }
    return {
      available: true,
      profile: latest.snapshot?.profile,
      builtAt: latest.snapshot?.builtAt,
      summary: latest.snapshot?.summary || {},
      details: latest.snapshot?.details || {},
      seeds: Array.isArray(latest.seeds) ? latest.seeds : [],
    };
  } catch {
    return unavailable("tree_compression_read_failed");
  }
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
 */
function treeRowsAvailable(db) {
  try {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes").get();
    return Number(row?.cnt || 0) > 0;
  } catch {
    return false;
  }
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

function normalizeScopeRefs(params = {}) {
  const refs = [];
  if (Array.isArray(params.refs)) {
    for (const ref of params.refs) {
      const refType = String(ref?.refType || ref?.ref_type || "").trim();
      const refId = String(ref?.refId || ref?.ref_id || "").trim();
      if (refType && refId) refs.push({ refType, refId });
    }
  }
  const refType = String(params.refType || "").trim();
  const refId = String(params.refId || "").trim();
  if (refType && refId) refs.push({ refType, refId });
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.refType}\0${ref.refId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    queryTermCoverage: 0,
    exactSeedCount: 0,
    queryTermCount: 0,
    broadRefCount: 0,
    broadDirCount: 0,
  };
}

function focusDescriptor(params = {}) {
  if (params.refType || params.refId) {
    return { type: "ref", refType: params.refType || null, refId: params.refId || null };
  }
  if (params.nodeId) return { type: "nodeId", value: String(params.nodeId) };
  if (params.symbolId) return { type: "symbolId", value: String(params.symbolId), path: params.path || null };
  if (params.path) return { type: "path", value: String(params.path) };
  return { type: "root", value: "root" };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
