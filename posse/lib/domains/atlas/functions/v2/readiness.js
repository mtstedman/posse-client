// @ts-check
//
// ATLAS v2 per-layer readiness. Computes a readiness "ledger" from artifacts
// that already exist on disk — SCIP stager meta sidecars, the main view file's
// meta table, blob_layers in the ledger, the tree-compression snapshot, and
// the embedding index's keys.db + inflight.json breadcrumb. There is no global
// "ATLAS is up" boolean here on purpose: each capability degrades or repairs
// independently, so a 30-minute embedding rebuild costs one capability at
// reduced quality, not the engine.
//
// Everything opens read-only and tolerates missing artifacts; this must be
// safe to call from boot paths before any warm has ever run.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  ledgerDbPath,
  mainViewPath,
  embeddingsRoot,
} from "./runtime-paths.js";
import { stagerMetaPathForOutput } from "./scip/stager-meta.js";
import { semanticLanguageTags } from "./resolver/adapters/registry.js";
import { shouldRunScipPhase } from "../../../integrations/functions/atlas-v2-mode.js";

/**
 * @typedef {"ready" | "warming" | "failed" | "stale" | "off"} AtlasLayerStatus
 *
 * @typedef {Object} AtlasLayerReadiness
 * @property {string} layer        e.g. "treesitter", "scip:python", "views", "tree-compression", "embeddings:<model_version>"
 * @property {AtlasLayerStatus} status
 * @property {number | null} coverage   0-100 where measurable, else null.
 * @property {string} detail            Human-readable one-liner for the TUI/status surfaces.
 */

/** Embedding coverage at or above this fraction of view symbols counts as parity. */
export const ATLAS_EMBEDDINGS_PARITY = 0.95;

/**
 * @param {string} dbPath
 * @returns {import("better-sqlite3").Database | null}
 */
function openReadonly(dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    return db;
  } catch {
    return null;
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} table
 * @returns {boolean}
 */
function tableExists(db, table) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * @param {string} repoRoot
 * @returns {{ views: AtlasLayerReadiness, treesitter: AtlasLayerReadiness, candidates: number, eligibleCandidates: number }}
 */
