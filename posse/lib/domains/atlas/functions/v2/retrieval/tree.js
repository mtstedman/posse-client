// @ts-check
//
// Tree retrieval shims. Rust owns tree traversal, scope scoring, and expansion;
// Node only reads the materialized view rows and wraps native results in the
// retrieval envelope.

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { readTreeBuildResult } from "../tree-derived.js";
import { readLatestTreeCompressionSnapshot } from "../tree-compression.js";
import { runAtlasNativeMethod } from "../native/invoke.js";
import { isDefaultVisibleSymbol } from "./hygiene.js";
import { countIncomingCallers } from "./usages.js";

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
  const widened = action === "tree.scope" ? collectScopeWidenedPaths({ view, params }) : [];
  const widenedPaths = widened.map((w) => w.path);
  const result = /** @type {Record<string, unknown>} */ (runAtlasNativeMethod("tree-scope", {
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
export function collectScopeWidenedPaths({ view, params = {}, maxPaths = 8, maxSymbolsPerFile = 12 }) {
  try {
    if (!view?.query || typeof view.query.symbolsInFile !== "function" || typeof view.query.callers !== "function") {
      return [];
    }
    const seedPaths = collectScopeSeedPaths(params);
    if (seedPaths.length === 0) return [];
    const seedDirs = seedPaths.map(parentDirOf).filter(Boolean);
    const seen = new Set(seedPaths);
    const taskTokens = taskIdentifierTokens(params.taskText);
    /** @type {Map<string, WidenedCaller>} */
    const byPath = new Map();
    /** @type {Map<number, number>} */
    const fanInByCaller = new Map();
    for (const seedPath of seedPaths.slice(0, 8)) {
      const symbols = selectWideningAnchors(view.query.symbolsInFile(seedPath), taskTokens, maxSymbolsPerFile);
      for (const symbol of symbols) {
        if (symbol?.global_id == null) continue;
        for (const edge of view.query.callers(symbol.global_id)) {
          const from = typeof view.query.getSymbol === "function" ? view.query.getSymbol(edge.from_global_id) : null;
          if (!from || !isDefaultVisibleSymbol(from)) continue;
          const callerPath = normalizeRepoPathCandidate(edge.repo_rel_path || from.repo_rel_path);
          if (!callerPath || seen.has(callerPath) || isUnderAnyDir(callerPath, seedDirs)) continue;
          // Fan-in of the CALLER symbol: how much of the codebase routes through
          // this caller. Distinct calling FILES, not call-site edges — edge
          // counting let a helper hammered from inside one test file outrank a
          // production gate called once each from dozens of files.
          let callerCount = fanInByCaller.get(from.global_id);
          if (callerCount == null) {
            callerCount = countIncomingCallers(view, from, { sampleLimit: 0, distinctPaths: true }).callerCount;
            fanInByCaller.set(from.global_id, callerCount);
          }
          const existing = byPath.get(callerPath);
          if (!existing || callerCount > existing.callerCount) {
            byPath.set(callerPath, { path: callerPath, callerName: from.name || null, callerCount, loadBearing: false });
          }
        }
      }
    }
    // Rank the FULL candidate set by fan-in before cutting to maxPaths: cutting
    // at the first N encountered made the result depend on seed order, letting
    // an early seed's low-value callers crowd out a later seed's hub.
    const out = [...byPath.values()].sort((a, b) => b.callerCount - a.callerCount).slice(0, maxPaths);
    // Relative cut, not an absolute count (fan-in scales with repo size): elevate
    // only the standouts — top-2 that are also genuine hubs (>=2 incoming and at
    // least half the top caller's fan-in). If nothing stands out, elevate nothing.
    const maxCount = out[0]?.callerCount || 0;
    const threshold = Math.max(2, Math.ceil(maxCount * 0.5));
    for (let i = 0; i < out.length; i += 1) {
      out[i].loadBearing = i < 2 && out[i].callerCount >= threshold;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Order a seed file's symbols for scope-widening: symbols whose name the task
 * text mentions come first, everything else keeps file order. Only the ordering
 * changes — the per-file cap still applies, so this matters exactly when the
 * file holds more symbols than the cap and the query target sits past it.
 *
 * @param {import("../contracts/api.js").ViewSymbol[]} symbols
 * @param {Set<string>} taskTokens
 * @param {number} maxSymbolsPerFile
 */
function selectWideningAnchors(symbols, taskTokens, maxSymbolsPerFile) {
  const all = Array.isArray(symbols) ? symbols : [];
  if (all.length <= maxSymbolsPerFile || taskTokens.size === 0) {
    return all.slice(0, maxSymbolsPerFile);
  }
  const named = [];
  const rest = [];
  for (const symbol of all) {
    const name = String(symbol?.name || "").toLowerCase();
    (name && taskTokens.has(name) ? named : rest).push(symbol);
  }
  return named.concat(rest).slice(0, maxSymbolsPerFile);
}

/**
 * Identifier-shaped tokens (length >= 3, case-folded) from free-form task
 * text, for matching against symbol names.
 *
 * @param {unknown} taskText
 * @returns {Set<string>}
 */
function taskIdentifierTokens(taskText) {
  const tokens = new Set();
  for (const match of String(taskText || "").matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
    tokens.add(match[0].toLowerCase());
  }
  return tokens;
}

function collectScopeSeedPaths(params = {}) {
  const raw = [
    ...(Array.isArray(params.paths) ? params.paths : []),
    ...(Array.isArray(params.editedFiles) ? params.editedFiles : []),
    params.path,
  ];
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    const path = normalizeRepoPathCandidate(value);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function normalizeRepoPathCandidate(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (!text || text.includes("\0") || text.startsWith("/") || /^[A-Za-z]:/.test(text)) return null;
  const parts = [];
  for (const segment of text.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function parentDirOf(path) {
  const index = String(path || "").lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function isUnderAnyDir(path, dirs) {
  return dirs.some((dir) => dir && (path === dir || path.startsWith(`${dir}/`)));
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
