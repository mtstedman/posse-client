// @ts-check
//
// repo.* and index.refresh handlers.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { Ledger } from "../../../classes/v2/Ledger.js";
import { View as ViewClass } from "../../../classes/v2/View.js";
import { ViewBuilder } from "../../../classes/v2/ViewBuilder.js";
import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";
import { childEmbeddingModelDirName } from "../../../classes/v2/ChildEmbeddingIndex.js";
import { embeddingsRoot, ledgerDbPath, mainViewPath, memoryDbPathForLedgerDb } from "../runtime-paths.js";
import { refresh as systemAtlasRefresh } from "../../../../system/functions/atlas.js";
import { supportedLanguageTags } from "../parser/languages/index.js";
import { nativeBinaries } from "../../../../../shared/tools/classes/BinaryManager.js";
import { __atlasNativeManagerForTests } from "../native/invoke.js";
import { openEmbeddingResources, semanticDispatchEnabled } from "../embeddings/resources.js";
import { inspectLocalOnnxStatus } from "../embeddings/local-onnx.js";
import { openViewWithMeta, removeSqliteFile, viewFreshness } from "../view-health.js";
import { buildAtlasCapabilities } from "../capabilities.js";
import { readGraphOverview } from "../graph-derived.js";
import { readLatestTreeCompressionSnapshot } from "../tree-compression.js";
import { readSemanticEnrichmentStatus } from "../semantic-enrichment.js";
import { mergeLayerRows } from "../ledger/layer-merge.js";
import { symbolHit, symbolIdOf } from "./cards.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { memorySurface } from "./memory.js";
import { getEffectivePolicy } from "./policy.js";
import { bufferStatus } from "./buffer.js";
import { getPrefetchStats } from "./prefetch.js";
import { liveReconciliationStatus } from "../live-reconciliation.js";
import { isDefaultVisibleSymbol, isGeneratedPath, isLiteralSymbolName, isNoisyLocalSymbol } from "./hygiene.js";
import { isBuiltinCall } from "../resolver/builtins.js";
import { PHP_STDLIB_FUNCTIONS } from "../resolver/php-stdlib.generated.js";
import { parseImportModuleRef } from "../resolver/import-context.js";
import { gitExecSafe } from "../../../../git/functions/utils.js";

let indexOperationCounter = 0;
const DEFAULT_BRANCH_CACHE_TTL_MS = 60_000;
const DEFAULT_BRANCH_CACHE_MAX = 200;
/** @type {Map<string, { branch: string, expiresAt: number }>} */
const DEFAULT_BRANCH_CACHE = new Map();
const EDGE_TAXONOMY_CACHE_TTL_MS = 30_000;
const EDGE_TAXONOMY_CACHE_MAX = 32;
const EDGE_TAXONOMY_CACHE = new Map();
// Emitted by the native parser's js/ts import edges (spec_javascript.rs). These
// confidence values are a temporary import-kind channel until the edge schema
// carries an explicit import_kind/external_descriptor.
const JS_IMPORT_CONFIDENCE_NAMESPACE = 85;
const JS_IMPORT_CONFIDENCE_DEFAULT = 88;

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").Ledger} LedgerContract */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-params.js").RepoRegisterParams} RepoRegisterParams */
/** @typedef {import("../contracts/tool-params.js").RepoStatusParams} RepoStatusParams */
/** @typedef {import("../contracts/tool-params.js").IndexRefreshParams} IndexRefreshParams */
/** @typedef {import("../contracts/tool-params.js").RepoOverviewParams} RepoOverviewParams */
/** @typedef {import("../contracts/tool-params.js").RepoQualityParams} RepoQualityParams */
/** @typedef {import("../contracts/tool-results.js").RepoRegisterData} RepoRegisterData */
/** @typedef {import("../contracts/tool-results.js").RepoStatusData} RepoStatusData */
/** @typedef {import("../contracts/tool-results.js").IndexRefreshData} IndexRefreshData */
/** @typedef {import("../contracts/tool-results.js").RepoOverviewData} RepoOverviewData */
/** @typedef {import("../contracts/tool-results.js").RepoQualityData} RepoQualityData */

/**
 * @param {{
 *   versionId: string,
 *   params: RepoRegisterParams,
 *   repoRoot?: string,
 *   repoId?: string,
 * }} args
 * @returns {Promise<ReturnType<typeof okEnvelope<RepoRegisterData>> | ReturnType<typeof errorEnvelope>>}
 */
export async function repoRegister({ versionId, params, repoRoot, repoId = "default" }) {
  const root = resolveRepoRoot(repoRoot || params.repoRoot);
  if (!root) {
    return errorEnvelope({
      action: "repo.register",
      versionId,
      code: "missing_repo_root",
      message: "repo.register requires repoRoot in params or dispatch context",
    });
  }

  const ledgerPath = ledgerDbPath(root);
  const viewPath = mainViewPath(root);
  const createdLedger = !fs.existsSync(ledgerPath);
  const buildEmptyView = params.buildEmptyView !== false;
  let createdView = false;
  const ledger = Ledger.open({ dbPath: ledgerPath });
  try {
    const branch = String(params.branch || defaultBranchForRepo(root)).trim() || "main";
    if (typeof ledger.ensureRootBranch === "function" && !ledger.getBranch(branch)) {
      ledger.ensureRootBranch(branch);
    }
    const seq = ledger.headSeq(branch);
    let viewProbe = null;
    if (buildEmptyView) {
      viewProbe = openViewWithMeta(viewPath, ViewClass);
      if (!viewProbe.ok && viewProbe.exists) removeSqliteFile(viewPath);
    }
    try { if (viewProbe?.ok) viewProbe.view.close(); } catch { /* ignore */ }
    if (buildEmptyView && !viewProbe?.ok) {
      fs.mkdirSync(path.dirname(viewPath), { recursive: true });
      await new ViewBuilder().buildFromAsync({
        ledger,
        branch,
        atSeq: seq,
        outPath: viewPath,
        options: { repoRoot: root, layerMerge: true },
      }, {
        label: "repo.register.buildEmptyView",
      });
      createdView = true;
    }
    const currentVersionId = `${branch}@${seq}`;
    return okEnvelope({
      action: "repo.register",
      versionId: currentVersionId || versionId,
      data: {
        repoId: params.repoId || repoId,
        repoRoot: root,
        ledgerPath,
        viewPath,
        versionId: currentVersionId,
        createdLedger,
        createdView,
        alreadyRegistered: !createdLedger && !createdView,
      },
    });
  } finally {
    ledger.close();
  }
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: RepoStatusParams,
 *   repoId?: string,
 *   repoRoot?: string,
 *   viewPath?: string,
 *   ledger?: LedgerContract,
 *   config?: Record<string, unknown>,
 * }} args
 */
export function repoStatus({ view, versionId, params, repoId = "default", repoRoot, viewPath, ledger, config = {} }) {
  const meta = view.meta();
  const stats = computeStats(view);
  const root = repoRoot || meta.repo_root || undefined;
  const embeddingStatus = root ? computeEmbeddingStatus(root, config) : null;
  const includeEdgeTaxonomy = params.detail !== "minimal";
  const edges = computeEdgeStats(view, { includeTaxonomy: includeEdgeTaxonomy, cacheKey: edgeStatsCacheKey({ meta, versionId }) });
  const freshness = ledger
    ? viewFreshness(meta, ledger)
    : { current: true, branch: meta.branch, ledgerSeq: meta.ledger_seq, headSeq: null, reason: null };
  const policy = ledger ? getEffectivePolicy(ledger, repoId) : null;
  const liveIndexStatus = buildLiveIndexStatus({ repoRoot: root, versionId });
  const health = buildRepoHealth({ stats, edges, freshness, embeddingStatus, liveIndexStatus });
  const capabilities = buildAtlasCapabilities({ config, policy, embeddingStatus });
  const watcherHealth = buildWatcherHealth({ config });
  const cacheStats = buildCacheStats();
  const prefetchStats = buildPrefetchStats();
  const semanticStatus = buildSemanticStatus({ config, embeddingStatus, view, edges, repoRoot: root });
  const indexProgress = buildIndexProgress({ meta, freshness, versionId });
  const graphDerivedState = buildGraphDerivedState(view);
  const treeCompression = buildTreeCompressionStatus(view);
  const dataQuality = params.detail === "minimal" ? null : buildDataQuality(view, ledger);
  const memoryStats = ledger ? buildMemoryStats(ledger, repoId) : null;
  /** @type {RepoStatusData} */
  const data = {
    repoId,
    versionId,
    indexedSymbols: stats.symbolCount,
    indexedFiles: stats.fileCount,
    languages: stats.languages,
    lastIndexedAt: meta.built_at,
    repoRoot: root,
    ledgerPath: root ? ledgerDbPath(root) : undefined,
    viewPath,
    branch: meta.branch,
    ledgerSeq: meta.ledger_seq,
    diagnostics: { warnings: [] },
    health,
    index: {
      byLang: stats.byLang,
      byKind: stats.byKind,
      tokenMetrics: tokenMetricsFor(stats),
    },
    edges,
    capabilities,
    watcherHealth,
    liveIndexStatus,
    prefetchStats,
    cacheStats,
    semanticStatus,
    indexProgress,
    graphDerivedState,
    treeCompression,
    memoryStats,
    features: {
      memory: policy ? policy.memoryEnabled !== false : true,
      runtime: policy ? policy.runtimeEnabled === true : false,
      workflow: true,
      liveBuffers: true,
      scipIngest: true,
    },
  };
  if (dataQuality) data.dataQuality = dataQuality;
  if (embeddingStatus) data.embeddings = embeddingStatus;
  if (!freshness.current) {
    data.diagnostics?.warnings.push("View is behind ledger head; run index.refresh.");
  }
  const trueUnresolvedRate = edges.taxonomy && edges.total > 0 ? Number(edges.trueUnresolved || 0) / edges.total : 0;
  if (edges.taxonomy && trueUnresolvedRate > 0.25) {
    data.diagnostics?.warnings.push(`High true-unresolved edge rate: ${Math.round(trueUnresolvedRate * 100)}%.`);
  }
  const scipWarning = scipAvailableButDisabledWarning({ root, ledger, config, edges });
  if (scipWarning) data.diagnostics?.warnings.push(scipWarning);
  if (params.surfaceMemories && ledger) {
    try {
      // memorySurface requires anchors (no anchors → always-empty presence,
      // which made this advertised feature a silent no-op). Seed it with the
      // repo's own recently-touched memory anchors so "surface relevant
      // memories" surfaces what the store actually knows about.
      const anchors = recentMemoryAnchorFiles(ledger, repoId);
      const surfaced = anchors.length > 0
        ? memorySurface({
          versionId,
          ledger,
          repoId,
          params: { fileRelPaths: anchors },
        })
        : null;
      data.surfacedMemories = surfaced?.ok ? surfaced.data : { symbols: [], files: [] };
    } catch {
      data.surfacedMemories = { symbols: [], files: [] };
    }
  } else if (params.surfaceMemories) {
    data.surfacedMemories = { symbols: [], files: [] };
  }
  const warnings = data.diagnostics?.warnings || [];
  return okEnvelope({
    action: "repo.status",
    versionId,
    data,
    meta: warnings.length > 0 ? { warnings: warnings.slice() } : undefined,
  });
}