function inspectViewAndTreesitter(repoRoot) {
  const viewPath = mainViewPath(repoRoot);
  const ledgerPath = ledgerDbPath(repoRoot);
  const ledgerDb = openReadonly(ledgerPath);
  const viewDb = openReadonly(viewPath);
  let candidates = 0;
  let eligibleCandidates = 0;

  /** @type {AtlasLayerReadiness} */
  let views;
  /** @type {AtlasLayerReadiness} */
  let treesitter;

  try {
    // -- treesitter: blob_layers rows are the per-blob parse outcomes.
    if (!ledgerDb || !tableExists(ledgerDb, "blob_layers")) {
      treesitter = { layer: "treesitter", status: "warming", coverage: 0, detail: "ledger not bootstrapped yet" };
    } else {
      /** @type {Record<string, number>} */
      const counts = {};
      try {
        for (const row of ledgerDb.prepare(
          "SELECT status, COUNT(*) AS c FROM blob_layers WHERE source = 'treesitter' GROUP BY status",
        ).all()) {
          counts[String(/** @type {any} */ (row).status)] = Number(/** @type {any} */ (row).c) || 0;
        }
      } catch { /* readiness is best-effort */ }
      const indexed = counts.indexed || 0;
      const failed = counts.failed || 0;
      if (indexed === 0 && failed === 0) {
        treesitter = { layer: "treesitter", status: "warming", coverage: 0, detail: "no parsed blobs yet" };
      } else if (indexed === 0) {
        treesitter = { layer: "treesitter", status: "failed", coverage: 0, detail: `${failed} blobs failed to parse` };
      } else {
        const coverage = Math.round((indexed / (indexed + failed)) * 100);
        treesitter = {
          layer: "treesitter",
          status: "ready",
          coverage,
          detail: failed > 0
            ? `${formatCount(indexed)} blobs parsed (${failed} failed)`
            : `${formatCount(indexed)} blobs parsed`,
        };
      }
    }

    // -- views: main view exists and is at the ledger head for its branch.
    if (!viewDb || !tableExists(viewDb, "meta")) {
      views = { layer: "views", status: "warming", coverage: 0, detail: "main view not built yet" };
    } else {
      /** @type {Record<string, string>} */
      const meta = {};
      try {
        for (const row of viewDb.prepare("SELECT key, value FROM meta").all()) {
          meta[String(/** @type {any} */ (row).key)] = String(/** @type {any} */ (row).value ?? "");
        }
      } catch { /* fall through to warming below */ }
      try {
        candidates = Number(viewDb.prepare("SELECT COUNT(*) AS c FROM symbols").get()?.c) || 0;
      } catch { /* leave 0 */ }
      try {
        // Embedding parity denominator: only symbols whose language the
        // embeddings ingest can actually encode (ingest.js filters by
        // hasLanguageSemantics, and skipped symbols never enter keys.db).
        // Counting ineligible symbols here pins parity below the threshold
        // forever on repos with enough unsupported-language symbols.
        const tags = semanticLanguageTags();
        const placeholders = tags.map(() => "?").join(",");
        eligibleCandidates = Number(
          viewDb.prepare(`SELECT COUNT(*) AS c FROM symbols WHERE lang IN (${placeholders})`).get(...tags)?.c,
        ) || 0;
      } catch { /* leave 0 */ }
      const branch = meta.branch || "main";
      const viewSeq = Number(meta.ledger_seq);
      let headSeq = null;
      if (ledgerDb && tableExists(ledgerDb, "symbol_deltas")) {
        try {
          const row = ledgerDb.prepare("SELECT MAX(seq) AS s FROM symbol_deltas WHERE branch = ?").get(branch);
          headSeq = row && row.s != null ? Number(row.s) : 0;
        } catch { /* leave null */ }
      }
      if (!Number.isFinite(viewSeq)) {
        views = { layer: "views", status: "warming", coverage: 0, detail: "main view meta unreadable" };
      } else if (headSeq != null && headSeq > viewSeq) {
        const coverage = headSeq > 0 ? Math.round((viewSeq / headSeq) * 100) : 0;
        views = {
          layer: "views",
          status: "stale",
          coverage,
          detail: `view at seq ${viewSeq}, ledger head ${headSeq}`,
        };
      } else {
        views = {
          layer: "views",
          status: "ready",
          coverage: 100,
          detail: `${formatCount(candidates)} symbols at seq ${viewSeq}${meta.built_at ? ` (built ${meta.built_at})` : ""}`,
        };
      }
    }
  } finally {
    try { ledgerDb?.close(); } catch { /* ignore */ }
    try { viewDb?.close(); } catch { /* ignore */ }
  }
  return { views, treesitter, candidates, eligibleCandidates };
}

/**
 * @param {string} repoRoot
 * @param {Record<string, any>} config
 * @returns {AtlasLayerReadiness[]}
 */
