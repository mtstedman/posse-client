// @ts-check
//
// Tree retrieval shims. Rust owns tree traversal, scope scoring, and expansion;
// Node only reads the materialized view rows and wraps native results in the
// retrieval envelope.

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { readTreeBuildResult } from "../tree-derived.js";
import { readLatestTreeCompressionSnapshot } from "../tree-compression.js";
import { runAtlasNativeMethodAsync } from "../native/invoke.js";
import { isCanonicalRepoPath, normalizeRepoPath } from "../paths.js";

const TREE_RUN_KIND = "tree-derived";
const TREE_TABLES = Object.freeze(["atlas_tree_nodes", "atlas_tree_refs", "derived_state_runs"]);

export function defaultTreeBranchLimitForFileCount(fileCount) {
  const files = Math.max(0, Number(fileCount) || 0);
  if (files <= 1_000) return 100;
  if (files <= 5_000) return 150;
  if (files <= 15_000) return 200;
  return 250;
}

function indexedTreeFileCount(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const direct = nodes.filter((node) => node?.kind === "file").length;
  const aggregate = nodes.reduce((max, node) => Math.max(max, Number(node?.descendantFileCount) || 0), 0);
  return Math.max(direct, aggregate);
}

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
export async function treeOverview({ view, versionId, params = {} }) {
  return runTreeTraversal({ view, versionId, params, action: "tree.overview", method: "tree-overview" });
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeOverviewParams,
 * }} args
 */
export async function treeWalk({ view, versionId, params = {} }) {
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
async function runTreeTraversal({ view, versionId, params = {}, action, method }) {
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
  const tree = readTreeBuildResult(db, { for: "traversal" });
  const indexedFileCount = indexedTreeFileCount(tree);
  const explicitLimit = Number.isInteger(params.limit) ? params.limit : null;
  const effectiveLimit = explicitLimit ?? (action === "tree.branch"
    ? defaultTreeBranchLimitForFileCount(indexedFileCount)
    : undefined);
  const result = /** @type {Record<string, unknown>} */ (await runAtlasNativeMethodAsync(method, {
    tree,
    path: params.path,
    nodeId: params.nodeId,
    symbolId: params.symbolId,
    refType: params.refType,
    refId: params.refId,
    maxDepth: params.maxDepth,
    limit: effectiveLimit,
    offset: params.offset,
    includeAggregates: params.includeAggregates,
    includeTerms: params.includeTerms === true,
    includeRefs: params.includeRefs === true,
    latestRun: params.includeLatestRun === false ? null : readLatestRun(db),
    compressionSnapshot: readOptionalCompressionSnapshot(db),
  }));
  if (action === "tree.branch") {
    result.limitSource = explicitLimit == null ? "repo_size_default" : "explicit";
    result.indexedFileCount = indexedFileCount;
  }
  renamePublicActionsInWarnings(result);
  return okEnvelope({ action, versionId, data: result });
}

/**
 * Node owns the public action names ("tree.branch"); the native runtime still
 * phrases its guidance warnings in terms of its internal method name
 * ("tree.walk", from the tree-walk route). Translate at the shim boundary so
 * callers are pointed at an action that actually exists.
 *
 * @param {Record<string, unknown>} result
 */
function renamePublicActionsInWarnings(result) {
  if (!Array.isArray(result?.warnings)) return;
  result.warnings = result.warnings.map((warning) => (
    typeof warning === "string" ? warning.replace(/\btree\.walk\b/g, "tree.branch") : warning
  ));
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").TreeScopeParams,
 * }} args
 */