/**
 * Compressed-tree label freshness: how many ML-authored area labels still
 * match the current deterministic tree, how many have drifted (area re-treed
 * since labeling), and when the model last actually wrote text. The ML pass
 * runs only at boot, so drift here is expected steady-state — this summary is
 * what tells you whether the overview labels are merely "slightly behind" or
 * genuinely rotten.
 *
 * @param {import("../contracts/api.js").View} view
 */
function buildTreeCompressionStatus(view) {
  const db = typeof /** @type {any} */ (view)?._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  if (!db) return null;
  try {
    const snapshot = readLatestTreeCompressionSnapshot(db, { seedLimit: 1000, withStaleness: true });
    if (!snapshot?.available || !snapshot.snapshot) return { available: false };
    let staleLabels = 0;
    let maxDriftCount = 0;
    let oldestStaleSince = null;
    let lastLabeledAt = null;
    for (const seed of snapshot.seeds) {
      if (seed.labelStale === true) staleLabels += 1;
      const drift = Number(seed.driftCount || 0);
      if (drift > maxDriftCount) maxDriftCount = drift;
      if (seed.staleSince && (!oldestStaleSince || seed.staleSince < oldestStaleSince)) oldestStaleSince = seed.staleSince;
      if (seed.labeledAt && (!lastLabeledAt || seed.labeledAt > lastLabeledAt)) lastLabeledAt = seed.labeledAt;
    }
    return {
      available: true,
      profile: snapshot.snapshot.profile || null,
      builtAt: snapshot.snapshot.builtAt || null,
      seedCount: snapshot.seeds.length,
      currentLabels: snapshot.seeds.length - staleLabels,
      staleLabels,
      maxDriftCount,
      oldestStaleSince,
      lastLabeledAt,
    };
  } catch {
    return { available: false };
  }
}

/**
 * File anchors of the repo's most recently touched active memories — the
 * seed set for repo.status's surfaceMemories presence summary.
 *
 * @param {LedgerContract} ledger
 * @param {string | null} repoId
 * @param {number} [limit]
 * @returns {string[]}
 */
function recentMemoryAnchorFiles(ledger, repoId, limit = 25) {
  const ledgerPath = typeof /** @type {any} */ (ledger)?._dbPath === "function"
    ? /** @type {any} */ (ledger)._dbPath()
    : "";
  const memoryPath = memoryDbPathForLedgerDb(ledgerPath);
  if (!repoId || !memoryPath || !fs.existsSync(memoryPath)) return [];
  let memoryDb = null;
  try {
    memoryDb = new Database(memoryPath, { readonly: true, fileMustExist: true });
    const rows = /** @type {Array<{ repo_rel_path: string }>} */ (memoryDb.prepare(
      `SELECT l.repo_rel_path AS repo_rel_path
       FROM memory_file_links l
       JOIN memories m ON m.memory_id = l.memory_id
       WHERE m.repo_id = ? AND m.deleted = 0
       GROUP BY l.repo_rel_path
       ORDER BY MAX(m.updated_at) DESC
       LIMIT ?`,
    ).all(repoId, Math.max(1, limit)));
    return rows.map((row) => String(row.repo_rel_path || "")).filter(Boolean);
  } catch {
    return []; // best effort; repo.status must not fail on memory surfacing
  } finally {
    try { memoryDb?.close?.(); } catch { /* ignore */ }
  }
}

/**
 * @param {LedgerContract} ledger
 * @param {string | null} [repoId]
 */
function buildMemoryStats(ledger, repoId = null) {
  const db = typeof /** @type {any} */ (ledger)?._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
  const ledgerPath = typeof /** @type {any} */ (ledger)?._dbPath === "function"
    ? /** @type {any} */ (ledger)._dbPath()
    : "";
  const memoryPath = memoryDbPathForLedgerDb(ledgerPath);
  // Scope to this repo's ACTIVE rows: memory.db is shared across repo ids and
  // keeps soft-deleted rows, so an unscoped COUNT advertises memory (and
  // unhides memory.surface downstream) for stores holding only deleted or
  // other-repo rows.
  const activeCountSql = repoId
    ? "SELECT COUNT(*) AS cnt FROM memories WHERE repo_id = ? AND deleted = 0"
    : "SELECT COUNT(*) AS cnt FROM memories WHERE deleted = 0";
  const activeCountParams = repoId ? [repoId] : [];
  let memories = db ? countSql(db, activeCountSql, activeCountParams) : 0;
  if (memoryPath && fs.existsSync(memoryPath)) {
    let memoryDb = null;
    try {
      memoryDb = new Database(memoryPath, { readonly: true, fileMustExist: true });
      memories = countSql(memoryDb, activeCountSql, activeCountParams);
    } catch {
      // Keep repo.status best-effort; memory.surface/get are the source of truth.
    } finally {
      try { memoryDb?.close?.(); } catch { /* ignore */ }
    }
  }
  if (!db) return { memories, feedbackSignals: 0 };
  return {
    memories,
    feedbackSignals: countSql(db, "SELECT COUNT(*) AS cnt FROM feedback_signals"),
  };
}

/**
 * @param {{
 *   versionId: string,
 *   params: IndexRefreshParams,
 *   repoRoot?: string,
 *   ledger?: LedgerContract,
 *   config?: Record<string, unknown>,
 * }} args
 * @returns {Promise<ReturnType<typeof okEnvelope<IndexRefreshData>> | ReturnType<typeof errorEnvelope>>}
 */
export async function indexRefresh({ versionId, params, repoRoot, ledger, config = {} }) {
  const root = resolveRepoRoot(repoRoot);
  if (!root) {
    return errorEnvelope({
      action: "index.refresh",
      versionId,
      code: "missing_repo_root",
      message: "index.refresh requires dispatch context repoRoot",
    });
  }

  const branch = String(params.branch || defaultBranchForRepo(root)).trim() || "main";
  const paths = Array.isArray(params.paths) ? params.paths : [];
  const requestedMode = params.mode || "smart";
  const mode = requestedMode === "incremental" || (requestedMode === "smart" && paths.length > 0)
    ? "incremental"
    : "full";
  const operation = createIndexOperation({ params, mode, branch, paths });
  const diagnostics = params.includeDiagnostics ? createIndexDiagnostics(operation) : null;
  const progress = createIndexProgressRecorder({ operation, diagnostics });
  try {
    const refreshResult = await systemAtlasRefresh({
      reason: "tool.index.refresh",
      repoRoot: root,
      mode,
      branch,
      paths,
      wait: params.wait !== false,
      config,
      ledger,
      onProgress: progress.onProgress,
    });
    progress.finish("completed");
    const nextVersionId = refreshResult.versionId || `${branch}@0`;
    /** @type {IndexRefreshData} */
    const data = {
      repoRoot: root,
      branch,
      mode,
      versionId: nextVersionId,
      viewPath: refreshResult.viewPath || mainViewPath(root),
      warmResult: refreshResult.warmResult,
      operation,
    };
    if (diagnostics) data.diagnostics = diagnostics;
    return okEnvelope({
      action: "index.refresh",
      versionId: nextVersionId,
      data,
      meta: indexRefreshMeta(operation, diagnostics),
    });
  } catch (err) {
    progress.finish("failed", err);
    return errorEnvelope({
      action: "index.refresh",
      versionId,
      code: "index_refresh_failed",
      message: errorMessage(err, "index refresh failed"),
      details: {
        operation,
        ...(diagnostics ? { diagnostics } : {}),
      },
      meta: indexRefreshMeta(operation, diagnostics),
    });
  }
}