function inspectScipLayers(repoRoot, config) {
  const mode = String(config?.scipMode || "off").trim().toLowerCase();
  if (!shouldRunScipPhase(mode)) {
    return [{ layer: "scip", status: "off", coverage: null, detail: `scip mode ${mode || "off"}` }];
  }
  const scipDir = String(config?.scipDir || path.join(repoRoot, ".posse", "atlas", "scip"));
  /** @type {AtlasLayerReadiness[]} */
  const layers = [];
  let entries = [];
  try {
    entries = fs.existsSync(scipDir) ? fs.readdirSync(scipDir) : [];
  } catch {
    entries = [];
  }
  const readMeta = (outputPath) => {
    try {
      return JSON.parse(fs.readFileSync(stagerMetaPathForOutput(outputPath), "utf8"));
    } catch {
      return null;
    }
  };
  const stagedOutputs = new Set();
  for (const name of entries) {
    if (!/\.scip$/iu.test(name)) continue;
    stagedOutputs.add(name.toLowerCase());
    const meta = readMeta(path.join(scipDir, name));
    const language = String(meta?.language || name.replace(/\.scip$/iu, "")) || "unknown";
    // An absent status field means "staged" — the field postdates schema v1
    // metas, and metaIsCurrent applies the same reading.
    const status = String(meta?.status || "staged").trim().toLowerCase();
    if (status === "failed") {
      const attempts = Number(meta?.attempt_count) || 1;
      layers.push({
        layer: `scip:${language}`,
        status: "failed",
        coverage: 0,
        detail: `${meta?.failure_reason || "stage failed"} (attempt ${attempts})`,
      });
    } else if (status === "staged" || status === "recovered") {
      layers.push({
        layer: `scip:${language}`,
        status: "ready",
        coverage: 100,
        detail: status === "recovered" ? "staged (recovered meta)" : `staged at ${meta?.head ? String(meta.head).slice(0, 12) : "unknown head"}`,
      });
    } else {
      layers.push({
        layer: `scip:${language}`,
        status: "warming",
        coverage: 0,
        detail: `meta status ${status}`,
      });
    }
  }
  // Meta sidecars whose .scip output is absent: a failed stage never promotes
  // its temp output, so the normal first-failure state is exactly this —
  // failed meta, no artifact. Without this pass the failure is invisible
  // (generic "scip warming", or nothing at all when another language staged
  // fine) and self-repair's failed-status restage trigger never fires.
  for (const name of entries) {
    if (!/\.meta\.json$/iu.test(name)) continue;
    const outputName = name.replace(/\.meta\.json$/iu, ".scip");
    if (stagedOutputs.has(outputName.toLowerCase())) continue;
    const meta = readMeta(path.join(scipDir, outputName));
    const language = String(meta?.language || outputName.replace(/\.scip$/iu, "")) || "unknown";
    const status = String(meta?.status || "staged").trim().toLowerCase();
    if (status === "failed") {
      const attempts = Number(meta?.attempt_count) || 1;
      layers.push({
        layer: `scip:${language}`,
        status: "failed",
        coverage: 0,
        detail: `${meta?.failure_reason || "stage failed"} (attempt ${attempts}, no staged output)`,
      });
    } else {
      // A non-failed meta without its output is inconsistent (artifact
      // deleted out from under the meta) — report warming, never ready.
      layers.push({
        layer: `scip:${language}`,
        status: "warming",
        coverage: 0,
        detail: `meta status ${status} but staged output missing`,
      });
    }
  }
  if (layers.length === 0) {
    layers.push({ layer: "scip", status: "warming", coverage: 0, detail: "no staged SCIP artifacts yet" });
  }
  return layers;
}

/**
 * @param {string} repoRoot
 * @param {Record<string, any>} config
 * @returns {AtlasLayerReadiness}
 */
function inspectTreeCompression(repoRoot, config) {
  const mode = String(config?.treeCompressionMode || "off").trim().toLowerCase();
  if (mode === "off") {
    return { layer: "tree-compression", status: "off", coverage: null, detail: "mode off" };
  }
  const viewDb = openReadonly(mainViewPath(repoRoot));
  if (!viewDb) {
    return { layer: "tree-compression", status: "warming", coverage: 0, detail: "main view not built yet" };
  }
  try {
    if (!tableExists(viewDb, "atlas_tree_compression_snapshots")) {
      return { layer: "tree-compression", status: "warming", coverage: 0, detail: "no compression snapshot yet" };
    }
    const snapshot = /** @type {any} */ (viewDb.prepare(
      "SELECT id, built_at, profile, status FROM atlas_tree_compression_snapshots ORDER BY id DESC LIMIT 1",
    ).get());
    if (!snapshot) {
      return { layer: "tree-compression", status: "warming", coverage: 0, detail: "no compression snapshot yet" };
    }
    if (String(snapshot.status || "").toLowerCase() === "failed") {
      return { layer: "tree-compression", status: "failed", coverage: 0, detail: `snapshot ${snapshot.id} failed` };
    }
    let total = 0;
    let stale = 0;
    if (tableExists(viewDb, "atlas_tree_compression_seeds")) {
      try {
        const row = /** @type {any} */ (viewDb.prepare(
          "SELECT COUNT(*) AS total, SUM(CASE WHEN stale_since IS NOT NULL THEN 1 ELSE 0 END) AS stale FROM atlas_tree_compression_seeds WHERE snapshot_id = ?",
        ).get(snapshot.id));
        total = Number(row?.total) || 0;
        stale = Number(row?.stale) || 0;
      } catch { /* leave counts at 0 */ }
    }
    if (total <= 0) {
      return {
        layer: "tree-compression",
        status: "failed",
        coverage: 0,
        detail: `snapshot ${snapshot.id} has no seeds`,
      };
    }
    const coverage = Math.round(((total - stale) / total) * 100);
    return {
      layer: "tree-compression",
      status: stale > 0 && total > 0 && stale >= total ? "stale" : "ready",
      coverage,
      detail: `${total} seeds (${stale} stale labels, ${snapshot.profile || "default"} profile)`,
    };
  } finally {
    try { viewDb.close(); } catch { /* ignore */ }
  }
}