export async function treeScope({ view, versionId, params = {} }) {
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
export async function treeGrow({ view, versionId, params = {} }) {
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
async function runTreeScope({ view, versionId, params = {}, action }) {
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
  const widened = action === "tree.scope" ? await collectScopeWidenedPaths({ view, params }) : [];
  const widenedPaths = widened.map((w) => w.path);
  const result = /** @type {Record<string, unknown>} */ (await runAtlasNativeMethodAsync("tree-scope", {
    tree: readTreeBuildResult(db, { for: "scope" }),
    taskText: params.taskText,
    paths: params.paths,
    widenedPaths,
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
    siblingNumericFamilyCap: params.siblingNumericFamilyCap,
    taskType: params.taskType,
    compressionSnapshot: readOptionalCompressionSnapshot(db),
  }));
  if (widenedPaths.length > 0) {
    const sidecar = result.sidecar && typeof result.sidecar === "object" && !Array.isArray(result.sidecar)
      ? /** @type {Record<string, unknown>} */ (result.sidecar)
      : {};
    result.sidecar = {
      ...sidecar,
      scopeWidening: {
        used: true,
        reason: "incoming_callers",
        paths: widenedPaths,
        callers: widened,
      },
    };
  }
  result.latestRun = readLatestRun(db);
  return okEnvelope({ action, versionId, data: result });
}

/**
 * @typedef {{ path: string, callerName: string | null, callerCount: number, loadBearing: boolean }} WidenedCaller
 */

/**
 * Find one-hop caller files for explicit scope file seeds, annotated with each
 * caller's own fan-in (incoming-caller count). The native scorer treats the
 * paths as soft context via `widenedPaths`; the fan-in lets the handoff ELEVATE
 * a load-bearing hub (e.g. the executor gate everything routes through) instead
 * of leaving it as one bare path among many — surfacing without leverage was
 * shown insufficient. `loadBearing` marks the fan-in standouts; a widened caller
 * with no clear fan-in advantage is left un-elevated on purpose.
 *
 * Which symbols in a seed file get widened from is anchored on the task text:
 * a symbol the task names outranks file position, so a query target defined
 * late in a large file (past the per-file cap) is still the one whose callers
 * are examined. Position is only the fallback ordering.
 *
 * @param {{ view: import("../contracts/api.js").View, params?: import("../contracts/tool-params.js").TreeScopeParams, maxPaths?: number, maxSymbolsPerFile?: number }} args
 * @returns {WidenedCaller[]}
 */
export async function collectScopeWidenedPaths({ view, params = {}, maxPaths = 8, maxSymbolsPerFile = 12 }) {
  if (!view?.query || typeof view.query.symbolsInFile !== "function" || typeof view.query.callers !== "function") {
    return [];
  }
  const baseRequest = {
    paths: arrayValue(params.paths),
    editedFiles: arrayValue(params.editedFiles),
    path: params.path,
    taskText: params.taskText,
    maxPaths,
    maxSymbolsPerFile,
  };
  const seedSelection = /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("tree-scope-widening", {
    ...baseRequest,
    files: [],
    callerEdges: [],
    fanInEdges: [],
  }));
  const seedPaths = Array.isArray(seedSelection.seedPaths) ? seedSelection.seedPaths : [];
  if (seedPaths.length === 0) return [];
  // Sequential reads: the native worker is serial, so fan the query calls out
  // one at a time rather than issuing an unbounded Promise.all across seeds.
  const files = [];
  for (const path of seedPaths) {
    files.push({ path, symbols: await view.query.symbolsInFile(path) });
  }
  const callerEdges = [];
  const callerSymbols = new Map();
  for (const file of files) {
    for (const symbol of file.symbols) {
      if (symbol?.global_id == null) continue;
      for (const edge of await view.query.callers(symbol.global_id)) {
        const from = typeof view.query.getSymbol === "function" ? await view.query.getSymbol(edge.from_global_id) : null;
        if (!from) continue;
        const input = wideningCallInput(symbol.global_id, edge, from);
        if (!input) continue;
        callerEdges.push(input);
        if (from.global_id != null) callerSymbols.set(from.global_id, from);
      }
    }
  }
  const fanInEdges = [];
  for (const caller of callerSymbols.values()) {
    for (const edge of await view.query.callers(caller.global_id)) {
      const from = typeof view.query.getSymbol === "function" ? await view.query.getSymbol(edge.from_global_id) : null;
      if (!from) continue;
      const input = wideningCallInput(caller.global_id, edge, from);
      if (input) fanInEdges.push(input);
    }
  }
  const result = /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("tree-scope-widening", {
    ...baseRequest,
    files,
    callerEdges,
    fanInEdges,
  }));
  return Array.isArray(result.callers) ? result.callers : [];
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function wideningCallInput(targetGlobalId, edge, from) {
  const fromPath = String(from?.repo_rel_path || "");
  const sitePath = String(edge?.repo_rel_path || fromPath);
  if (!isCanonicalRepoPath(fromPath) || !isCanonicalRepoPath(sitePath)) return null;
  return {
    targetGlobalId,
    from,
    sitePath,
  };
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
      seeds: (Array.isArray(latest.seeds) ? latest.seeds : []).map(canonicalizeSeedPathLists),
    };
  } catch {
    return unavailable("tree_compression_read_failed");
  }
}

/**
 * Seed entrypoints / likely-tests are model-written annotations, so sloppy
 * forms ("./src//x.ts", backslashes) are expected. The pre-native scorer
 * normalized them at match time; the native canonical check REJECTS
 * non-canonical paths instead of normalizing, so feed it canonical forms or
 * the seed's file pins silently vanish.
 *
 * @param {Record<string, any>} seed
 */
function canonicalizeSeedPathLists(seed) {
  return {
    ...seed,
    entrypoints: canonicalSeedPaths(seed?.entrypoints),
    likelyTests: canonicalSeedPaths(seed?.likelyTests),
  };
}

/**
 * @param {unknown} values
 * @returns {string[]}
 */
function canonicalSeedPaths(values) {
  /** @type {string[]} */
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeRepoPath(String(value ?? ""));
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
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