/**
 * @param {Record<string, unknown>} operation
 * @param {Record<string, unknown> | null} diagnostics
 * @returns {Record<string, unknown>}
 */
function indexRefreshMeta(operation, diagnostics) {
  return {
    operation,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: RepoOverviewParams,
 * }} args
 */
export function repoOverview({ view, versionId, params }) {
  const stats = computeStats(view);
  const edges = computeEdgeStats(view, { includeTaxonomy: true, cacheKey: edgeStatsCacheKey({ meta: view.meta(), versionId }) });
  const level = params.level || "stats";
  const includeDirectories = level === "directories" || level === "full";
  const includeHotspots = params.includeHotspots === true || level === "hotspots" || level === "full";
  const includeGraph = level === "graph" || level === "full";
  const directories = includeDirectories ? topDirectorySummaries(view, params) : undefined;
  const topSymbols = includeHotspots || includeGraph ? topSymbolMetrics(view, 10) : null;
  const derivedGraph = includeGraph ? readGraphDerivedOverview(view, 10) : null;
  /** @type {RepoOverviewData} */
  const data = {
    level,
    etag: `ov:${versionId}:${level}:${stats.symbolCount}`,
  };

  if (params.ifNoneMatch && params.ifNoneMatch === data.etag) {
    return okEnvelope({
      action: "repo.overview",
      versionId,
      data: { level, etag: data.etag },
      meta: { notModified: true, cached: true, etag: data.etag },
    });
  }

  if (level !== "stats") {
    data.directories = directories;
  }

  data.stats = {
    files: stats.fileCount,
    symbols: stats.symbolCount,
    byLang: stats.byLang,
    byKind: stats.byKind,
    edges,
    tokenMetrics: tokenMetricsFor(stats),
  };
  if (includeHotspots) {
    data.hotspots = topHotspots(view, 10);
    data.graph = {
      edges,
      symbolKinds: stats.byKind,
      languages: stats.languages,
      topByFanIn: topSymbols?.byFanIn || [],
      topByFanOut: topSymbols?.byFanOut || [],
    };
  }
  if (includeGraph) {
    const entryPoints = findEntryPointPaths(view);
    const layers = directories ? identifyArchitecturalLayers(directories) : [];
    data.graph = {
      ...(data.graph || {}),
      edges,
      symbolKinds: stats.byKind,
      languages: stats.languages,
      topByFanIn: topSymbols?.byFanIn || [],
      topByFanOut: topSymbols?.byFanOut || [],
      centrality: derivedGraph?.centrality || [],
      clusters: derivedGraph?.clusters || [],
      processes: derivedGraph?.processes || [],
      entryPoints,
      layers,
      derivedState: {
        available: derivedGraph?.available === true,
        reason: derivedGraph?.reason || null,
        latestRun: derivedGraph?.latestRun || null,
      },
      tokenCompression: overviewTokenMetrics(stats, directories || []),
    };
  }
  data.capabilities = {
    workflow: true,
    memory: true,
    runtime: "policy-gated",
    liveBuffers: true,
    scipIngest: true,
  };

  return okEnvelope({ action: "repo.overview", versionId, data });
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: RepoQualityParams,
 *   repoRoot?: string,
 *   viewPath?: string,
 *   ledger?: LedgerContract,
 *   config?: Record<string, unknown>,
 * }} args
 */
export function repoQuality({ view, versionId, params, repoRoot, viewPath, ledger, config = {} }) {
  const meta = view.meta();
  const root = repoRoot || meta.repo_root || undefined;
  const stats = computeStats(view);
  const edges = computeEdgeStats(view, { includeTaxonomy: true, cacheKey: edgeStatsCacheKey({ meta, versionId }) });
  const freshness = ledger
    ? viewFreshness(meta, ledger)
    : { current: true, branch: meta.branch, ledgerSeq: meta.ledger_seq, headSeq: null, reason: null };
  const treeSitter = treeSitterHealth({
    languages: stats.languages,
    probe: !!params.probeTreeSitter,
  });
  const embeddings = root ? computeEmbeddingStatus(root, config) : undefined;
  const feedback = ledger
    ? qualityFeedback({
        ledger,
        limit: typeof params.feedbackLimit === "number" && params.feedbackLimit > 0
          ? Math.min(Math.floor(params.feedbackLimit), 1000)
          : 100,
        halfLifeDays: params.halfLifeDays,
      })
    : undefined;
  const dataQuality = buildDataQuality(view, ledger);
  const warnings = [];
  if (!freshness.current && freshness.reason) warnings.push(freshness.reason);
  if (edges.unresolvedRate > 0.25) warnings.push(`High unresolved edge rate: ${Math.round(edges.unresolvedRate * 100)}%.`);
  const scipWarning = scipAvailableButDisabledWarning({ root, ledger, config, edges });
  if (scipWarning) warnings.push(scipWarning);
  for (const failure of treeSitter.observedFailures) {
    warnings.push(`native parser unavailable for ${failure.lang}: ${failure.error}`);
  }
  if (embeddings && !embeddings.enabled && embeddings.reason && embeddings.reason !== "disabled") {
    warnings.push(`Embeddings unavailable: ${embeddings.reason}`);
  }

  /** @type {RepoQualityData} */
  const data = {
    repoRoot: root,
    viewPath,
    view: {
      branch: meta.branch,
      ledgerSeq: meta.ledger_seq,
      headSeq: freshness.headSeq,
      current: freshness.current,
      reason: freshness.reason,
    },
    coverage: {
      files: stats.fileCount,
      symbols: stats.symbolCount,
      languages: stats.languages,
    },
    edges,
    dataQuality,
    treeSitter,
    embeddings,
    feedback,
    diagnostics: { warnings },
  };
  return okEnvelope({
    action: "repo.quality",
    versionId,
    data,
    meta: warnings.length > 0 ? { warnings: warnings.slice() } : undefined,
  });
}

/**
 * @param {View} view
 */
function computeStats(view) {
  if (typeof view?.query?.stats === "function") {
    const stats = view.query.stats();
    return {
      symbolCount: Number(stats.symbol_count || 0),
      fileCount: Number(stats.file_count || 0),
      languages: Object.keys(stats.by_lang || {}).sort(),
      byLang: stats.by_lang || {},
      byKind: stats.by_kind || {},
      truncated: false,
    };
  }
  /** @type {Map<string, number>} */
  const byLang = new Map();
  /** @type {Map<string, number>} */
  const byKind = new Map();
  /** @type {Set<string>} */
  const files = new Set();
  const all = readAllSymbols(view);
  for (const s of all) {
    files.add(s.repo_rel_path);
    byLang.set(s.lang, (byLang.get(s.lang) || 0) + 1);
    byKind.set(s.kind, (byKind.get(s.kind) || 0) + 1);
  }
  /** @type {Record<string, number>} */
  const byLangObj = {};
  for (const [k, v] of byLang) byLangObj[k] = v;
  /** @type {Record<string, number>} */
  const byKindObj = {};
  for (const [k, v] of byKind) byKindObj[k] = v;
  return {
    symbolCount: all.length,
    fileCount: files.size,
    languages: [...byLang.keys()].sort(),
    byLang: byLangObj,
    byKind: byKindObj,
    truncated: false,
  };
}

/**
 * @param {View} view
 * @returns {import("better-sqlite3").Database | null}
 */
function viewDb(view) {
  return typeof /** @type {any} */ (view)._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
}

/**
 * @param {View} view
 * @param {{ pathPrefix?: string }} [opts]
 * @returns {ViewSymbol[]}
 */
function readAllSymbols(view, opts = {}) {
  return view.query.allSymbols({
    limit: Number.MAX_SAFE_INTEGER,
    ...(opts.pathPrefix ? { pathPrefix: opts.pathPrefix } : {}),
  });
}

function tokenMetricsFor(stats) {
  return {
    estimatedCardTokens: stats.symbolCount * 220,
    estimatedSkeletonTokens: stats.symbolCount * 320,
    estimatedFileContextTokens: stats.fileCount * 800,
  };
}

function buildRepoHealth({ stats, edges, freshness, embeddingStatus, liveIndexStatus = null }) {
  const indexedCoverage = stats.fileCount > 0 && stats.symbolCount > 0 ? 100 : stats.fileCount > 0 ? 60 : 20;
  const edgeQuality = edges.total > 0 ? Math.round((edges.resolved / edges.total) * 100) : 100;
  const callResolution = edges.callTotal > 0 ? Math.round((edges.callResolved / edges.callTotal) * 100) : 100;
  const embeddingFreshness = embeddingStatus?.enabled ? 100 : embeddingStatus?.reason === "disabled" ? 75 : 60;
  const liveBufferFreshness = liveIndexStatus?.enabled === false
    ? 75
    : liveIndexStatus?.parseFailureCount > 0
      ? 70
      : 100;
  const components = {
    coverage: indexedCoverage,
    indexedCoverage,
    parseHealth: stats.symbolCount > 0 ? 100 : stats.fileCount > 0 ? 70 : 40,
    edgeResolution: edgeQuality,
    edgeQuality,
    callResolution,
    freshness: freshness.current ? 100 : 50,
    embeddingFreshness,
    embeddings: embeddingFreshness,
    liveBufferFreshness,
  };
  const scored = [
    components.indexedCoverage,
    components.parseHealth,
    components.edgeQuality,
    components.callResolution,
    components.freshness,
    components.embeddingFreshness,
    components.liveBufferFreshness,
  ];
  const healthScore = Math.round(
    scored.reduce((sum, score) => sum + score, 0) / scored.length,
  );
  return {
    schemaVersion: 2,
    healthScore,
    components,
    current: freshness.current,
    reason: freshness.reason,
  };
}