/**
 * @param {string} repoRoot
 * @param {Record<string, any>} config
 * @param {number} candidates  Encodable symbol count of the main view (embedding
 *   denominator) — symbols with language semantics only, matching what the
 *   embeddings ingest will ever write to keys.db.
 * @param {number} parity
 * @returns {AtlasLayerReadiness[]}
 */
function inspectEmbeddings(repoRoot, config, candidates, parity) {
  const root = embeddingsRoot(repoRoot);
  /** @type {AtlasLayerReadiness[]} */
  const layers = [];
  let dirs = [];
  try {
    dirs = fs.existsSync(root)
      ? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    const modelDir = path.join(root, dir.name);
    const keysDb = openReadonly(path.join(modelDir, "keys.db"));
    if (!keysDb) continue;
    let vectors = 0;
    let modelVersion = dir.name;
    try {
      if (tableExists(keysDb, "vectors")) {
        vectors = Number(keysDb.prepare("SELECT COUNT(*) AS c FROM vectors").get()?.c) || 0;
      }
      if (tableExists(keysDb, "meta")) {
        const row = /** @type {any} */ (keysDb.prepare("SELECT value FROM meta WHERE key = 'model_version'").get());
        if (row?.value) modelVersion = String(row.value);
      }
    } catch { /* leave defaults */ } finally {
      try { keysDb.close(); } catch { /* ignore */ }
    }
    const inflight = fs.existsSync(path.join(modelDir, "inflight.json"));
    const layer = `embeddings:${modelVersion}`;
    if (candidates <= 0) {
      layers.push({
        layer,
        status: inflight ? "warming" : "ready",
        coverage: null,
        detail: `${formatCount(vectors)} vectors (no view symbol count to compare)`,
      });
      continue;
    }
    const coverage = Math.min(100, Math.round((vectors / candidates) * 100));
    const atParity = vectors / candidates >= parity;
    layers.push({
      layer,
      status: !atParity || inflight ? "warming" : "ready",
      coverage,
      detail: `${formatCount(vectors)}/${formatCount(candidates)} symbols${inflight ? " (encode in flight or interrupted)" : ""}`,
    });
  }
  if (layers.length === 0) {
    layers.push({ layer: "embeddings", status: "warming", coverage: 0, detail: "no embedding index built yet" });
  }
  return layers;
}

/**
 * Compute per-layer readiness for a repo from on-disk artifacts only. Cheap
 * enough for boot paths: a handful of read-only SQLite opens plus directory
 * scans; no encoder, daemon, or parser is touched.
 *
 * @param {{
 *   repoRoot: string,
 *   config?: Record<string, any>,
 *   parity?: number,
 * }} args
 * @returns {{ layers: AtlasLayerReadiness[], notReady: AtlasLayerReadiness[] }}
 */
export function computeAtlasLayerReadiness({ repoRoot, config = {}, parity = ATLAS_EMBEDDINGS_PARITY }) {
  const root = String(repoRoot || "");
  const { views, treesitter, eligibleCandidates } = inspectViewAndTreesitter(root);
  const layers = [
    treesitter,
    ...inspectScipLayers(root, config),
    views,
    inspectTreeCompression(root, config),
    ...inspectEmbeddings(root, config, eligibleCandidates, parity),
  ];
  const notReady = layers.filter((layer) => layer.status !== "ready" && layer.status !== "off");
  return { layers, notReady };
}

/**
 * One-line summary for logs/boot detail text, e.g.
 * "scip:python failed; embeddings:jina-v2 warming 73%".
 *
 * @param {AtlasLayerReadiness[]} layers
 * @returns {string}
 */
export function summarizeAtlasReadiness(layers) {
  const parts = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer.status === "ready" || layer.status === "off") continue;
    const coverage = Number.isFinite(Number(layer.coverage)) ? ` ${layer.coverage}%` : "";
    parts.push(`${layer.layer} ${layer.status}${coverage}`);
  }
  return parts.length > 0 ? parts.join("; ") : "all layers ready";
}