/**
 * @param {string | undefined} root
 * @returns {string | null}
 */
function resolveRepoRoot(root) {
  if (!root || typeof root !== "string") return null;
  return path.resolve(root);
}

/**
 * @param {View} view
 * @param {LedgerContract | undefined} ledger
 */
function buildDataQuality(view, ledger) {
  const symbols = readAllSymbols(view);
  const hiddenNoisySymbols = symbols.filter(isNoisyLocalSymbol).length;
  const generatedFileSymbols = symbols.filter((s) => isGeneratedPath(s.repo_rel_path)).length;
  const literalSymbols = symbols.filter((s) => isLiteralSymbolName(s.name)).length;
  const literalDuplicateGroups = duplicateLiteralGroups(symbols);
  return {
    symbols: {
      total: symbols.length,
      bySource: symbolCountsBySource({ symbols, ledger }),
      hiddenNoisySymbols,
      generatedFileSymbols,
      literalSymbols,
      literalDuplicateGroups,
    },
    edges: edgeSourceQuality(view),
  };
}

/**
 * @param {ViewSymbol[]} symbols
 */
function duplicateLiteralGroups(symbols) {
  const counts = new Map();
  for (const s of symbols) {
    if (!isLiteralSymbolName(s.name)) continue;
    const key = `${s.repo_rel_path}\0${s.kind}\0${String(s.name).replace(/^(['"`])(.*)\1$/, "$2").toLowerCase()}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let groups = 0;
  let duplicateRows = 0;
  for (const count of counts.values()) {
    if (count <= 1) continue;
    groups += 1;
    duplicateRows += count - 1;
  }
  return { groups, duplicateRows };
}

/**
 * @param {{ symbols: ViewSymbol[], ledger?: LedgerContract }} args
 * @returns {Record<string, number> | null}
 */
function symbolCountsBySource({ symbols, ledger }) {
  const db = ledger && typeof /** @type {any} */ (ledger)._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
  if (!db) return null;
  try {
    /** @type {Record<string, number>} */
    const out = {};
    /** @type {ViewSymbol[]} */
    const flatFallback = [];
    const byBlob = new Map();
    for (const symbol of symbols) {
      if (!symbol.content_hash || !Number.isInteger(symbol.local_id)) continue;
      const key = `${symbol.content_hash}\0${symbol.lang || ""}`;
      const group = byBlob.get(key) || [];
      group.push(symbol);
      byBlob.set(key, group);
    }
    for (const group of byBlob.values()) {
      const first = group[0];
      let merged = null;
      try {
        merged = mergeLayerRows(db, first.content_hash, first.lang || null);
      } catch {
        merged = null;
      }
      if (!merged || !Array.isArray(merged.symbols) || merged.symbols.length === 0) {
        flatFallback.push(...group);
        continue;
      }
      const sourceByLocal = new Map(
        merged.symbols.map((row) => [Number(row.local_id), String(row.source || "unknown")]),
      );
      for (const symbol of group) {
        const source = sourceByLocal.get(symbol.local_id) || "unknown";
        out[source] = (out[source] || 0) + 1;
      }
    }
    countFlatSymbolsBySource(db, flatFallback, out);
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {any} db
 * @param {ViewSymbol[]} symbols
 * @param {Record<string, number>} out
 */
function countFlatSymbolsBySource(db, symbols, out) {
  const chunkSize = 400;
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize)
      .filter((symbol) => symbol.content_hash && Number.isInteger(symbol.local_id));
    if (chunk.length === 0) continue;
    const values = chunk.map(() => "(?, ?)").join(", ");
    const params = [];
    for (const symbol of chunk) {
      params.push(symbol.content_hash, symbol.local_id);
    }
    const rows = db.prepare(
      `WITH keys(content_hash, local_id) AS (VALUES ${values})
       SELECT COALESCE(bs.source, 'unknown') AS source, COUNT(*) AS count
       FROM keys k
       LEFT JOIN blob_symbols bs
         ON bs.content_hash = k.content_hash AND bs.local_id = k.local_id
       GROUP BY source`,
    ).all(...params);
    for (const row of rows) {
      const source = String(row.source || "unknown");
      out[source] = (out[source] || 0) + Number(row.count || 0);
    }
  }
}

/**
 * @param {View} view
 */
function edgeSourceQuality(view) {
  try {
    return typeof view?.query?.edgeStats === "function" ? view.query.edgeStats().by_source : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ root?: string, ledger?: LedgerContract, config?: Record<string, unknown>, edges: { external?: number } }} args
 * @returns {string | null}
 */
function scipAvailableButDisabledWarning({ root, ledger, config = {}, edges }) {
  if (configuredScipMode(config) !== "off") return null;
  if (Number(edges?.external || 0) > 0) return null;
  const indexed = ledgerScipIndexCount(ledger);
  const staged = stagedScipFileCount(root);
  if (indexed <= 0 && staged <= 0) return null;
  const parts = [];
  if (indexed > 0) parts.push(`${indexed} ingested SCIP index${indexed === 1 ? "" : "es"}`);
  if (staged > 0) parts.push(`${staged} staged .scip file${staged === 1 ? "" : "s"}`);
  return `SCIP data available (${parts.join(", ")}) but atlas_scip_mode=off; compiler-grade edges are excluded from the view.`;
}

/**
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function configuredScipMode(config) {
  return String(
    config.scipMode
      ?? config.atlas_scip_mode
      ?? config.POSSE_ATLAS_SCIP_MODE
      ?? "",
  ).trim().toLowerCase();
}

/**
 * @param {LedgerContract | undefined} ledger
 * @returns {number}
 */
function ledgerScipIndexCount(ledger) {
  const db = ledger && typeof /** @type {any} */ (ledger)._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
  if (!db) return 0;
  try {
    const row = db.prepare(
      "SELECT COUNT(*) AS cnt FROM scip_indexes WHERE status IN ('complete', 'partial')",
    ).get();
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}

/**
 * @param {string | undefined} root
 * @returns {number}
 */
function stagedScipFileCount(root) {
  if (!root) return 0;
  try {
    const dir = path.join(root, ".posse", "atlas", "scip");
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".scip"))
      .length;
  } catch {
    return 0;
  }
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function defaultBranchForRepo(repoRoot) {
  return detectGitCurrentBranch(repoRoot) || detectGitDefaultBranch(repoRoot) || "main";
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function detectGitCurrentBranch(repoRoot) {
  const branch = gitOutput(repoRoot, ["branch", "--show-current"]);
  return branch && branch !== "HEAD" ? branch : "";
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function detectGitDefaultBranch(repoRoot) {
  const key = path.resolve(repoRoot);
  const cached = DEFAULT_BRANCH_CACHE.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.branch;

  let detected = "";
  for (const args of [
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ["rev-parse", "--abbrev-ref", "origin/HEAD"],
  ]) {
    detected = normalizeRemoteBranch(gitOutput(repoRoot, args));
    if (detected) break;
  }
  writeDefaultBranchCache(key, detected, now);
  return detected;
}

/**
 * @param {string} key
 * @param {string} branch
 * @param {number} now
 */
function writeDefaultBranchCache(key, branch, now) {
  DEFAULT_BRANCH_CACHE.set(key, { branch, expiresAt: now + DEFAULT_BRANCH_CACHE_TTL_MS });
  while (DEFAULT_BRANCH_CACHE.size > DEFAULT_BRANCH_CACHE_MAX) {
    const first = DEFAULT_BRANCH_CACHE.keys().next().value;
    if (!first) break;
    DEFAULT_BRANCH_CACHE.delete(first);
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeRemoteBranch(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "origin/HEAD" || raw === "HEAD") return "";
  return raw.startsWith("origin/") ? raw.slice("origin/".length) : raw;
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {string}
 */
function gitOutput(repoRoot, args) {
  return gitExecSafe(args, repoRoot);
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} [config]
 * @returns {{ enabled: boolean, provider: string | null, backend?: string | null, indexedCount?: number, reason?: string | null }}
 */
function computeEmbeddingStatus(repoRoot, config = {}) {
  const resources = openEmbeddingResources({ repoRoot, config });
  try {
    // Count straight from the sidecar keys.db instead of index.count(): the
    // production index is a child process whose count() is async (useless to
    // this synchronous helper) and whose first request would fork a child and
    // fully init the ANN just to answer a status probe.
    const indexedCount = resources.index
      ? countIndexedEmbeddings(repoRoot, resources.index)
      : undefined;
    return {
      enabled: resources.enabled,
      provider: resources.provider || null,
      backend: resources.backend || null,
      reason: resources.reason,
      ...(Number.isFinite(indexedCount) ? { indexedCount } : {}),
    };
  } finally {
    void Promise.resolve(resources.close()).catch(() => {});
  }
}

/**
 * Read-only `SELECT COUNT(*) FROM keys` against the embedding sidecar for the
 * index's (model, model_version). Missing sidecar means nothing indexed yet
 * (count 0); a read failure yields undefined so the status omits the field.
 *
 * @param {string} repoRoot
 * @param {{ model: string, model_version: string }} index
 * @returns {number | undefined}
 */
function countIndexedEmbeddings(repoRoot, index) {
  const sidecarPath = path.join(
    embeddingsRoot(repoRoot),
    childEmbeddingModelDirName({ model: index.model, model_version: index.model_version }),
    "keys.db",
  );
  if (!fs.existsSync(sidecarPath)) return 0;
  let db = null;
  try {
    db = new Database(sidecarPath, { readonly: true, fileMustExist: true });
    const row = /** @type {{ c: number } | undefined} */ (
      db.prepare("SELECT COUNT(*) AS c FROM keys").get()
    );
    return Number(row?.c ?? 0);
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

/**
 * @param {{ config?: Record<string, unknown> }} args
 */
function buildWatcherHealth({ config = {} }) {
  const requested = configFlag(config.atlasWatcherEnabled)
    || configFlag(config.watcherEnabled)
    || configFlag(config.atlasLiveReconciliation)
    || configFlag(config.liveReconciliationEnabled);
  return {
    enabled: requested,
    running: false,
    filesWatched: 0,
    eventsReceived: 0,
    eventsProcessed: 0,
    errors: 0,
    queueDepth: 0,
    restartCount: 0,
    stale: false,
    lastEventAt: null,
    lastSuccessfulReindexAt: null,
    reason: requested ? "watcher_not_implemented" : "not_configured",
  };
}

/**
 * @param {{ repoRoot?: string, versionId: string }} args
 */
function buildLiveIndexStatus({ repoRoot, versionId }) {
  if (!repoRoot) {
    return {
      enabled: false,
      mode: "buffer-overlay",
      running: false,
      reason: "missing_repo_root",
      buffers: 0,
      dirtyBuffers: 0,
      parsedBuffers: 0,
      parseFailureCount: 0,
      pendingWrites: 0,
      queuedCheckpoints: 0,
      lastBufferAt: null,
      lastSuccessfulReindexAt: null,
      stale: false,
      warnings: [],
    };
  }
  try {
    const status = /** @type {any} */ (bufferStatus({ repoRoot, versionId, params: {} }));
    if (!status.ok) throw new Error(status.error?.message || status.error?.code || "buffer_status_failed");
    const data = /** @type {any} */ (status.data || {});
    const parseFailureCount = Number(data.parseFailureCount || 0);
    const dirtyBuffers = Number(data.dirtyCount || 0);
    const reconciliation = liveReconciliationStatus({
      repoRoot,
      buffers: Number(data.total || 0),
      dirtyBuffers,
      parsedBuffers: Number(data.parsedCount || 0),
      parseFailureCount,
      lastBufferAt: data.lastUpdatedAt || null,
    });
    return {
      enabled: true,
      mode: "buffer-reconciliation",
      running: true,
      reason: null,
      buffers: Number(data.total || 0),
      dirtyBuffers,
      parsedBuffers: Number(data.parsedCount || 0),
      parseFailureCount,
      syntaxErrorCount: Number(data.syntaxErrorCount || 0),
      pendingWrites: dirtyBuffers,
      queuedCheckpoints: 0,
      lastBufferAt: data.lastUpdatedAt || null,
      lastSuccessfulReindexAt: reconciliation.lastSuccessfulReindexAt,
      stale: parseFailureCount > 0,
      reconciliation,
      draftLimit: data.draftLimit,
      draftLimitReached: data.draftLimitReached === true,
      staleRejectedCount: Number(data.staleRejectedCount || 0),
      versionConflictRejectedCount: Number(data.versionConflictRejectedCount || 0),
      draftLimitRejectedCount: Number(data.draftLimitRejectedCount || 0),
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
    };
  } catch (err) {
    return {
      enabled: true,
      mode: "buffer-overlay",
      running: false,
      reason: err?.message || String(err),
      buffers: 0,
      dirtyBuffers: 0,
      parsedBuffers: 0,
      parseFailureCount: 0,
      pendingWrites: 0,
      queuedCheckpoints: 0,
      lastBufferAt: null,
      lastSuccessfulReindexAt: null,
      stale: true,
      warnings: ["Unable to read live buffer status."],
    };
  }
}

function buildCacheStats() {
  try {
    const stats = getRetrievalCache().telemetry();
    return {
      enabled: true,
      mode: "process-local",
      cards: {
        entries: Number(stats.cards.entries || 0),
        hitRate: stats.cards.hitRate,
        hits: stats.cards.hits,
        misses: stats.cards.misses,
        sets: stats.cards.sets,
      },
      slices: {
        entries: Number(stats.slices.entries || 0),
        hitRate: stats.slices.hitRate,
        hits: stats.slices.hits,
        misses: stats.slices.misses,
        sets: stats.slices.sets,
      },
      hitRate: combinedHitRate(stats.cards, stats.slices),
      reason: null,
    };
  } catch (err) {
    return {
      enabled: false,
      mode: "process-local",
      cards: { entries: 0, hitRate: null, hits: null, misses: null },
      slices: { entries: 0, hitRate: null, hits: null, misses: null },
      hitRate: null,
      reason: err?.message || String(err),
    };
  }
}

function buildPrefetchStats() {
  return getPrefetchStats();
}

/**
 * @param {{ hits: number, misses: number }} cards
 * @param {{ hits: number, misses: number }} slices
 */
function combinedHitRate(cards, slices) {
  const hits = Number(cards.hits || 0) + Number(slices.hits || 0);
  const misses = Number(cards.misses || 0) + Number(slices.misses || 0);
  const total = hits + misses;
  return total > 0 ? hits / total : null;
}

/**
 * @param {{ config?: Record<string, unknown>, embeddingStatus?: { enabled?: boolean, provider?: string | null, backend?: string | null, indexedCount?: number, reason?: string | null } | null, view?: View, edges?: ReturnType<typeof computeEdgeStats>, repoRoot?: string }} args
 */
function buildSemanticStatus({ config = {}, embeddingStatus = null, view, edges, repoRoot }) {
  const dispatchEnabled = semanticDispatchEnabled(config);
  const embeddingsEnabled = embeddingStatus?.enabled === true;
  const enrichment = readSemanticEnrichmentStatus({ view, edges });
  return {
    enabled: dispatchEnabled && embeddingsEnabled,
    dispatchEnabled,
    provider: embeddingStatus?.provider || null,
    backend: embeddingStatus?.backend || null,
    indexedCount: Number.isFinite(Number(embeddingStatus?.indexedCount)) ? Number(embeddingStatus?.indexedCount) : null,
    wi_mode: normalizeWiEmbeddingsMode(config),
    reason: dispatchEnabled
      ? embeddingsEnabled ? null : embeddingStatus?.reason || "embeddings_unavailable"
      : "semantic_dispatch_disabled",
    embeddings: embeddingStatus || { enabled: false, provider: null, backend: null, reason: "missing_repo_root" },
    enrichment,
    localOnnx: inspectLocalOnnxStatus({ repoRoot, config }),
  };
}

/**
 * @param {Record<string, unknown>} config
 * @returns {"off" | "on_demand" | "on"}
 */
function normalizeWiEmbeddingsMode(config = {}) {
  const raw = String(config.wiEmbeddings || config.atlasWiEmbeddings || config.atlas_wi_embeddings || "on_demand").trim().toLowerCase();
  return raw === "off" || raw === "on_demand" || raw === "on" ? raw : "on_demand";
}

/**
 * @param {{ meta: ReturnType<View["meta"]>, freshness: { current: boolean, reason: string | null }, versionId: string }} args
 */
function buildIndexProgress({ meta, freshness, versionId }) {
  const lastVersionId = `${meta.branch}@${meta.ledger_seq}`;
  return {
    active: false,
    operationId: null,
    status: freshness.current ? "idle" : "stale",
    mode: null,
    phase: null,
    current: null,
    total: null,
    percent: null,
    startedAt: null,
    updatedAt: meta.built_at || null,
    completedAt: meta.built_at || null,
    lastIndexedAt: meta.built_at || null,
    lastVersionId,
    requestedVersionId: versionId,
    lastError: freshness.current ? null : freshness.reason,
  };
}

/**
 * @param {View} view
 */
function buildGraphDerivedState(view) {
  const graph = readGraphDerivedOverview(view, 5);
  if (!graph.available) {
    return {
      available: false,
      status: "unavailable",
      reason: graph.reason || "graph_derived_unavailable",
      clusterCount: 0,
      processCount: 0,
      centralityRows: 0,
      latestRun: graph.latestRun || null,
      topClusters: [],
      longestProcesses: [],
      topCentrality: [],
    };
  }
  const db = typeof /** @type {any} */ (view)._unsafeDb === "function" ? /** @type {any} */ (view)._unsafeDb() : null;
  return {
    available: true,
    status: graph.latestRun?.status || "ready",
    reason: null,
    clusterCount: db ? countSql(db, "SELECT COUNT(*) AS cnt FROM cluster_summaries") : graph.clusters.length,
    processCount: db ? countSql(db, "SELECT COUNT(*) AS cnt FROM process_summaries") : graph.processes.length,
    centralityRows: db ? countSql(db, "SELECT COUNT(*) AS cnt FROM symbol_centrality") : graph.centrality.length,
    latestRun: graph.latestRun || null,
    topClusters: graph.clusters,
    longestProcesses: graph.processes,
    topCentrality: graph.centrality,
  };
}

/**
 * @param {View} view
 * @param {number} limit
 */
function readGraphDerivedOverview(view, limit) {
  const db = typeof /** @type {any} */ (view)._unsafeDb === "function" ? /** @type {any} */ (view)._unsafeDb() : null;
  if (!db) {
    return {
      available: false,
      reason: "view_db_unavailable",
      clusters: [],
      processes: [],
      centrality: [],
      latestRun: null,
    };
  }
  try {
    return readGraphOverview(db, limit);
  } catch (err) {
    return {
      available: false,
      reason: err?.message || String(err),
      clusters: [],
      processes: [],
      centrality: [],
      latestRun: null,
    };
  }
}

/**
 * @param {{ params: IndexRefreshParams, mode: "full" | "incremental", branch: string, paths: string[] }} args
 */
function createIndexOperation({ params, mode, branch, paths }) {
  const startedAt = new Date().toISOString();
  return {
    operationId: normalizeOperationId(params.operationId) || nextIndexOperationId(),
    asyncRequested: params.async === true || params.wait === false,
    detached: false,
    accepted: true,
    status: "running",
    mode,
    branch,
    phase: "queued",
    progress: {
      current: 0,
      total: paths.length > 0 ? paths.length : null,
      percent: null,
    },
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    durationMs: 0,
    lastError: null,
  };
}

/**
 * @param {ReturnType<typeof createIndexOperation>} operation
 */
function createIndexDiagnostics(operation) {
  return {
    schemaVersion: 1,
    operationId: operation.operationId,
    startedAt: operation.startedAt,
    completedAt: null,
    totalDurationMs: 0,
    phases: {},
    events: [],
  };
}

/**
 * @param {{ operation: ReturnType<typeof createIndexOperation>, diagnostics: ReturnType<typeof createIndexDiagnostics> | null }} args
 */
function createIndexProgressRecorder({ operation, diagnostics }) {
  const startedMs = Date.now();
  /** @type {string | null} */
  let activePhase = null;
  let activePhaseStartedMs = startedMs;

  /**
   * @param {string} nextPhase
   */
  function switchPhase(nextPhase) {
    const now = Date.now();
    if (activePhase) {
      recordPhaseTiming(activePhase, now - activePhaseStartedMs);
    }
    activePhase = nextPhase;
    activePhaseStartedMs = now;
  }

  /**
   * @param {string} phase
   * @param {number} durationMs
   */
  function recordPhaseTiming(phase, durationMs) {
    if (!diagnostics || !phase) return;
    const phases = /** @type {Record<string, any>} */ (diagnostics.phases);
    const current = phases[phase] || { count: 0, durationMs: 0 };
    current.count += 1;
    current.durationMs += Math.max(0, Math.round(durationMs));
    phases[phase] = current;
  }

  return {
    /**
     * @param {Record<string, unknown>} event
     */
    onProgress(event) {
      const nowIso = new Date().toISOString();
      const stage = normalizeProgressStage(event.stage || event.kind || operation.phase);
      if (stage && stage !== activePhase) switchPhase(stage);
      operation.phase = stage || operation.phase;
      operation.updatedAt = nowIso;
      const current = finiteNumber(event.current ?? event.progress_current);
      const total = finiteNumber(event.total ?? event.progress_total);
      const percent = finiteNumber(event.percent ?? event.progress_percent);
      if (current != null) operation.progress.current = current;
      if (total != null) operation.progress.total = total;
      if (percent != null) operation.progress.percent = Math.max(0, Math.min(100, percent));
      else if (operation.progress.total && operation.progress.current != null) {
        operation.progress.percent = Math.max(0, Math.min(100, (operation.progress.current / operation.progress.total) * 100));
      }
      if (diagnostics) {
        const events = /** @type {any[]} */ (diagnostics.events);
        if (events.length < 200) {
          events.push({
            at: nowIso,
            stage: operation.phase,
            text: typeof event.text === "string" ? event.text : null,
            current: operation.progress.current,
            total: operation.progress.total,
            percent: operation.progress.percent,
          });
        }
      }
    },
    /**
     * @param {"completed" | "failed"} status
     * @param {unknown} [err]
     */
    finish(status, err = null) {
      const now = Date.now();
      if (activePhase) {
        recordPhaseTiming(activePhase, now - activePhaseStartedMs);
        activePhase = null;
      }
      const completedAt = new Date(now).toISOString();
      operation.status = status;
      operation.phase = status === "completed" ? "complete" : "failed";
      operation.updatedAt = completedAt;
      operation.completedAt = completedAt;
      operation.durationMs = Math.max(0, now - startedMs);
      operation.progress.percent = status === "completed" ? 100 : operation.progress.percent;
      operation.lastError = status === "failed" ? errorMessage(err, "index refresh failed") : null;
      if (diagnostics) {
        diagnostics.completedAt = completedAt;
        diagnostics.totalDurationMs = operation.durationMs;
      }
    },
  };
}

function nextIndexOperationId() {
  indexOperationCounter = (indexOperationCounter + 1) % 1_000_000;
  return `atlas-index-${Date.now().toString(36)}-${indexOperationCounter.toString(36)}`;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeOperationId(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, 128);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeProgressStage(value) {
  const text = String(value || "").trim().toLowerCase();
  return text.replace(/[^a-z0-9_.-]+/g, "_").slice(0, 80);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} err
 * @param {string} fallback
 * @returns {string}
 */
function errorMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = /** @type {{ message?: unknown, code?: unknown }} */ (err);
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
    if (typeof obj.code === "string" && obj.code.trim()) return obj.code;
  }
  return String(err);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function configFlag(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

/**
 * @param {View} view
 * @param {{ includeTaxonomy?: boolean, cacheKey?: string | null }} [opts]
 * @returns {{ total: number, resolved: number, unresolved: number, unresolvedRate: number, internal: number, external: number, runtimeExternal?: number, dynamicReceiver?: number, importScopedExternal?: number, localUnbound?: number, selfReceiver?: number, trueUnresolved?: number, byKind: Record<string, number>, callTotal: number, callResolved: number, callResolutionRate: number, taxonomy?: Record<string, number> | null, taxonomyUnavailable?: string }}
 */
function computeEdgeStats(view, opts = {}) {
  const includeTaxonomy = opts.includeTaxonomy === true;
  if (typeof view?.query?.edgeStats === "function") {
    const nativeStats = view.query.edgeStats();
    const total = Number(nativeStats.total || 0);
    const internal = Number(nativeStats.internal || 0);
    const external = Number(nativeStats.external || 0);
    const resolved = Number(nativeStats.resolved || 0);
    const callTotal = Number(nativeStats.call_total || 0);
    const callResolved = Number(nativeStats.call_resolved || 0);
    const byKind = nativeStats.by_kind || {};
    const unresolved = Math.max(0, total - resolved);
    const out = {
      total,
      resolved,
      unresolved,
      unresolvedRate: total > 0 ? unresolved / total : 0,
      internal,
      external,
      byKind,
      callTotal,
      callResolved,
      callResolutionRate: callTotal > 0 ? callResolved / callTotal : 1,
    };
    if (!includeTaxonomy) return out;
    const taxonomy = edgeTaxonomy(view, nativeStats, opts.cacheKey || null);
    return {
      ...out,
      runtimeExternal: taxonomy.runtimeExternal,
      dynamicReceiver: taxonomy.dynamicReceiver,
      importScopedExternal: taxonomy.importScopedExternal,
      localUnbound: taxonomy.localUnbound,
      selfReceiver: taxonomy.selfReceiver,
      trueUnresolved: taxonomy.trueUnresolved,
      taxonomy,
    };
  }
  let total = 0;
  let resolved = 0;
  let internal = 0;
  let external = 0;
  let callTotal = 0;
  let callResolved = 0;
  /** @type {Record<string, number>} */
  const byKind = {};
  for (const s of readAllSymbols(view)) {
    const callees = view.query.callees(s.global_id);
    total += callees.length;
    resolved += callees.filter((edge) => edge.to_global_id != null || edge.to_external_id != null).length;
    internal += callees.filter((edge) => edge.to_global_id != null).length;
    external += callees.filter((edge) => edge.to_external_id != null).length;
    for (const edge of callees) {
      byKind[edge.kind] = (byKind[edge.kind] || 0) + 1;
      if (edge.kind === "calls") {
        callTotal += 1;
        if (edge.to_global_id != null || edge.to_external_id != null) callResolved += 1;
      }
    }
  }
  const unresolved = Math.max(0, total - resolved);
  const out = {
    total,
    resolved,
    unresolved,
    unresolvedRate: total > 0 ? unresolved / total : 0,
    internal,
    external,
    byKind,
    callTotal,
    callResolved,
    callResolutionRate: callTotal > 0 ? callResolved / callTotal : 1,
  };
  if (includeTaxonomy) out.taxonomyUnavailable = "view_db_unavailable";
  return out;
}

/**
 * @param {View} view
 * @param {{ internal?: number, external?: number }} edgeStats
 * @param {string | null} [cacheKey]
 */
function edgeTaxonomy(view, edgeStats, cacheKey = null) {
  const cached = readEdgeTaxonomyCache(cacheKey);
  if (cached) return cached;
  const input = view.query.edgeTaxonomyInput();
  const rows = Array.isArray(input.unresolved_edges) ? input.unresolved_edges : [];
  const importRows = Array.isArray(input.import_edges) ? input.import_edges : [];
  const importsByFile = buildExternalImportBindings(importRows);
  const repoSymbolNames = new Set(
    (Array.isArray(input.symbol_names) ? input.symbol_names : [])
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  );
  const taxonomy = {
    internalResolved: Number(edgeStats.internal || 0),
    externalResolved: Number(edgeStats.external || 0),
    runtimeExternal: 0,
    importScopedExternal: 0,
    dynamicReceiver: 0,
    localUnbound: 0,
    selfReceiver: 0,
    trueUnresolved: 0,
  };
  for (const row of rows) {
    const bucket = classifyUnresolvedEdge(row, { importsByFile, repoSymbolNames });
    taxonomy[bucket] += 1;
  }
  writeEdgeTaxonomyCache(cacheKey, taxonomy);
  return taxonomy;
}

function readEdgeTaxonomyCache(cacheKey) {
  if (!cacheKey) return null;
  const row = EDGE_TAXONOMY_CACHE.get(cacheKey);
  if (!row) return null;
  if (Date.now() - Number(row.at || 0) > EDGE_TAXONOMY_CACHE_TTL_MS) {
    EDGE_TAXONOMY_CACHE.delete(cacheKey);
    return null;
  }
  return { ...row.taxonomy };
}

function writeEdgeTaxonomyCache(cacheKey, taxonomy) {
  if (!cacheKey) return;
  EDGE_TAXONOMY_CACHE.set(cacheKey, { at: Date.now(), taxonomy: { ...taxonomy } });
  while (EDGE_TAXONOMY_CACHE.size > EDGE_TAXONOMY_CACHE_MAX) {
    const oldest = EDGE_TAXONOMY_CACHE.keys().next().value;
    if (!oldest) break;
    EDGE_TAXONOMY_CACHE.delete(oldest);
  }
}

function edgeStatsCacheKey({ meta, versionId }) {
  const root = String(meta?.repo_root || "");
  const branch = String(meta?.branch || "");
  const seq = String(meta?.ledger_seq ?? "");
  return `${root}\0${versionId || `${branch}@${seq}`}`;
}

/**
 * @param {{ kind?: string, to_name?: string, to_module?: string | null, repo_rel_path?: string, lang?: string }} edge
 * @param {{ importsByFile?: Map<string, { namedExternal: Set<string>, namespaceExternal: Set<string> }>, repoSymbolNames?: Set<string> }} [ctx]
 * @returns {"runtimeExternal" | "importScopedExternal" | "dynamicReceiver" | "localUnbound" | "selfReceiver" | "trueUnresolved"}
 */
function classifyUnresolvedEdge(edge, ctx = {}) {
  const kind = String(edge.kind || "");
  const lang = normalizeLang(edge.lang);
  const target = String(edge.to_name || "").trim();
  const moduleName = edge.to_module == null ? "" : String(edge.to_module).trim();
  const fileImports = edge.repo_rel_path ? ctx.importsByFile?.get(edge.repo_rel_path) : null;
  if (kind === "imports" && isBareExternalModule(moduleName)) return "runtimeExternal";
  if ((lang === "sh" || lang === "shell" || lang === "bash") && kind === "calls") return "runtimeExternal";
  if ((kind === "extends" || kind === "implements") && isJsLikeLang(lang) && isImportedExternalTarget(target, fileImports)) {
    return "importScopedExternal";
  }
  if (kind === "calls") {
    if (lang === "php" && isPhpDynamicReceiver(target)) return "dynamicReceiver";
    if (lang === "php" && isPhpRuntimeFunction(target)) return "runtimeExternal";
    if (isJsLikeLang(lang)) {
      if (isImportedExternalTarget(target, fileImports)) return "importScopedExternal";
      if (isBuiltinCall(target)) return "runtimeExternal";
      if (isJsSelfReceiver(target)) return "selfReceiver";
      if (isJsDynamicReceiver(target)) return "dynamicReceiver";
      if (target && ctx.repoSymbolNames && !ctx.repoSymbolNames.has(target)) return "localUnbound";
    }
  }
  return "trueUnresolved";
}

function normalizeLang(lang) {
  const text = String(lang || "").trim().toLowerCase();
  if (text === "typescript") return "ts";
  if (text === "javascript") return "js";
  return text;
}

function isBareExternalModule(moduleName) {
  if (!moduleName) return false;
  const base = moduleName.split("#")[0];
  if (base.startsWith(".") || base.startsWith("/") || base.startsWith("@/")) return false;
  return true;
}

function isJsLikeLang(lang) {
  return lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx";
}

/**
 * @param {Array<{ repo_rel_path: string, to_name: string, to_module: string | null, lang?: string, confidence?: number | null }>} rows
 */
function buildExternalImportBindings(rows) {
  const byFile = new Map();
  for (const row of rows) {
    const lang = normalizeLang(row.lang);
    if (!isJsLikeLang(lang)) continue;
    const moduleRef = parseImportModuleRef(String(row.to_module || ""));
    if (!isBareExternalModule(moduleRef.module)) continue;
    const file = String(row.repo_rel_path || "");
    const name = String(row.to_name || "").trim();
    if (!file || !name) continue;
    let bucket = byFile.get(file);
    if (!bucket) {
      bucket = { namedExternal: new Set(), namespaceExternal: new Set() };
      byFile.set(file, bucket);
    }
    bucket.namedExternal.add(name);
    if (Number(row.confidence || 0) === JS_IMPORT_CONFIDENCE_NAMESPACE || Number(row.confidence || 0) === JS_IMPORT_CONFIDENCE_DEFAULT) {
      bucket.namespaceExternal.add(name);
    }
  }
  return byFile;
}

function isImportedExternalTarget(target, fileImports) {
  if (!target || !fileImports) return false;
  if (fileImports.namedExternal.has(target)) return true;
  const root = memberRootName(target);
  return !!root && fileImports.namespaceExternal.has(root);
}

function isJsDynamicReceiver(target) {
  const root = memberRootName(target);
  if (!root || root === target) return false;
  return root !== "this" && root !== "super";
}

function isJsSelfReceiver(target) {
  const root = memberRootName(target);
  return root === "this" || root === "super";
}

function memberRootName(target) {
  const text = String(target || "").trim();
  const dot = text.indexOf(".");
  return dot > 0 ? text.slice(0, dot) : text;
}

function isPhpRuntimeFunction(target) {
  const name = target.replace(/^\\+/, "").trim().toLowerCase();
  if (!name || name.includes(".") || name.includes("->") || name.includes("::")) return false;
  return PHP_STDLIB_FUNCTIONS.has(name) || PHP_LANGUAGE_CONSTRUCTS.has(name);
}

const PHP_LANGUAGE_CONSTRUCTS = new Set([
  "array",
  "die",
  "echo",
  "empty",
  "eval",
  "exit",
  "include",
  "include_once",
  "isset",
  "list",
  "print",
  "require",
  "require_once",
  "unset",
]);

function isPhpDynamicReceiver(target) {
  const match = String(target || "").trim().match(/^(\$[A-Za-z_][A-Za-z0-9_]*)(?:\.|->|::)[A-Za-z_][A-Za-z0-9_]*/);
  if (!match) return false;
  return !PHP_SELF_RECEIVERS.has(match[1].toLowerCase());
}

const PHP_SELF_RECEIVERS = new Set(["$this"]);

/**
 * @param {any} db
 * @param {string} sql
 * @param {unknown[]} [params]
 */
function countSql(db, sql, params = []) {
  try {
    const row = db.prepare(sql).get(...params);
    return Number(row?.cnt ?? row?.count ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {any} db
 * @returns {Record<string, number>}
 */
/**
 * @param {{ languages: string[], probe: boolean }} args
 */
function treeSitterHealth({ languages, probe }) {
  const known = supportedLanguageTags();
  const knownSet = new Set(known);
  const observed = languages.filter((lang) => knownSet.has(lang)).sort();
  const manager = __atlasNativeManagerForTests() || nativeBinaries;
  const nativeAvailable = manager.shouldUse("atlas");
  const observedFailures = nativeAvailable
    ? []
    : observed.map((lang) => ({ lang, error: "native_binary_unavailable" }));
  const probedLanguages = probe
    ? observed.map((lang) => ({
        lang,
        ok: nativeAvailable,
        ...(!nativeAvailable ? { error: "native_binary_unavailable" } : {}),
      }))
    : [];
  return {
    knownLanguageCount: known.length,
    observedLanguages: observed,
    observedFailures,
    probed: probe,
    probedLanguages,
  };
}

/**
 * @param {{ ledger: LedgerContract, limit: number, halfLifeDays?: number }} args
 * @returns {{ totalFeedback: number, usefulFeedback?: number, missingFeedback?: number, topMissingSymbols: { symbolId: string, count: number }[] }}
 */
function qualityFeedback({ ledger, limit, halfLifeDays }) {
  const db = typeof /** @type {any} */ (ledger)._unsafeDb === "function" ? /** @type {any} */ (ledger)._unsafeDb() : null;
  if (db) {
    try {
      const total = db.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN signal = 'useful' THEN 1 ELSE 0 END) AS useful,
           SUM(CASE WHEN signal = 'missing' THEN 1 ELSE 0 END) AS missing
         FROM feedback_signals`,
      ).get();
      const topMissing = db.prepare(
        `SELECT content_hash, local_id, COUNT(*) AS count, MAX(ts) AS last_ts
         FROM feedback_signals
         WHERE signal = 'missing'
         GROUP BY content_hash, local_id
         ORDER BY count DESC, last_ts DESC
         LIMIT ?`,
      ).all(limit).map((row) => ({ symbolId: symbolIdOf(row), count: Number(row.count || 0) }));
      return {
        totalFeedback: Number(total?.total || 0),
        usefulFeedback: Number(total?.useful || 0),
        missingFeedback: Number(total?.missing || 0),
        topMissingSymbols: topMissing,
      };
    } catch {
      // Fall back to the public aggregate API below.
    }
  }
  const rows = ledger.recentFeedback({ limit, halfLifeDays });
  return {
    totalFeedback: rows.reduce((sum, row) => sum + row.useful_count + row.missing_count, 0),
    usefulFeedback: rows.reduce((sum, row) => sum + row.useful_count, 0),
    missingFeedback: rows.reduce((sum, row) => sum + row.missing_count, 0),
    topMissingSymbols: rows
      .filter((row) => row.missing_count > 0)
      .sort((a, b) => b.missing_count - a.missing_count)
      .slice(0, limit)
      .map((row) => ({ symbolId: symbolIdOf(row), count: row.missing_count })),
  };
}

/**
 * @param {View} view
 * @param {RepoOverviewParams} params
 */
function topDirectorySummaries(view, params) {
  const focus = params.directories || [];
  const maxDirs = params.maxDirectories || 10;
  const maxExports = params.maxExportsPerDirectory || 5;
  const metrics = symbolMetrics(view);
  /** @type {Map<string, { files: Set<string>, symbols: ViewSymbol[] }>} */
  const buckets = new Map();
  for (const s of readAllSymbols(view)) {
    const dir = directoryOf(s.repo_rel_path);
    if (focus.length > 0 && !focus.some((f) => dir === f || dir.startsWith(`${f}/`))) continue;
    if (!buckets.has(dir)) buckets.set(dir, { files: new Set(), symbols: [] });
    const b = /** @type {{ files: Set<string>, symbols: ViewSymbol[] }} */ (buckets.get(dir));
    b.files.add(s.repo_rel_path);
    b.symbols.push(s);
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1].symbols.length - a[1].symbols.length);
  return sorted.slice(0, maxDirs).map(([dir, b]) => {
    const visibleSymbols = b.symbols.filter((s) => isDefaultVisibleSymbol(s) && !isGeneratedPath(s.repo_rel_path));
    return {
      repo_rel_path: dir || ".",
      files: b.files.size,
      symbols: b.symbols.length,
      topExports: visibleSymbols
        .filter((s) => s.visibility !== "private" && s.visibility !== "protected")
        .slice(0, maxExports)
        .map((s) => symbolHit(s)),
      topByFanIn: rankedSymbolsByMetric(visibleSymbols, metrics, "fanIn", 3),
      topByFanOut: rankedSymbolsByMetric(visibleSymbols, metrics, "fanOut", 3),
    };
  });
}

/**
 * @param {View} view
 * @param {number} limit
 */
function topHotspots(view, limit) {
  /** @type {Map<string, { inbound: number, outbound: number, symbols: Set<number> }>} */
  const byPath = new Map();
  const metrics = symbolMetrics(view);
  for (const s of readAllSymbols(view)) {
    if (!isDefaultVisibleSymbol(s) || isGeneratedPath(s.repo_rel_path)) continue;
    const current = byPath.get(s.repo_rel_path) || { inbound: 0, outbound: 0, symbols: new Set() };
    const m = metrics.get(s.global_id) || { fanIn: 0, fanOut: 0 };
    current.inbound += m.fanIn;
    current.outbound += m.fanOut;
    current.symbols.add(s.global_id);
    byPath.set(s.repo_rel_path, current);
  }
  const merged = [...byPath.entries()].map(([pathName, row]) => ({
    path: pathName,
    total: row.inbound + row.outbound,
    ins: row.inbound,
    outs: row.outbound,
    symbolCount: row.symbols.size,
  }));
  merged.sort((a, b) => b.total - a.total);
  return merged.slice(0, limit).map((row) => ({
    repo_rel_path: row.path,
    inboundEdges: row.ins,
    outboundEdges: row.outs,
    symbolCount: row.symbolCount,
    score: row.total,
    reason: hotspotReason(row.ins, row.outs),
  }));
}

/**
 * @param {View} view
 * @returns {Map<number, { fanIn: number, fanOut: number }>}
 */
function symbolMetrics(view) {
  /** @type {Map<number, { fanIn: number, fanOut: number }>} */
  const out = new Map();
  if (typeof view?.query?.symbolMetrics === "function") {
    for (const row of view.query.symbolMetrics()) {
      out.set(Number(row.global_id), {
        fanIn: Number(row.fan_in || 0),
        fanOut: Number(row.fan_out || 0),
      });
    }
    return out;
  }
  for (const s of readAllSymbols(view)) {
    out.set(s.global_id, {
      fanIn: view.query.callers(s.global_id).length,
      fanOut: view.query.callees(s.global_id).length,
    });
  }
  return out;
}

/**
 * @param {View} view
 * @param {number} limit
 */
function topSymbolMetrics(view, limit) {
  const metrics = symbolMetrics(view);
  const symbols = readAllSymbols(view)
    .filter((s) => isDefaultVisibleSymbol(s) && !isGeneratedPath(s.repo_rel_path));
  return {
    byFanIn: rankedSymbolsByMetric(symbols, metrics, "fanIn", limit),
    byFanOut: rankedSymbolsByMetric(symbols, metrics, "fanOut", limit),
  };
}

/**
 * @param {ViewSymbol[]} symbols
 * @param {Map<number, { fanIn: number, fanOut: number }>} metrics
 * @param {"fanIn" | "fanOut"} metric
 * @param {number} limit
 */
function rankedSymbolsByMetric(symbols, metrics, metric, limit) {
  return [...symbols]
    .map((symbol) => ({ symbol, score: metrics.get(symbol.global_id)?.[metric] || 0 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.global_id - b.symbol.global_id)
    .slice(0, limit)
    .map((entry) => {
      const hit = symbolHit(entry.symbol);
      hit.score = entry.score;
      return hit;
    });
}

/**
 * @param {number} inbound
 * @param {number} outbound
 */
function hotspotReason(inbound, outbound) {
  if (inbound > outbound * 1.5) return "high_fanin";
  if (outbound > inbound * 1.5) return "high_fanout";
  return "high_connectivity";
}

/**
 * @param {View} view
 * @returns {string[]}
 */
function findEntryPointPaths(view) {
  const names = new Set(["main", "index", "server", "app", "cli", "orchestrator"]);
  const paths = new Set();
  for (const s of readAllSymbols(view)) {
    const file = s.repo_rel_path.split("/").pop() || "";
    const stem = file.replace(/\.[^.]+$/, "");
    if (names.has(stem) || s.name === "main" || s.name === "run") paths.add(s.repo_rel_path);
  }
  return [...paths].sort().slice(0, 25);
}

/**
 * @param {Array<{ repo_rel_path: string }>} directories
 * @returns {string[]}
 */
function identifyArchitecturalLayers(directories) {
  const layerPatterns = [
    { pattern: /^src\/?(api|routes|controllers|handlers)\b/, layer: "API" },
    { pattern: /^src\/?(services|domain|core)\b/, layer: "Service" },
    { pattern: /^src\/?(db|data|models|entities|repositories)\b/, layer: "Data" },
    { pattern: /^src\/?(utils?|helpers?|lib|common)\b/, layer: "Utilities" },
    { pattern: /^src\/?(cli|commands)\b/, layer: "CLI" },
    { pattern: /^src\/?(config|settings)\b/, layer: "Configuration" },
    { pattern: /^src\/?(mcp|protocol)\b/, layer: "Protocol" },
    { pattern: /^src\/?(indexer|parser|analyzer)\b/, layer: "Indexer" },
    { pattern: /^src\/?(graph|slice)\b/, layer: "Graph" },
    { pattern: /^tests?\b/, layer: "Tests" },
  ];
  const layers = [];
  for (const dir of directories) {
    const p = dir.repo_rel_path === "." ? "" : dir.repo_rel_path;
    for (const { pattern, layer } of layerPatterns) {
      if (pattern.test(p) && !layers.includes(layer)) layers.push(layer);
    }
  }
  return layers;
}

/**
 * @param {{ symbolCount: number, fileCount: number }} stats
 * @param {Array<{ symbols: number, topExports?: unknown[], topByFanIn?: unknown[], topByFanOut?: unknown[] }>} directories
 */
function overviewTokenMetrics(stats, directories) {
  const fullCardsEstimate = stats.symbolCount * 220;
  const overviewTokens = 50 + directories.reduce((sum, dir) => {
    return sum
      + 25
      + (dir.topExports?.length || 0) * 12
      + (dir.topByFanIn?.length || 0) * 15
      + (dir.topByFanOut?.length || 0) * 15;
  }, 0);
  return {
    fullCardsEstimate,
    overviewTokens,
    compressionRatio: overviewTokens > 0 ? Math.round((fullCardsEstimate / overviewTokens) * 10) / 10 : 1,
  };
}

/**
 * @param {string} repoRelPath
 * @returns {string}
 */
function directoryOf(repoRelPath) {
  const idx = repoRelPath.lastIndexOf("/");
  return idx <= 0 ? "" : repoRelPath.slice(0, idx);
}
